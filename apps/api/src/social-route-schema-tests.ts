import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { socialRouteSchemas } from "./schemas/social-routes.js";

await test("offline social contracts cover exactly the runtime registrations", async () => {
  const source = await readFile(
    new URL("./routes/social.ts", import.meta.url),
    "utf8",
  );
  const actual: string[] = [];
  const registrations = source.matchAll(
    /typed\.(get|post|patch|put|delete)\(\s*("[^"]+"|`[^`]+`),\s*\{(?:\s*preHandler: (?:required|optional),)?\s*schema: socialRouteSchemas\.(get|post|patch|put|delete)\[("[^"]+"|`[^`]+`)\]/g,
  );
  for (const registration of registrations) {
    assert.equal(registration[1], registration[3]);
    assert.equal(registration[2], registration[4]);
    const paths = registration[2].includes("${kind}")
      ? ["/users/:id/followers", "/users/:id/following"]
      : [JSON.parse(registration[2]) as string];
    for (const path of paths) actual.push(`${registration[1]} ${path}`);
  }
  assert.equal(actual.length, 29);
  assert.equal(
    [...source.matchAll(/typed\.(get|post|patch|put|delete)\(/g)].length,
    28,
  );
  const contracts = Object.entries(socialRouteSchemas).flatMap(
    ([method, routes]) =>
      Object.entries(routes).map(([path, route]) => {
        assert.ok(route.response[200]);
        for (const status of [400, 401, 403, 404, 409, 429, 500, 503])
          assert.ok(status in route.response);
        return `${method} ${path}`;
      }),
  );
  assert.deepEqual(actual.sort(), contracts.sort());
});
