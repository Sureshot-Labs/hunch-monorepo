// @requires-db
import assert from "node:assert/strict";
import "./integration-test-database-guard.js";
import { buildApp } from "./app.js";
const app = await buildApp();
try {
  await app.ready();
  const spec = app.swagger() as { paths: Record<string, unknown> };
  for (const [path, field] of [
    ["/feed", "representative"],
    ["/market-map/sidebars", "newActivity"],
    ["/discovery/hidden-gems", "researchAskComparison"],
    ["/intel/traders/big-moves", "relatedMoves"],
    ["/social/feed", "previousThesisId"],
  ])
    assert.ok(
      JSON.stringify(spec.paths[path]).includes(`"${field}"`),
      `${path} must declare ${field}`,
    );
  console.log("product quality OpenAPI fields passed");
} finally {
  await app.close();
}
