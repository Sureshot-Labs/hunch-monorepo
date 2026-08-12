import { randomBytes } from "node:crypto";

import type { Pool, PoolClient } from "@hunch/infra";
import { Interface } from "ethers";

import {
  canonicalAssetKey,
  canonicalLocationKey,
  stableOpaqueId,
} from "../../account-value/canonical.js";
import {
  POLYMARKET_FUNDING_ROUTER_ABI,
  type PolymarketFundingPlan,
} from "../../services/polymarket-funding-router.js";
import {
  fetchErc20Allowance,
  fetchErc20BalanceOf,
  fetchEvmCall,
} from "../../services/polygon-rpc.js";
import type {
  AssetLocation,
  AssetRef,
  JsonValue,
  VenueAccountBinding,
  WalletExecutionProfile,
} from "../domain/types.js";
import {
  canonicalAccountAddress,
  sameAccountAddress,
  sameAsset,
} from "../domain/asset-identity.js";
import { resolveTelegramPolymarketWrapCapability } from "../execution/delegated-funding-capability-resolver.js";
import { POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID } from "../execution/delegated-funding-profile-ids.js";
import { lockTelegramFundingLinkLifecycle } from "../execution/telegram-funding-link-lifecycle-lock.js";
import {
  PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID,
  resolveActionSponsorship,
} from "../execution/sponsorship-policy.js";
import {
  parseTelegramFundingAutomationPolicyV2,
  telegramFundingAutomationPolicyMatchesAuthorization,
} from "../execution/telegram-funding-automation-policy.js";
import {
  canonicalJsonHash,
  fundingSubjectLookupHmac,
} from "../persistence/canonical.js";
import {
  commitFundingOperationInTransaction,
  createFundingQuoteInTransaction,
  FUNDING_OPERATION_RECONCILIATION_TTL_MS,
  type FundingCommitPlan,
} from "../persistence/funding-operation-repository.js";
import type { FundingReceiveReceiptRoutingTarget } from "../persistence/funding-receive-session-repository.js";
import type { FundingReceiveReceiptAutomaticExecution } from "../receive/receive-receipt-router.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import { lockPolymarketFundingOperationPredecessor } from "./polymarket-funding-commit-guard.js";
import {
  buildExactPolymarketDepositUsdceWrapPlan,
  buildPolymarketFundingActionValidation,
  buildPolymarketFundingFollowupAction,
} from "./polymarket-funding-followup.js";
import type { PolymarketRouterFundingSnapshot } from "./polymarket-funding-snapshot.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;
type PreparedOperation = Awaited<
  ReturnType<
    NonNullable<FundingReceiveReceiptAutomaticExecution["prepareOperation"]>
  >
>;

const fundingRouterInterface = new Interface(POLYMARKET_FUNDING_ROUTER_ABI);

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asset(value: unknown): AssetRef | null {
  const candidate = record(value);
  const networkId = string(candidate?.networkId);
  const assetId = string(candidate?.assetId);
  const decimals = candidate?.decimals;
  return networkId &&
    assetId &&
    Number.isInteger(decimals) &&
    Number(decimals) >= 0 &&
    Number(decimals) <= 36
    ? { networkId, assetId, decimals: Number(decimals) }
    : null;
}

function venueBinding(value: unknown): VenueAccountBinding | null {
  const candidate = record(value);
  const settlement = record(candidate?.settlementLocation);
  const settlementAsset = asset(settlement?.asset);
  const details = record(settlement?.details);
  const signingMode = string(candidate?.signingMode);
  if (
    !candidate ||
    !settlement ||
    !settlementAsset ||
    !details ||
    (signingMode !== "web_client" &&
      signingMode !== "privy_authorization" &&
      signingMode !== "privy_delegated")
  ) {
    return null;
  }
  const bindingId = string(candidate.bindingId);
  const venueId = string(candidate.venueId);
  const controllerWalletId = string(candidate.controllerWalletId);
  const executionWalletId = string(candidate.executionWalletId);
  const accountRef = string(candidate.accountRef);
  const kind = string(settlement.kind);
  const locationId = string(settlement.locationId);
  const accountId = string(settlement.accountId);
  return bindingId &&
    venueId &&
    controllerWalletId &&
    executionWalletId &&
    accountRef &&
    kind &&
    locationId &&
    accountId
    ? {
        bindingId,
        venueId,
        controllerWalletId,
        executionWalletId,
        accountRef,
        settlementLocation: {
          kind,
          locationId,
          accountId,
          asset: settlementAsset,
          details: details as JsonRecord,
        },
        signingMode,
      }
    : null;
}

