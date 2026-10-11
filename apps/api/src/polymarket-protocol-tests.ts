import assert from "node:assert/strict";
import { ethers } from "ethers";

import {
  normalizePolymarketAssetId,
  POLYMARKET_PROTOCOL_CONTRACTS,
  polymarketV2ConditionIdToBytes31,
  resolvePolymarketMarketAssets,
  parsePolymarketMarketAssets,
  readPolymarketIndexedAssets,
} from "@hunch/shared";
import {
  buildPolymarketOrderDomain,
  computePolymarketOrderHashV2,
} from "./services/polymarket-order-hash.js";
import { POLYMARKET_ORDER_TYPE_STRING } from "./services/polymarket-signing-schema.js";

// Public Gamma 5331723 read on 2026-10-05; no user balances/credentials.
const legacyMarket = {
  version: "v1",
  conditionId:
    "0xdaeb69f6671cc915dc6ee135786cd95b7131890283d3f947d11a2e77379f50e5",
  clobTokenIds: JSON.stringify([
    "113370520490507646250500701219384673009095163173294222529417095958546047347489",
    "111670199862512159470046956718951939362587080225073962365419923233163966341385",
  ]),
  outcomes: '["Yes","No"]',
  negRisk: false,
};
const legacy = resolvePolymarketMarketAssets(legacyMarket);
assert.equal(legacy.assetKind, "ctf");
assert.equal(legacy.exchangeAddress, POLYMARKET_PROTOCOL_CONTRACTS.exchangeV2);
assert.equal(legacy.orderDomainVersion, "2");
assert.equal(legacy.assets[0], JSON.parse(legacyMarket.clobTokenIds)[0]);
assert.equal(
  resolvePolymarketMarketAssets({ ...legacyMarket, negRisk: true })
    .exchangeAddress,
  POLYMARKET_PROTOCOL_CONTRACTS.negRiskExchangeV2,
);
// V2 metadata fixture is synthetic; do not claim live V2 trade acceptance.
const v2Market = {
  ...legacyMarket,
  version: "v2",
  conditionId: ethers.toBeHex((1n << 248n) | (0xabn << 120n), 32),
  positionIds: [
    ((1n << 248n) | (0xabn << 120n)).toString(),
    ((1n << 248n) | (0xabn << 120n) | 1n).toString(),
  ],
  outcomes: '["Norway","Wales"]',
};
const v2 = resolvePolymarketMarketAssets(v2Market);
assert.deepEqual(parsePolymarketMarketAssets(v2), v2);
assert.equal(
  parsePolymarketMarketAssets({
    ...v2,
    positionContract: legacy.positionContract,
  }),
  null,
);
assert.deepEqual(
  readPolymarketIndexedAssets(v2Market).assetIds,
  v2Market.positionIds,
);
assert.deepEqual(
  readPolymarketIndexedAssets({ ...v2Market, version: undefined }).assetIds,
  [],
);
assert.deepEqual(
  readPolymarketIndexedAssets({ ...v2Market, version: "v3" }).assetIds,
  [],
);
assert.deepEqual(
  readPolymarketIndexedAssets({ ...legacyMarket, version: undefined }).assetIds,
  legacy.assets,
);
assert.deepEqual(v2.assets, v2Market.positionIds);
assert.deepEqual(v2.outcomes, ["Norway", "Wales"]);
assert.equal(v2.assetKind, "position_manager");
assert.equal(
  v2.positionContract,
  POLYMARKET_PROTOCOL_CONTRACTS.positionManager,
);
assert.equal(v2.exchangeAddress, POLYMARKET_PROTOCOL_CONTRACTS.exchangeV3);
assert.equal(v2.orderDomainVersion, "3");
assert.equal(v2.conditionalAssetType, "CONDITIONAL-V2");
assert.deepEqual(
  resolvePolymarketMarketAssets({ ...v2Market, version: "v1" }).assets,
  legacy.assets,
  "explicit v1 must select clobTokenIds even when positionIds exist",
);
for (const patch of [
  { version: undefined },
  { version: "v3" },
  { positionIds: [1, 2] },
  { positionIds: '["1","2"]' },
  { positionIds: ["1", "1"] },
  { positionIds: ["1", (1n << 256n).toString()] },
  { outcomes: '["Yes"]' },
  { conditionId: legacyMarket.conditionId },
  { negRisk: "false" },
  { negRisk: true },
  { positionIds: [...v2Market.positionIds].reverse() },
  {
    conditionId: ethers.toBeHex(
      BigInt(v2Market.conditionId) | (137n << 24n),
      32,
    ),
  },
]) {
  assert.throws(() => resolvePolymarketMarketAssets({ ...v2Market, ...patch }));
}
assert.equal(normalizePolymarketAssetId("0001"), "1");
assert.equal(normalizePolymarketAssetId(Number.MAX_SAFE_INTEGER + 1), null);
assert.equal(normalizePolymarketAssetId("1e18"), null);
assert.equal(normalizePolymarketAssetId("9".repeat(100_000)), null);
assert.equal(
  polymarketV2ConditionIdToBytes31(v2Market.conditionId),
  v2Market.conditionId.slice(0, -2),
);
assert.throws(() => polymarketV2ConditionIdToBytes31(`0x00${"ab".repeat(31)}`));

// Golden checked against deployed ExchangeV3 hashOrder() view, 2026-10-05.
const zeroAddress = ethers.ZeroAddress;
const zeroBytes32 = ethers.ZeroHash;
const goldenOrder = {
  salt: "1",
  maker: zeroAddress,
  signer: zeroAddress,
  tokenId: "1",
  makerAmount: "1000000",
  takerAmount: "2000000",
  side: 0,
  signatureType: 3,
  timestamp: "1791220000",
  metadata: zeroBytes32,
  builder: zeroBytes32,
};
assert.equal(
  ethers.id(POLYMARKET_ORDER_TYPE_STRING),
  "0xbb86318a2138f5fa8ae32fbe8e659f8fcf13cc6ae4014a707893055433818589",
);
assert.equal(
  ethers.TypedDataEncoder.hashDomain(
    buildPolymarketOrderDomain(v2.exchangeAddress, "3"),
  ),
  "0x466c63910185bbd55e8679264200c4e0abdcbb0c6264eb3d41d13326022e095b",
);
assert.equal(
  computePolymarketOrderHashV2({
    exchangeAddress: v2.exchangeAddress,
    orderDomainVersion: "3",
    order: goldenOrder,
  }),
  "0x529d440652102e5d9aea11536d90c0a43148fc1dc7e80c525de83cd0cfe14040",
);
assert.throws(
  () => buildPolymarketOrderDomain(v2.exchangeAddress),
  /does not match/,
);
assert.throws(
  () => buildPolymarketOrderDomain(legacy.exchangeAddress, "3"),
  /does not match/,
);
assert.doesNotThrow(() => buildPolymarketOrderDomain(legacy.exchangeAddress));
console.log(
  "[polymarket-protocol-tests] asset selection, domain and deployed golden passed",
);
