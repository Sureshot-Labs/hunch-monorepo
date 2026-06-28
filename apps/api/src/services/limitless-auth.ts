import { AuthService, type VenueCredentials } from "../auth.js";
import { isRecord } from "../lib/type-guards.js";
import {
  isLimitlessPartnerHmacConfigured,
  type LimitlessRequestAuthInputs,
} from "./limitless-client.js";

export type LimitlessProfile = {
  id?: number;
  account?: string;
  client?: string;
  rank?: { feeRateBps?: number; name?: string };
};

export type LimitlessAuthMode = "partner_hmac";

export type LimitlessAuthContext = {
  creds: VenueCredentials;
  authMode: LimitlessAuthMode;
  storedProfile: LimitlessProfile | null;
};

export type LimitlessAuthVerification =
  | { ok: true; profile: LimitlessProfile | null; payload: unknown }
  | { ok: false; status: number; payload: unknown; message: string | null };

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function parseFeeRateBps(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return undefined;
}

export function extractLimitlessProfile(
  value: unknown,
): LimitlessProfile | null {
  if (!isRecord(value)) return null;
  const profileRaw = isRecord(value.profile) ? value.profile : value;
  if (!isRecord(profileRaw)) return null;
  const idCandidate =
    profileRaw.id ??
    profileRaw.userId ??
    profileRaw.user_id ??
    profileRaw.profileId ??
    profileRaw.profile_id;
  const idFromString =
    typeof idCandidate === "string" && idCandidate.trim()
      ? Number.parseInt(idCandidate, 10)
      : null;
  const id =
    typeof idCandidate === "number"
      ? idCandidate
      : typeof idFromString === "number" && Number.isFinite(idFromString)
        ? idFromString
        : null;
  const account =
    typeof profileRaw.account === "string"
      ? profileRaw.account
      : typeof profileRaw.address === "string"
        ? profileRaw.address
        : typeof profileRaw.wallet === "string"
          ? profileRaw.wallet
          : typeof profileRaw.walletAddress === "string"
            ? profileRaw.walletAddress
            : typeof profileRaw.wallet_address === "string"
              ? profileRaw.wallet_address
              : null;
  const normalizedAccount =
    typeof account === "string" && account.trim().length > 0
      ? account.trim()
      : null;
  const client =
    typeof profileRaw.client === "string"
      ? profileRaw.client
      : typeof profileRaw.clientType === "string"
        ? profileRaw.clientType
        : typeof profileRaw.client_type === "string"
          ? profileRaw.client_type
          : null;
  const rankRaw = isRecord(profileRaw.rank) ? profileRaw.rank : null;
  const rankFeeRateBps =
    parseFeeRateBps(rankRaw?.feeRateBps) ??
    parseFeeRateBps(rankRaw?.fee_rate_bps) ??
    parseFeeRateBps(rankRaw?.feeRate) ??
    parseFeeRateBps(rankRaw?.fee_rate) ??
    parseFeeRateBps(profileRaw.feeRateBps) ??
    parseFeeRateBps(profileRaw.fee_rate_bps) ??
    parseFeeRateBps(profileRaw.feeRate) ??
    parseFeeRateBps(profileRaw.fee_rate) ??
    parseFeeRateBps(profileRaw.rankFeeRateBps) ??
    parseFeeRateBps(profileRaw.rank_fee_rate_bps);
  const rankName =
    (typeof rankRaw?.name === "string" && rankRaw.name) ||
    (typeof profileRaw.rank === "string" && profileRaw.rank) ||
    (typeof profileRaw.rankName === "string" && profileRaw.rankName) ||
    (typeof profileRaw.rank_name === "string" && profileRaw.rank_name) ||
    undefined;
  const rank =
    rankFeeRateBps != null || rankName
      ? {
          ...(rankFeeRateBps != null ? { feeRateBps: rankFeeRateBps } : {}),
          ...(rankName ? { name: rankName } : {}),
        }
      : undefined;
  return {
    ...(id != null ? { id } : {}),
    ...(normalizedAccount ? { account: normalizedAccount } : {}),
    ...(client ? { client } : {}),
    ...(rank ? { rank } : {}),
  };
}

function hasUsefulLimitlessProfile(
  profile: LimitlessProfile | null,
): profile is LimitlessProfile {
  return Boolean(
    profile &&
    (profile.id != null ||
      profile.account != null ||
      profile.client != null ||
      profile.rank != null),
  );
}

const LIMITLESS_PROFILE_COLLECTION_KEYS = [
  "profile",
  "items",
  "accounts",
  "partnerAccounts",
  "partner_accounts",
  "data",
  "results",
] as const;

function collectLimitlessProfiles(
  value: unknown,
  depth: number,
  out: LimitlessProfile[],
): void {
  if (depth > 4 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLimitlessProfiles(item, depth + 1, out);
    }
    return;
  }
  if (!isRecord(value)) return;

  const direct = extractLimitlessProfile(value);
  if (hasUsefulLimitlessProfile(direct)) {
    out.push(direct);
  }

  for (const key of LIMITLESS_PROFILE_COLLECTION_KEYS) {
    if (key in value) {
      collectLimitlessProfiles(value[key], depth + 1, out);
    }
  }
}