async function routerNonce(input: {
  routerAddress: string;
  signerAddress: string;
}): Promise<bigint> {
  const result = await fetchEvmCall({
    rpcUrl: fundingSidecarRuntimeConfig.polygonRpcUrl,
    timeoutMs: fundingSidecarRuntimeConfig.polygonRpcTimeoutMs,
    to: input.routerAddress,
    data: fundingRouterInterface.encodeFunctionData("fundingNonce", [
      input.signerAddress,
    ]),
  });
  const decoded = fundingRouterInterface.decodeFunctionResult(
    "fundingNonce",
    result,
  ) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "bigint") {
    throw new Error("Polymarket Funding Router nonce is unavailable");
  }
  return value;
}

async function fundingSnapshot(input: {
  signerAddress: string;
  depositWallet: string;
  receiptRaw: string;
  now: Date;
}): Promise<PolymarketRouterFundingSnapshot | null> {
  const routerAddress =
    fundingSidecarRuntimeConfig.polymarketFundingRouterAddress;
  const pUsdAddress = fundingSidecarRuntimeConfig.polymarketPusdAddress;
  const usdceAddress = fundingSidecarRuntimeConfig.polymarketUsdceAddress;
  if (!routerAddress || BigInt(input.receiptRaw) <= 0n) return null;
  const rpc = {
    rpcUrl: fundingSidecarRuntimeConfig.polygonRpcUrl,
    timeoutMs: fundingSidecarRuntimeConfig.polygonRpcTimeoutMs,
  };
  const [depositPusdRaw, depositUsdceRaw, allowanceRaw, nonce] =
    await Promise.all([
      fetchErc20BalanceOf({
        ...rpc,
        tokenAddress: pUsdAddress,
        owner: input.depositWallet,
      }),
      fetchErc20BalanceOf({
        ...rpc,
        tokenAddress: usdceAddress,
        owner: input.depositWallet,
      }),
      fetchErc20Allowance({
        ...rpc,
        tokenAddress: usdceAddress,
        owner: input.depositWallet,
        spender: routerAddress,
      }),
      routerNonce({
        routerAddress,
        signerAddress: input.signerAddress,
      }),
    ]);
  const receiptRaw = BigInt(input.receiptRaw);
  if (depositUsdceRaw < receiptRaw || allowanceRaw < receiptRaw) return null;
  return {
    signerAddress: input.signerAddress,
    depositWallet: input.depositWallet,
    depositPusdRaw: depositPusdRaw.toString(),
    // The exact receipt operation must not consume pre-existing pUSD.
    depositLockedRaw: depositPusdRaw.toString(),
    depositUsdceRaw: depositUsdceRaw.toString(),
    signerPusdRaw: "0",
    signerUsdceRaw: "0",
    fundingCapRaw: input.receiptRaw,
    routerAddress,
    routerNonceRaw: nonce.toString(),
    depositRouterUsdceAllowanceRaw: allowanceRaw.toString(),
    routerPusdAllowanceRaw: "0",
    routerUsdceAllowanceRaw: "0",
    clobPusdRaw: null,
    observedAt: input.now.toISOString(),
  };
}

function sourceLocation(target: FundingReceiveReceiptRoutingTarget): {
  location: AssetLocation;
  componentId: string;
} {
  const address = canonicalAccountAddress(
    target.receipt.asset.networkId,
    target.receipt.destinationAddress,
  );
  const location: AssetLocation = {
    kind: "venue_account",
    locationId: stableOpaqueId(
      "location",
      [
        target.userId,
        "venue_account",
        address,
        canonicalAssetKey(target.receipt.asset),
      ].join(":"),
    ),
    accountId: target.userId,
    asset: target.receipt.asset,
    details: {
      address,
      balanceClass: target.venueId,
      venueId: target.venueId,
    },
  };
  return {
    location,
    componentId: stableOpaqueId("asset", canonicalLocationKey(location)),
  };
}

