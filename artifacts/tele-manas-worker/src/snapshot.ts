import {
  getCallCount,
  getPageViews,
  getTmcCount,
  getStates,
  getOrgs,
  type OrgEntry,
  type State,
} from "./api";

export interface Snapshot {
  capturedAt: string;
  totalCalls: number;
  pageViews: number;
  cells: {
    tmc: number;
    mi: number;
    rcc: number;
  };
  states: State[];
  orgs: OrgEntry[];
}

function parseCount(raw: string, label: string): number {
  const n = parseInt(raw.trim(), 10);
  if (isNaN(n)) throw new Error(`${label}: expected integer, got ${JSON.stringify(raw)}`);
  return n;
}

function requireArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}: expected non-empty array, got ${JSON.stringify(value)}`);
  }
  return value as T[];
}

export async function fetchSnapshot(): Promise<Snapshot> {
  const [callCount, pageViews, tmcCount, states, orgs] = await Promise.all([
    getCallCount(),
    getPageViews(),
    getTmcCount(),
    getStates(),
    getOrgs(),
  ]);

  return {
    capturedAt: new Date().toISOString(),
    totalCalls: parseCount(callCount.Total_Calls, "Total_Calls"),
    pageViews: parseCount(pageViews.PageViews, "PageViews"),
    cells: {
      tmc: parseCount(tmcCount.TMC, "TMC"),
      mi: parseCount(tmcCount.MI, "MI"),
      rcc: parseCount(tmcCount.RCC, "RCC"),
    },
    states: requireArray<State>(states, "states"),
    orgs: requireArray<OrgEntry>(orgs, "orgs"),
  };
}
