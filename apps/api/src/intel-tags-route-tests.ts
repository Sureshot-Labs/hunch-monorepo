import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { DbQuery } from "./db.js";
import { createHunchesRoutes } from "./routes/hunches.js";
import { intelTagFixture } from "./intel-tags-test-fixtures.js";
import { classifyIntelTags } from "./services/intel-tags.js";
import {
  INTEL_TAG_NOTES_SQL,
  INTEL_TAG_BASELINES_SQL,
} from "./services/intel-tags-loader.js";
const f = intelTagFixture();
const row = {
  ...f.note,
  title: "A trader holds NO",
  description: "Saved research",
  updated_at: f.note.created_at,
  market_title: "No agreement",
  market_venue: "limitless",
  market_outcomes: '["Yes","No"]',
  market_image: null,
  event_id: "event",
  event_title: "Specific event",
  market_status: "ACTIVE",
  close_time: null,
  expiration_time: null,
  event_status: "ACTIVE",
  event_end_time: null,
  pm_accepting_orders: null,
  resolved_outcome: "NO",
  market_metadata: {},
  market_updated_at: f.note.created_at,
  current_price: null,
  current_price_as_of: null,
};
let failing = true,
  tagReads = 0;
const sqlCalls: string[] = [];
const db = {
  query: async (sql: string) => {
    sqlCalls.push(sql);
    if (sql === INTEL_TAG_NOTES_SQL) {
      tagReads++;
      if (failing) throw Error("temporary enrichment failure");
      return { rows: [{ ...f.note, ...f.market }] };
    }
    if (sql === INTEL_TAG_BASELINES_SQL) return { rows: [f.baseline] };
    if (sql.includes("wallet_profiles")) return { rows: [] };
    return { rows: [row] };
  },
} as unknown as DbQuery;
const app = Fastify();
app.setSerializerCompiler(serializerCompiler);
app.setValidatorCompiler(validatorCompiler);
await app.register(createHunchesRoutes(db, f));
try {
  const first = await app.inject("/hunches");
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json().items[0].tags, []);
  failing = false;
  const recovered = await app.inject("/hunches");
  assert.equal(recovered.statusCode, 200);
  const item = recovered.json().items[0],
    expected = classifyIntelTags(f);
  for (const key of ["tags", "primaryTag", "tagsVersion"] as const)
    assert.deepEqual(item[key], expected[key]);
  assert.equal(item.headline, row.title);
  assert.equal(item.summary, row.description);
  assert.equal(item.market.title, row.market_title);
  assert.equal(item.selectedSideResult, "WIN");
  assert.equal(item.noteId, row.id);
  assert.equal(recovered.json().total, 1);
  assert.equal(tagReads, 2, "failed enrichment was not cached");
  await app.inject("/hunches");
  assert.equal(tagReads, 2, "successful page retains existing short cache");
  const detail = await app.inject(`/hunches/${f.note.id}`);
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.json().item, { ...item, holders: [] });
  for (const url of [
    "/hunches?limit=101",
    "/hunches?window=latest",
    "/hunches/not-a-uuid",
  ])
    assert.equal((await app.inject(url)).statusCode, 400);
  assert.ok(sqlCalls.every((sql) => !/\b(insert|delete|update)\s/i.test(sql)));
  console.log(
    "Intel HTTP: additive serialization, list/detail parity, cache recovery and validation passed",
  );
} finally {
  await app.close();
}
