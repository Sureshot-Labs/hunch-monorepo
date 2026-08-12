import { canonicalJsonHash } from "../persistence/canonical.js";

import {
  derivePrivyAuthorizationPublicKey,
  normalizePrivyAuthorizationPublicKey,
} from "./privy-authorization-key.js";

export type KnownPrivySignerPurpose = "polymarket_automation";

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
  authority: Readonly<{ signerId: string; policyId: string }>,
): readonly KnownPrivySignerSpec[] {
  const signerId = source.PRIVY_WALLET_AUTHORIZATION_ID?.trim() ?? "";
  const policyId = source.PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_ID?.trim() ?? "";
  if (
    !signerId ||
    !policyId ||
    authority.signerId !== signerId ||
    authority.policyId !== policyId
  ) {
    return [];
  }
  return [
    { purpose: "polymarket_automation", signerId, policyIds: [policyId] },
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
  authority: Readonly<{
    authorizationPublicKey: string;
    policyFingerprint: string;
    policyId: string;
    signerFingerprint: string;
    signerId: string;
  }>,
): readonly KnownPrivySignerRuntimeSpec[] {
  const signerId = environmentValue(source, "PRIVY_WALLET_AUTHORIZATION_ID");
  const signerFingerprint = environmentValue(
    source,
    "PRIVY_WALLET_AUTHORIZATION_FINGERPRINT",
  );
  const authorizationPublicKey = derivePublicKeyOrEmpty(
    environmentValue(source, "PRIVY_WALLET_AUTHORIZATION_KEY"),
  );
  const policyId = environmentValue(
    source,
    "PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_ID",
  );
  const policyFingerprint = environmentValue(
    source,
    "PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_FINGERPRINT",
  );
  if (
    ![
      signerId,
      signerFingerprint,
      authorizationPublicKey,
      policyId,
      policyFingerprint,
    ].every(Boolean) ||
    authority.signerId !== signerId ||
    authority.signerFingerprint !== signerFingerprint ||
    authority.policyId !== policyId ||
    authority.policyFingerprint !== policyFingerprint ||
    normalizePrivyAuthorizationPublicKey(authority.authorizationPublicKey) !==
      normalizePrivyAuthorizationPublicKey(authorizationPublicKey)
  ) {
    return [];
  }
  return [
    {
      purpose: "polymarket_automation",
      signerId,
      signerFingerprint,
      authorizationPublicKey,
      policyIds: [policyId],
      policyFingerprints: { [policyId]: policyFingerprint },
    },
  ];
}

export function polymarketPersistedSignerRuntimeSpecs(
  authority: Readonly<{
    authorizationPublicKey: string;
    policyFingerprint: string;
    policyId: string;
    signerFingerprint: string;
    signerId: string;
  }>,
): readonly KnownPrivySignerRuntimeSpec[] {
  if (!Object.values(authority).every((value) => value.trim().length > 0)) {
    return [];
  }
  return [
    {
      purpose: "polymarket_automation",
      signerId: authority.signerId,
      signerFingerprint: authority.signerFingerprint,
      authorizationPublicKey: authority.authorizationPublicKey,
      policyIds: [authority.policyId],
      policyFingerprints: {
        [authority.policyId]: authority.policyFingerprint,
      },
    },
  ];
}
