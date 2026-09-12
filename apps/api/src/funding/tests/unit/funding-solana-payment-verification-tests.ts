import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import {
  AccountLayout,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  prepareFundingSolanaPayment,
  type RelaySponsorRedis,
} from "../../execution/relay-solana-sponsorship.js";
import { DIRECT_SOLANA_WITHDRAWAL_FEE_ONLY_POLICY } from "../../execution/direct-solana-sponsorship-policy.js";
import {
  buildExactSolWithdrawalAction,
  buildExactUsdcWithdrawalAction,
} from "../../execution/direct-withdrawal-transfer.js";
import {
  relaySolanaActionMessage,
  RELAY_SOLANA_FEE_ONLY_POLICY,
} from "../../../funding-providers/relay/solana-sponsorship.js";
import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";
import { RELAY_SOLANA_DEPOSITORY } from "../../../funding-providers/relay/solana-rehearsal.js";
import { applyEmbeddedSolanaBackendSponsorshipPolicy } from "../../../routes/embedded-wallets.js";
import { assertClientExecutable } from "../../execution/operation-action-runtime.js";
import { prepareEmbeddedSolanaTransactionRequests } from "../../../services/embedded-solana.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import {
  deriveFundingLifecycle,
  type FundingLifecycleFacts,
} from "../../lifecycle/funding-lifecycle-projector.js";
import type {
  ResolvedExternalRecipient,
  WalletExecutionProfile,
  SvmTransactionAction,
} from "../../domain/types.js";

const sender = Keypair.generate().publicKey;
const receiver = Keypair.generate().publicKey;
const feePayer = Keypair.generate().publicKey;
const asset = {
  networkId: "solana:mainnet",
  assetId: SystemProgram.programId.toBase58(),
  decimals: 9,
};
const profile: WalletExecutionProfile = {
  walletId: "wallet_test",
  address: sender.toBase58(),
  networkId: asset.networkId,
  source: "embedded",
  serverWalletRef: "privy-test",
  controllerWalletRef: "controller-test",
  signingModes: ["privy_authorization"],
  sponsorshipPolicyIds: [],
};
const recipient = {
  address: receiver.toBase58(),
  addressFingerprint: "recipient-fingerprint",
  asset,
  networkId: asset.networkId,
} as ResolvedExternalRecipient;
const built = buildExactSolWithdrawalAction({
  profile,
  recipient,
  amount: { asset, raw: "2995000" },
});
const serialize = (action: SvmTransactionAction = built.action) =>
  Buffer.from(
    new VersionedTransaction(
      relaySolanaActionMessage(
        action,
        profile.address,
        SystemProgram.programId.toBase58(),
      ).compileToV0Message(),
    ).serialize(),
  ).toString("base64");