function commitPlan(input: {
  target: FundingReceiveReceiptRoutingTarget;
  binding: VenueAccountBinding;
  profile: WalletExecutionProfile;
  snapshot: PolymarketRouterFundingSnapshot;
  plan: PolymarketFundingPlan;
  now: Date;
}): FundingCommitPlan {
  const operationIdentity = canonicalJsonHash({
    receiptId: input.target.receipt.receiptId,
    authorizationId: input.target.telegramFundingAuthorizationId,
    fundingPlan: input.plan,
  });
  const action = buildPolymarketFundingFollowupAction({
    binding: input.binding,
    canonicalRouterAddress: input.snapshot.routerAddress,
    inspectionRevision: operationIdentity,
    operationId: stableOpaqueId("funding_quote", operationIdentity),
    plan: input.plan,
  });
  const sponsorship = resolveActionSponsorship({
    action,
    profile: input.profile,
  });
  const source = sourceLocation(input.target);
  const requestedSource = {
    asset: input.target.receipt.asset,
    raw: input.target.receipt.rawAmount,
  } as const;
  const requestedDestination = {
    asset: input.target.destinationAsset,
    raw: input.target.receipt.rawAmount,
  } as const;
  const reservationExpiresAt = new Date(
    input.now.getTime() + FUNDING_OPERATION_RECONCILIATION_TTL_MS,
  ).toISOString();
  return {
    operation: {
      purpose: "add_funds",
      initialState: { status: "in_progress", stage: "committed" },
      experienceMode: "prepare_first",
      planKind: "venue_preparation",
      sourceSnapshot: {
        kind: "venue_preparation",
        venueId: "polymarket",
        venueBindingId: input.binding.bindingId,
        inputCount: 1,
      },
      destinationTargetSnapshot: input.target.destinationTargetSnapshot,
      externalRecipientId: null,
      venueId: "polymarket",
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: input.target.venueBindingSnapshot,
      walletExecutionSnapshot: input.profile as unknown as JsonRecord,
      placementSnapshot: {},
      requestedSourceAmount: requestedSource as unknown as JsonRecord,
      requestedDestinationAmount: requestedDestination as unknown as JsonRecord,
      supportMetadata: {
        adapterId: "polymarket_funding_router_v1",
        preparationKind: "polymarket_funding_router",
        venueBindingOptionId: input.target.venueBindingOptionId,
        fundingPlan: input.plan as unknown as JsonRecord,
        before: {
          routerNonceRaw: input.snapshot.routerNonceRaw,
          depositPusdRaw: input.snapshot.depositPusdRaw,
          clobPusdRaw: input.snapshot.clobPusdRaw,
          observedAt: input.snapshot.observedAt,
        },
      },
    },
    segments: [],
    steps: [
      {
        ordinal: 0,
        segmentOrdinal: null,
        stepKind: "venue_preparation",
        state: "planned",
        actionFingerprint: canonicalJsonHash(action),
        executorId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
        payerRequirement: sponsorship.payerRequirement,
        dependsOnOrdinal: null,
        normalizedAction: action as unknown as JsonRecord,
        // The 60-second quote gates commit only. This exact amount/nonce/
        // destination contract has no provider price or time validity.
        actionExpiresAt: null,
        actionValidationResult: {
          ...buildPolymarketFundingActionValidation({
            destinationAssetId: input.target.destinationAsset.assetId,
            plan: input.plan,
            profileAddress: input.profile.address,
            routerAddress: input.snapshot.routerAddress,
            sponsorship,
          }),
          activation: "after_verified_ingress",
        },
      },
    ],
    reservations: [
      {
        segmentOrdinal: null,
        componentId: source.componentId,
        locationId: source.location.locationId,
        networkId: input.target.receipt.asset.networkId,
        assetId: input.target.receipt.asset.assetId,
        assetDecimals: input.target.receipt.asset.decimals,
        rawAmount: input.target.receipt.rawAmount,
        mode: "subtract_available",
        expiresAt: reservationExpiresAt,
      },
    ],
  };
}

