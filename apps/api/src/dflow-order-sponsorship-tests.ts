#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  buildDflowOrderRequestQuery,
  finalizeDflowSponsoredOrderOrFallback,
  resolveDflowActualSponsorshipDecision,
} from "./routes/dflow-private.js";
import {
  resolveEmbeddedSolanaActualSponsorshipDecision,
  type EmbeddedSolanaSponsorshipLimits,
} from "./services/embedded-solana-sponsorship.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const WALLET = "F7RnPpFGLzY2r17MLTrxgJXDWiHF5etiEaLNn11GebLJ";
const SPONSOR = "B2oU6ZDdb3dk4GMJepKiWiBVVzF46vuW12RcKpQ5sGTX";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const limits: EmbeddedSolanaSponsorshipLimits = {
  dflow: {
    maxPerHour: 10,
    maxPerDay: 50,
    maxLamportsPerWalletPerDay: 10_000_000,
  },
  across: {
    maxPerHour: 5,
    maxPerDay: 20,
    maxLamportsPerWalletPerDay: 200_000,
  },
  directTransfer: {
    maxPerHour: 5,
    maxPerDay: 20,
    maxLamportsPerWalletPerDay: 150_000,
    minAmountRaw: "500000",
  },
  debridge: {
    maxPerHour: 3,
    maxPerDay: 10,
    maxLamportsPerWalletPerDay: 100_000,
  },
};

const fakeAnalysis = {
  ok: true,
  digest: "digest",
  version: 0 as const,
  feePayer: SPONSOR,
  signerAddresses: [SPONSOR, WALLET],
  signatureCount: 2,
  staticAccountCount: 2,
  addressTableLookupCount: 0,
  usesAddressLookupTables: false,
  programIds: ["DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH"],
  unknownProgramIds: [],
  instructions: [],
  hasNativeSolTransfer: false,
  hasSyncNative: false,
  systemCreateLamports: "0",
  ataCreateCount: 0,
  estimatedSponsorLamports: "5000",
  malformedReason: null,
};

function baseFinalizeInputs(overrides: Record<string, unknown> = {}) {
  return {
    payload: { transaction: "sponsoredTx" },
    query: {
      inputMint: USDC_MINT,
      outputMint: USDC_MINT,
      amount: "1000000",
    },
    userId: "user-id",
    walletAddress: WALLET,
    userPublicKey: WALLET,
    sponsorAddress: SPONSOR,
    sponsorshipMarketState: {
      marketIds: ["kalshi:TEST"],
      marketInitialized: true,
    },
    sponsorshipLimits: limits,
    sponsorshipMode: "enforce" as const,
    sponsorshipObserveCanSponsor: false,
    requester: async ({ sponsored }: { sponsored: boolean }) => ({
      ok: true as const,
      payload: sponsored
        ? { transaction: "unexpectedSponsoredFallback" }
        : {
            transaction: "userFundedTx",
            hunchSponsorshipIntentId: "must-be-stripped",
            hunchSponsoredDflow: true,
            hunchSponsorAddress: SPONSOR,
          },
    }),
    logger: {
      warn: () => undefined,
    },
    refreshTransaction: async () => "refreshedSponsoredTx",
    computeMessageDigest: () => "messageDigest",
    analyzeTransaction: () => fakeAnalysis,
    validateSponsoredAnalysis: () => ({
      valid: true,
      reasons: [],
      estimatedSponsorLamports: 5000n,
      estimatedFeeLamports: 5000n,
      systemCreateLamports: 0n,
    }),
    reserveBudget: async () => ({ ok: true, reasons: [] }),
    createIntent: async () => ({
      id: "solsp_test",
      flow: "dflow" as const,
      userId: "user-id",
      signer: WALLET,
      transactionDigest: "transactionDigest",
      createdAt: "2026-06-02T00:00:00.000Z",
      expiresAt: "2026-06-02T00:05:00.000Z",
    }),
    upsertLedger: async () => undefined,
    now: () => new Date("2026-06-02T00:00:00.000Z"),
    ...overrides,
  };
}

