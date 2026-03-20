import type { Snapshot } from "./snapshot";

/**
 * PostHog's data warehouse ingests R2 files using DuckDB, which reads NDJSON
 * with a wildcard URL pattern (e.g. telemanas/summary/*.ndjson).
 *
 * We write two separate tables so PostHog can query them independently:
 *
 *   telemanas/summary/YYYY-MM-DD.ndjson   — one flat row per run
 *   telemanas/orgs/YYYY-MM-DD.ndjson      — one row per TMC facility per run
 *
 * One file per day keeps the object count low and makes the wildcard pattern
 * predictable. Writes are idempotent: running twice on the same day overwrites
 * the file, which avoids the read-modify-write race that append patterns create.
 *
 * Column names use snake_case since PostHog exposes them as table columns.
 */

export interface SummaryRow {
  captured_at: string;
  total_calls: number;
  page_views: number;
  cells_tmc: number;
  cells_mi: number;
  cells_rcc: number;
  org_count: number;
  state_count: number;
}

export interface OrgRow {
  captured_at: string;
  state_name: string;
  org_name: string;
  call_count: number | null;
}

export interface WriteResult {
  summaryKey: string;
  orgsKey: string;
  orgRows: number;
}

function toNdjson(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

export async function saveToR2(
  bucket: R2Bucket,
  snapshot: Snapshot
): Promise<WriteResult> {
  const date = snapshot.capturedAt.slice(0, 10); // "YYYY-MM-DD"

  const summary: SummaryRow = {
    captured_at: snapshot.capturedAt,
    total_calls: snapshot.totalCalls,
    page_views: snapshot.pageViews,
    cells_tmc: snapshot.cells.tmc,
    cells_mi: snapshot.cells.mi,
    cells_rcc: snapshot.cells.rcc,
    org_count: snapshot.orgs.length,
    state_count: snapshot.states.length,
  };

  const orgRows: OrgRow[] = snapshot.orgs.map((org) => ({
    captured_at: snapshot.capturedAt,
    state_name: org.stateName,
    org_name: org.name,
    call_count: org.count,
  }));

  const summaryKey = `telemanas/summary/${date}.ndjson`;
  const orgsKey = `telemanas/orgs/${date}.ndjson`;

  const opts = { httpMetadata: { contentType: "application/x-ndjson" } };

  await Promise.all([
    bucket.put(summaryKey, toNdjson([summary]), opts),
    bucket.put(orgsKey, toNdjson(orgRows), opts),
  ]);

  return { summaryKey, orgsKey, orgRows: orgRows.length };
}
