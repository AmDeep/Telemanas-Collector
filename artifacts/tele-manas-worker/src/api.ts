const BASE = "https://telemanas.mohfw.gov.in/TELEMANAS/rest/v0";

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

export interface CallCount {
  Total_Calls: string;
}

export interface PageViews {
  PageViews: string;
}

export interface TmcCount {
  TMC: string;
  MI: string;
  RCC: string;
}

export interface State {
  stateid: number;
  stateName: string;
}

export interface OrgEntry {
  stateName: string;
  name: string;
  count: number | null;
}

/**
 * Fetch with a hard timeout and simple exponential-backoff retry.
 *
 * Why retry here rather than at the snapshot level? Each API call is
 * independent and cheap. Retrying the whole snapshot on a single transient
 * failure would waste time and quota.
 *
 * Backoff: 1s → 2s → give up. Three attempts is plenty for a cron job where
 * a failure just means we skip that day's snapshot and try again tomorrow.
 */
async function fetchWithRetry(url: string): Promise<Response> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(1000 * 2 ** (attempt - 1)); // 1s, 2s
      }
    }
  }

  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function get<T>(path: string): Promise<T> {
  const res = await fetchWithRetry(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path} failed: HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getCallCount(): Promise<CallCount> {
  return get<CallCount>("/getCallCount");
}

export async function getPageViews(): Promise<PageViews> {
  return get<PageViews>("/getPageviews");
}

export async function getTmcCount(): Promise<TmcCount> {
  return get<TmcCount>("/getTMCcount/TMC");
}

export async function getStates(): Promise<State[]> {
  return get<State[]>("/getStates");
}

export async function getOrgs(): Promise<OrgEntry[]> {
  return get<OrgEntry[]>("/getOrg/TMC");
}

/** Lightweight reachability check — hits the smallest endpoint. */
export async function ping(): Promise<{ reachable: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    const res = await fetchWithRetry(`${BASE}/getCallCount`);
    return { reachable: res.ok, latencyMs: Date.now() - start };
  } catch {
    return { reachable: false, latencyMs: Date.now() - start };
  }
}
