import assert from "node:assert/strict";

import {
  buildPolymarketSourceRepair,
  hasSafeResolutionOutcome,
  resolveDflowOutcome,
  resolveLimitlessOutcome,
  resolvePolymarketGammaOutcome,
} from "./services/market-resolution-outcomes.js";

{
  const outcome = resolvePolymarketGammaOutcome({
    outcomePrices: '["1","0"]',
    closed: true,
  });
  assert.equal(outcome.resolvedOutcome, "YES");
  assert.equal(outcome.resolvedOutcomePct, null);
  assert.equal(hasSafeResolutionOutcome(outcome), true);
}

{
  const source = buildPolymarketSourceRepair({
    acceptingOrders: false,
    active: false,
    archived: false,
    closed: true,
    outcomePrices: ["1", "0"],
    resolutionSource: "uma",
    resolvedBy: "0xabc",
  });
  assert.equal(source.accepting_orders, false);
  assert.equal(source.active, false);
  assert.equal(source.closed, true);
  assert.equal(source.outcome_prices, '["1","0"]');
  assert.equal(source.resolution_source, "uma");
  assert.equal(source.resolved_by, "0xabc");
}

{
  const outcome = resolvePolymarketGammaOutcome({
    outcomePrices: ["0", "1"],
    closed: true,
  });
  assert.equal(outcome.resolvedOutcome, "NO");
}

{
  const outcome = resolvePolymarketGammaOutcome({
    outcomePrices: '["0.5","0.5"]',
    closed: true,
  });
  assert.equal(outcome.resolvedOutcome, null);
  assert.equal(hasSafeResolutionOutcome(outcome), false);
}

{
  const outcome = resolvePolymarketGammaOutcome({
    outcomePrices: '["0.998","0.002"]',
    closed: true,
  });
  assert.equal(outcome.resolvedOutcome, null);
}

{
  const outcome = resolvePolymarketGammaOutcome({
    closed: true,
  });
  assert.equal(outcome.resolvedOutcome, null);
}

{
  assert.equal(
    resolveLimitlessOutcome({ winningOutcomeIndex: 0 }).resolvedOutcome,
    "YES",
  );
  assert.equal(
    resolveLimitlessOutcome({ winningOutcomeIndex: "1" }).resolvedOutcome,
    "NO",
  );
  assert.equal(
    resolveLimitlessOutcome({ winningOutcomeIndex: 2 }).resolvedOutcome,
    null,
  );
}

{
  assert.equal(resolveDflowOutcome({ result: "yes" }).resolvedOutcome, "YES");
  assert.equal(resolveDflowOutcome({ result: "NO" }).resolvedOutcome, "NO");
}

{
  const outcome = resolveDflowOutcome({
    result: "scalar",
    scalarOutcomePct: "0.42",
  });
  assert.equal(outcome.resolvedOutcome, null);
  assert.equal(outcome.resolvedOutcomePct, 0.42);
}

{
  const outcome = resolveDflowOutcome({
    result: "scalar",
  });
  assert.equal(outcome.resolvedOutcome, null);
  assert.equal(outcome.resolvedOutcomePct, null);
}

{
  const outcome = resolveDflowOutcome({
    extra: JSON.stringify({
      result: "scalar",
      accounts: {
        yes: { scalarOutcomePct: 0.75 },
        no: { scalarOutcomePct: 0.75 },
      },
    }),
  });
  assert.equal(outcome.resolvedOutcome, null);
  assert.equal(outcome.resolvedOutcomePct, 0.75);
}

{
  const outcome = resolveDflowOutcome({
    account: JSON.stringify({
      extra: JSON.stringify({
        result: "yes",
      }),
    }),
  });
  assert.equal(outcome.resolvedOutcome, "YES");
}
