# tele-manas-collector


---

## Connection

The public dashboard at `https://telemanas.mohfw.gov.in/telemanas-dashboard/#/` is an Angular single-page app — its HTML is an empty shell with no data in it. All the metrics on the page come from unauthenticated REST API endpoints that the Angular app calls at runtime. These were found by extracting URLs from the compiled JavaScript bundle the dashboard loads.

The worker connects directly to those endpoints:

| Endpoint | Data |
|---|---|
| `…/rest/v0/getCallCount` | Cumulative calls taken since launch |
| `…/rest/v0/getPageviews` | Cumulative page views |
| `…/rest/v0/getTMCcount/TMC` | Count of Tele MANAS Cells, Medical Institutions, Regional Coordinating Centres |
| `…/rest/v0/getStates` | All 36 states/UTs with their IDs |
| `…/rest/v0/getTMC/0/TMC` | All 53 TMC facilities with 28 fields each (incl. active counsellors) |
| `…/rest/v0/getTMC/0/MI` | All 23 Medical Institution facilities |
| `…/rest/v0/getTMC/0/RCC` | All 5 Regional Coordinating Centres |

All seven calls run in parallel on each collection run.

The base URL for all endpoints is `https://telemanas.mohfw.gov.in/TELEMANAS/rest/v0`.

### Why `getTMC` and not `getOrg`

The bundle also exposes `getOrg/TMC`, `getOrg/MI`, and `getOrg/RCC`. These return only `{stateName, name, count}` per facility where `count` is always null. The `getTMC/0/{type}` endpoint is a strict superset: it returns 28 fields per facility including `activeCounsellors`, `status`, `mentoringInstitute`, and `rcc`. The `getOrg` endpoints are not called.

### Endpoints that require authentication

These exist in the bundle but return HTTP 404 without a valid Bearer token and cannot be collected:

- `districtReport/{date}` — district-level call breakdown (would be the most valuable dataset)
- `orgReport/{date}` — facility-level call log
- `getAgeCount/{stateId}` — caller age distribution
- `getLast7daysCount/{id}` — 7-day rolling trend per facility

---

## What it produces

Two NDJSON files per day in R2 — one per PostHog data warehouse table:

```
telemanas/summary/2026-03-20.ndjson       which produces one flat row per run
telemanas/facilities/2026-03-20.ndjson    which produces one row per facility (TMC + MI + RCC)
```

## Architecture

```
Cloudflare Cron (03:00 UTC daily)
         │
         ▼
  fetchSnapshot()                         src/snapshot.ts
    ├── getCallCount()        ─┐
    ├── getPageViews()         │
    ├── getTmcCount()          │  Promise.all — all seven in parallel
    ├── getStates()            │
    ├── getFacilities("TMC")   │
    ├── getFacilities("MI")    │
    └── getFacilities("RCC")  ─┘
         │
         ▼  validate — fail loudly on NaN or empty arrays
         │
         ▼
  saveToR2()                              src/storage.ts
    ├── telemanas/summary/YYYY-MM-DD.ndjson      (1 row)
    └── telemanas/facilities/YYYY-MM-DD.ndjson   (81 rows)
         │
         ▼
  Cloudflare R2  ──S3-compatible API──▶  PostHog Data Warehouse
```

---

### Decision log

Every choice below had at least one real alternative considered. The reasoning is written out so that future maintainers can re-evaluate when the constraints change.

---


#### Why NDJSON, not CSV or Parquet

PostHog's data warehouse ingests three file formats: CSV, NDJSON, and Parquet.