export function createPolymarketReceiptOperationPreparer(input: {
  subjectLookupHmacKey: string;
  subjectLookupKeyVersion: number;
}): NonNullable<FundingReceiveReceiptAutomaticExecution["prepareOperation"]> {
  return async (db: Pool, target, now): Promise<PreparedOperation> => {
    const automation = parseTelegramFundingAutomationPolicyV2(
      target.telegramAutomationPolicy,
    );
    const binding = venueBinding(target.venueBindingSnapshot);
    const linkedAddress = string(
      binding?.settlementLocation.details.linkedAddress,
    );
    if (
      !automation ||
      !binding ||
      target.ownerChannel !== "telegram" ||
      target.venueId !== "polymarket" ||
      binding.venueId !== "polymarket" ||
      !sameAccountAddress(
        "evm:137",
        binding.accountRef,
        target.receipt.destinationAddress,
      ) ||
      !sameAsset(binding.settlementLocation.asset, target.destinationAsset) ||
      !linkedAddress ||
      !target.telegramAccountId ||
      !target.telegramUserId
    ) {
      return null;
    }
    const capability = await resolveTelegramPolymarketWrapCapability(db, {
      userId: target.userId,
      telegramAccountId: target.telegramAccountId,
      telegramUserId: target.telegramUserId,
      destinationOptionId: target.destinationOptionId,
      venueBindingOptionId: target.venueBindingOptionId,
      expectedAuthorizationId: automation.authorizationId,
      expectedAuthorizationFingerprint: automation.authorizationFingerprint,
      expectedFundingPolicyRevision: automation.fundingPolicyRevision,
      now,
    });
    const authorization = capability.authorization;
    if (
      capability.decision.kind !== "allowed" ||
      !authorization ||
      !telegramFundingAutomationPolicyMatchesAuthorization(
        automation,
        authorization,
      ) ||
      !sameAccountAddress("evm:137", authorization.walletAddress, linkedAddress)
    ) {
      return null;
    }
    const snapshot = await fundingSnapshot({
      signerAddress: authorization.walletAddress,
      depositWallet: target.receipt.destinationAddress,
      receiptRaw: target.receipt.rawAmount,
      now,
    });
    if (!snapshot) return null;
    const plan = buildExactPolymarketDepositUsdceWrapPlan({
      receiptRaw: target.receipt.rawAmount,
      snapshot,
    });
    if (!plan) return null;
    const profile: WalletExecutionProfile = {
      walletId: binding.executionWalletId,
      controllerWalletRef: authorization.userWalletId,
      networkId: "evm:137",
      address: authorization.walletAddress,
      source: "embedded",
      signingModes: ["privy_authorization"],
      serverWalletRef: authorization.privyWalletId,
      sponsorshipPolicyIds: [PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID],
      evmAtomicBatchMode: null,
    };
    const frozenPlan = commitPlan({
      target,
      binding,
      profile,
      snapshot,
      plan,
      now,
    });
    const consentToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + 60_000);
    return {
      verify: async (client: PoolClient) => {
        // Consent, unlink, grant, route commit, and the later broadcast
        // boundary share this first lock. Do not reorder the mutable rows.
        await lockTelegramFundingLinkLifecycle(client, target.userId);
        const current = await resolveTelegramPolymarketWrapCapability(client, {
          userId: target.userId,
          telegramAccountId: target.telegramAccountId as string,
          telegramUserId: target.telegramUserId as string,
          destinationOptionId: target.destinationOptionId,
          venueBindingOptionId: target.venueBindingOptionId,
          expectedAuthorizationId: automation.authorizationId,
          expectedAuthorizationFingerprint: automation.authorizationFingerprint,
          expectedFundingPolicyRevision: automation.fundingPolicyRevision,
          now,
          lock: true,
        });
        if (
          current.decision.kind !== "allowed" ||
          !current.authorization ||
          !telegramFundingAutomationPolicyMatchesAuthorization(
            automation,
            current.authorization,
          ) ||
          !sameAccountAddress(
            "evm:137",
            current.authorization.walletAddress,
            authorization.walletAddress,
          )
        ) {
          throw new Error("delegated funding authority changed before commit");
        }
        await lockPolymarketFundingOperationPredecessor(client, {
          userId: target.userId,
          venueBindingOptionId: target.venueBindingOptionId,
        });
      },
      commit: async (client: PoolClient) => {
        const quote = await createFundingQuoteInTransaction(client, {
          userId: target.userId,
          discoveryProjectionId: stableOpaqueId(
            "funding_projection",
            target.receipt.receiptId,
          ),
          selectedSourceOptionSnapshot:
            frozenPlan.operation.sourceSnapshot ?? {},
          marketContextSnapshot: null,
          destinationOptionSnapshot: target.destinationTargetSnapshot,
          venueBindingSnapshot: target.venueBindingSnapshot,
          planSnapshot: frozenPlan,
          policyVersion: target.policyVersion,
          policyRevision: automation.fundingPolicyRevision,
          canonicalRequest: {
            kind: "automatic_receive_receipt",
            receiptId: target.receipt.receiptId,
            observationRevision: target.receipt.observationRevision,
            authorizationId: automation.authorizationId,
            authorizationFingerprint: automation.authorizationFingerprint,
            ownershipRevision: target.ownershipRevision,
          },
          consentToken,
          expiresAt,
        });
        const committed = await commitFundingOperationInTransaction(client, {
          userId: target.userId,
          quoteId: quote.id,
          consentToken,
          idempotencyKey: `receive-receipt:${target.receipt.receiptId}`,
          plan: frozenPlan,
          subjectLookupHmac: fundingSubjectLookupHmac(
            target.userId,
            input.subjectLookupHmacKey,
          ),
          subjectLookupKeyVersion: input.subjectLookupKeyVersion,
          now,
        });
        return committed.operation.id;
      },
    };
  };
}
