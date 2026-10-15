import { z } from "zod";
import type {
  AssetLocation,
  FundingTarget,
  ExternalHandoffAction,
  JsonObject,
  Money,
  NormalizedAction,
  WalletExecutionProfile,
} from "../../funding/domain/types.js";
import {
  sameAccountAddress,
  sameAsset,
} from "../../funding/domain/asset-identity.js";
import {
  HYPERCORE_MAINNET_USDC,
  isHypercoreMainnetUsdc,
  hypercoreLocationDex,
  RELAY_HYPERCORE_EXECUTOR,
} from "../../funding/domain/hypercore-identity.js";
import {
  canonicalJsonEqual,
  canonicalJsonHash,
} from "../../funding/persistence/canonical.js";
import type { FundingCommitStep } from "../../funding/persistence/funding-operation-repository.js";
import {
  relayHypercorePairBindingSchema,
  validateRelayHypercorePayloads,
} from "./hypercore-actions.js";
import type { validateRelayHypercoreQuote } from "./hypercore-quote.js";

export { RELAY_HYPERCORE_EXECUTOR };
export const RELAY_HYPERCORE_AUTH = "relay_hypercore_nonce_mapping_v1";
export const RELAY_HYPERCORE_SEND = "relay_hypercore_send_asset_v1";

const moneySchema = z
  .object({
    asset: z
      .object({
        networkId: z.string().min(1),
        assetId: z.string().min(1),
        decimals: z.number().int().nonnegative(),
      })
      .strict(),
    raw: z.string().regex(/^[1-9]\d*$/),
  })
  .strict();
const actionSchema = z
  .object({
    kind: z.literal("external_handoff"),
    actionId: z.string().min(1),
    networkId: z.literal(HYPERCORE_MAINNET_USDC.networkId),
    actorWalletId: z.string().min(1),
    handoffKind: z.enum([RELAY_HYPERCORE_AUTH, RELAY_HYPERCORE_SEND]),
    payload: z
      .object({
        binding: relayHypercorePairBindingSchema,
        minimumOutput: moneySchema,
        requestFingerprint: z.string().regex(/^[\da-f]{64}$/),
        quoteFingerprint: z.string().regex(/^[\da-f]{64}$/),
        contractsRevision: z.string().regex(/^[\da-f]{64}$/),
        expiresAt: z.string().datetime(),
        data: z.unknown(),
        destinationTarget: z.unknown(),
        recipientAddress: z.string().regex(/^0x[\da-fA-F]{40}$/),
      })
      .strict(),
  })
  .strict();

/** Only exact native adapter names, never a namespace/prefix permission. */
export function isRelayHypercoreHandoff(
  action: NormalizedAction,
): action is ExternalHandoffAction & {
  handoffKind: typeof RELAY_HYPERCORE_AUTH | typeof RELAY_HYPERCORE_SEND;
} {
  return (
    action.kind === "external_handoff" &&
    (action.handoffKind === RELAY_HYPERCORE_AUTH ||
      action.handoffKind === RELAY_HYPERCORE_SEND)
  );
}

/** Classification only; final admission still rechecks authority/capacity.
 * The sole supported signature leg is the bound non-monetary mapping paired
 * with its dependent native send. Never opt arbitrary signatures into a plan. */
export function isRelayHypercoreClientPair(
  steps: readonly FundingCommitStep[],
): boolean {
  const [authStep, sendStep] = steps;
  if (
    steps.length !== 2 ||
    !authStep ||
    !sendStep ||
    authStep.executorId !== RELAY_HYPERCORE_EXECUTOR ||
    sendStep.executorId !== RELAY_HYPERCORE_EXECUTOR ||
    authStep.stepKind !== "signature" ||
    sendStep.stepKind !== "external_handoff" ||
    authStep.dependsOnOrdinal !== null ||
    sendStep.dependsOnOrdinal !== authStep.ordinal ||
    authStep.segmentOrdinal !== sendStep.segmentOrdinal
  )
    return false;
  try {
    const [auth, send] = z
      .tuple([actionSchema, actionSchema])
      .parse([authStep.normalizedAction, sendStep.normalizedAction]);
    const { data: authorization, ...authCommon } = auth.payload;
    const { data: transfer, ...sendCommon } = send.payload;
    if (
      auth.handoffKind !== RELAY_HYPERCORE_AUTH ||
      send.handoffKind !== RELAY_HYPERCORE_SEND ||
      auth.actorWalletId !== send.actorWalletId ||
      auth.actionId === send.actionId ||
      !canonicalJsonEqual(authCommon, sendCommon)
    )
      return false;
    validateRelayHypercorePayloads(
      { authorization, transfer },
      auth.payload.binding,
    );
    return true;
  } catch {
    return false;
  }
}

