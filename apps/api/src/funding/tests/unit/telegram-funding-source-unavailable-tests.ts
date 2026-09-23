#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { FundingReceiveReceipt } from "../../domain/types.js";
import {
  buildTelegramFundingProgressMessage,
  buildTelegramFundingReceiptStatusMessage,
} from "../../../services/telegram-funding-presentation.js";
import type { TelegramFundingProgressProjection } from "../../../services/telegram-funding-contracts.js";
import {
  parseTelegramFundingProgressProjection,
  refineRetainedTerminalForUnavailableSource,
} from "../../../services/telegram-funding-progress.js";
import { telegramPolygonFundingPresentation } from "../../../services/telegram-funding-route.js";

const contextId = "bcd2487e-152a-4edf-88dc-3adfcff96355";
const receipt: FundingReceiveReceipt = {
  receiptId: "12cd2d7f-6073-47b5-8c09-f59a7b40c272",
  receiveSessionId: "c05f17c6-5d53-4cc7-b06c-b23f17e7d25d",
  variantId: "synthetic_sol_usdc",
  asset: {
    networkId: "solana:mainnet",
    assetId: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  },
  destinationAddress: "9xQeWvG816bUx9EPjHmaT23yvVMZq4XFmYdWkP3vZC8V",
  rawAmount: "2000000",
  observationRevision: "synthetic_observation",
  observedAt: "2026-09-23T10:24:22.000Z",
  status: "recovery_required",
  sourceUnavailable: true,
  handling: "automatic_conversion",
  childFundingOperationId: null,
};

const crossCard = buildTelegramFundingReceiptStatusMessage({
  contextId,
  venue: "polymarket",
  receipts: [receipt],
});
assert.match(crossCard.text, /not converted/);
assert.doesNotMatch(crossCard.text, /pending|preserved|refunded/i);

const projection: TelegramFundingProgressProjection = {
  version: 2,
  fundingContextId: contextId,
  state: "needs_attention",
  terminal: true,
  presentation: telegramPolygonFundingPresentation("usdce_wrap_automatic"),
  assetSymbol: "USDC",
  rawAmount: "2000000",
  receiveAddress: null,
  expiresAt: "2026-09-23T12:00:00.000Z",
  observedAt: receipt.observedAt,
  sourceUnavailable: true,
};
assert.deepEqual(
  parseTelegramFundingProgressProjection(projection),
  projection,
);
const message = buildTelegramFundingProgressMessage(projection);
assert.match(message.text, /not converted/);
assert.doesNotMatch(message.text, /preserved|needs review|pending/i);
assert.equal(
  parseTelegramFundingProgressProjection({
    ...projection,
    sourceUnavailable: false,
  }),
  null,
  "false cannot silently serialize as an unknown terminal flag",
);

const retained: TelegramFundingProgressProjection = {
  version: 2,
  fundingContextId: contextId,
  state: "expired",
  terminal: true,
  presentation: projection.presentation,
  assetSymbol: projection.assetSymbol,
  rawAmount: projection.rawAmount,
  receiveAddress: null,
  expiresAt: projection.expiresAt,
  observedAt: projection.observedAt,
  returnToMarketAvailable: true,
};
const refined = refineRetainedTerminalForUnavailableSource(retained, {
  ...projection,
  assetSymbol: "USDC",
  rawAmount: "210731",
});
assert.deepEqual(refined, {
  ...retained,
  state: "needs_attention",
  sourceUnavailable: true,
  assetSymbol: "USDC",
  rawAmount: "210731",
  observedAt: projection.observedAt,
});
assert.ok(refined);
assert.match(
  buildTelegramFundingProgressMessage(refined).text,
  /not converted/,
);
assert.deepEqual(
  buildTelegramFundingProgressMessage(refined).reply_markup,
  buildTelegramFundingProgressMessage(retained).reply_markup,
  "copy-only terminal refinement must preserve the existing navigation actions",
);
assert.equal(
  refineRetainedTerminalForUnavailableSource(
    { ...retained, state: "ready" },
    projection,
  ),
  null,
  "a successful Buy terminal cannot be demoted",
);
assert.equal(
  refineRetainedTerminalForUnavailableSource(
    { ...retained, state: "unavailable" },
    projection,
  ),
  null,
  "a security-redacted terminal remains absorbing",
);
assert.equal(
  refineRetainedTerminalForUnavailableSource(
    { ...retained, receiveAddress: receipt.destinationAddress },
    projection,
  ),
  null,
  "an address-bearing terminal cannot use the copy-only refinement",
);
assert.equal(
  refineRetainedTerminalForUnavailableSource(retained, {
    ...projection,
    fundingContextId: "2acd2d7f-6073-47b5-8c09-f59a7b40c272",
  }),
  null,
  "a different context cannot replace the retained card",
);
