// Local acceptance harness, never imported by the API or deployed worker.
// Requires explicit disposable targets; no remote credentials/provider calls.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { createIntegrationTestPool } from "./test-database-target.js";
import { mapHip4Market, applyHip4Book } from "./services/hip4-mapping.js";
import {
  persistHip4Market,
  readHip4Policy,
} from "./services/hip4-repository.js";
for (const key of ["DATABASE_URL", "REDIS_URL"]) {
  const target = new URL(process.env[key] ?? "");
  if (
    target.hostname !== "127.0.0.1" ||
    (key === "DATABASE_URL" && !target.pathname.startsWith("/hip4_"))
  )
    throw new Error("local_disposable_target_required");
}
process.env.HUNCH_RUNTIME_SECRETS_LOADED = "1";
process.env.JWT_SECRET = "hip4-disposable-local-browser-fixture-only";
process.env.PRIVY_APP_ID = "hip4-local-fixture";
process.env.PRIVY_APP_SECRET = "hip4-local-fixture";
process.env.ADMIN_AUTH_LEGACY_FALLBACK = "true";
const pool = await createIntegrationTestPool({ max: 2 });
const [
  { AuthService },
  { hip4ReadRoutes },
  { pricesSseRoutes },
  { getRedis },
  { closeAcquiredRuntimeResources },
] = await Promise.all([
  import("./auth.js"),
  import("./routes/hip4-read.js"),
  import("./routes/prices-sse.js"),
  import("./redis.js"),
  import("./runtime-resource-cleanup.js"),
]);
const app = Fastify({ forceCloseConnections: true });
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
const users: string[] = [];
const sessions = new Map<string, string>();
for (const role of ["admin", "member"]) {
  const id = randomUUID();
  users.push(id);
  await pool.query(
    "insert into users(id,display_name,is_admin) values($1,$2,$3)",
    [id, `HIP4 fixture ${role}`, role === "admin"],
  );
  const token = AuthService.generateToken(id);
  await AuthService.createSession(
    id,
    "0x0000000000000000000000000000000000000001",
    token,
  );
  sessions.set(role, token);
}
const policyId = randomUUID();
await pool.query(
  "insert into runtime_policies(id,policy_key,effective_at,payload) values($1,'hip4_read',$2,$3)",
  [
    policyId,
    new Date(Date.now() - 1000),
    JSON.stringify({
      enabled: true,
      outcomeAllowlist: [8775],
      bookMaxAgeMs: 3000,
      policyCheckMs: 1000,
    }),
  ],
);
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
const main = fixture.observations[0];
const seed = async () => {
  const now = Date.now();
  const mapped = mapHip4Market({
    ...main,
    outcome: 8775,
    settlement: null,
    fetchedAt: new Date(now).toISOString(),
    generation: randomUUID(),
  });
  for (const sideIndex of [0, 1] as const)
    mapped.market = applyHip4Book(
      mapped.market,
      sideIndex,
      {
        coin: mapped.market.sides[sideIndex].coin,
        time: now,
        levels: [
          [{ px: sideIndex ? "0.4" : "0.6", sz: "10", n: 1 }],
          [{ px: sideIndex ? "0.42" : "0.62", sz: "10", n: 1 }],
        ],
      },
      now,
      3000,
    );
  await persistHip4Market(pool, {
    ...mapped,
    trades: Array.from({ length: 8 }, (_, index) => ({
      coin: "#87750",
      time: now - (8 - index) * 60000,
      tid: index,
      px: String(0.4 + index / 100),
      sz: "10",
      side: "B" as const,
      hash: "fixture",
    })),
  });
  const redis = await getRedis();
  const { revision } = await readHip4Policy(pool);
  for (const side of mapped.market.sides) {
    const payload = JSON.stringify({
      token_id: side.tokenId,
      best_bid: Number(side.bid),
      best_ask: Number(side.ask),
      ts: now,
      valid_until: new Date(now + 3000).toISOString(),
      policy_revision: revision,
    });
    await redis?.set(`top:${side.tokenId}`, payload, { PX: 3000 });
    await redis?.publish(`prices:${side.tokenId}`, payload);
  }
};
await seed();
await app.register(hip4ReadRoutes);
await app.register(pricesSseRoutes);
app.get<{ Params: { role: string } }>(
  "/__test/login/:role",
  async (request, reply) => {
    const token = sessions.get(request.params.role);
    reply.header(
      "Set-Cookie",
      `hunch_session=${token ?? ""}; HttpOnly; Path=/; SameSite=Lax${token ? "" : "; Max-Age=0"}`,
    );
    return reply.redirect("http://localhost:3014/api/hunch/__test/browser");
  },
);
app.get("/__test/browser", async (request, reply) => {
  const bearer = request.headers.authorization?.replace(/^Bearer /, "");
  const role =
    [...sessions].find(([, token]) => token === bearer)?.[0] ?? "anonymous";
  return reply.type("text/html; charset=utf-8")
    .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HIP4 acceptance</title></head><body style="background:#111;color:#eee;font:18px system-ui;padding:24px"><h1>HIP4 browser → Next → real middleware</h1><p>Disposable synthetic user: ${role}</p><nav><a href="http://localhost:3015/__test/login/admin">Admin</a> · <a href="http://localhost:3015/__test/login/member">Member</a> · <a href="http://localhost:3015/__test/login/logout">Logout</a></nav><p>Local synthetic tick only; no external requests.</p><button id="run" style="margin-top:24px;padding:16px">Run disposable checks</button><pre id="result" style="white-space:pre-wrap"></pre><script>
  document.querySelector('#run').onclick=async()=>{
    const lines=[];const show=()=>document.querySelector('#result').textContent=lines.join('\\n');
    const read=async(path)=>{const response=await fetch('/api/hunch'+path);lines.push(response.status+' '+path+' | '+response.headers.get('cache-control'));show();return response;};
    const response=await read('/markets/hyperliquid/canary');
    if(response.ok){const page=await response.json();const market=page.markets[0];lines.push('market '+market.marketId+'; freshness '+market.sides[0].bookState);show();
      for(const suffix of ['', '/trades','/candles']) await read('/markets/hyperliquid/canary/'+encodeURIComponent(market.marketId)+suffix);
      await read('/markets/hyperliquid/canary/hyperliquid%3Atestnet%3Aoutcome%3A8775');
      await new Promise(resolve=>{const stream=new EventSource('/api/hunch/prices/stream?token_id='+encodeURIComponent(market.sides[0].tokenId));let done=false;const finish=()=>{if(done)return;done=true;stream.close();resolve();};stream.onopen=()=>{lines.push('SSE OPEN (authorized)');show();void fetch('/api/hunch/__test/tick',{method:'POST'});};stream.addEventListener('tick',event=>{const tick=JSON.parse(event.data);lines.push('SSE TICK '+tick.token_id);show();finish();});stream.onerror=()=>{lines.push('SSE ERROR');show();finish();};setTimeout(finish,5000);});
    } else await read('/prices/stream?token_id=hyperliquid%3Amainnet%3A87750');
    lines.push('CHECKS FINISHED');show();
  };
  </script></body></html>`);
});
app.post("/__test/tick", async () => {
  await seed();
  return { ok: true };
});
await app.listen({ host: "127.0.0.1", port: 3015 });
console.log(
  "HIP4 local acceptance API: http://127.0.0.1:3015 (synthetic data, real auth middleware)",
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await app.close();
  await pool.query("delete from runtime_policies where id=$1", [policyId]);
  await pool.query("delete from users where id=any($1::uuid[])", [users]);
  await pool.end();
  await closeAcquiredRuntimeResources();
  // The shared SSE subscriber is process-owned; this disposable harness has no
  // other tasks to keep alive after its explicit DB/session cleanup completes.
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