export function relayHypercoreNormalizedActions(input: {
  validated: ReturnType<typeof validateRelayHypercoreQuote>;
  minimumOutput: Money;
  actorWalletId: string;
  quoteCorrelationId: string;
  destinationTarget: FundingTarget;
  recipientAddress: string;
}): readonly ExternalHandoffAction[] {
  const result = input.validated;
  const { requestId, ...binding } = result.actions.binding;
  const common = {
    binding,
    minimumOutput: input.minimumOutput,
    requestFingerprint: canonicalJsonHash({ provider: "relay", requestId }),
    quoteFingerprint: result.fingerprint,
    contractsRevision: result.contractsRevision,
    expiresAt: result.expiresAt.toISOString(),
    destinationTarget: input.destinationTarget,
    recipientAddress: input.recipientAddress,
  };
  return (
    [
      [RELAY_HYPERCORE_AUTH, result.actions.payloads.authorization],
      [RELAY_HYPERCORE_SEND, result.actions.payloads.transfer],
    ] as const
  ).map(([handoffKind, data], index) => ({
    kind: "external_handoff",
    actionId: `${input.quoteCorrelationId}:native:${index}`,
    networkId: HYPERCORE_MAINNET_USDC.networkId,
    actorWalletId: input.actorWalletId,
    handoffKind,
    payload: structuredClone({ ...common, data }) as JsonObject,
  }));
}

/** Uses the common commit-step contract. A verified nonce mapping is a
 * non-monetary signature step; only the dependent SendAsset may move funds.
 * This does not enable an executor or confer delegated signing authority. */
export function relayHypercoreCommitSteps(input: {
  actions: readonly NormalizedAction[];
  profile: WalletExecutionProfile;
  sourceAmount: Money;
  sourceLocation: AssetLocation;
  minimumOutput: Money;
  policyRevision: string;
  executorId: string;
  requestId: string;
  expiresAt: string;
  destinationTarget: FundingTarget;
  recipientAddress: string | null;
  now: Date;
}): readonly FundingCommitStep[] {
  const [auth, send] = z
    .tuple([actionSchema, actionSchema])
    .parse(input.actions);
  const { data: authData, ...authCommon } = auth.payload;
  const { data: sendData, ...sendCommon } = send.payload;
  const profile = input.profile;
  if (
    auth.handoffKind !== RELAY_HYPERCORE_AUTH ||
    send.handoffKind !== RELAY_HYPERCORE_SEND ||
    auth.actionId === send.actionId ||
    !canonicalJsonEqual(authCommon, sendCommon) ||
    input.executorId !== RELAY_HYPERCORE_EXECUTOR ||
    profile.networkId !== HYPERCORE_MAINNET_USDC.networkId ||
    auth.actorWalletId !== profile.walletId ||
    send.actorWalletId !== profile.walletId ||
    !profile.controllerWalletRef ||
    !/^0x[\da-fA-F]{40}$/.test(profile.address) ||
    !sameAccountAddress(
      profile.networkId,
      profile.address,
      auth.payload.binding.owner,
    ) ||
    !isHypercoreMainnetUsdc(input.sourceAmount.asset) ||
    input.sourceAmount.raw !== auth.payload.binding.sourceRaw ||
    input.sourceLocation.details.controllerWalletId !== profile.walletId ||
    hypercoreLocationDex(input.sourceLocation) !==
      auth.payload.binding.sourceDex ||
    typeof input.sourceLocation.details.address !== "string" ||
    !sameAccountAddress(
      profile.networkId,
      profile.address,
      input.sourceLocation.details.address,
    ) ||
    canonicalJsonHash({ provider: "relay", requestId: input.requestId }) !==
      auth.payload.requestFingerprint ||
    input.expiresAt !== auth.payload.expiresAt ||
    !canonicalJsonEqual(
      input.destinationTarget,
      auth.payload.destinationTarget,
    ) ||
    !input.recipientAddress ||
    !sameAccountAddress(
      input.minimumOutput.asset.networkId,
      input.recipientAddress,
      auth.payload.recipientAddress,
    ) ||
    !sameAsset(input.minimumOutput.asset, auth.payload.minimumOutput.asset) ||
    input.minimumOutput.raw !== auth.payload.minimumOutput.raw ||
    !Number.isFinite(input.now.getTime()) ||
    Date.parse(auth.payload.expiresAt) <= input.now.getTime()
  )
    throw new Error("native_commit_binding_mismatch");
  const signingMode =
    profile.source === "external" && profile.signingModes.includes("web_client")
      ? "web_client"
      : profile.source === "embedded" &&
          profile.serverWalletRef &&
          profile.signingModes.includes("privy_authorization")
        ? "privy_authorization"
        : null;
  if (!signingMode) throw new Error("native_user_signing_profile_unavailable");
  const validated = validateRelayHypercorePayloads(
    { authorization: authData, transfer: sendData },
    auth.payload.binding,
  );
  return [auth, send].map((action, ordinal) => ({
    ordinal,
    segmentOrdinal: 0,
    stepKind: ordinal === 0 ? "signature" : "external_handoff",
    state: "action_required",
    actionFingerprint: canonicalJsonHash(action),
    executorId: RELAY_HYPERCORE_EXECUTOR,
    payerRequirement: "none",
    dependsOnOrdinal: ordinal === 0 ? null : ordinal - 1,
    actionExpiresAt: action.payload.expiresAt,
    normalizedAction: action as unknown as JsonObject,
    actionValidationResult: {
      validatorId: RELAY_HYPERCORE_EXECUTOR,
      validationRevision: validated.fingerprint,
      policyRevision: input.policyRevision,
      validatedAt: input.now.toISOString(),
      signerAddress: profile.address,
      signingMode,
      nativeStage: ordinal === 0 ? "nonce_mapping" : "send_asset",
      nativePairFingerprint: validated.fingerprint,
      relayProtocolOrderId: validated.binding.protocolOrderId.toLowerCase(),
      nativeNonce: validated.binding.nonce,
      nativeEnvironment: "mainnet",
      valueMoving: ordinal !== 0,
    },
  }));
}
