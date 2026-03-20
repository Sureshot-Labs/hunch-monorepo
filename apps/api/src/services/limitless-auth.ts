import { ethers } from "ethers";
import { AuthService, type VenueCredentials } from "../auth.js";
import { isRecord } from "../lib/type-guards.js";
import {
  extractLimitlessMessage,
  limitlessRequest,
  type LimitlessRequestAuthInputs,
} from "./limitless-client.js";

export type LimitlessProfile = {
  id?: number;
  account?: string;
  client?: string;
  rank?: { feeRateBps?: number; name?: string };
};

export type LimitlessAuthMode = "api_key" | "session";

export type LimitlessAuthContext = {
  creds: VenueCredentials;
  authMode: LimitlessAuthMode;
  apiKey?: string;
  sessionCookie?: string;
  storedProfile: LimitlessProfile | null;
};

export type LimitlessAuthVerification =
  | { ok: true; profile: LimitlessProfile | null; payload: unknown }
  | { ok: false; status: number; payload: unknown; message: string | null };

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (!payload) return null;
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded =
    padding === 0 ? normalized : `${normalized}${"=".repeat(4 - padding)}`;
  try {
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

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

export function extractLimitlessProfile(value: unknown): LimitlessProfile | null {
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

export function extractLimitlessProfileFromSessionCookie(
  sessionCookie: string | null | undefined,
): LimitlessProfile | null {
  if (!sessionCookie) return null;
  const payload = decodeJwtPayload(sessionCookie);
  if (!payload) return null;
  return extractLimitlessProfile(payload);
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
    ...(base?.id ?? extra?.id ? { id: base?.id ?? extra?.id } : {}),
    ...(base?.account ?? extra?.account
      ? { account: base?.account ?? extra?.account }
      : {}),
    ...(base?.client ?? extra?.client
      ? { client: base?.client ?? extra?.client }
      : {}),
    ...(rank ? { rank } : {}),
  };
}

function extractStoredProfile(additionalData: unknown): LimitlessProfile | null {
  if (!isRecord(additionalData)) return extractLimitlessProfile(additionalData);
  return extractLimitlessProfile(additionalData.profile ?? additionalData);
}

function extractStoredAuthMode(
  creds: VenueCredentials,
): LimitlessAuthMode {
  const additionalData = creds.additionalData;
  if (isRecord(additionalData) && additionalData.authMode === "api_key") {
    return "api_key";
  }
  if (isRecord(additionalData) && additionalData.authMode === "session") {
    return "session";
  }
  const secret = creds.apiSecret.trim();
  if (secret.toLowerCase().startsWith("lmts_")) return "api_key";
  return "session";
}

export function buildLimitlessRequestAuthInputs(
  authContext: Pick<LimitlessAuthContext, "authMode" | "apiKey" | "sessionCookie">,
): LimitlessRequestAuthInputs {
  if (authContext.authMode === "api_key") {
    return authContext.apiKey ? { apiKey: authContext.apiKey } : {};
  }
  return authContext.sessionCookie
    ? { sessionCookie: authContext.sessionCookie }
    : {};
}

export async function loadLimitlessProfileForWallet(inputs: {
  walletAddress: string;
  authContext?: Pick<
    LimitlessAuthContext,
    "authMode" | "apiKey" | "sessionCookie"
  > | null;
  additionalData?: unknown;
  baseProfile?: LimitlessProfile | null;
}): Promise<LimitlessProfile | null> {
  const storedProfile = extractLimitlessProfile(inputs.additionalData ?? null);
  const sessionProfile =
    inputs.authContext?.authMode === "session"
      ? extractLimitlessProfileFromSessionCookie(
          inputs.authContext.sessionCookie,
        )
      : null;
  const liveProfile = inputs.authContext
    ? await fetchLimitlessProfileForAddress({
        address: inputs.walletAddress,
        ...buildLimitlessRequestAuthInputs(inputs.authContext),
      })
    : null;

  return mergeLimitlessProfiles(
    inputs.baseProfile ?? null,
    mergeLimitlessProfiles(
      sessionProfile,
      mergeLimitlessProfiles(storedProfile, liveProfile),
    ),
  );
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
  const secret = creds.apiSecret.trim();
  return {
    creds,
    authMode,
    ...(authMode === "api_key" && secret ? { apiKey: secret } : {}),
    ...(authMode === "session" && secret ? { sessionCookie: secret } : {}),
    storedProfile: mergeLimitlessProfiles(
      extractStoredProfile(creds.additionalData),
      authMode === "session" ? extractLimitlessProfileFromSessionCookie(secret) : null,
    ),
  };
}

export async function fetchLimitlessProfileForAddress(inputs: {
  address: string;
  apiKey?: string | null;
  sessionCookie?: string | null;
}): Promise<LimitlessProfile | null> {
  const trimmedAddress = inputs.address.trim();
  if (!trimmedAddress) return null;
  let requestAddress = trimmedAddress;
  try {
    requestAddress = ethers.getAddress(trimmedAddress);
  } catch {
    // Non-checksummed but otherwise valid addresses can still be queried as-is.
  }
  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/profiles/${encodeURIComponent(requestAddress)}`,
    ...(inputs.apiKey ? { apiKey: inputs.apiKey } : {}),
    ...(inputs.sessionCookie ? { sessionCookie: inputs.sessionCookie } : {}),
  });
  if (!upstream.ok) return null;
  return extractLimitlessProfile(upstream.payload);
}

export async function verifyLimitlessAuthContext(inputs: {
  authContext: LimitlessAuthContext;
  walletAddress: string;
}): Promise<LimitlessAuthVerification> {
  const walletAddress = inputs.walletAddress.trim();
  if (inputs.authContext.authMode === "api_key") {
    const profile = await fetchLimitlessProfileForAddress({
      address: walletAddress,
      apiKey: inputs.authContext.apiKey,
    });
    if (!profile) {
      return {
        ok: false,
        status: 401,
        payload: { error: "Limitless API key is invalid." },
        message: "Limitless API key is invalid.",
      };
    }
    const actual = profile.account ? normalizeAddress(profile.account) : null;
    if (actual && actual !== normalizeAddress(walletAddress)) {
      return {
        ok: false,
        status: 400,
        payload: {
          error: "Limitless API key belongs to a different account.",
          expected: walletAddress,
          actual: profile.account,
        },
        message: "Limitless API key belongs to a different account.",
      };
    }
    return { ok: true, profile, payload: profile };
  }

  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: "/auth/verify-auth",
    ...(inputs.authContext.sessionCookie
      ? { sessionCookie: inputs.authContext.sessionCookie }
      : {}),
  });
  if (!upstream.ok) {
    return {
      ok: false,
      status: upstream.status,
      payload: upstream.payload,
      message: extractLimitlessMessage(upstream.payload),
    };
  }

  return {
    ok: true,
    profile: extractLimitlessProfile(upstream.payload),
    payload: upstream.payload,
  };
}

export async function validateLimitlessApiKeyForWallet(inputs: {
  apiKey: string;
  walletAddress: string;
}): Promise<
  | { ok: true; profile: LimitlessProfile | null; payload: unknown }
  | { ok: false; status: number; payload: unknown; message: string }
> {
  const profile = await fetchLimitlessProfileForAddress({
    address: inputs.walletAddress,
    apiKey: inputs.apiKey,
  });

  if (!profile) {
    const upstream = await limitlessRequest({
      method: "GET",
      requestPath: `/profiles/${encodeURIComponent(inputs.walletAddress.trim())}`,
      apiKey: inputs.apiKey,
    });
    if (!upstream.ok) {
      return {
        ok: false,
        status: upstream.status,
        payload: upstream.payload,
        message:
          extractLimitlessMessage(upstream.payload) ??
          "Failed to validate Limitless API key.",
      };
    }
    return {
      ok: true,
      profile: extractLimitlessProfile(upstream.payload),
      payload: upstream.payload,
    };
  }

  const actual = profile?.account ? normalizeAddress(profile.account) : null;
  if (actual && actual !== normalizeAddress(inputs.walletAddress)) {
    return {
      ok: false,
      status: 400,
      payload: profile,
      message: "Limitless API key belongs to a different account.",
    };
  }

  return { ok: true, profile, payload: profile };
}
