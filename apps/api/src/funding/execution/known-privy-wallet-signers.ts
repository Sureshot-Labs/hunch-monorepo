import { canonicalJsonHash } from "../persistence/canonical.js";

import {
  derivePrivyAuthorizationPublicKey,
  normalizePrivyAuthorizationPublicKey,
} from "./privy-authorization-key.js";

export type KnownPrivySignerPurpose =
  | "polymarket_trade"
  | "polymarket_deposit_usdce_wrap";

export type KnownPrivySignerSpec = Readonly<{
  purpose: KnownPrivySignerPurpose;
  signerId: string;
  policyIds: readonly string[];
}>;

export type PrivyAdditionalSignerBinding = Readonly<{
  signerId: string;
  overridePolicyIds: readonly string[];
}>;

export type KnownPrivySignerRuntimeSpec = KnownPrivySignerSpec &
  Readonly<{
    authorizationPublicKey: string;
    policyFingerprints: Readonly<Record<string, string>>;
    signerFingerprint: string;
  }>;

export type PrivyKeyQuorumSnapshot = Readonly<{
  authorizationPublicKeys: readonly string[];
  authorizationThreshold: number | null;
  id: string;
  nestedKeyQuorumIds: readonly string[];
  userIds: readonly string[];
}>;

export function privyKeyQuorumFingerprint(
  input: PrivyKeyQuorumSnapshot,
): string {
  return canonicalJsonHash({
    authorizationPublicKeys: [...input.authorizationPublicKeys].sort(),
    authorizationThreshold: input.authorizationThreshold,
    id: input.id,
    nestedKeyQuorumIds: [...input.nestedKeyQuorumIds].sort(),
    userIds: [...input.userIds].sort(),
  });
}

export function knownPrivyPolicyFingerprint(
  input: Readonly<{
    chainType: string;
    id: string;
    rules: readonly Readonly<Record<string, unknown>>[];
  }>,
): string {
  return canonicalJsonHash(input);
}

export function validateKnownPrivySignerRuntime(
  input: Readonly<{
    attachedPolicyId: string;
    policyChainType: string;
    policyFingerprint: string;
    quorum: PrivyKeyQuorumSnapshot;
    spec: KnownPrivySignerRuntimeSpec;
  }>,
): boolean {
  const expectedPolicyFingerprint =
    input.spec.policyFingerprints[input.attachedPolicyId];
  return (
    input.quorum.id === input.spec.signerId &&
    input.quorum.authorizationThreshold === 1 &&
    input.quorum.authorizationPublicKeys.length === 1 &&
    input.quorum.nestedKeyQuorumIds.length === 0 &&
    input.quorum.userIds.length === 0 &&
    normalizePrivyAuthorizationPublicKey(
      input.quorum.authorizationPublicKeys[0] ?? "",
    ) ===
      normalizePrivyAuthorizationPublicKey(input.spec.authorizationPublicKey) &&
    privyKeyQuorumFingerprint(input.quorum) === input.spec.signerFingerprint &&
    input.policyChainType === "ethereum" &&
    typeof expectedPolicyFingerprint === "string" &&
    expectedPolicyFingerprint === input.policyFingerprint
  );
}

export function validateKnownPrivyWalletSigners(
  input: Readonly<{
    signers: readonly PrivyAdditionalSignerBinding[];
    specs: readonly KnownPrivySignerSpec[];
    requiredPurposes?: readonly KnownPrivySignerPurpose[];
  }>,
): Readonly<{ valid: boolean; issues: readonly string[] }> {
  const issues: string[] = [];
  const specsBySigner = new Map<string, KnownPrivySignerSpec>();
  for (const spec of input.specs) {
    const signerId = spec.signerId.trim();
    const policyIds = [
      ...new Set(spec.policyIds.map((id) => id.trim())),
    ].filter(Boolean);
    if (!signerId || policyIds.length === 0 || specsBySigner.has(signerId)) {
      issues.push("known signer registry is incomplete or duplicated");
      continue;
    }
    specsBySigner.set(signerId, { ...spec, signerId, policyIds });
  }
  const seen = new Set<string>();
  const attachedPurposes = new Set<KnownPrivySignerPurpose>();
  for (const signer of input.signers) {
    const signerId = signer.signerId.trim();
    const spec = specsBySigner.get(signerId);
    if (!spec || seen.has(signerId)) {
      issues.push("wallet contains an unknown or duplicate signer");
      continue;
    }
    seen.add(signerId);
    if (
      signer.overridePolicyIds.length !== 1 ||
      !spec.policyIds.includes(signer.overridePolicyIds[0]?.trim() ?? "")
    ) {
      issues.push("wallet signer has an unexpected override policy");
      continue;
    }
    attachedPurposes.add(spec.purpose);
  }
  for (const purpose of input.requiredPurposes ?? []) {
    if (!attachedPurposes.has(purpose)) {
      issues.push(`wallet is missing required signer purpose ${purpose}`);
    }
  }
  return { valid: issues.length === 0, issues };
}