- **CSV** loses type information. `active_counsellors` would be ingested as a string unless you configure a schema override in PostHog. NDJSON preserves `null` vs `"null"` vs `0` natively.
- **Parquet** is columnar and efficient for large datasets but requires a schema to be defined at write time. Adding a field would require rewriting all historical files or migrating the PostHog schema. NDJSON is schema-flexible: new fields in future API responses are picked up automatically on the next sync.
- **NDJSON** (one JSON object per line) is the right middle ground for this volume: human-readable for debugging, typed, schema-flexible, and directly supported by DuckDB (PostHog's warehouse engine) without any transformation.

---

#### Why two tables, not one

The first version of this design wrote a single NDJSON file with the summary metrics nested alongside a `facilities` array. This is easy to write but unpleasant to query: accessing `facilities[0].active_counsellors` in DuckDB requires `json_extract` or `unnest`, and PostHog's insight UI does not expose those functions directly.

Flat rows — one per facility for the facilities table, one per run for the summary — let you write plain `SELECT`, `GROUP BY`, and `SUM` queries in PostHog without any JSON path gymnastics. The cost is two `bucket.put()` calls instead of one, which is negligible.

A third table for states was considered but rejected: the state list is reference data (36 static entries), not a time series. It doesn't need to be tracked daily. If state-level metrics become available (e.g., via authenticated endpoints), a separate table can be added at that point.

---

#### Why `getTMC/0/{type}`, not `getOrg/{type}`

Both endpoint families appear in the Angular bundle. `getOrg/TMC` was the obvious first find because it matches the endpoint name — but inspecting the actual response revealed that `count` is always `null` in every record. The endpoint returns `{stateName, name, count: null}` — a simplified view with no useful data beyond facility names.

`getTMC/{stateId}/{type}` uses `stateId = 0` to mean "all states" and returns 28 fields per facility including:

- `activeCounsellors` — the only live operational metric available without authentication
- `status` — whether the facility is currently active
- `mentoringInstitute` and `rcc` — the supervisory network structure

The `getOrg` family is not called at all. Using both would be redundant, and the richer endpoint is strictly preferable.

---

#### Why parallel fetching with per-call retries

The seven API calls are independent — no response depends on another — so running them sequentially would waste wall-clock time for no reason. `Promise.all` runs them concurrently; the total time is bounded by the slowest single call (~1s observed) rather than the sum (~7s).

The retry logic is attached at the individual call level, not the whole snapshot. This matters because a single slow endpoint (e.g., `getTMC/0/MI` timing out) would not abort the other six calls if retried in isolation. A global timeout wrapping the entire `Promise.all` would cancel all calls on the first failure.

---

#### Why a hard 10-second timeout per call

The Tele MANAS server is a government-hosted backend with inconsistent response times. In testing, responses ranged from 700ms to 1,200ms. Without a timeout, a hung connection would block that call's goroutine indefinitely and eventually cause the entire Worker invocation to hit Cloudflare's wall-clock limit (which surfaces as a silent failure, not an error).

`AbortController` with a 10-second deadline gives the server eight to nine times its observed response time before the call is abandoned. If three attempts all time out, the error propagates loudly and the run is marked failed in Cloudflare's cron logs — which is the right outcome.

---

#### Why overwrite, not append

The first version attempted to append new data to an existing daily file: read the object from R2, concatenate the new NDJSON line, write it back. This has a race condition: if two invocations run concurrently (which Cloudflare does not guarantee it won't do), both would read the same original object and each would overwrite with a file containing only their own data, silently dropping the other's write.

`bucket.put()` is atomic — it either fully replaces the object or fails. Running twice on the same day is safe: the second run overwrites the first with a fresh snapshot, which is correct because the API metrics are cumulative totals (the later value is always the right one for that day).

---

#### Why the `telemanas/{table}/YYYY-MM-DD.ndjson` key structure

PostHog's data warehouse source uses a path prefix with a wildcard (`telemanas/summary/` → picks up all `.ndjson` files under that prefix). The date in the filename is the partition key — PostHog can infer it as a column or you can extract it with `substring(captured_at, 1, 10)` in a query.

Alternatives considered:

- **`telemanas/YYYY/MM/DD/summary.ndjson`** — Hive-style partitioning. Useful for Athena or Spark which can prune partitions. PostHog/DuckDB doesn't use this structure, so it's unnecessary complexity.
- **`telemanas/summary/latest.ndjson`** — Always overwrite a single file. Loses history entirely. Rejected.
- **`telemanas/summary/YYYY-MM-DD-HH-mm.ndjson`** — Finer granularity. More files, more PostHog sync overhead, and unnecessary given the daily cron cadence.

---

#### Why loud validation, not silent fallbacks

The API returns numeric values as strings (`"Total_Calls": "3500914"`). An earlier draft silently defaulted to `0` when `parseInt` returned `NaN`. This would have written rows like `{"total_calls": 0, "page_views": 0}` to R2 without any visible error — PostHog would ingest them and they'd show up as real data points, silently corrupting the time series.

The current code throws immediately if any numeric field cannot be parsed or if any array is empty. The Worker invocation fails, Cloudflare logs the error, and the cron dashboard shows a failed run — which is obvious and actionable. A row is never written unless the snapshot is fully valid.

---

#### Why 03:00 UTC

The Tele MANAS dashboard is primarily used during Indian business hours (IST = UTC+5:30, so business hours run roughly 03:30–13:30 UTC). Collecting at 03:00 UTC captures the end-of-previous-day state just before the next business day begins. It also avoids peak server load and is well within the Cloudflare free-tier cron window.

---

#### Fields stored vs. fields dropped

The `getTMC/0/{type}` response has 28 fields. The worker stores 13 of them. The dropped fields fall into three categories:

| Category | Fields | Reason dropped |
|---|---|---|
| SVG map coordinates | `x`, `y` | Pixel positions on the dashboard's India SVG — meaningless outside that context |
| Social media / branding | `logo`, `twitter`, `twitter_url`, `instagram`, `instagram_url`, `facebook`, `facebook_url`, `youtube`, `youtube_url` | PR/comms data, not operational metrics |
| Contact details | `address`, `email`, `phoneNumber`, `adminIncharge`, `adminContact` | Operational data; changes rarely; not useful for trend analysis; contains PII risk if the bucket is ever made public |

All of these can be added back by editing `toFacilityRow()` in `src/storage.ts` — they are present in the raw API response and in the `Facility` interface in `src/api.ts`.

---

## Worker endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Usage text |
| `GET` | `/health` | Checks both the Tele MANAS API and R2 binding. Returns 200 if both reachable, 503 otherwise |
| `POST` | `/trigger` | Run a collection immediately, returns the written R2 keys and row counts |

**Health check response:**
```json
{
  "ok": true,
  "api": { "ok": true, "latencyMs": 342 },
  "r2":  { "ok": true }
}
```

**Trigger response:**
```json
{
  "ok": true,
  "capturedAt": "2026-03-20T03:00:12.341Z",
  "totalCalls": 3501120,
  "facilities": 81,
  "summaryKey": "telemanas/summary/2026-03-20.ndjson",
  "facilitiesKey": "telemanas/facilities/2026-03-20.ndjson",
  "facilityRows": 81
}
```

---

## Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **A Cloudflare account** — [dash.cloudflare.com](https://dash.cloudflare.com) (free tier is enough)
- **Wrangler CLI** — installed automatically by `npm install` via the `devDependencies`

---

## Local development

### 1. Install dependencies

```bash
cd tele-manas-worker
npm install
```

### 2. Type-check

```bash
npm run typecheck
```

This compiles the TypeScript against the Cloudflare Workers types. No output means no errors.

### 3. Start the local dev server

```bash
npm run dev
```

Wrangler starts a local server on `http://localhost:8787` and provisions an in-process R2 bucket (`TELE_MANAS_BUCKET`) backed by a local `.wrangler/state/` directory — no Cloudflare account or real bucket is needed at this stage.

You should see output like:

```
⛅️ wrangler 3.x.x
------------------
▲ [WARNING] Using Workers Dev Platform (local)
Your worker has access to the following bindings:
  - R2 Buckets:
    - TELE_MANAS_BUCKET: tele-manas-data (local)
[mf:inf] Ready on http://localhost:8787
```

### 4. Verify the API is reachable

```bash
curl http://localhost:8787/health
```

Expected response (`"api": {"ok": true}` confirms the Tele MANAS endpoints are up; `"r2": {"ok": true}` confirms the local bucket binding works):

```json
{"ok":true,"api":{"ok":true,"latencyMs":812},"r2":{"ok":true}}
```

### 5. Run a collection manually

```bash
curl -X POST http://localhost:8787/trigger
```

Expected response:

```json
{
  "ok": true,
  "capturedAt": "2026-03-20T12:00:00.000Z",
  "totalCalls": 3501120,
  "facilities": 81,
  "summaryKey": "telemanas/summary/2026-03-20.ndjson",
  "facilitiesKey": "telemanas/facilities/2026-03-20.ndjson",
  "facilityRows": 81
}
```

### 6. Inspect the written NDJSON files

The local R2 state lives in `.wrangler/state/v3/r2/`. You can view the written files:

```bash
# List what was written
ls .wrangler/state/v3/r2/*/buckets/tele-manas-data/

# Read the summary file
cat .wrangler/state/v3/r2/*/buckets/tele-manas-data/telemanas/summary/*.ndjson | python3 -m json.tool

# Count facility rows
wc -l .wrangler/state/v3/r2/*/buckets/tele-manas-data/telemanas/facilities/*.ndjson
```

### 7. Simulate the cron trigger

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

This fires the `scheduled` handler the same way the Cloudflare cron does — useful to confirm the end-to-end path works before deploying.

---

## Deployment

### 1. Authenticate with Cloudflare

```bash
npx wrangler login
```

This opens a browser window. Log in with your Cloudflare account.

### 2. Create the R2 bucket (one time only)

```bash
npx wrangler r2 bucket create tele-manas-data
```

### 3. Deploy the worker

```bash
npm run deploy
```

Wrangler bundles the TypeScript, uploads it to Cloudflare, and links the `TELE_MANAS_BUCKET` binding to the `tele-manas-data` bucket you just created.

You should see:

```
Total Upload: xx.xx KiB / gzip: xx.xx KiB
Uploaded tele-manas-collector (xx sec)
Published tele-manas-collector (xx sec)
  https://tele-manas-collector.<your-subdomain>.workers.dev
Current Deployment ID: ...
```

### 4. Verify the deployed worker

```bash
# Health check
curl https://tele-manas-collector.<your-subdomain>.workers.dev/health

# Manual trigger
curl -X POST https://tele-manas-collector.<your-subdomain>.workers.dev/trigger
```

The worker will also run automatically every day at **03:00 UTC** from this point forward (configured in `wrangler.toml`).

### 5. Confirm data landed in R2

```bash
npx wrangler r2 object list tele-manas-data
```

After the first run you should see:

```
telemanas/summary/2026-03-20.ndjson
telemanas/facilities/2026-03-20.ndjson
```

To download and inspect a file:

```bash
npx wrangler r2 object get tele-manas-data/telemanas/summary/2026-03-20.ndjson --file /tmp/summary.ndjson
cat /tmp/summary.ndjson
```

---

## PostHog ingestion from R2

PostHog connects to R2 using Cloudflare's S3-compatible API. You need three things before starting: your **Cloudflare Account ID**, an **R2 API token**, and the **bucket name** (`tele-manas-data`).

### Step 1 — Find your Cloudflare Account ID

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Select any domain (or the main account page)
3. In the right-hand sidebar under **Account ID**, copy the 32-character hex string

Your R2 endpoint URL will be:
```
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

### Step 2 — Create an R2 API token

1. In the Cloudflare dashboard, go to **R2 → Manage R2 API Tokens**
2. Click **Create API Token**
3. Set **Permissions** to **Object Read Only**
4. Under **Specify bucket**, select **tele-manas-data** only (principle of least privilege)
5. Click **Create API Token**
6. Copy the **Access Key ID** and **Secret Access Key** — you won't see the secret again

### Step 3 — Add the data source in PostHog

1. In PostHog, go to **Data pipeline → Sources**
2. Click **New source** → choose **S3** (Cloudflare R2 uses the S3 protocol)
3. Fill in the form:

| Field | Value |
|---|---|
| **Display name** | `tele_manas_summary` |
| **Bucket** | `tele-manas-data` |
| **Bucket region** | `auto` |
| **Path prefix** | `telemanas/summary/` |
| **File format** | NDJSON |
| **Endpoint URL** | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| **Access Key ID** | (from Step 2) |
| **Secret Access Key** | (from Step 2) |

4. Click **Test connection** — PostHog will list the files it finds
5. Click **Next** and review the inferred schema. Column names will match the NDJSON keys exactly (`captured_at`, `total_calls`, `page_views`, `cells_tmc`, `cells_mi`, `cells_rcc`, `facility_count`, `state_count`)
6. Click **Import** to finish

### Step 4 — Add the facilities table

Repeat Step 3 with a second source:

| Field | Value |
|---|---|
| **Display name** | `tele_manas_facilities` |
| **Bucket** | `tele-manas-data` |
| **Bucket region** | `auto` |
| **Path prefix** | `telemanas/facilities/` |
| **File format** | NDJSON |
| **Endpoint URL** | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| **Access Key ID** | (same token from Step 2) |
| **Secret Access Key** | (same token from Step 2) |

The facilities table schema: `captured_at`, `id`, `tmc_id`, `type`, `name`, `state`, `state_id`, `city`, `status`, `active_counsellors`, `mhp`, `mentoring_institute`, `rcc`.

### Step 5 — Trigger the first sync

PostHog syncs on a schedule after the source is added. To run it immediately:

1. Go to **Data pipeline → Sources**
2. Find `tele_manas_summary` → click the three-dot menu → **Sync now**
3. Repeat for `tele_manas_facilities`

### Step 6 — Query in PostHog

Once the sync completes, both tables are queryable in **Data pipeline → Data warehouse** (or via SQL in any PostHog insight using the HogQL editor):

```sql
-- Total calls over time
SELECT captured_at, total_calls, page_views
FROM tele_manas_summary
ORDER BY captured_at

-- Active counsellors per facility type over time
SELECT captured_at, type, sum(active_counsellors) AS total_counsellors
FROM tele_manas_facilities
GROUP BY captured_at, type
ORDER BY captured_at, type

-- Facilities by state with counsellor count
SELECT state, count(*) AS facilities, sum(active_counsellors) AS counsellors
FROM tele_manas_facilities
WHERE captured_at = (SELECT max(captured_at) FROM tele_manas_facilities)
GROUP BY state
ORDER BY counsellors DESC
```

New daily files are picked up automatically on each scheduled sync without any configuration changes.

---

## What I'd improve with more time

**Authenticated endpoints.** The most valuable data — district-level call breakdowns and per-facility call logs — sits behind the login wall. Authenticating programmatically is feasible (the login sequence uses `genSalt/` + `loginj` with a captcha) but out of scope for a read-only public data collector.

**Change detection.** We write even if nothing changed since the last run. Once there's months of history, it'd be cheap to compare `total_calls` against the previous file before writing. Not worth the extra R2 read now.

**Schema versioning.** If the API response shape changes, old and new rows will mix in PostHog with no marker. A `schema_version` field on each row would make future migrations straightforward.

**Backfill.** The API only exposes current totals — there's no historical endpoint. We lose everything before the first run.
