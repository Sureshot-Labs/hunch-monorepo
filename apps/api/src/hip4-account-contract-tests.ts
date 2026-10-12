import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hip4Identity, hip4RawUnits } from "@hunch/shared";
import {
  hip4AccountAbstractionSchema,
  hip4AccountFillSchema,
  hip4AccountRoleSchema,
  hip4BorrowLendStateSchema,
  hip4HistoricalOrderObservationSchema,
  hip4SpotAccountStateSchema,
  parseHip4LedgerObservation,
} from "./services/hip4-account-contract.js";
import { mapHip4Market } from "./services/hip4-mapping.js";

const readFixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/hip4/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const fixture = readFixture("account-contracts");
const preflight = readFixture("preflight-observations-20261012");
const protocol = readFixture("protocol-observations-20261012");
const publicAccounts = readFixture("public-account-observations-20261012");
const officialUi = readFixture("official-ui-contract-20261012");
const publicState = readFixture("public-account-state-20261012");
const smallOrders = readFixture("original-order-minimum-20261012");
const explorerOrders = readFixture("explorer-order-observations-20261012");

test("original explorer actions preserve limit input without inferring native acceptance or minimum", () => {
  assert.equal(explorerOrders.coverage.perOrderExecutionResult, false);
  assert.equal(explorerOrders.coverage.exactMinimumBoundaryObserved, false);
  assert.equal(explorerOrders.observations.length, 2);
  const [buy, sell] = explorerOrders.observations;
  for (const tx of [buy, sell]) {
    assert.equal(tx.error, null);
    assert.equal(tx.singleHipOrder, true);
    assert.equal(tx.action.orders.length, 1);
    const order = tx.action.orders[0];
    const encoding = order.a - 100_000_000;
    const identity = hip4Identity("mainnet", Math.floor(encoding / 10));
    assert.equal(identity.sides[encoding % 10].assetId, order.a);
    assert.equal(order.r, false);
  }
  const buyOrder = buy.action.orders[0];
  assert.equal(buyOrder.b, true);
  assert.equal(buyOrder.t.limit.tif, "Gtc");
  assert.equal(
    hip4RawUnits(buyOrder.p, 5) * hip4RawUnits(buyOrder.s, 0),
    100_000n,
  );
  const sellOrder = sell.action.orders[0];
  assert.equal(sellOrder.b, false);
  assert.equal(sellOrder.t.limit.tif, "Ioc");
  assert.equal(
    hip4RawUnits(sellOrder.p, 5) * hip4RawUnits(sellOrder.s, 0),
    920n,
  );
  // The sell limit floor is not its executed price or proof that a 0.0092-unit
  // opening order is admissible. Top-level null error supplies no per-order result.
  assert.equal("execution" in sell, false);
});

test("native small-order evidence preserves original BUY size and separate open/filled events", () => {
  assert.equal(smallOrders.requests, 14);
  assert.equal(smallOrders.coverage.queriedAccounts, 10);
  assert.equal(smallOrders.coverage.exactMinimumBoundaryObserved, false);
  assert.equal(smallOrders.coverage.minimumRejectionsInReturnedSample, 0);
  const observations: ReturnType<
    typeof hip4HistoricalOrderObservationSchema.parse
  >[] = smallOrders.accounts.flatMap((account: { orders: unknown[] }) =>
    account.orders.map((entry) =>
      hip4HistoricalOrderObservationSchema.parse(entry),
    ),
  );
  const filled = observations.find(
    (entry) => entry.order.oid === 1 && entry.status === "filled",
  );
  const opened = observations.find(
    (entry) => entry.order.oid === 1 && entry.status === "open",
  );
  assert.ok(filled);
  assert.ok(opened);
  assert.equal(filled.order.side, "B");
  assert.equal(filled.order.reduceOnly, false);
  assert.equal(filled.order.origSz, "2.0");
  assert.equal(filled.order.sz, "0.0");
  assert.equal(opened.order.sz, "2.0");
  assert.equal(opened.order.origSz, filled.order.origSz);
  assert.ok(filled.statusTimestamp >= opened.statusTimestamp);
  assert.equal(
    hip4RawUnits(filled.order.limitPx, 5) *
      hip4RawUnits(filled.order.origSz, 0),
    115082n,
  );
  // A liquidity rejection is not a minimum rejection or an executed order.
  assert.ok(observations.some((entry) => entry.status === "iocCancelRejected"));
});

