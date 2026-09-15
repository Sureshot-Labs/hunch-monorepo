import assert from "node:assert/strict";
import {
  telegramFundingUnavailableLines,
  telegramDepositShortfallLines,
  telegramQuoteFailureCopy,
} from "./services/telegram-funding-unavailable-copy.js";

const text = telegramFundingUnavailableLines({
  venue: "Polymarket",
  reasonCodes: ["funding_planner_provider_unavailable"],
  balance: {
    requiredUsd: "1.049602",
    availableUsd: "0",
    shortfallUsd: "1.049602",
  },
}).join("\n");
assert.match(text, /1\.049602 including fees/);
assert.match(text, /Available there: \$0/);
assert.match(text, /not necessarily an amount you need to deposit/);
assert.match(text, /adding funds is not a verified solution/);
assert.doesNotMatch(text, /needs native gas/);
const unknown = telegramFundingUnavailableLines({
  venue: "Limitless",
  reasonCodes: [],
}).join("\n");
assert.doesNotMatch(unknown, /\$/);
assert.match(unknown, /Nothing was submitted/);

const deposited = telegramDepositShortfallLines({
  venue: "Polymarket",
  balance: {
    requiredUsd: "1.049962",
    availableUsd: "1",
    shortfallUsd: "0.049962",
  },
}).join("\n");
assert.match(deposited, /Required on Polymarket: \$1\.049962/);
assert.match(deposited, /Available there: \$1\./);
assert.match(deposited, /Shortfall: \$0\.049962/);
assert.match(deposited, /price-movement allowance/);
assert.doesNotMatch(
  telegramDepositShortfallLines({ venue: "Polymarket" }).join("\n"),
  /\$/,
);
assert.match(
  telegramQuoteFailureCopy("market_orderbook_unavailable").lines.join(" "),
  /Adding funds will not fix/,
);
assert.doesNotMatch(
  telegramQuoteFailureCopy("venue_request_failed").heading,
  /Market is currently unavailable/,
);
assert.match(
  telegramQuoteFailureCopy("quote_expired").heading,
  /Quote expired/,
);
assert.match(
  telegramQuoteFailureCopy("market_not_orderable").heading,
  /not accepting orders/,
);
assert.doesNotMatch(
  telegramQuoteFailureCopy("market_orderbook_unavailable").lines.join(" "),
  /market.*closed/i,
);
assert.match(
  telegramQuoteFailureCopy("venue_request_failed").lines.join(" "),
  /Nothing was submitted/,
);

// RelayFirstSourcePlanner normalizes a thrown provider_unavailable to this code.
for (const reason of [
  "provider_status_unknown",
  "provider_unavailable",
  "funding_planner_provider_unavailable",
]) {
  const unavailable = telegramFundingUnavailableLines({
    venue: "Polymarket",
    reasonCodes: ["insufficient_gas", reason, "insufficient_liquidity"],
  }).join("\n");
  assert.match(unavailable, /network or route check did not complete/);
  assert.doesNotMatch(unavailable, /needs native gas/);
  assert.doesNotMatch(unavailable, /\$/);
}
