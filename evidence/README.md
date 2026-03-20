# API Evidence — Tele MANAS REST Endpoints

Snapshots captured from the live backend at `https://telemanas.mohfw.gov.in/TELEMANAS/rest/v0/`
on 2026-03-20.  All calls are unauthenticated (no cookies, no token, just `Accept: application/json`).

## Confirmed public endpoints

| File | Endpoint | Notes |
|---|---|---|
| `callcount.json` | `GET /getCallCount` | Cumulative calls since launch; single key `Total_Calls` |
| `pageviews.json` | `GET /getPageviews` | Cumulative dashboard page-views; single key `PageViews` |
| `tmccount.json` | `GET /getTMCcount/TMC` | Facility counts: `{"TMC":"53","MI":"23","RCC":"5"}` |
| `states.json` | `GET /getStates` | 36 state/UT records with numeric `stateid` and `stateName` |
| `tmc.json` | `GET /getTMC/0/TMC` | 53 TMC facility records with 28 fields each |
| `mi.json` | `GET /getTMC/0/MI` | 23 MI facility records |
| `rcc.json` | `GET /getTMC/0/RCC` | 5 RCC facility records |

## The `getTMC/{stateId}/{type}` endpoint

This is the primary facility data source used by the interactive map on the dashboard.
`stateId = 0` returns all states. State-filtered calls (`stateId = 28` for Andhra Pradesh, etc.)
return the same data filtered to that state.

Key fields returned per facility (28 total):

| Field | Notes |
|---|---|
| `id`, `tmcId`, `type` | Facility identity |
| `tmcName`, `state`, `stateId`, `city` | Location |
| `status` | `"Active"` / `"Inactive"` |
| `activeCounsellors` | Live counsellor headcount — the most important time-series field |
| `mhp` | Mental health professionals on staff |
| `mentoringInstitute` | Which NIMHANS-network institution supervises this facility |
| `rcc` | Parent Regional Collaborating Centre |
| `x`, `y` | SVG map coordinates (not geographic) — not stored |
| Social media fields, `logo`, `address`, `email`, `phoneNumber` | Operational/PR — not stored |

## Superseded endpoint: `/getOrg/{type}`

The bundle also contains calls to `getOrg/TMC`, `getOrg/MI`, `getOrg/RCC`. These return
`{stateName, name, count}` records where `count` is **always null**. They are a simplified
legacy view. The worker does NOT call these — `getTMC/0/{type}` is strictly richer.

## Authenticated endpoints (not collected)

These endpoints are present in the Angular bundle but return HTTP 404 without a Bearer token:

- `GET /rest/districtReport/{date}` — district-level call breakdown
- `GET /rest/orgReport/{date}` — facility-level call log
- `GET /rest/getAgeCount/{stateId}` — caller age distribution
- `GET /rest/getLast7daysCount/{id}` — 7-day rolling trend per facility
- `POST /rest/loginj`, `GET /rest/createCaptcha/`, `GET /rest/genSalt/` — login flow

## robots.txt

The site's `robots.txt` disallows `/*.json$` and `/*.js$` — these rules target
**static asset files** served from the file system, not REST API endpoints.
Our calls to `/rest/v0/…` paths are unaffected.
All data exposed by these endpoints is already publicly visible on the dashboard.

## Note on SSL

The Tele MANAS server uses a certificate not trusted by Node.js's default CA store.
`NODE_TLS_REJECT_UNAUTHORIZED=0` was used for this local evidence run only.
Cloudflare Workers uses its own certificate trust store and handles this correctly
in production — no workaround is needed in the deployed worker.