export function polymarketKnownSignerSpecs(
  source: Readonly<Record<string, string | undefined>>,
  wrap: Readonly<{ signerId: string; policyId: string }>,
): readonly KnownPrivySignerSpec[] {
  const tradeSignerId = source.PRIVY_WALLET_AUTHORIZATION_ID?.trim() ?? "";
  const tradePolicyIds = [
    source.PRIVY_POLYMARKET_BOT_BUY_POLICY_ID,
    source.PRIVY_POLYMARKET_BOT_SELL_POLICY_ID,
    source.PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_ID,
  ]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean);
  return [
    ...(tradeSignerId && tradePolicyIds.length > 0
      ? [
          {
            purpose: "polymarket_trade" as const,
            signerId: tradeSignerId,
            policyIds: tradePolicyIds,
          },
        ]
      : []),
    {
      purpose: "polymarket_deposit_usdce_wrap" as const,
      signerId: wrap.signerId,
      policyIds: [wrap.policyId],
    },
  ];
}

function environmentValue(
  source: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  return source[key]?.trim() ?? "";
}

function derivePublicKeyOrEmpty(privateKey: string): string {
  try {
    return derivePrivyAuthorizationPublicKey(privateKey);
  } catch {
    return "";
  }
}

export function polymarketKnownSignerRuntimeSpecs(
  source: Readonly<Record<string, string | undefined>>,
  wrap: Readonly<{
    authorizationPublicKey: string;
    policyFingerprint: string;
    policyId: string;
    signerFingerprint: string;
    signerId: string;
  }>,
): readonly KnownPrivySignerRuntimeSpec[] {
  const tradePolicyPairs = [
    [
      "PRIVY_POLYMARKET_BOT_BUY_POLICY_ID",
      "PRIVY_POLYMARKET_BOT_BUY_POLICY_FINGERPRINT",
    ],
    [
      "PRIVY_POLYMARKET_BOT_SELL_POLICY_ID",
      "PRIVY_POLYMARKET_BOT_SELL_POLICY_FINGERPRINT",
    ],
    [
      "PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_ID",
      "PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_FINGERPRINT",
    ],
  ] as const;
  const tradePolicies = tradePolicyPairs
    .map(([idKey, fingerprintKey]) => ({
      id: environmentValue(source, idKey),
      fingerprint: environmentValue(source, fingerprintKey),
    }))
    .filter(({ id, fingerprint }) => id && fingerprint);
  const tradeSignerId = environmentValue(
    source,
    "PRIVY_WALLET_AUTHORIZATION_ID",
  );
  const tradeSignerFingerprint = environmentValue(
    source,
    "PRIVY_WALLET_AUTHORIZATION_FINGERPRINT",
  );
  const tradePublicKey = derivePublicKeyOrEmpty(
    environmentValue(source, "PRIVY_WALLET_AUTHORIZATION_KEY"),
  );
  const wrapComplete = [
    wrap.signerId,
    wrap.signerFingerprint,
    wrap.authorizationPublicKey,
    wrap.policyId,
    wrap.policyFingerprint,
  ].every(Boolean);
  return [
    ...(tradeSignerId &&
    tradeSignerFingerprint &&
    tradePublicKey &&
    tradePolicies.length > 0
      ? [
          {
            purpose: "polymarket_trade" as const,
            signerId: tradeSignerId,
            signerFingerprint: tradeSignerFingerprint,
            authorizationPublicKey: tradePublicKey,
            policyIds: tradePolicies.map(({ id }) => id),
            policyFingerprints: Object.fromEntries(
              tradePolicies.map(({ id, fingerprint }) => [id, fingerprint]),
            ),
          },
        ]
      : []),
    ...(wrapComplete
      ? [
          {
            purpose: "polymarket_deposit_usdce_wrap" as const,
            signerId: wrap.signerId,
            signerFingerprint: wrap.signerFingerprint,
            authorizationPublicKey: wrap.authorizationPublicKey,
            policyIds: [wrap.policyId],
            policyFingerprints: {
              [wrap.policyId]: wrap.policyFingerprint,
            },
          },
        ]
      : []),
  ];
}
