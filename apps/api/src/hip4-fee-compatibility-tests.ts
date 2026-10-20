import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hip4Identity } from "@hunch/shared";
import { hip4FeeTestObservation } from "./hip4-fee-test-fixture.js";
import { quoteHip4OrderFees } from "./services/hip4-order-fees.js";

type CapturedClosing = {
  outcomeSpec: {
    outcome: number;
    name?: string;
    venue: string;
    quoteToken: string;
  };
  dir: "Sell" | "Settlement";
  px: string;
  sz: string;
  fee: string;
  crossed: boolean;
  userFees: {
    userSpotCrossRate: string;
    userSpotAddRate: string;
    activeReferralDiscount: string;
  };
};
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/hip4/official-ui-fee-default-20261019.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  rule: string;
  officialUi: { url: string; sha256: string; absentDeployerScale: string };
  feeScale: string;
  coverage: {
    omittedDeployerScaleClosingRecords: number;
    informativePositiveFeeRecords: number;
    takerSellRecords: number;
    takerSettlementRecords: number;
    makerRecords: number;
    zeroPayoutSettlementsExcluded: number;
    historicalFeeRateSnapshots: boolean;
    universalFeeRoundingEstablished: boolean;
  };
  records: CapturedClosing[];
};

// Independent rational arithmetic for the portable evidence, not production
// fee helpers or a claim that the protocol always floors each fill this way.
type Fraction = { numerator: bigint; denominator: bigint };
const one: Fraction = { numerator: 1n, denominator: 1n };
function fraction(value: string): Fraction {
  assert.match(value, /^(0|[1-9]\d*)(\.\d+)?$/u);
  const [whole, decimals = ""] = value.split(".");
  return {
    numerator: BigInt(whole + decimals),
    denominator: 10n ** BigInt(decimals.length),
  };
}
function multiply(...values: Fraction[]): Fraction {
  return values.reduce(
    (result, value) => ({
      numerator: result.numerator * value.numerator,
      denominator: result.denominator * value.denominator,
    }),
    one,
  );
}
function combinedScale(deployer: Fraction): Fraction {
  const protocol = deployer.numerator > deployer.denominator ? deployer : one;
  return {
    numerator:
      deployer.numerator * protocol.denominator +
      protocol.numerator * deployer.denominator,
    denominator: deployer.denominator * protocol.denominator,
  };
}
function unroundedFeeAtoms(
  record: CapturedClosing,
  deployerScale: string,
): Fraction {
  const referral = fraction(record.userFees.activeReferralDiscount);
  return multiply(
    fraction(record.px),
    fraction(record.sz),
    fraction(
      record.crossed
        ? record.userFees.userSpotCrossRate
        : record.userFees.userSpotAddRate,
    ),
    {
      numerator: referral.denominator - referral.numerator,
      denominator: referral.denominator,
    },
    fraction(fixture.feeScale),
    combinedScale(fraction(deployerScale)),
    { numerator: 100000000n, denominator: 1n },
  );
}
function observedFeeAtoms(record: CapturedClosing): bigint {
  const raw = multiply(fraction(record.fee), {
    numerator: 100000000n,
    denominator: 1n,
  });
  assert.equal(raw.numerator % raw.denominator, 0n);
  return raw.numerator / raw.denominator;
}

