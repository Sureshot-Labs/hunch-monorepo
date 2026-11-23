import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readHouseTraderKeyFile,
  readHouseTraderPublicSettings,
} from "./services/house-trader-key-file.js";
import {
  houseReceiptMatchesFinalized,
  houseWithdrawalRecipient,
  houseWithdrawalPreviewMatches,
} from "./services/house-trader-withdrawal.js";
import { ethers } from "ethers";
import {
  buildPolymarketAssetContext,
  DEFAULT_CANONICAL_MARKET_TOP_MAX_AGE_MS,
  POLYMARKET_PROTOCOL_CONTRACTS as contracts,
  resolvePolymarketMarketAssets,
} from "@hunch/shared";
import { signHouseOrder } from "./services/polymarket-order-signature.js";
import { buildPolymarketOrderDomain } from "./services/polymarket-order-hash.js";
import {
  POLYMARKET_ORDER_TYPE_STRING,
  POLYMARKET_TYPED_DATA_SIGN_TYPES,
} from "./services/polymarket-signing-schema.js";
import {
  houseTradeReceipt,
  positionNet,
} from "./services/house-trader-receipts.js";
import {
  adverseEntry,
  costBasisForShares,
  houseDepositSetupRetry,
  houseTraderDefault,
  houseTraderPolicy,
  priceExit,
  usdRaw,
} from "./services/house-trader-policy.js";
import {
  houseValuationContext,
  summarizeHouseValuations,
  valueHousePosition,
} from "./services/house-trader-valuation.js";
import type { PolymarketHoldingMarkRow } from "./services/polymarket-holding-marks.js";

const valuationTime = Date.parse("2026-11-23T12:00:00Z");
const asset = buildPolymarketAssetContext(
  "polymarket:1",
  resolvePolymarketMarketAssets({
    version: "v1",
    conditionId: `0x${"11".repeat(32)}`,
    clobTokenIds: ["100", "101"],
    outcomes: ["Yes", "No"],
  }),
  "101",
);
const noPosition = {
  token_id: "101",
  market_id: "polymarket:1",
  outcome: "NO" as const,
  result: { assetContext: asset },
};
assert.deepEqual(houseValuationContext(noPosition), asset);
assert.equal(houseValuationContext({ ...noPosition, outcome: "YES" }), null);
const currentBid: PolymarketHoldingMarkRow = {
  token_id: "101",
  position_contract: "",
  market_id: "polymarket:1",
  outcome_side: "NO",
  current_token_id: "101",
  top_ts: new Date(valuationTime - 1000),
  best_bid: "0.61",
  best_ask: "0.62",
  mid: "0.615",
  last_price: "0.70",
  resolved_outcome: null,
  resolved_outcome_pct: null,
  status: "ACTIVE",
};
const valueInput = {
  asset,
  shares: 3_000_000n,
  cost: costBasisForShares(4_000_000n, 10_000_000n, 3_000_000n),
  balanceCheckedAt: valuationTime,
  now: valuationTime,
};
const marked = valueHousePosition({ ...valueInput, mark: currentBid });
assert.equal(marked?.source, "best_bid");
assert.equal(marked?.priceRaw, "610000");
assert.equal(marked?.valueRaw, "1830000");
assert.equal(marked.pnlRaw, "630000", "use only the remaining cost basis");
for (const patch of [
  { market_id: "polymarket:2" },
  { outcome_side: "YES" },
  { current_token_id: "201" },
  { best_bid: null },
  { best_bid: "0.70" },
  { top_ts: new Date(valuationTime + 1) },
  { top_ts: new Date(valuationTime - DEFAULT_CANONICAL_MARKET_TOP_MAX_AGE_MS) },
  { status: "CLOSED" },
  { status: "SETTLED" },
] as const) {
  assert.equal(
    valueHousePosition({ ...valueInput, mark: { ...currentBid, ...patch } }),
    null,
  );
}
assert.equal(valueHousePosition({ ...valueInput, mark: undefined }), null);
assert.equal(
  valueHousePosition({ ...valueInput, mark: currentBid, cost: null }),
  null,
);
const loss = valueHousePosition({
  ...valueInput,
  mark: { ...currentBid, status: "SETTLED", resolved_outcome: "YES" },
});
assert.equal(loss?.source, "settlement");
assert.equal(loss?.valueRaw, "0");
assert.equal(loss.pnlRaw, "-1200000");
assert.equal(
  valueHousePosition({
    ...valueInput,
    mark: { ...currentBid, status: "SETTLED", resolved_outcome_pct: "7500" },
  })?.priceRaw,
  "250000",
);
const portfolio = new Map([
  ["one", { valuation: marked }],
  ["two", { valuation: loss }],
  ["stale", { valuation: marked, balanceUnavailable: true }],
]);
assert.deepEqual(
  summarizeHouseValuations(
    ["one", "two", "stale", "missing"],
    portfolio,
    valuationTime,
  ),
  {
    valueRaw: "1830000",
    pnlRaw: "-570000",
    openPositions: 4,
    valuedPositions: 2,
    validUntil: marked.validUntil,
  },
);
assert.equal(
  summarizeHouseValuations(["one"], portfolio, Date.parse(marked.validUntil))
    .pnlRaw,
  null,
);
assert.equal(
  summarizeHouseValuations([], portfolio, valuationTime).pnlRaw,
  "0",
);

