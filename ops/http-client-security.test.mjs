import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

// Bun substitutes its native undici shim (without MockAgent). These tests
// exercise the actual npm packages under Node, not Bun's separate implementation.
for (const [label, manifest] of [
  ["undici 7", "../package.json"],
  ["undici 6", "../apps/indexer-polymarket/package.json"],
]) {
  test(
    `${label} preserves custom TLS verification in origin pools`,
    { skip: Boolean(process.versions.bun) },
    async () => {
      const { Agent, MockAgent, request } = createRequire(
        new URL(manifest, import.meta.url),
      )("undici");
      const mockAgent = new MockAgent();
      mockAgent.disableNetConnect();
      const checkServerIdentity = () => new Error("test pin rejected");
      let preserved = false;
      const agent = new Agent({
        tls: { checkServerIdentity },
        factory: (origin, options) => {
          preserved = options?.tls?.checkServerIdentity === checkServerIdentity;
          const pool = mockAgent.get(String(origin));
          pool.intercept({ path: "/" }).reply(200, "ok");
          return pool;
        },
      });
      try {
        const response = await request("https://dependency-smoke.invalid/", {
          dispatcher: agent,
        });
        assert.equal(await response.body.text(), "ok");
        assert.equal(preserved, true);
      } finally {
        await agent.close();
        await mockAgent.close();
      }
    },
  );
}
