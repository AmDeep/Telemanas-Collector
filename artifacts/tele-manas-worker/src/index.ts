import { fetchSnapshot } from "./snapshot";
import { saveToR2 } from "./storage";
import { ping } from "./api";

export interface Env {
  TELE_MANAS_BUCKET: R2Bucket;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(run(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/health") {
      return handleHealth(env);
    }

    if (pathname === "/trigger") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return handleTrigger(env);
    }

    return new Response(
      "Tele MANAS collector\n" +
        "  GET  /health   — liveness + dependency check\n" +
        "  POST /trigger  — run a collection immediately\n",
      { status: 200 }
    );
  },
} satisfies ExportedHandler<Env>;

async function run(env: Env): Promise<void> {
  const snapshot = await fetchSnapshot();
  await saveToR2(env.TELE_MANAS_BUCKET, snapshot);
}

async function handleTrigger(env: Env): Promise<Response> {
  try {
    const snapshot = await fetchSnapshot();
    const result = await saveToR2(env.TELE_MANAS_BUCKET, snapshot);
    return Response.json({
      ok: true,
      capturedAt: snapshot.capturedAt,
      totalCalls: snapshot.totalCalls,
      summaryKey: result.summaryKey,
      orgsKey: result.orgsKey,
      orgRows: result.orgRows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

async function handleHealth(env: Env): Promise<Response> {
  const [api, r2] = await Promise.all([
    checkApi(),
    checkR2(env.TELE_MANAS_BUCKET),
  ]);

  const ok = api.ok && r2.ok;
  return Response.json({ ok, api, r2 }, { status: ok ? 200 : 503 });
}

async function checkApi(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const { reachable, latencyMs } = await ping();
  return reachable
    ? { ok: true, latencyMs }
    : { ok: false, latencyMs, error: "Tele MANAS API unreachable" };
}

async function checkR2(
  bucket: R2Bucket
): Promise<{ ok: boolean; error?: string }> {
  try {
    // list() with limit=1 is the lightest R2 operation that proves the binding works
    await bucket.list({ limit: 1 });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
