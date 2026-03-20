import type { Snapshot, } from "./snapshot";
import type { Facility } from "./api";

/**
 * Writes two NDJSON files to R2 per collection run — one per PostHog table:
 *
 *   telemanas/summary/YYYY-MM-DD.ndjson      — one flat row (totals + counts)
 *   telemanas/facilities/YYYY-MM-DD.ndjson   — one row per facility (TMC + MI + RCC)
 *
 * Writes are atomic and idempotent: bucket.put() overwrites the same-day file
 * on reruns rather than appending, which avoids the read-modify-write race that
 * an append strategy creates.
 *
 * PostHog setup — configure two data warehouse sources pointing at:
 *   telemanas/summary/*.ndjson        (one row per day)
 *   telemanas/facilities/*.ndjson     (N rows per day, one per facility)
 *
 * Column names use snake_case since PostHog exposes them as table column names.
 */

export interface SummaryRow {
  captured_at: string;
  total_calls: number;
  page_views: number;
  cells_tmc: number;
  cells_mi: number;
  cells_rcc: number;
  facility_count: number;
  state_count: number;
}

export interface FacilityRow {
  captured_at: string;
  id: number;
  tmc_id: string;
  type: string;
  name: string;
  state: string;
  state_id: number;
  city: string;
  status: string;
  active_counsellors: number | null;
  mhp: number | null;
  mentoring_institute: string | null;
  rcc: string | null;
}

export interface WriteResult {
  summaryKey: string;
  facilitiesKey: string;
  facilityRows: number;
}

function toNdjson(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function parseIntOrNull(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = parseInt(value, 10);
  return isNaN(n) ? null : n;
}

function toFacilityRow(f: Facility, capturedAt: string): FacilityRow {
  return {
    captured_at:         capturedAt,
    id:                  f.id,
    tmc_id:              f.tmcId,
    type:                f.type,
    name:                f.tmcName,
    state:               f.state,
    state_id:            f.stateId,
    city:                f.city,
    status:              f.status,
    active_counsellors:  parseIntOrNull(f.activeCounsellors),
    mhp:                 parseIntOrNull(f.mhp),
    mentoring_institute: f.mentoringInstitute ?? null,
    rcc:                 f.rcc ?? null,
  };
}

export async function saveToR2(
  bucket: R2Bucket,
  snapshot: Snapshot
): Promise<WriteResult> {
  const date = snapshot.capturedAt.slice(0, 10); // "YYYY-MM-DD"

  const summary: SummaryRow = {
    captured_at:    snapshot.capturedAt,
    total_calls:    snapshot.totalCalls,
    page_views:     snapshot.pageViews,
    cells_tmc:      snapshot.cells.tmc,
    cells_mi:       snapshot.cells.mi,
    cells_rcc:      snapshot.cells.rcc,
    facility_count: snapshot.facilities.length,
    state_count:    snapshot.states.length,
  };

  const facilityRows: FacilityRow[] = snapshot.facilities.map((f) =>
    toFacilityRow(f, snapshot.capturedAt)
  );

  const summaryKey    = `telemanas/summary/${date}.ndjson`;
  const facilitiesKey = `telemanas/facilities/${date}.ndjson`;
  const opts = { httpMetadata: { contentType: "application/x-ndjson" } };

  await Promise.all([
    bucket.put(summaryKey,    toNdjson([summary]),    opts),
    bucket.put(facilitiesKey, toNdjson(facilityRows), opts),
  ]);

  return { summaryKey, facilitiesKey, facilityRows: facilityRows.length };
}