const tests: TestCase[] = [
  {
    name: "DFlow actual sponsorship is disabled in observe mode by default",
    run: () => {
      const decision = resolveDflowActualSponsorshipDecision({
        embeddedSolanaSponsorship: true,
        dflowFlowEnabled: true,
        mode: "observe",
        observeCanSponsor: false,
      });

      assert.equal(decision.policyAllows, true);
      assert.equal(decision.actualSponsorAllowed, false);
      assert.ok(decision.reasons.includes("observe_mode_log_only"));
    },
  },
  {
    name: "shared sponsorship decision disables actual direct transfer sponsorship in observe log-only mode",
    run: () => {
      const decision = resolveEmbeddedSolanaActualSponsorshipDecision({
        embeddedSolanaSponsorship: true,
        flow: "directTransfer",
        flowEnabled: true,
        mode: "observe",
        observeCanSponsor: false,
      });

      assert.equal(decision.policyAllows, true);
      assert.equal(decision.actualSponsorAllowed, false);
      assert.deepEqual(decision.reasons, ["observe_mode_log_only"]);
    },
  },
  {
    name: "shared sponsorship decision preserves observe-can-sponsor override",
    run: () => {
      const decision = resolveEmbeddedSolanaActualSponsorshipDecision({
        embeddedSolanaSponsorship: true,
        flow: "across",
        flowEnabled: true,
        mode: "observe",
        observeCanSponsor: true,
      });

      assert.equal(decision.policyAllows, true);
      assert.equal(decision.actualSponsorAllowed, true);
      assert.deepEqual(decision.reasons, []);
    },
  },
  {
    name: "shared sponsorship decision preserves disabled policy and flow reasons",
    run: () => {
      const decision = resolveEmbeddedSolanaActualSponsorshipDecision({
        embeddedSolanaSponsorship: false,
        flow: "debridge",
        flowEnabled: false,
        mode: "enforce",
        observeCanSponsor: true,
      });

      assert.equal(decision.policyAllows, false);
      assert.equal(decision.actualSponsorAllowed, false);
      assert.deepEqual(decision.reasons, [
        "sponsorship_disabled",
        "flow_debridge_disabled",
      ]);
    },
  },
  {
    name: "DFlow actual sponsorship is allowed in observe mode with override",
    run: () => {
      const decision = resolveDflowActualSponsorshipDecision({
        embeddedSolanaSponsorship: true,
        dflowFlowEnabled: true,
        mode: "observe",
        observeCanSponsor: true,
      });

      assert.equal(decision.actualSponsorAllowed, true);
    },
  },
  {
    name: "DFlow actual sponsorship is allowed in enforce mode when Access allows",
    run: () => {
      const decision = resolveDflowActualSponsorshipDecision({
        embeddedSolanaSponsorship: true,
        dflowFlowEnabled: true,
        mode: "enforce",
        observeCanSponsor: false,
      });

      assert.equal(decision.actualSponsorAllowed, true);
    },
  },
  {
    name: "DFlow actual sponsorship is disabled when Access or flow is disabled",
    run: () => {
      assert.equal(
        resolveDflowActualSponsorshipDecision({
          embeddedSolanaSponsorship: false,
          dflowFlowEnabled: true,
          mode: "enforce",
          observeCanSponsor: true,
        }).actualSponsorAllowed,
        false,
      );
      assert.equal(
        resolveDflowActualSponsorshipDecision({
          embeddedSolanaSponsorship: true,
          dflowFlowEnabled: false,
          mode: "enforce",
          observeCanSponsor: true,
        }).actualSponsorAllowed,
        false,
      );
    },
  },
  {
    name: "budget failure returns a user-funded DFlow fallback payload",
    run: async () => {
      const requests: boolean[] = [];
      const result = await finalizeDflowSponsoredOrderOrFallback(
        baseFinalizeInputs({
          requester: async ({ sponsored }: { sponsored: boolean }) => {
            requests.push(sponsored);
            return {
              ok: true as const,
              payload: {
                transaction: "userFundedTx",
                hunchSponsorshipIntentId: "must-be-stripped",
              },
            };
          },
          reserveBudget: async () => ({
            ok: false,
            reasons: ["sponsorship_budget_unavailable"],
          }),
        }),
      );

      assert.deepEqual(requests, [false]);
      assert.equal(result.ok, true);
      assert.equal(result.sponsored, false);
      assert.equal(result.fallbackReason, "budget_failed");
      assert.deepEqual(result.payload, { transaction: "userFundedTx" });
    },
  },
  {
    name: "validation failure returns a user-funded DFlow fallback payload",
    run: async () => {
      const requests: boolean[] = [];
      const result = await finalizeDflowSponsoredOrderOrFallback(
        baseFinalizeInputs({
          requester: async ({ sponsored }: { sponsored: boolean }) => {
            requests.push(sponsored);
            return {
              ok: true as const,
              payload: { transaction: "userFundedTx" },
            };
          },
          validateSponsoredAnalysis: () => ({
            valid: false,
            reasons: ["fee_payer_mismatch"],
            estimatedSponsorLamports: 5000n,
            estimatedFeeLamports: 5000n,
            systemCreateLamports: 0n,
          }),
        }),
      );

      assert.deepEqual(requests, [false]);
      assert.equal(result.ok, true);
      assert.equal(result.sponsored, false);
      assert.equal(result.fallbackReason, "validation_failed");
    },
  },
  {
    name: "intent creation failure returns a user-funded DFlow fallback payload",
    run: async () => {
      const requests: boolean[] = [];
      const result = await finalizeDflowSponsoredOrderOrFallback(
        baseFinalizeInputs({
          requester: async ({ sponsored }: { sponsored: boolean }) => {
            requests.push(sponsored);
            return {
              ok: true as const,
              payload: { transaction: "userFundedTx" },
            };
          },
          createIntent: async () => null,
        }),
      );

      assert.deepEqual(requests, [false]);
      assert.equal(result.ok, true);
      assert.equal(result.sponsored, false);
      assert.equal(result.fallbackReason, "intent_create_failed");
    },
  },
  {
    name: "failed user-funded fallback returns fallback DFlow error response",
    run: async () => {
      const result = await finalizeDflowSponsoredOrderOrFallback(
        baseFinalizeInputs({
          requester: async () => ({
            ok: false as const,
            status: 503,
            payload: { error: "fallback failed" },
          }),
          reserveBudget: async () => ({
            ok: false,
            reasons: ["sponsorship_budget_unavailable"],
          }),
        }),
      );

      assert.equal(result.ok, false);
      assert.equal(result.status, 503);
      assert.equal(result.fallbackReason, "budget_failed");
      assert.deepEqual(result.payload, { error: "fallback failed" });
    },
  },
  {
    name: "sponsored buy request uses sponsor rent recipient and close authority",
    run: () => {
      const query = buildDflowOrderRequestQuery({
        query: {
          inputMint: USDC_MINT,
          outputMint: "OutcomeMint11111111111111111111111111111111",
          amount: "1000000",
        },
        userPublicKey: WALLET,
        sponsored: true,
        sponsorAddress: SPONSOR,
      });

      assert.equal(query.sponsor, SPONSOR);
      assert.equal(query.sponsorExec, true);
      assert.equal(query.outcomeAccountRentRecipient, SPONSOR);
      assert.equal(query.outputCloseAuthority, SPONSOR);
      assert.equal(query.rentRecipientDecision, undefined);
      assert.equal(query.outcomeAccountRentRecipientRole, undefined);
      assert.equal(query.outcomeAccountRentRecipientReason, undefined);
    },
  },
  {
    name: "sponsored sell request uses user rent recipient and no output close authority",
    run: () => {
      const query = buildDflowOrderRequestQuery({
        query: {
          inputMint: "OutcomeMint11111111111111111111111111111111",
          outputMint: USDC_MINT,
          amount: "1000000",
        },
        userPublicKey: WALLET,
        sponsored: true,
        sponsorAddress: SPONSOR,
      });

      assert.equal(query.sponsor, SPONSOR);
      assert.equal(query.sponsorExec, true);
      assert.equal(query.outcomeAccountRentRecipient, WALLET);
      assert.equal(query.outputCloseAuthority, undefined);
      assert.equal(query.rentRecipientDecision, undefined);
      assert.equal(query.outcomeAccountRentRecipientRole, undefined);
      assert.equal(query.outcomeAccountRentRecipientReason, undefined);
    },
  },
  {
    name: "sponsored redemption request uses user rent recipient and does not forward purpose",
    run: () => {
      const query = buildDflowOrderRequestQuery({
        query: {
          inputMint: "OutcomeMint11111111111111111111111111111111",
          outputMint: USDC_MINT,
          amount: "1000000",
          purpose: "redeem",
        },
        userPublicKey: WALLET,
        sponsored: true,
        sponsorAddress: SPONSOR,
      });

      assert.equal(query.sponsor, SPONSOR);
      assert.equal(query.sponsorExec, true);
      assert.equal(query.outcomeAccountRentRecipient, WALLET);
      assert.equal(query.outputCloseAuthority, undefined);
      assert.equal(query.purpose, undefined);
      assert.equal(query.rentRecipientDecision, undefined);
      assert.equal(query.outcomeAccountRentRecipientRole, undefined);
      assert.equal(query.outcomeAccountRentRecipientReason, undefined);
      assert.equal(query.platformFeeBps, undefined);
      assert.equal(query.platformFeeScale, undefined);
      assert.equal(query.platformFeeMode, undefined);
      assert.equal(query.feeAccount, undefined);
    },
  },
  {
    name: "successful sponsored order returns sponsorship fields and no fallback",
    run: async () => {
      const requests: boolean[] = [];
      const ledgerWrites: unknown[] = [];
      const result = await finalizeDflowSponsoredOrderOrFallback(
        baseFinalizeInputs({
          requester: async ({ sponsored }: { sponsored: boolean }) => {
            requests.push(sponsored);
            return { ok: true as const, payload: { transaction: "fallback" } };
          },
          upsertLedger: async (input: unknown) => {
            ledgerWrites.push(input);
          },
        }),
      );

      assert.deepEqual(requests, []);
      assert.equal(result.ok, true);
      assert.equal(result.sponsored, true);
      assert.deepEqual(result.payload, {
        transaction: "refreshedSponsoredTx",
        hunchSponsorshipIntentId: "solsp_test",
        hunchSponsoredDflow: true,
        hunchSponsorAddress: SPONSOR,
      });
      assert.equal(ledgerWrites.length, 1);
    },
  },
  {
    name: "successful sponsored redemption records purpose in sponsorship ledger metadata",
    run: async () => {
      const ledgerWrites: Array<Record<string, unknown>> = [];
      const result = await finalizeDflowSponsoredOrderOrFallback(
        baseFinalizeInputs({
          query: {
            inputMint: "OutcomeMint11111111111111111111111111111111",
            outputMint: USDC_MINT,
            amount: "1000000",
            purpose: "redeem",
          },
          upsertLedger: async (input: Record<string, unknown>) => {
            ledgerWrites.push(input);
          },
        }),
      );

      assert.equal(result.ok, true);
      assert.equal(result.sponsored, true);
      assert.equal(ledgerWrites.length, 1);
      const metadata = ledgerWrites[0]?.metadata as
        | Record<string, unknown>
        | undefined;
      const rentRecipientDecision = metadata?.rentRecipientDecision as
        | Record<string, unknown>
        | undefined;
      assert.equal(metadata?.purpose, "redeem");
      assert.equal(metadata?.maxAtaCreateCount, 0);
      assert.equal(metadata?.expectedDflowOutcomeRentLamports, "0");
      assert.equal(ledgerWrites[0]?.rentLamports, null);
      assert.equal(ledgerWrites[0]?.rentStatus, "unknown");
      assert.equal(
        rentRecipientDecision?.reason,
        "unknown_provenance_user_recipient",
      );
      assert.equal(rentRecipientDecision?.outcomeAccountRentRecipient, WALLET);
      assert.equal(
        rentRecipientDecision?.outcomeAccountRentRecipientRole,
        "user",
      );
      assert.equal(rentRecipientDecision?.outputCloseAuthority, null);
    },
  },
  {
    name: "successful sponsored buy records sponsor rent provenance and locked rent",
    run: async () => {
      const ledgerWrites: Array<Record<string, unknown>> = [];
      const result = await finalizeDflowSponsoredOrderOrFallback(
        baseFinalizeInputs({
          query: {
            inputMint: USDC_MINT,
            outputMint: "OutcomeMint11111111111111111111111111111111",
            amount: "1000000",
          },
          analyzeTransaction: () => ({
            ...fakeAnalysis,
            ataCreateCount: 1,
          }),
          validateSponsoredAnalysis: () => ({
            valid: true,
            reasons: [],
            estimatedSponsorLamports: 2_105_000n,
            estimatedFeeLamports: 5000n,
            systemCreateLamports: 0n,
          }),
          upsertLedger: async (input: Record<string, unknown>) => {
            ledgerWrites.push(input);
          },
        }),
      );

      assert.equal(result.ok, true);
      assert.equal(result.sponsored, true);
      assert.equal(ledgerWrites.length, 1);
      assert.equal(ledgerWrites[0]?.rentLamports, "2100000");
      assert.equal(ledgerWrites[0]?.rentStatus, "locked");
      const metadata = ledgerWrites[0]?.metadata as
        | Record<string, unknown>
        | undefined;
      const rentRecipientDecision = metadata?.rentRecipientDecision as
        | Record<string, unknown>
        | undefined;
      assert.equal(metadata?.maxAtaCreateCount, 1);
      assert.equal(
        rentRecipientDecision?.reason,
        "sponsored_buy_new_outcome_account",
      );
      assert.equal(rentRecipientDecision?.outcomeAccountRentRecipient, SPONSOR);
      assert.equal(
        rentRecipientDecision?.outcomeAccountRentRecipientRole,
        "sponsor",
      );
      assert.equal(rentRecipientDecision?.outputCloseAuthority, SPONSOR);
    },
  },
];

let passed = 0;
for (const test of tests) {
  await test.run();
  passed += 1;
}

console.log(`[dflow-order-sponsorship-tests] passed ${passed}/${tests.length}`);