function profileIdentityKey(profile: LimitlessProfile): string {
  const id = profile.id == null ? "" : String(profile.id);
  const account =
    profile.account == null ? "" : normalizeAddress(profile.account);
  return `${id}:${account}`;
}

export function extractLimitlessPartnerAccountProfiles(
  value: unknown,
): LimitlessProfile[] {
  const collected: LimitlessProfile[] = [];
  collectLimitlessProfiles(value, 0, collected);

  const seen = new Set<string>();
  const unique: LimitlessProfile[] = [];
  for (const profile of collected) {
    const key = profileIdentityKey(profile);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(profile);
  }
  return unique;
}

function isValidLimitlessProfileId(id: number | undefined): id is number {
  return typeof id === "number" && Number.isFinite(id) && id > 0;
}

export function extractLimitlessPartnerAccountProfile(
  value: unknown,
  account: string,
): LimitlessProfile | null {
  const requestedAccount = normalizeAddress(account);
  for (const profile of extractLimitlessPartnerAccountProfiles(value)) {
    if (!isValidLimitlessProfileId(profile.id)) continue;
    if (!profile.account) continue;
    if (normalizeAddress(profile.account) !== requestedAccount) continue;
    return profile;
  }
  return null;
}

export function mergeLimitlessProfiles(
  base: LimitlessProfile | null,
  extra: LimitlessProfile | null,
): LimitlessProfile | null {
  if (!base && !extra) return null;
  const rankFeeRateBps = base?.rank?.feeRateBps ?? extra?.rank?.feeRateBps;
  const rankName = base?.rank?.name ?? extra?.rank?.name;
  const rank =
    rankFeeRateBps != null || rankName
      ? {
          ...(rankFeeRateBps != null ? { feeRateBps: rankFeeRateBps } : {}),
          ...(rankName ? { name: rankName } : {}),
        }
      : undefined;
  return {
    ...((base?.id ?? extra?.id) ? { id: base?.id ?? extra?.id } : {}),
    ...((base?.account ?? extra?.account)
      ? { account: base?.account ?? extra?.account }
      : {}),
    ...((base?.client ?? extra?.client)
      ? { client: base?.client ?? extra?.client }
      : {}),
    ...(rank ? { rank } : {}),
  };
}

function extractStoredProfile(
  additionalData: unknown,
): LimitlessProfile | null {
  if (!isRecord(additionalData)) return extractLimitlessProfile(additionalData);
  return extractLimitlessProfile(additionalData.profile ?? additionalData);
}

function extractStoredAuthMode(
  creds: VenueCredentials,
): LimitlessAuthMode | null {
  const additionalData = creds.additionalData;
  if (isRecord(additionalData) && additionalData.authMode === "partner_hmac") {
    return "partner_hmac";
  }
  return null;
}

export function buildLimitlessRequestAuthInputs(
  _authContext?: Pick<LimitlessAuthContext, "authMode"> | null,
): LimitlessRequestAuthInputs {
  return { auth: "partner_hmac" };
}

export async function loadLimitlessProfileForWallet(inputs: {
  walletAddress: string;
  authContext?: Pick<LimitlessAuthContext, "authMode"> | null;
  additionalData?: unknown;
  baseProfile?: LimitlessProfile | null;
}): Promise<LimitlessProfile | null> {
  const storedProfile = extractLimitlessProfile(inputs.additionalData ?? null);
  return mergeLimitlessProfiles(inputs.baseProfile ?? null, storedProfile);
}

export async function resolveLimitlessAuthContext(
  userId: string,
  walletAddress: string,
): Promise<LimitlessAuthContext | null> {
  const creds = await AuthService.getVenueCredentials(
    userId,
    "limitless",
    walletAddress,
  );
  if (!creds) return null;

  const authMode = extractStoredAuthMode(creds);
  if (!authMode) return null;
  return {
    creds,
    authMode,
    storedProfile: extractStoredProfile(creds.additionalData),
  };
}

export async function verifyLimitlessAuthContext(inputs: {
  authContext: LimitlessAuthContext;
  walletAddress: string;
}): Promise<LimitlessAuthVerification> {
  const walletAddress = inputs.walletAddress.trim();
  if (!isLimitlessPartnerHmacConfigured()) {
    return {
      ok: false,
      status: 503,
      payload: { error: "Limitless is temporarily unavailable." },
      message: "Limitless is temporarily unavailable.",
    };
  }

  const profile = inputs.authContext.storedProfile;
  if (!profile?.id) {
    return {
      ok: false,
      status: 400,
      payload: { error: "Limitless profile mapping is missing." },
      message: "Limitless profile mapping is missing.",
    };
  }
  const actual = profile.account ? normalizeAddress(profile.account) : null;
  if (actual && actual !== normalizeAddress(walletAddress)) {
    return {
      ok: false,
      status: 400,
      payload: {
        error: "Stored Limitless profile belongs to a different account.",
        expected: walletAddress,
        actual: profile.account,
      },
      message: "Stored Limitless profile belongs to a different account.",
    };
  }

  return {
    ok: true,
    profile,
    payload: { profile },
  };
}