assert.deepEqual(
  houseTraderPolicy.parse(houseTraderDefault),
  houseTraderDefault,
);
assert.equal(
  houseTraderPolicy.safeParse({ ...houseTraderDefault, fixedBuyUsd: "bad" })
    .success,
  false,
);
assert.equal(
  houseTraderPolicy.safeParse({ ...houseTraderDefault, fixedBuyUsd: "3" })
    .success,
  false,
);
assert.equal(
  houseTraderPolicy.safeParse({ ...houseTraderDefault, aiExit: true }).success,
  false,
);
assert.equal(usdRaw("2.001234"), 2_001_234n);
assert.equal(
  houseReceiptMatchesFinalized(
    { blockHash: "0xAA", status: 0 },
    { blockHash: "0xaa", succeeded: false },
  ),
  true,
);
assert.equal(
  houseReceiptMatchesFinalized(
    { blockHash: "0xaa", status: 0 },
    { blockHash: "0xbb", succeeded: false },
  ),
  false,
);
assert.equal(
  houseReceiptMatchesFinalized(
    { blockHash: "0xaa", status: 0 },
    { blockHash: "0xaa", succeeded: true },
  ),
  false,
);
assert.equal(
  houseReceiptMatchesFinalized(
    { blockHash: "0xaa", status: null },
    { blockHash: "0xaa", succeeded: false },
  ),
  false,
);
assert.equal(
  houseReceiptMatchesFinalized({ blockHash: "0xaa", status: 1 }, null),
  false,
);
assert.equal(
  houseDepositSetupRetry({
    failed: false,
    hasRelayerObservation: false,
    elapsedMs: 179_999,
    attempts: 1,
  }),
  "wait",
);
assert.equal(
  houseDepositSetupRetry({
    failed: false,
    hasRelayerObservation: false,
    elapsedMs: 180_000,
    attempts: 1,
  }),
  "retry",
);
assert.equal(
  houseDepositSetupRetry({
    failed: false,
    hasRelayerObservation: true,
    elapsedMs: 599_999,
    attempts: 2,
  }),
  "wait",
);
assert.equal(
  houseDepositSetupRetry({
    failed: false,
    hasRelayerObservation: true,
    elapsedMs: 600_000,
    attempts: 3,
  }),
  "review",
);
assert.equal(
  houseDepositSetupRetry({
    failed: true,
    hasRelayerObservation: true,
    elapsedMs: 0,
    attempts: 1,
  }),
  "retry",
);
assert.equal(
  costBasisForShares(50_000_000n, 100_000_000n, 50_000_000n),
  25_000_000n,
);
assert.equal(
  priceExit(
    30_000_000n,
    costBasisForShares(50_000_000n, 100_000_000n, 50_000_000n) ?? 0n,
    { takeProfitBps: null, stopLossBps: 1000 },
  ),
  null,
);
assert.equal(adverseEntry(0.52, 0.5, 200), false);
assert.equal(adverseEntry(0.52001, 0.5, 200), true);
assert.equal(adverseEntry(0.3, NaN, 200), true);
assert.equal(
  priceExit(12_000_000n, 10_000_000n, {
    takeProfitBps: 2000,
    stopLossBps: null,
  }),
  "take_profit",
);
assert.equal(
  priceExit(9_000_001n, 10_000_000n, {
    takeProfitBps: null,
    stopLossBps: 1000,
  }),
  null,
);
assert.equal(
  priceExit(9_000_000n, 10_000_000n, {
    takeProfitBps: null,
    stopLossBps: 1000,
  }),
  "stop_loss",
);
const key = ethers.Wallet.createRandom();
const keyDir = mkdtempSync(join(tmpdir(), "hunch-house-trader-test-"));
const keyFile = join(keyDir, "key.json");
const keyLink = join(keyDir, "key-link.json");
try {
  writeFileSync(
    keyFile,
    JSON.stringify({ HUNCH_HOUSE_TRADER_PRIVATE_KEY: key.privateKey }),
    { flag: "wx", mode: 0o600 },
  );
  assert.equal(
    readHouseTraderKeyFile(keyFile, key.address).controller,
    key.address,
  );
  assert.throws(
    () => readHouseTraderKeyFile(keyFile, ethers.Wallet.createRandom().address),
    /controller_mismatch/,
  );
  chmodSync(keyFile, 0o644);
  assert.throws(
    () => readHouseTraderKeyFile(keyFile, key.address),
    /unsafe_house_trader_key_file/,
  );
  chmodSync(keyFile, 0o400);
  symlinkSync(keyFile, keyLink);
  assert.throws(() => readHouseTraderKeyFile(keyLink, key.address));
  assert.throws(
    () =>
      readHouseTraderPublicSettings({
        HUNCH_HOUSE_TRADER_PRIVATE_KEY: "accidental_env_injection",
      }),
    /file_only/,
  );
  const pub = {
    HUNCH_HOUSE_TRADER_EXPECTED_CONTROLLER: key.address,
  };
  assert.equal(readHouseTraderPublicSettings(pub).expected, key.address);
  assert.throws(
    () =>
      readHouseTraderPublicSettings({
        ...pub,
        HUNCH_HOUSE_TRADER_EXPECTED_CONTROLLER: ethers.ZeroAddress,
      }),
    /invalid_house_trader_controller/,
  );
} finally {
  if (existsSync(keyLink)) unlinkSync(keyLink);
  if (existsSync(keyFile)) unlinkSync(keyFile);
  rmdirSync(keyDir);
}
const owner = "0x0000000000000000000000000000000000000011";
const other = "0x0000000000000000000000000000000000000022";
const cash = "0x0000000000000000000000000000000000000033";
assert.equal(houseWithdrawalRecipient(other, [owner]), other);
assert.equal(houseWithdrawalRecipient(owner, [owner]), null);
assert.equal(houseWithdrawalRecipient(ethers.ZeroAddress), null);
assert.equal(houseWithdrawalRecipient("recipient.eth"), null);
const withdrawalPreview = {
  chainId: 137,
  recipient: other,
  amountRaw: "1000001",
};
assert.equal(
  houseWithdrawalPreviewMatches(withdrawalPreview, other, 1_000_001n),
  true,
);
assert.equal(
  houseWithdrawalPreviewMatches(withdrawalPreview, owner, 1_000_001n),
  false,
);
assert.equal(
  houseWithdrawalPreviewMatches(withdrawalPreview, other, 1_000_000n),
  false,
);
assert.equal(
  houseWithdrawalPreviewMatches(
    { ...withdrawalPreview, chainId: 8453 },
    other,
    1_000_001n,
  ),
  false,
);
const ledger = contracts.positionManager;
assert.equal(ethers.toUtf8Bytes(POLYMARKET_ORDER_TYPE_STRING).length, 186);
for (const [version, exchange] of [
  ["2", contracts.exchangeV2],
  ["3", contracts.exchangeV3],
] as const) {
  for (const side of [0, 1]) {
    const order = {
      salt: "17",
      maker: owner,
      signer: owner,
      tokenId: "9",
      makerAmount: "1800000",
      takerAmount: "2500000",
      side,
      signatureType: 3,
      timestamp: "1",
      metadata: ethers.ZeroHash,
      builder: ethers.ZeroHash,
    };
    const wrapped = await signHouseOrder(key, { order, exchange, version });
    const types = Object.fromEntries(
      Object.entries(POLYMARKET_TYPED_DATA_SIGN_TYPES).map(
        ([field, values]) => [field, [...values]],
      ),
    );
    const domain = buildPolymarketOrderDomain(exchange, version);
    const message = {
      contents: order,
      name: "DepositWallet",
      version: "1",
      chainId: 137,
      verifyingContract: owner,
      salt: ethers.ZeroHash,
    };
    const inner = wrapped.slice(0, 132);
    assert.equal(
      ethers.verifyTypedData(domain, types, message, inner),
      key.address,
    );
    assert.notEqual(
      ethers.verifyTypedData(
        domain,
        types,
        { ...message, contents: { ...order, makerAmount: "2000000" } },
        inner,
      ),
      key.address,
    );
  }
}
const iface = new ethers.Interface([
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)",
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
function log(address: string, event: string, args: unknown[]) {
  const fragment = iface.getEvent(event);
  assert.ok(fragment);
  return { address, ...iface.encodeEventLog(fragment, args) };
}
const hash = ethers.id("fixture order");
const instrument = {
  hash,
  exchange: contracts.exchangeV3,
  owner,
  tokenId: "9",
  collateral: cash,
  ledger,
  side: "BUY" as const,
};
const logs = [
  log(contracts.exchangeV3, "OrderFilled", [
    hash,
    owner,
    other,
    0,
    9,
    1800000,
    2500000,
    50000,
    ethers.ZeroHash,
    ethers.ZeroHash,
  ]),
  log(ledger, "TransferSingle", [other, other, owner, 9, 2500000]),
  log(cash, "Transfer", [owner, other, 1850000]),
];
assert.deepEqual(houseTradeReceipt(logs, instrument), {
  shares: 2_500_000n,
  cash: -1_850_000n,
  maker: 1_800_000n,
});
assert.equal(houseTradeReceipt(logs, { ...instrument, side: "SELL" }), null);
assert.equal(
  houseTradeReceipt(logs, { ...instrument, hash: ethers.id("wrong") }),
  null,
);
assert.equal(
  houseTradeReceipt(
    logs.filter((item) => item.address !== ledger),
    instrument,
  ),
  null,
);
assert.equal(
  positionNet(
    [
      log(ledger, "TransferSingle", [
        owner,
        owner,
        ethers.ZeroAddress,
        9,
        2500000,
      ]),
    ],
    ledger,
    "9",
    owner,
  ),
  -2_500_000n,
);
console.info(
  "house-trader policy, four signature cases and receipt proofs passed",
);