const now = new Date();
const facts: FundingLifecycleFacts = {
  now,
  plan: {
    initialState: { status: "awaiting_user", progressStage: "source_action" },
    requestedDestination: { ...asset, raw: "2995000" },
    routeLegs: [],
    completionEvidence: "destination_credit",
  },
  actions: [
    {
      actionId: "step",
      ordinal: 0,
      executorId: "wallet_profile_svm_v1",
      routeLegId: null,
      dependsOnActionId: null,
      activation: "immediate",
      expiresAt: new Date(now.getTime() + 60000),
      independentLane: true,
      mayMoveMoney: true,
      safeInternalHandoff: false,
      requiresSourceDebitEvidence: false,
      requiresVenueReadiness: false,
      attempts: [
        {
          attemptNumber: 1,
          outcome: "started",
          broadcastMayHaveOccurred: false,
          referenceKind: null,
          startedAt: now,
          updatedAt: now,
          receipt: null,
        },
      ],
    },
  ],
  transfers: [],
  reservations: [{ mode: "subtract_available", state: "active" }],
  consumer: { required: false, completed: false, unresolved: false },
  receive: null,
};
let nativeBalance = 2995000;
let budgetAllowed = true;
let charged = 0;
let failRpc = false;
let failSimulation = false;
const mint = new PublicKey(RELAY_PINNED_ASSETS.solanaUsdc);
const sourceAta = getAssociatedTokenAddressSync(mint, sender);
const relayAta = getAssociatedTokenAddressSync(mint, feePayer);
let destinationExists = true;
let frozen = false;
function tokenInfo(owner: PublicKey) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount: 3000000n,
      delegateOption: 0,
      delegate: SystemProgram.programId,
      state: frozen ? 2 : 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: SystemProgram.programId,
    },
    data,
  );
  return {
    data,
    lamports: 2039280,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
  };
}
const connection = {
  getAccountInfo: async (key: PublicKey) => {
    if (failRpc)
      throw new Error("RPC unavailable at https://secret.invalid/?key=private");
    return {
      owner: SystemProgram.programId,
      data: Buffer.alloc(0),
      executable: false,
      lamports: key.equals(sender) ? nativeBalance : 100000000,
    };
  },
  getSlotLeader: async () => feePayer.toBase58(),
  getLatestBlockhash: async () => ({
    blockhash: SystemProgram.programId.toBase58(),
    lastValidBlockHeight: 100,
  }),
  getFeeForMessage: async () => ({ value: 5000 }),
  getSlot: async () => 10,
  getMultipleAccountsInfo: async () => [
    tokenInfo(sender),
    destinationExists ? tokenInfo(receiver) : null,
  ],
  getMultipleAccountsInfoAndContext: async () => ({
    context: { slot: 10 },
    value: [
      tokenInfo(sender),
      destinationExists ? tokenInfo(feePayer) : null,
      null,
    ],
  }),
  getMinimumBalanceForRentExemption: async () => 2039280,
  simulateTransaction: async () => ({
    value: {
      err: failSimulation ? "AccountNotFound" : null,
      innerInstructions: [
        {
          instructions: [
            {
              programId: TOKEN_PROGRAM_ID,
              parsed: {
                type: "transferChecked",
                info: {
                  source: sourceAta.toBase58(),
                  destination: relayAta.toBase58(),
                  authority: sender.toBase58(),
                  mint: mint.toBase58(),
                  tokenAmount: { amount: "2000000" },
                },
              },
            },
          ],
        },
      ],
    },
  }),
} as unknown as Connection;
const cache = new Map<string, string>();
const redis: RelaySponsorRedis = {
  get: async (key) => cache.get(key) ?? null,
  set: async (key, value) => {
    if (!cache.has(key)) cache.set(key, value);
    return "OK";
  },
  eval: async () => {
    charged++;
    return budgetAllowed ? 1 : 0;
  },
};
const row = {
  operation_id: "operation",
  step_id: "step",
  normalized_action: built.action,
  action_fingerprint: canonicalJsonHash(built.action),
  action_validation_result: {
    ...built.validation,
    sponsorshipPolicyId: DIRECT_SOLANA_WITHDRAWAL_FEE_ONLY_POLICY,
    withdrawalUserSolCostRaw: "0",
  },
  external_recipient_id: "recipient",
  wallet_execution_snapshot: profile,
  provider_id: "direct_wallet",
  payer_requirement: "privy_sponsor",
};
let candidateRows: unknown[] = [row];
const db = {
  query: async () => ({ rows: candidateRows }),
} as unknown as Parameters<typeof prepareFundingSolanaPayment>[0]["db"];
const input: Parameters<typeof prepareFundingSolanaPayment>[0] = {
  db,
  redis,
  userId: "user",
  signer: profile.address,
  requestId: built.action.actionId,
  transaction: serialize(),
  requestedSponsor: true,
  dependencies: {
    connection,
    loadLifecycle: async () => ({
      facts,
      lifecycle: deriveFundingLifecycle(facts),
    }),
    resolveRecipient: async () => recipient,
  },
};
const originalFlag = process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED;
process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = "true";
try {
  const prepared = await prepareFundingSolanaPayment(input);
  assert.equal(prepared?.payment.binding.payer, "privy_sponsor");
  assert.equal(prepared?.payment.requiredSignerLamports, 2995000n);
  assert.equal(charged, 0, "Prepare must not charge the execution budget");
  assert.ok(prepared);
  await prepareFundingSolanaPayment({
    ...input,
    execute: true,
    expectedBinding: prepared.payment.binding,
  });
  assert.equal(charged, 1);
  budgetAllowed = false;
  await assert.rejects(
    prepareFundingSolanaPayment({
      ...input,
      execute: true,
      expectedBinding: prepared.payment.binding,
    }),
    /limit reached/,
  );
  budgetAllowed = true;
  await assert.rejects(
    prepareFundingSolanaPayment({
      ...input,
      expectedBinding: { ...prepared.payment.binding, attemptNumber: 2 },
    }),
    /current attempt/,
  );
  await assert.rejects(
    prepareFundingSolanaPayment({ ...input, requestedSponsor: false }),
    /payer/,
  );
  process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = "false";
  await assert.rejects(prepareFundingSolanaPayment(input), /payer/);
  process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = "true";
  candidateRows = [];
  await assert.rejects(
    prepareFundingSolanaPayment({
      ...input,
      execute: true,
      expectedBinding: prepared.payment.binding,
    }),
    /current owned/,
  );
  candidateRows = [row, row];
  await assert.rejects(
    prepareFundingSolanaPayment(input),
    /cannot be verified/,
  );
  candidateRows = [{ ...row, action_fingerprint: "changed" }];
  await assert.rejects(prepareFundingSolanaPayment(input), /action changed/);
  candidateRows = [
    { ...row, wallet_execution_snapshot: { ...profile, source: "external" } },
  ];
  await assert.rejects(prepareFundingSolanaPayment(input), /ownership/);
  candidateRows = [row];
  await assert.rejects(
    prepareFundingSolanaPayment({ ...input, signer: receiver.toBase58() }),
    /ownership/,
  );
  const changed = buildExactSolWithdrawalAction({
    profile,
    recipient,
    amount: { asset, raw: "2995001" },
  });
  await assert.rejects(
    prepareFundingSolanaPayment({
      ...input,
      transaction: serialize(changed.action),
    }),
    /message changed/,
  );
  const destinationChanged = buildExactSolWithdrawalAction({
    profile,
    recipient: { ...recipient, address: feePayer.toBase58() },
    amount: { asset, raw: "2995000" },
  });
  await assert.rejects(
    prepareFundingSolanaPayment({
      ...input,
      transaction: serialize(destinationChanged.action),
    }),
    /message changed/,
  );
  failSimulation = true;
  await assert.rejects(prepareFundingSolanaPayment(input), /simulation failed/);
  failSimulation = false;
  failRpc = true;
  await assert.rejects(
    prepareFundingSolanaPayment(input),
    (error) =>
      error instanceof Error &&
      /funding payment could not be verified/.test(error.message) &&
      !error.message.includes("secret.invalid"),
  );
  failRpc = false;
  const activeAction = facts.actions[0];
  const activeAttempt = activeAction?.attempts[0];
  assert.ok(activeAction);
  assert.ok(activeAttempt);
  assert.ok(input.dependencies);
  const uncertainFacts: FundingLifecycleFacts = {
    ...facts,
    actions: [
      {
        ...activeAction,
        attempts: [
          {
            ...activeAttempt,
            outcome: "ambiguous",
            broadcastMayHaveOccurred: true,
          },
        ],
      },
    ],
  };
  await assert.rejects(
    prepareFundingSolanaPayment({
      ...input,
      dependencies: {
        ...input.dependencies,
        loadLifecycle: async () => ({
          facts: uncertainFacts,
          lifecycle: deriveFundingLifecycle(uncertainFacts),
        }),
      },
    }),
    /current funding attempt/,
  );
  const expiredFacts = { ...facts, now: new Date(now.getTime() + 120000) };
  await assert.rejects(
    prepareFundingSolanaPayment({
      ...input,
      dependencies: {
        ...input.dependencies,
        loadLifecycle: async () => ({
          facts: expiredFacts,
          lifecycle: deriveFundingLifecycle(expiredFacts),
        }),
      },
    }),
    /no longer available/,
  );
  // Exact user-paid fee, with no extra 0.003 SOL buffer. The same proof path
  // applies even when sponsorship is globally disabled.
  cache.clear();
  nativeBalance = 3000000;
  process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = "false";
  candidateRows = [
    {
      ...row,
      payer_requirement: "user",
      action_validation_result: {
        ...row.action_validation_result,
        withdrawalUserSolCostRaw: "5000",
        sponsorshipPolicyId: null,
      },
    },
  ];
  const userPaid = await prepareFundingSolanaPayment({
    ...input,
    requestedSponsor: false,
  });
  assert.ok(userPaid);
  assert.equal(userPaid?.payment.binding.payer, "user");
  assert.equal(userPaid?.payment.requiredSignerLamports, 3000000n);
  const beforeCharge = charged;
  await prepareFundingSolanaPayment({
    ...input,
    requestedSponsor: false,
    execute: true,
    expectedBinding: userPaid.payment.binding,
  });
  assert.equal(
    charged,
    beforeCharge,
    "User-paid execution never consumes sponsor budget",
  );
  nativeBalance--;
  await assert.rejects(
    prepareFundingSolanaPayment({ ...input, requestedSponsor: false }),
    /withdrawal sponsorship changed/,
  );
  // Actual Relay proof -> HTTP policy -> generic builder, with zero SOL.
  process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = "true";
  nativeBalance = 0;
  const deposit = Buffer.alloc(48, 1);
  Buffer.from("0b9c60da27a3b413", "hex").copy(deposit);
  deposit.writeBigUInt64LE(2000000n, 8);
  const relayAddresses = [
    receiver,
    sender,
    sender,
    feePayer,
    mint,
    sourceAta,
    relayAta,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
  ];
  const relayAction: SvmTransactionAction = {
    kind: "svm_transaction",
    actionId: `relay:${"a".repeat(64)}:deposit`,
    networkId: asset.networkId,
    signerWalletId: profile.walletId,
    addressLookupTables: [],
    instructions: [
      {
        programId: RELAY_SOLANA_DEPOSITORY,
        data: deposit.toString("hex"),
        dataEncoding: "hex",
        accounts: relayAddresses.map((key, i) => ({
          address: key.toBase58(),
          signer: i === 1,
          writable: [1, 5, 6].includes(i),
        })),
      },
    ],
  };
  const verifyRoute = async (
    action: SvmTransactionAction,
    sponsored = true,
  ) => {
    cache.clear();
    const policy = await applyEmbeddedSolanaBackendSponsorshipPolicy({
      user: { id: "user" } as Parameters<
        typeof applyEmbeddedSolanaBackendSponsorshipPolicy
      >[0]["user"],
      signer: profile.address,
      transactions: [
        {
          id: action.actionId,
          label: "Funding transaction",
          transaction: serialize(action),
          sponsor: sponsored,
        },
      ],
      dependencies: {
        lossCloseEnabled: async () => false,
        getRedis: async () => null,
        prepareFunding: async (routeInput) =>
          prepareFundingSolanaPayment({
            ...routeInput,
            db,
            redis,
            dependencies: input.dependencies,
          }),
      },
    });
    const requests = await prepareEmbeddedSolanaTransactionRequests({
      context: {
        signer: profile.address,
        walletId: "privy-test",
        walletProfile: {
          walletId: "privy-test",
          address: profile.address,
          walletType: "solana",
          source: "embedded",
          isInternalWallet: true,
        },
      },
      transactions: policy.transactions,
      embeddedSolanaSponsorshipEnabled: policy.embeddedSolanaSponsorshipEnabled,
      fundingPayment: policy.fundingPayment,
      fetchSponsorBalanceLamports: async () => BigInt(nativeBalance),
    });
    assert.equal(requests[0]?.input.body.sponsor, sponsored);
    return requests;
  };
  assert.equal(
    assertClientExecutable(
      relayAction,
      "wallet_profile_svm_v1",
      [profile],
      "privy_sponsor",
    ).payerRequirement,
    "privy_sponsor",
  );
  process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = "false";
  assert.throws(
    () =>
      assertClientExecutable(
        relayAction,
        "wallet_profile_svm_v1",
        [profile],
        "privy_sponsor",
      ),
    /fee payer changed/,
  );
  assert.equal(
    assertClientExecutable(
      relayAction,
      "wallet_profile_svm_v1",
      [profile],
      "user",
    ).payerRequirement,
    "user",
  );
  process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = "true";
  // A user-paid native Relay action is not a sponsored USDC action and must
  // still reach the legacy native guard, not a new funding-ID rejection.
  const nativeRelay = {
    ...built.action,
    actionId: "relay:native-intent:deposit",
  };
  candidateRows = [
    {
      ...row,
      provider_id: "relay",
      payer_requirement: "user",
      normalized_action: nativeRelay,
      action_fingerprint: canonicalJsonHash(nativeRelay),
    },
  ];
  nativeBalance = 10000000;
  await verifyRoute(nativeRelay, false);
  candidateRows = [
    {
      ...row,
      provider_id: "relay",
      normalized_action: relayAction,
      action_fingerprint: canonicalJsonHash(relayAction),
      action_validation_result: {
        sponsorshipPolicyId: RELAY_SOLANA_FEE_ONLY_POLICY,
      },
    },
  ];
  await verifyRoute(relayAction);
  nativeBalance = 10000000;
  await verifyRoute(relayAction);
  frozen = true;
  await assert.rejects(verifyRoute(relayAction), /existing-account USDC/);
  frozen = false;
  destinationExists = false;
  await assert.rejects(verifyRoute(relayAction), /existing-account USDC/);
  destinationExists = true;
  // Direct USDC uses the same final-payer boundary; ATA creation remains user paid.
  const tokenAsset = { ...asset, assetId: mint.toBase58(), decimals: 6 };
  const tokenRecipient = { ...recipient, asset: tokenAsset };
  const tokenBuilt = buildExactUsdcWithdrawalAction({
    profile,
    recipient: tokenRecipient,
    amount: { asset: tokenAsset, raw: "2000000" },
    createRecipientAta: false,
  });
  input.dependencies = {
    ...input.dependencies,
    resolveRecipient: async () => tokenRecipient,
  };
  candidateRows = [
    {
      ...row,
      normalized_action: tokenBuilt.action,
      action_fingerprint: canonicalJsonHash(tokenBuilt.action),
      action_validation_result: {
        ...tokenBuilt.validation,
        sponsorshipPolicyId: DIRECT_SOLANA_WITHDRAWAL_FEE_ONLY_POLICY,
        withdrawalUserSolCostRaw: "0",
      },
    },
  ];
  nativeBalance = 0;
  await verifyRoute(tokenBuilt.action);
  nativeBalance = 10000000;
  await verifyRoute(tokenBuilt.action);
  const ataBuilt = buildExactUsdcWithdrawalAction({
    profile,
    recipient: tokenRecipient,
    amount: { asset: tokenAsset, raw: "2000000" },
    createRecipientAta: true,
  });
  destinationExists = false;
  candidateRows = [
    {
      ...row,
      normalized_action: ataBuilt.action,
      action_fingerprint: canonicalJsonHash(ataBuilt.action),
      payer_requirement: "user",
      action_validation_result: {
        ...ataBuilt.validation,
        withdrawalUserSolCostRaw: "2044280",
      },
    },
  ];
  await verifyRoute(ataBuilt.action, false);
  nativeBalance = 0;
  await assert.rejects(
    verifyRoute(ataBuilt.action, false),
    /withdrawal sponsorship changed/,
  );
  console.log(
    "[funding-solana-payment-verification-tests] exact proof, ownership, payer, native costs, simulation, expiry, uncertainty and budgets passed",
  );
} finally {
  if (originalFlag === undefined)
    delete process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED;
  else process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = originalFlag;
}
