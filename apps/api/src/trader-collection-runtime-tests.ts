import assert from "node:assert/strict";
import {
  traderRedisCommand,
  traderSliceAction,
} from "./services/trader-collection-service.js";

// A ready but blackholed Redis socket must not pin the only active cycle or
// Fastify onClose. A later pass can use a replacement client straight away.
let discarded = 0;
await assert.rejects(
  traderRedisCommand(
    () => new Promise<never>(() => {}),
    () => {
      discarded++;
    },
    5,
  ),
  /trader_cache_timeout/,
);
assert.equal(discarded, 1);
assert.equal(
  await traderRedisCommand(
    async () => "OK",
    () => {
      discarded++;
    },
  ),
  "OK",
);
assert.equal(discarded, 1);

const slice = {
  stopped: false,
  lostLease: false,
  cooling: false,
  remaining: 3,
  ageSeconds: 25,
  attempts: 2,
  selected: 5,
  observed: 2,
};
assert.equal(traderSliceAction(slice), "checkpoint");
assert.equal(traderSliceAction({ ...slice, ageSeconds: 211 }), "publish");
// Budget expiry allows explicitly partial publication, but provider cooldown
// must checkpoint the same work without replacing the previously served version.
assert.equal(
  traderSliceAction({ ...slice, ageSeconds: 211, cooling: true }),
  "checkpoint",
);
assert.equal(
  traderSliceAction({ ...slice, cooling: true, lostLease: true }),
  "retain",
);
assert.equal(traderSliceAction({ ...slice, stopped: true }), "retain");
assert.equal(
  traderSliceAction({ ...slice, remaining: 0, observed: 0 }),
  "retain",
);
assert.equal(
  traderSliceAction({ ...slice, remaining: 0, observed: 5 }),
  "publish",
);
assert.equal(
  traderSliceAction({ ...slice, remaining: 0, observed: 0, selected: 0 }),
  "publish",
);
console.log("OK: trader cache timeouts, recovery and fenced slice decisions");