test("omitted deployer compatibility evidence is pinned, bounded and deidentified", () => {
  assert.equal(fixture.rule, "official_ui_default_20261019");
  assert.equal(
    fixture.officialUi.url,
    "https://app.hyperliquid.xyz/assets/config-1E2uRQO0.js",
  );
  assert.equal(
    fixture.officialUi.sha256,
    "3942a353642d32b2b72c16a77572a2ff75ca22d2d88907698234926a59285c7f",
  );
  assert.equal(fixture.officialUi.absentDeployerScale, "0");
  assert.equal(fixture.coverage.omittedDeployerScaleClosingRecords, 12);
  assert.equal(fixture.coverage.informativePositiveFeeRecords, 8);
  assert.equal(fixture.records.length, 8);
  assert.equal(fixture.coverage.zeroPayoutSettlementsExcluded, 4);
  assert.equal(fixture.coverage.makerRecords, 0);
  assert.equal(fixture.coverage.historicalFeeRateSnapshots, false);
  assert.equal(fixture.coverage.universalFeeRoundingEstablished, false);
  assert.equal(
    fixture.records.filter((record) => record.dir === "Sell").length,
    fixture.coverage.takerSellRecords,
  );
  assert.equal(
    fixture.records.filter((record) => record.dir === "Settlement").length,
    fixture.coverage.takerSettlementRecords,
  );
  assert.equal(
    fixture.records.find((record) => record.outcomeSpec.outcome === 8774)
      ?.outcomeSpec.name,
    "template:sportsContestWinner",
  );
  for (const record of fixture.records) {
    assert.deepEqual(Object.keys(record).sort(), [
      "crossed",
      "dir",
      "fee",
      "outcomeSpec",
      "px",
      "sz",
      "userFees",
    ]);
    assert.deepEqual(Object.keys(record.userFees).sort(), [
      "activeReferralDiscount",
      "userSpotAddRate",
      "userSpotCrossRate",
    ]);
    assert.deepEqual(
      Object.keys(record.outcomeSpec).sort(),
      record.outcomeSpec.name
        ? ["name", "outcome", "quoteToken", "venue"]
        : ["outcome", "quoteToken", "venue"],
    );
    assert.equal(Object.hasOwn(record.outcomeSpec, "deployerFeeScale"), false);
    assert.equal(record.outcomeSpec.quoteToken, "USDC");
    assert.equal(record.outcomeSpec.venue, "txyz");
    assert.equal(record.crossed, true);
    assert.ok(observedFeeAtoms(record) > 0n);
  }
});

test("eight positive captured fees corroborate absent deployer zero, not a free close or universal two-times fee", () => {
  assert.deepEqual(combinedScale(fraction("0")), one);
  assert.deepEqual(combinedScale(fraction("1")), {
    numerator: 2n,
    denominator: 1n,
  });
  for (const record of fixture.records) {
    const unrounded = unroundedFeeAtoms(record, "0");
    const observed = observedFeeAtoms(record);
    assert.equal(observed, unrounded.numerator / unrounded.denominator);
    const doubled = unroundedFeeAtoms(record, "1");
    assert.ok(observed < doubled.numerator / doubled.denominator);
  }
});

test("current-terms production SELL estimates cover the two captured SELL fees without claiming a lifetime cap", () => {
  for (const record of fixture.records.filter(
    (entry) => entry.dir === "Sell",
  )) {
    const identity = hip4Identity("mainnet", record.outcomeSpec.outcome);
    const quantity = fraction(record.sz);
    assert.equal(quantity.numerator % quantity.denominator, 0n);
    const observation = hip4FeeTestObservation({
      marketId: identity.marketId,
      marketRevision: `public-omitted-scale-${record.outcomeSpec.outcome}`,
      closing: {
        userFees: record.userFees,
        feeScale: fixture.feeScale,
        deployerFeeScale: "0",
        deployerFeeScaleSource: "official_ui_default_20261019",
      },
    });
    const quote = quoteHip4OrderFees({
      observation,
      address: observation.address,
      action: {
        type: "order",
        grouping: "na",
        orders: [
          {
            a: identity.sides[0].assetId,
            b: false,
            p: record.px,
            s: (quantity.numerator / quantity.denominator).toString(),
            r: false,
            t: { limit: { tif: "Ioc" } },
            c: `0x${"cd".repeat(16)}`,
          },
        ],
      },
    });
    const unrounded = unroundedFeeAtoms(record, "0");
    assert.equal(
      quote.estimatedFeeAtLimitRaw,
      (
        (unrounded.numerator + unrounded.denominator - 1n) /
        unrounded.denominator
      ).toString(),
    );
    assert.ok(observedFeeAtoms(record) <= BigInt(quote.estimatedFeeAtLimitRaw));
    assert.ok(BigInt(quote.estimatedFeeAtLimitRaw) > 0n);
    assert.equal(quote.lifetimeFeeCapRaw, null);
    assert.equal(quote.buyFeeCapRaw, null);
    assert.equal(quote.feeAccounting, "actual_execution_fee");
  }
});