test("fresh public unified snapshots preserve distinct balance, hold and maintenance capacity", () => {
  assert.equal(publicState.requests, 11);
  assert.equal(publicState.approvedMaximum, 12);
  assert.equal(publicState.accounts.length, 3);
  assert.equal(publicState.coverage.completeHistory, false);
  for (const account of publicState.accounts) {
    assert.equal(
      hip4AccountAbstractionSchema.parse(account.abstraction),
      "unifiedAccount",
    );
    assert.deepEqual(
      hip4SpotAccountStateSchema.parse(account.spot.snapshot),
      account.spot.snapshot,
    );
    assert.ok(
      account.spot.totalBalanceRows >= account.spot.snapshot.balances.length,
    );
  }
  const state = hip4SpotAccountStateSchema.parse(
    publicState.accounts[2].spot.snapshot,
  );
  const usdc = state.balances.find((row) => row.token === 0);
  assert.ok(usdc);
  const capacityEntry = state.tokenToAvailableAfterMaintenance?.find(
    ([id]) => id === 0,
  );
  assert.ok(capacityEntry);
  const capacity = capacityEntry[1];
  const total = hip4RawUnits(usdc.total, 8);
  const unheld = total - hip4RawUnits(usdc.hold, 8);
  assert.equal(total, 2991451160n);
  assert.equal(unheld, 2346851160n);
  assert.equal(hip4RawUnits(capacity, 8), 2669151160n);
  assert.notEqual(hip4RawUnits(capacity, 8), unheld);
  assert.equal("spendable" in state, false);
});

test("native original HIP BUY orders below ten are not partial-fill minimum evidence", () => {
  const history = publicState.accounts[2].historical;
  const observations = history.orders.map((entry: unknown) =>
    hip4HistoricalOrderObservationSchema.parse(entry),
  );
  const buy = observations.find(
    (entry: { order: { oid: number } }) => entry.order.oid === 59,
  );
  assert.ok(buy);
  assert.equal(buy.order.side, "B");
  assert.equal(buy.order.reduceOnly, false);
  assert.equal(buy.order.origSz, "22.0");
  assert.equal(buy.order.sz, "22.0");
  assert.equal(
    hip4RawUnits(buy.order.limitPx, 5) * hip4RawUnits(buy.order.origSz, 0),
    338580n,
  );
  assert.equal(buy.status, "open");
  assert.equal(publicState.coverage.currentOpenOrders, false);
  assert.equal(publicState.coverage.exactMinimumBoundaryObserved, false);
  assert.equal(history.providerMaximumPossiblyReached, true);
  assert.ok(history.hipInWindow > observations.length);
});

