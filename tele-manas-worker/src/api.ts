/**
 * API client for the Tele MANAS REST backend.
 *
 * The public dashboard at https://telemanas.mohfw.gov.in/telemanas-dashboard/#/
 * is an Angular SPA — its HTML contains no data. All metrics come from
 * unauthenticated JSON endpoints discovered by extracting URLs from the
 * compiled JavaScript bundle the dashboard loads.
 *
 * Public endpoints (no auth, confirmed working):
 *   /rest/v0/getCallCount            — cumulative total calls
 *   /rest/v0/getPageviews            — cumulative page views
 *   /rest/v0/getTMCcount/TMC         — facility counts by type (TMC/MI/RCC)
 *   /rest/v0/getStates               — all 36 states/UTs with IDs
 *   /rest/v0/getTMC/{stateId}/{type} — rich facility data (28 fields)
 *                                       type: TMC | MI | RCC
 *                                       stateId: 0 = all states
 *
 * Also present in the bundle but require a Bearer token (not public):
 *   /rest/districtReport/{date}      — district-level report (auth)
 *   /rest/orgReport/{date}           — org-level report (auth)
 *   /rest/getAgeCount/{stateId}      — age breakdown (auth, returns 404 unauthenticated)
 *   /rest/getLast7daysCount/{id}     — 7-day trend (auth, returns 404 unauthenticated)
 *
 * Note: /rest/v0/getOrg/{type} is an older, simplified version of getTMC that
 * returns only {stateName, name, count} where count is always null. getTMC is
 * strictly richer and should be preferred.
 */

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

export type OrgType = "TMC" | "MI" | "RCC";

export interface Facility {
  id: number;
  tmcId: string;
  type: OrgType;
  tmcName: string;
  stateId: number;
  state: string;
  city: string;
  status: string;
  mhp: string | null;
  activeCounsellors: string | null;
  mentoringInstitute: string | null;
  rcc: string | null;
  // Note: address, email, phoneNumber, adminIncharge, adminContact,
  // x, y (SVG coords), and social media fields also exist in the response
  // but are omitted here — they are operational/UI details, not analytics.
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with a hard timeout and exponential-backoff retry.
 * Retrying at the call level means one slow endpoint does not hold up the others.
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
        await sleep(1000 * 2 ** (attempt - 1)); // 1s, then 2s
      }
    }
  }

  throw lastErr;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetchWithRetry(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const getCallCount  = (): Promise<CallCount>  => get<CallCount>("/getCallCount");
export const getPageViews  = (): Promise<PageViews>  => get<PageViews>("/getPageviews");
export const getTmcCount   = (): Promise<TmcCount>   => get<TmcCount>("/getTMCcount/TMC");
export const getStates     = (): Promise<State[]>    => get<State[]>("/getStates");
export const getFacilities = (type: OrgType): Promise<Facility[]> =>
  get<Facility[]>(`/getTMC/0/${type}`);

/** Reachability check — hits the cheapest endpoint. */
export async function ping(): Promise<{ reachable: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    const res = await fetchWithRetry(`${BASE}/getCallCount`);
    return { reachable: res.ok, latencyMs: Date.now() - start };
  } catch {
    return { reachable: false, latencyMs: Date.now() - start };
  }
}
