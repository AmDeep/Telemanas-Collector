# Tele MANAS Collector

A Cloudflare Worker that scrapes the public Tele MANAS dashboard API on a daily schedule and stores snapshots in Cloudflare R2 for ingestion into PostHog's data warehouse.

---

## What it collects

The dashboard exposes five unauthenticated JSON endpoints:

| Endpoint | Data |
|---|---|
| `/rest/v0/getCallCount` | Cumulative total of calls taken |
| `/rest/v0/getPageviews` | Cumulative page view count |
| `/rest/v0/getTMCcount/TMC` | Count of Tele MANAS Cells (TMC), Medical Institutions (MI), Regional Coordinating Centres (RCC) |
| `/rest/v0/getStates` | All 36 states/UTs with their IDs |
| `/rest/v0/getOrg/TMC` | All 52 TMC facilities with their state and name |

All five calls are made in parallel so each collection run takes roughly as long as the slowest endpoint.

---

## Architecture

```
Cron trigger (03:00 UTC daily)
         │
         ▼
  fetchSnapshot()
    ├── getCallCount()   ─┐
    ├── getPageViews()    │ parallel
    ├── getTmcCount()     │
    ├── getStates()       │
    └── getOrgs()        ─┘
         │
         ▼ validate (fail loud, not silently)
         │
         ▼
  saveToR2()
    ├── telemanas/summary/YYYY-MM-DD.ndjson  (1 flat row)
    └── telemanas/orgs/YYYY-MM-DD.ndjson     (1 row per facility)
```

### Why two tables?

PostHog's data warehouse ingests NDJSON from R2 using DuckDB and a wildcard file URL pattern. Each table is configured separately in PostHog:

- **`telemanas/summary/*.ndjson`** — one row per collection run. Gives you a time series of total call volume, page views, and cell counts. The primary table for trend analysis.
- **`telemanas/orgs/*.ndjson`** — one row per TMC facility per collection run. Lets you track when new facilities are added, and later correlate facility-level data if the API ever exposes call counts per org.

Keeping them separate lets PostHog query each independently without unnesting arrays. A single nested snapshot blob would require JSON path syntax for every query, which is awkward.

### Storage format

Files are NDJSON (one JSON object per line). Column names use snake_case because PostHog exposes them directly as table column names, and snake_case is the convention for SQL.

**Summary row example:**
```json
{"captured_at":"2026-03-20T12:40:48.972Z","total_calls":3500914,"page_views":613105,"cells_tmc":53,"cells_mi":23,"cells_rcc":5,"org_count":52,"state_count":36}
```

**Org row example:**
```json
{"captured_at":"2026-03-20T12:40:48.972Z","state_name":"Andhra pradesh","org_name":"Government Hospital for Mental Care","call_count":null}
```

### Idempotent writes, no race conditions

The original design appended to a daily file with a read-modify-write pattern (`bucket.get` → modify → `bucket.put`). This has a race condition: if a scheduled run and a manual `/trigger` POST overlap, one overwrites the other mid-flight.

The fix is to write one file per day rather than appending. Running twice on the same date overwrites the file with the latest values, which is the right behaviour — we want the most recent snapshot for that day, not a confusing double-count. `bucket.put` is atomic on R2.

### Retry and timeout

Each API call gets:
- **10-second timeout** via `AbortController` — the Tele MANAS server is a `.gov.in` domain that can be slow
- **3 attempts** with exponential backoff (1s, 2s) — handles transient failures without burning the whole run on one flaky endpoint

Retrying at the individual-call level rather than the whole-snapshot level means a single slow endpoint doesn't delay everything else. Three attempts is conservative; this is a once-daily job so even a full failure just means we skip that day.

### Response validation

`parseInt` results are checked for `NaN` and arrays are checked to be non-empty before the snapshot is accepted. This surfaces data-shape changes as loud errors (visible in Cloudflare's cron failure logs) rather than silently writing `null` or `NaN` values into R2.

---

## PostHog ingestion setup

In PostHog → Data warehouse → Sources → Add source → S3:

| Field | Value |
|---|---|
| Display name | `Tele MANAS` |
| Access key ID | R2 API token (Object Read Only) |
| Secret access key | R2 API token secret |
| Region | `auto` |
| Bucket | `tele-manas-data` |
| Path prefix | `telemanas/summary/*.ndjson` |
| File format | NDJSON |

Repeat for the orgs table using path prefix `telemanas/orgs/*.ndjson`.

PostHog will discover all existing files and incrementally sync new ones as the cron writes them. The wildcard matches files by date, so you get one row per day in the summary table automatically.

**To get the R2 endpoint URL** (needed for PostHog's bucket URL field):
```
https://<ACCOUNT_ID>.r2.cloudflarestorage.com/tele-manas-data
```
Find your account ID in the Cloudflare dashboard → R2.

---

## HTTP endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Usage text |
| `GET` | `/health` | Liveness + dependency check. Returns 200 if both the Tele MANAS API and R2 are reachable, 503 otherwise |
| `POST` | `/trigger` | Run a collection immediately, returns the written keys and row counts |

### Health check response

```json
{
  "ok": true,
  "api": { "ok": true, "latencyMs": 342 },
  "r2":  { "ok": true }
}
```

The health check pings the lightest Tele MANAS endpoint (`/getCallCount`) and does a `bucket.list()` with `limit: 1` to verify the R2 binding. Both checks run in parallel. A 503 response means PostHog syncs should be investigated.

---

## Development

```bash
# Install dependencies
pnpm install

# Type check
pnpm typecheck

# Run locally (uses a local R2 preview bucket)
pnpm dev

# While dev server is running:
curl http://localhost:8787/health
curl -X POST http://localhost:8787/trigger

# Test the scheduled cron trigger
curl http://localhost:8787/cdn-cgi/handler/scheduled
```

## Deployment

```bash
# First time only: create the R2 bucket
wrangler r2 bucket create tele-manas-data

# Authenticate with Cloudflare
wrangler login

# Deploy
pnpm deploy
```

After deployment, the worker runs at 03:00 UTC daily. You can verify it's working by checking `GET /health` on the deployed URL and confirming files appear in R2 after the first scheduled run.

---

## Decisions I'd revisit with more time

**Per-state call data.** The map on the dashboard shows calls by state, but the state-specific API endpoint (`/getOrg/{stateId}`) returns 404 for all state IDs tested. The state-level data is likely computed client-side from something not in the public endpoints. A closer read of the minified Angular bundle might reveal a working endpoint.

**Change detection before writing.** We always write even if nothing changed. Once the dataset has months of history, it would be cheap to check whether `total_calls` moved before writing, skipping unchanged days. Not worth the complexity now.

**Schema versioning.** If the Tele MANAS API changes its response shape, old and new NDJSON rows will be silently mixed in PostHog with no marker. Adding a `schema_version` field (e.g. `"v1"`) to each row would make migrations straightforward to filter.

**Backfill.** The API only exposes current values, so we lose history before the first run. There is no way to recover it unless someone has screenshots of old dashboard states.