test("historical status and native order identity survive repeated client IDs without inferring terminal state", () => {
  const observations: ReturnType<
    typeof hip4HistoricalOrderObservationSchema.parse
  >[] = publicState.accounts.flatMap(
    (account: { historical: { orders: unknown[] } }) =>
      account.historical.orders.map((entry) =>
        hip4HistoricalOrderObservationSchema.parse(entry),
      ),
  );
  const first = observations.find((entry) => entry.order.oid === 9);
  const replacement = observations.find((entry) => entry.order.oid === 32);
  assert.ok(first);
  assert.ok(replacement);
  assert.equal(first.order.cloid, replacement.order.cloid);
  assert.notEqual(first.order.oid, replacement.order.oid);
  assert.notEqual(first.statusTimestamp, replacement.statusTimestamp);
  for (const account of publicState.accounts)
    for (const entry of account.historical.orders)
      assert.deepEqual(
        hip4HistoricalOrderObservationSchema.parse(entry),
        entry,
      );
  const newer = {
    ...first,
    status: "filled",
    statusTimestamp: first.statusTimestamp + 1,
  };
  assert.equal(
    hip4HistoricalOrderObservationSchema.parse(newer).status,
    "filled",
  );
  assert.equal(
    hip4HistoricalOrderObservationSchema.parse(first).status,
    "open",
  );
  for (const patch of [
    { coin: "#113822" },
    { origSz: "-1" },
    { origSz: 22 },
    { limitPx: "1.1" },
    { oid: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.throws(() =>
      hip4HistoricalOrderObservationSchema.parse({
        ...first,
        order: { ...first.order, ...patch },
      }),
    );
  assert.equal(
    hip4HistoricalOrderObservationSchema.parse({
      ...first,
      status: "futureStatus",
    }).status,
    "futureStatus",
  );
});

test("wire-contract provenance does not claim observed receipts or funded account evidence", () => {
  assert.equal(
    fixture.origin,
    "synthetic-wire-contract-not-live-account-or-receipt",
  );
  assert.ok(
    fixture.sources.wireTypeReference.includes(
      "db80d598f6e4672edc090fe69994ecec97ebc980",
    ),
  );
  assert.equal(preflight.origin, "authorized-unsigned-third-party-preflight");
  assert.equal(preflight.cases.length, 8);
});

test("account roles keep parent fields distinct; abstraction default is not renamed Standard", () => {
  const owner = "0x0000000000000000000000000000000000000001";
  for (const role of ["missing", "user", "vault"])
    assert.equal(hip4AccountRoleSchema.parse({ role }).role, role);
  assert.deepEqual(
    hip4AccountRoleSchema.parse({ role: "agent", data: { user: owner } }),
    { role: "agent", data: { user: owner } },
  );
  assert.deepEqual(
    hip4AccountRoleSchema.parse({
      role: "subAccount",
      data: { master: owner },
    }),
    { role: "subAccount", data: { master: owner } },
  );
  assert.throws(() =>
    hip4AccountRoleSchema.parse({ role: "agent", data: { master: owner } }),
  );
  assert.throws(() =>
    hip4AccountRoleSchema.parse({ role: "subAccount", data: { user: owner } }),
  );
  for (const mode of [
    "default",
    "disabled",
    "dexAbstraction",
    "unifiedAccount",
    "portfolioMargin",
  ])
    assert.equal(hip4AccountAbstractionSchema.parse(mode), mode);
  assert.throws(() => hip4AccountAbstractionSchema.parse("newMode"));
});

test("outcome balances do not require a spot token index; decimal strings remain lossless", () => {
  const state = hip4SpotAccountStateSchema.parse(fixture.spot);
  assert.deepEqual(state, fixture.spot);
  assert.equal(state.balances[1].token, undefined);
  assert.equal(state.balances[1].coin, "+115660");
  assert.equal(state.balances[2].coin, "o11566");
  assert.equal(
    hip4RawUnits(state.balances[0].total, 8),
    900719925474099312345678n,
  );
  assert.throws(() =>
    hip4SpotAccountStateSchema.parse({
      balances: [{ coin: "USDC", total: "10", hold: "0", entryNtl: "0" }],
    }),
  );
  assert.throws(() =>
    hip4SpotAccountStateSchema.parse({
      balances: [{ ...state.balances[0], total: 100 }],
    }),
  );
  assert.throws(() =>
    hip4SpotAccountStateSchema.parse({
      balances: [{ ...state.balances[0], total: "1e3" }],
    }),
  );
});

test("outcome balances cannot bypass known-field validation through the missing-token alternative", () => {
  for (const coin of ["+115660", "o11566"]) {
    const base = { coin, total: "20", hold: "0", entryNtl: "10" };
    for (const patch of [
      { token: -1 },
      { token: "0" },
      { token: null },
      { spotHold: 10 },
      { borrowed: "-5" },
      { supplied: "1e2" },
      { ltv: null },
    ]) {
      assert.equal(
        hip4SpotAccountStateSchema.safeParse({
          balances: [{ ...base, ...patch }],
        }).success,
        false,
      );
    }
    // Complete corrected observations recover immediately; no state/cooldown.
    assert.deepEqual(
      hip4SpotAccountStateSchema.parse({ balances: [base] }).balances[0],
      base,
    );
    const supplied = {
      ...base,
      token: 0,
      spotHold: "2",
      borrowed: "1",
      supplied: "0",
      ltv: "0.5",
    };
    assert.deepEqual(
      hip4SpotAccountStateSchema.parse({ balances: [supplied] }).balances[0],
      supplied,
    );
  }
});

test("portfolio capacity, borrowing and escrow remain separate observations, not guessed spendable cash", () => {
  const state = hip4SpotAccountStateSchema.parse(fixture.portfolio);
  assert.deepEqual(state, fixture.portfolio);
  assert.equal(state.tokenToAvailableAfterMaintenance?.[0][1], "45.0");
  assert.equal(state.balances[0].borrowed, "20.0");
  assert.equal(
    hip4BorrowLendStateSchema.parse(fixture.borrowLend).tokenToState[0][1]
      .borrow.value,
    "20.1",
  );
  assert.equal("spendable" in state, false);
  assert.deepEqual(hip4SpotAccountStateSchema.parse({ balances: [] }), {
    balances: [],
  });
  assert.equal(
    hip4SpotAccountStateSchema.parse({
      balances: [{ ...fixture.portfolio.balances[0], total: "-1.1" }],
    }).balances[0].total,
    "-1.1",
  );
});

test("known ledger kinds preserve transfer locations, human units, fees and nullable nonce", () => {
  for (const entry of fixture.ledger) {
    const parsed = parseHip4LedgerObservation(entry);
    assert.equal(parsed.supported, true);
    assert.deepEqual(parsed.entry, entry);
  }
  const send = parseHip4LedgerObservation(fixture.ledger[0]);
  assert.equal(send.entry.delta.sourceDex, "spot");
  assert.equal(send.entry.delta.destinationDex, "");
  assert.equal(send.entry.delta.token, "USDC");
  assert.equal(send.entry.delta.fee, "0.02");
  assert.equal(send.entry.delta.nativeTokenFee, "0.02");
  assert.equal(hip4RawUnits(send.entry.delta.amount as string, 8), 1000000000n);
  assert.equal(
    parseHip4LedgerObservation(fixture.ledger[1]).entry.delta.nonce,
    null,
  );
  assert.equal(
    parseHip4LedgerObservation(fixture.ledger[2]).entry.delta.type,
    "accountClassTransfer",
  );
  assert.equal("confirmedCredit" in send, false);
});

test("unknown ledger events remain observable; malformed known events cannot masquerade as unknown", () => {
  const original = fixture.ledger[0];
  for (const kind of ["futureEvent", "constructor", "__proto__"]) {
    const input = {
      ...original,
      delta: { type: kind, amount: "1.0", extra: "preserved" },
    };
    assert.deepEqual(parseHip4LedgerObservation(input), {
      supported: false,
      entry: input,
    });
  }
  for (const field of [
    "amount",
    "token",
    "sourceDex",
    "destinationDex",
    "nonce",
    "fee",
    "nativeTokenFee",
  ]) {
    const delta = { ...original.delta };
    delete delta[field];
    assert.throws(() => parseHip4LedgerObservation({ ...original, delta }));
  }
  for (const patch of [
    { amount: "-1" },
    { amount: "1e2" },
    { nonce: Number.MAX_SAFE_INTEGER + 1 },
    { destination: "USDC" },
  ])
    assert.throws(() =>
      parseHip4LedgerObservation({
        ...original,
        delta: { ...original.delta, ...patch },
      }),
    );
  assert.throws(() => parseHip4LedgerObservation({ ...original, hash: "" }));
  // An updated complete observation immediately recovers; no cooldown/state.
  assert.equal(parseHip4LedgerObservation(original).supported, true);
});

test("third-party preflight responses preserve HIP identity but do not establish a minimum or native fee", () => {
  const identities = hip4Identity("mainnet", preflight.outcome);
  for (const item of preflight.cases)
    assert.ok(
      identities.sides.some(
        (side) => side.coin === item.coin && side.assetId === item.asset,
      ),
    );
  const below = preflight.cases.find(
    (item: { name: string }) => item.name === "below-ten",
  );
  assert.equal(below.valid, true);
  assert.equal(hip4RawUnits(below.price, 1) * BigInt(below.size), 95n); // $9.50, despite the gateway guide's $10 claim.
  assert.equal(preflight.allResponses.isSpot, false);
  assert.equal(preflight.allResponses.estimatedFee, "0.04%");
  const fractional = preflight.cases.find(
    (item: { name: string }) => item.name === "fractional-size",
  );
  assert.equal(fractional.valid, false);
  assert.equal(fractional.errorField, "size");
});

test("public metadata still cannot gain executable precision or trade capability from gateway hints", () => {
  const observation = protocol.observations[0];
  const mapped = mapHip4Market({
    environment: "mainnet",
    outcome: observation.outcome.outcome,
    metadata: {
      outcomes: [observation.outcome],
      questions: [],
      feeScale: observation.feeScale,
    },
    spotMetadata: { tokens: [observation.quote] },
    fetchedAt: observation.collectedAt,
    generation: "p0-contract-test",
  });
  assert.equal(mapped.market.sides[0].szDecimals, null);
  assert.equal(mapped.market.capabilities.trade, false);
});

test("first-party outcome formatting is fixed five-place price and whole size, not generic spot precision", () => {
  assert.equal(
    officialUi.origin,
    "first-party-public-ui-source-inspection-not-exchange-validation",
  );
  assert.match(officialUi.source.sha256, /^[a-f0-9]{64}$/);
  const terms = officialUi.precision;
  assert.equal(terms.sizeDecimals, 0);
  assert.equal(terms.priceDecimalPlaces, 5);
  assert.equal(terms.outcomeTokenWeiDecimals, 5);
  assert.equal(hip4RawUnits("20.000", terms.sizeDecimals), 20n);
  assert.throws(() => hip4RawUnits("20.5", terms.sizeDecimals));
  for (const [price, raw] of [
    ["0.50001", 50001n],
    ["0.00001", 1n],
    ["0.00001000", 1n],
  ] as const)
    assert.equal(hip4RawUnits(price, terms.priceDecimalPlaces), raw);
  for (const price of ["0.500001", "0.000001", "0.00000001"])
    assert.throws(() => hip4RawUnits(price, terms.priceDecimalPlaces));
  assert.equal(officialUi.minimum.nativeBoundaryObserved, false);
  // Quote-token raw units and executable outcome units are separate contracts.
  assert.equal(hip4RawUnits("0.00000001", 8), 1n);
});

test("real HIP account fills include settlement and merge; transfers can omit fee denomination", () => {
  assert.equal(publicAccounts.requests, 17);
  assert.equal(publicAccounts.accounts.length, 3);
  const kinds = new Set<string>();
  let unknownFeeDenomination = false;
  for (const account of publicAccounts.accounts) {
    for (const entry of account.fills) {
      assert.deepEqual(hip4AccountFillSchema.parse(entry), entry);
      kinds.add(entry.dir);
    }
    for (const entry of account.ledger) {
      const parsed = parseHip4LedgerObservation(entry);
      assert.deepEqual(parsed.entry, entry);
      assert.equal(parsed.supported, entry.delta.type !== "vaultDeposit");
      if (entry.delta.nativeTokenFee === "0.00050675") {
        assert.equal(entry.delta.feeToken, "");
        assert.equal(entry.delta.fee, "0.0");
        unknownFeeDenomination = true;
      }
    }
  }
  assert.deepEqual(kinds, new Set(["Settlement", "Buy", "Merge Outcome"]));
  assert.equal(unknownFeeDenomination, true);
  // Settlement is present despite an empty non-funding ledger in this sample.
  assert.equal(publicAccounts.accounts[0].counts.ledger, 0);
  assert.ok(
    publicAccounts.accounts[0].fills.some(
      (fill: { dir: string }) => fill.dir === "Settlement",
    ),
  );
});

test("observed fee arithmetic matches sampled scales/discounts, not a global quote formula", () => {
  const scale = 100000000n;
  for (const account of publicAccounts.accounts) {
    const rate = hip4RawUnits(account.userFees.userSpotCrossRate, 8);
    const referral = hip4RawUnits(account.userFees.activeReferralDiscount, 8);
    for (const fill of account.fills) {
      if (fill.dir === "Buy") {
        assert.equal(hip4RawUnits(fill.fee, 8), 0n);
        continue;
      }
      // Only an observation: feeScale/deployer scale were 1 and all selected
      // closing events were crossed Settlement/Merge, not ordinary maker sells.
      assert.equal(fill.crossed, true);
      const notional = hip4RawUnits(fill.sz, 8) * hip4RawUnits(fill.px, 8);
      assert.equal(
        hip4RawUnits(fill.fee, 8) * scale ** 3n,
        notional * rate * 2n * (scale - referral),
      );
    }
  }
  // Both sampled markets independently resolved to the NO side.
  for (const settled of publicAccounts.settledOutcomes) {
    assert.equal(settled.settleFraction, "0.0");
    assert.equal(settled.spec.deployerFeeScale, "1.0");
  }
});

test("first-party fee contract and sampled settlement rates agree without double-discounting staking", () => {
  assert.equal(officialUi.fees.opening, "0");
  assert.deepEqual(officialUi.fees.mainnetAlignedNamesAtObservation, []);
  const scale = 100000000n;
  // Integer numerator, denominator = scale^4. Source rules are preserved in
  // the fixture; these tests do not install a production fee/debit estimator.
  const closingRate = (
    base: string,
    deployer: string,
    global: string,
    referral: string,
    aligned: boolean,
  ) => {
    const rate = base.startsWith("-") ? 0n : hip4RawUnits(base, 8);
    const deployerRate = hip4RawUnits(deployer, 8);
    const protocolRate = deployerRate > scale ? deployerRate : scale;
    const combined = aligned
      ? (protocolRate * 8n) / 10n + deployerRate
      : protocolRate + deployerRate;
    return (
      rate *
      combined *
      hip4RawUnits(global, 8) *
      (scale - hip4RawUnits(referral, 8))
    );
  };
  for (const account of publicAccounts.accounts) {
    const fees = account.userFees;
    const numerator = closingRate(
      fees.userSpotCrossRate,
      "1",
      "1",
      fees.activeReferralDiscount,
      false,
    );
    const expected =
      account.accountAlias === "participant-1" ? "0.0014" : "0.0012768";
    assert.equal(numerator, hip4RawUnits(expected, 8) * scale ** 3n);
  }
  assert.equal(
    closingRate("0.0007", "0", "1", "0", true),
    hip4RawUnits("0.00056", 8) * scale ** 3n,
  );
  assert.equal(
    closingRate("0.0007", "2", "1", "0", true),
    hip4RawUnits("0.00252", 8) * scale ** 3n,
  );
  assert.equal(closingRate("0.0007", "1", "0", "0", false), 0n);
  assert.equal(closingRate("-0.00001", "1", "1", "0", false), 0n);
});

test("fill IDs must not collapse partial fills or both legs of outcome transformations", () => {
  const fills = publicAccounts.accounts[2].fills.map((entry: unknown) =>
    hip4AccountFillSchema.parse(entry),
  );
  const partial = fills.filter((fill: { dir: string }) => fill.dir === "Buy");
  assert.equal(partial.length, 2);
  assert.equal(partial[0].oid, partial[1].oid);
  assert.equal(partial[0].cloid, partial[1].cloid);
  assert.notEqual(partial[0].tid, partial[1].tid);
  const merge = fills.filter(
    (fill: { dir: string }) => fill.dir === "Merge Outcome",
  );
  assert.equal(merge[0].hash, merge[1].hash);
  assert.notEqual(merge[0].coin, merge[1].coin);
  assert.notEqual(merge[0].tid, merge[1].tid);
  assert.throws(() =>
    hip4AccountFillSchema.parse({ ...partial[0], coin: "#115642" }),
  );
  assert.throws(() =>
    hip4AccountFillSchema.parse({ ...partial[0], px: "1.01" }),
  );
  assert.throws(() =>
    hip4AccountFillSchema.parse({
      ...partial[0],
      tid: Number.MAX_SAFE_INTEGER + 1,
    }),
  );
});
