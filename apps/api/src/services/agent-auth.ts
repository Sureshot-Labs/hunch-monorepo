import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { AuthService, type User } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";

export type AgentScope =
  | "read:account"
  | "read:wallets"
  | "read:orders"
  | "read:positions"
  | "read:funding"
  | "read:notifications";

export type AgentGrant = {
  id: string;
  userId: string;
  name: string;
  clientName: string | null;
  clientVersion: string | null;
  clientKind: string | null;
  tokenPrefix: string;
  scopes: AgentScope[];
  walletAddresses: string[];
  venues: string[];
  allowedChains: string[];
  allowedAssets: string[];
  confirmationMode: "always" | "policy" | "never";
  limits: Record<string, unknown>;
  metadata: Record<string, unknown>;
  isActive: boolean;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentGrantSummary = {
  id: string;
  name: string;
  clientName: string | null;
  clientVersion: string | null;
  clientKind: string | null;
  scopes: AgentScope[];
  walletAddresses: string[];
  venues: string[];
  limits: Record<string, unknown>;
  confirmationMode: "always" | "policy" | "never";
  isActive: boolean;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type AgentDeviceAuthorization = {
  id: string;
  status: "pending" | "approved" | "denied" | "expired" | "token_issued";
  requestedScopes: AgentScope[];
  requestedWalletAddresses: string[];
  requestedVenues: string[];
  requestedLimits: Record<string, unknown>;
  approvedScopes: AgentScope[] | null;
  approvedWalletAddresses: string[] | null;
  approvedVenues: string[] | null;
  approvedLimits: Record<string, unknown> | null;
  grantExpiresAt: Date | null;
  clientName: string | null;
  clientVersion: string | null;
  clientKind: string | null;
  metadata: Record<string, unknown>;
  approvedUserId: string | null;
  approvedGrantId: string | null;
  pollCount: number;
  approvalAttempts: number;
  lastPolledAt: Date | null;
  approvedAt: Date | null;
  deniedAt: Date | null;
  tokenIssuedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
};

export class AgentAuthError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "AgentAuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type AgentGrantRow = {
  id: string;
  user_id: string;
  name: string;
  client_name: string | null;
  client_version: string | null;
  client_kind: string | null;
  token_prefix: string;
  scopes: AgentScope[];
  wallet_addresses: string[];
  venues: string[];
  allowed_chains: string[];
  allowed_assets: string[];
  confirmation_mode: "always" | "policy" | "never";
  limits: Record<string, unknown>;
  metadata: Record<string, unknown>;
  is_active: boolean;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type AgentDeviceAuthorizationRow = {
  id: string;
  status: AgentDeviceAuthorization["status"];
  requested_scopes: AgentScope[];
  requested_wallet_addresses: string[];
  requested_venues: string[];
  requested_limits: Record<string, unknown>;
  approved_scopes: AgentScope[] | null;
  approved_wallet_addresses: string[] | null;
  approved_venues: string[] | null;
  approved_limits: Record<string, unknown> | null;
  grant_expires_at: Date | null;
  client_name: string | null;
  client_version: string | null;
  client_kind: string | null;
  metadata: Record<string, unknown>;
  approved_user_id: string | null;
  approved_grant_id: string | null;
  poll_count: number;
  approval_attempts: number;
  last_polled_at: Date | null;
  approved_at: Date | null;
  denied_at: Date | null;
  token_issued_at: Date | null;
  expires_at: Date;
  created_at: Date;
};

type Queryable = Pick<typeof pool, "query"> | Pick<PoolClient, "query">;

const READ_SCOPES: readonly AgentScope[] = [
  "read:account",
  "read:wallets",
  "read:orders",
  "read:positions",
  "read:funding",
  "read:notifications",
];
const READ_SCOPE_SET = new Set<AgentScope>(READ_SCOPES);
const WALLET_SENSITIVE_SCOPES = new Set<AgentScope>([
  "read:wallets",
  "read:orders",
  "read:positions",
  "read:funding",
]);
const MAX_APPROVAL_ATTEMPTS = 20;
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function hashOpaqueToken(token: string): string {
  if (!env.agentTokenHashSecret) {
    throw new AgentAuthError(
      "agent_auth_disabled",
      "Agent auth is not configured",
      503,
    );
  }
  return crypto
    .createHmac("sha256", env.agentTokenHashSecret)
    .update(token)
    .digest("hex");
}

function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function generateAgentToken(): string {
  const prefix = env.nodeEnv === "production" ? "ha_live_" : "ha_test_";
  return `${prefix}${generateOpaqueToken(32)}`;
}

function tokenPrefix(token: string): string {
  return token.slice(0, 16);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapGrant(row: AgentGrantRow): AgentGrant {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    clientName: row.client_name,
    clientVersion: row.client_version,
    clientKind: row.client_kind,
    tokenPrefix: row.token_prefix,
    scopes: row.scopes ?? [],
    walletAddresses: row.wallet_addresses ?? [],
    venues: row.venues ?? [],
    allowedChains: row.allowed_chains ?? [],
    allowedAssets: row.allowed_assets ?? [],
    confirmationMode: row.confirmation_mode,
    limits: row.limits ?? {},
    metadata: row.metadata ?? {},
    isActive: row.is_active,
    expiresAt: toDate(row.expires_at),
    lastUsedAt: row.last_used_at ? toDate(row.last_used_at) : null,
    revokedAt: row.revoked_at ? toDate(row.revoked_at) : null,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

export function summarizeAgentGrant(grant: AgentGrant): AgentGrantSummary {
  return {
    id: grant.id,
    name: grant.name,
    clientName: grant.clientName,
    clientVersion: grant.clientVersion,
    clientKind: grant.clientKind,
    scopes: grant.scopes,
    walletAddresses: grant.walletAddresses,
    venues: grant.venues,
    limits: grant.limits,
    confirmationMode: grant.confirmationMode,
    isActive: grant.isActive,
    expiresAt: grant.expiresAt.toISOString(),
    lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
    revokedAt: grant.revokedAt?.toISOString() ?? null,
    createdAt: grant.createdAt.toISOString(),
  };
}

function mapAuthorization(
  row: AgentDeviceAuthorizationRow,
): AgentDeviceAuthorization {
  return {
    id: row.id,
    status: row.status,
    requestedScopes: row.requested_scopes ?? [],
    requestedWalletAddresses: row.requested_wallet_addresses ?? [],
    requestedVenues: row.requested_venues ?? [],
    requestedLimits: row.requested_limits ?? {},
    approvedScopes: row.approved_scopes,
    approvedWalletAddresses: row.approved_wallet_addresses,
    approvedVenues: row.approved_venues,
    approvedLimits: row.approved_limits,
    grantExpiresAt: row.grant_expires_at ? toDate(row.grant_expires_at) : null,
    clientName: row.client_name,
    clientVersion: row.client_version,
    clientKind: row.client_kind,
    metadata: row.metadata ?? {},
    approvedUserId: row.approved_user_id,
    approvedGrantId: row.approved_grant_id,
    pollCount: Number(row.poll_count ?? 0),
    approvalAttempts: Number(row.approval_attempts ?? 0),
    lastPolledAt: row.last_polled_at ? toDate(row.last_polled_at) : null,
    approvedAt: row.approved_at ? toDate(row.approved_at) : null,
    deniedAt: row.denied_at ? toDate(row.denied_at) : null,
    tokenIssuedAt: row.token_issued_at ? toDate(row.token_issued_at) : null,
    expiresAt: toDate(row.expires_at),
    createdAt: toDate(row.created_at),
  };
}

function normalizeWalletAddress(input: string): string {
  const trimmed = input.trim();
  if (ETH_ADDRESS_RE.test(trimmed)) return trimmed.toLowerCase();
  return trimmed;
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
}

function uniqueWallets(values: readonly string[] | undefined): string[] {
  return uniqueStrings(values).map(normalizeWalletAddress);
}

function normalizeScopes(values: readonly AgentScope[] | undefined) {
  const source: readonly AgentScope[] = values?.length
    ? values
    : ["read:account"];
  const scopes = Array.from(new Set(source));
  for (const scope of scopes) {
    if (!READ_SCOPE_SET.has(scope)) {
      throw new AgentAuthError("invalid_scope", `Unsupported scope: ${scope}`);
    }
  }
  return scopes;
}

function assertSubset<T extends string>(
  selected: readonly T[],
  requested: readonly T[],
  code: string,
  label: string,
) {
  if (requested.length === 0) {
    if (selected.length > 0) {
      throw new AgentAuthError(
        code,
        `${label} approval cannot be wider than the original request`,
      );
    }
    return;
  }
  const allowed = new Set(requested);
  const invalid = selected.find((value) => !allowed.has(value));
  if (invalid) {
    throw new AgentAuthError(code, `${label} was not requested: ${invalid}`);
  }
}

function hasWalletSensitiveScope(scopes: readonly AgentScope[]): boolean {
  return scopes.some((scope) => WALLET_SENSITIVE_SCOPES.has(scope));
}

function assertWalletApprovalAllowed(input: {
  selectedWallets: readonly string[];
  requestedWallets: readonly string[];
  approvedScopes: readonly AgentScope[];
}) {
  if (input.requestedWallets.length > 0) {
    assertSubset(
      input.selectedWallets,
      input.requestedWallets,
      "invalid_wallet",
      "Wallet",
    );
    return;
  }
  if (
    input.selectedWallets.length > 0 &&
    !hasWalletSensitiveScope(input.approvedScopes)
  ) {
    throw new AgentAuthError(
      "invalid_wallet",
      "Wallet approval requires a wallet-sensitive scope",
    );
  }
}

async function assertWalletsLinked(userId: string, walletAddresses: string[]) {
  if (walletAddresses.length === 0) return;
  const linked = await Promise.all(
    walletAddresses.map((walletAddress) =>
      AuthService.getUserWalletByAddress(userId, walletAddress),
    ),
  );
  const missingIndex = linked.findIndex((wallet) => !wallet);
  if (missingIndex >= 0) {
    throw new AgentAuthError(
      "wallet_not_linked",
      "Wallet is not linked to the authenticated user",
      403,
    );
  }
}

async function recordAgentAudit(
  db: Queryable,
  input: {
    userId?: string | null;
    grantId?: string | null;
    deviceAuthorizationId?: string | null;
    eventType: string;
    actorType: "user" | "agent" | "system";
    ipAddress?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await db.query(
    `
      insert into agent_audit_events (
        user_id,
        grant_id,
        device_authorization_id,
        event_type,
        actor_type,
        ip_address,
        user_agent,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      input.userId ?? null,
      input.grantId ?? null,
      input.deviceAuthorizationId ?? null,
      input.eventType,
      input.actorType,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      input.metadata ?? {},
    ],
  );
}

async function fetchAuthorizationByHash(
  db: Queryable,
  field: "device_code_hash" | "approval_token_hash",
  hash: string,
  lock = false,
): Promise<AgentDeviceAuthorization | null> {
  const { rows } = await db.query<AgentDeviceAuthorizationRow>(
    `
      select
        id,
        status,
        requested_scopes,
        requested_wallet_addresses,
        requested_venues,
        requested_limits,
        approved_scopes,
        approved_wallet_addresses,
        approved_venues,
        approved_limits,
        grant_expires_at,
        client_name,
        client_version,
        client_kind,
        metadata,
        approved_user_id,
        approved_grant_id,
        poll_count,
        approval_attempts,
        last_polled_at,
        approved_at,
        denied_at,
        token_issued_at,
        expires_at,
        created_at
      from agent_device_authorizations
      where ${field} = $1
      limit 1
      ${lock ? "for update" : ""}
    `,
    [hash],
  );
  const row = rows[0];
  return row ? mapAuthorization(row) : null;
}

async function expireAuthorizationIfNeeded(
  db: Queryable,
  auth: AgentDeviceAuthorization,
): Promise<AgentDeviceAuthorization> {
  if (
    auth.expiresAt.getTime() > Date.now() ||
    auth.status === "denied" ||
    auth.status === "expired" ||
    auth.status === "token_issued"
  ) {
    return auth;
  }
  await db.query(
    `
      update agent_device_authorizations
      set status = 'expired'
      where id = $1 and status in ('pending', 'approved')
    `,
    [auth.id],
  );
  return { ...auth, status: "expired" };
}

function buildApprovalUrl(approvalToken: string): string {
  const base = env.agentAppBaseUrl.replace(/\/+$/, "");
  return `${base}/agent/approve/${encodeURIComponent(approvalToken)}`;
}

function grantName(input: {
  grantName?: string | null;
  profileLabel?: string | null;
  clientName?: string | null;
}) {
  return (
    input.grantName?.trim() ||
    input.profileLabel?.trim() ||
    input.clientName?.trim() ||
    "Hunch Agent"
  );
}

function expiresAtForDays(days: 1 | 7 | 30 | 90): Date {
  const ttlMs = Math.min(
    days * 24 * 60 * 60 * 1000,
    env.agentGrantMaxReadTtlMs,
  );
  return new Date(Date.now() + ttlMs);
}

export class AgentAuthService {
  static allowedReadScopes(): AgentScope[] {
    return [...READ_SCOPES];
  }

  static async startDeviceAuthorization(input: {
    requestedScopes?: AgentScope[];
    requestedWalletAddresses?: string[];
    requestedVenues?: string[];
    requestedLimits?: Record<string, unknown>;
    clientName?: string | null;
    clientVersion?: string | null;
    clientKind?: string | null;
    profileLabel?: string | null;
    grantName?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }) {
    const deviceCode = generateOpaqueToken(32);
    const approvalToken = generateOpaqueToken(32);
    const requestedScopes = normalizeScopes(input.requestedScopes);
    const requestedWalletAddresses = uniqueWallets(
      input.requestedWalletAddresses,
    );
    const requestedVenues = uniqueStrings(input.requestedVenues);
    const expiresAt = new Date(Date.now() + env.agentAuthApprovalTtlMs);
    const metadata = {
      profileLabel: input.profileLabel ?? null,
      grantName: input.grantName ?? null,
    };

    const { rows } = await pool.query<{ id: string }>(
      `
        insert into agent_device_authorizations (
          device_code_hash,
          approval_token_hash,
          status,
          requested_scopes,
          requested_wallet_addresses,
          requested_venues,
          requested_limits,
          client_name,
          client_version,
          client_kind,
          metadata,
          expires_at
        )
        values ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11)
        returning id
      `,
      [
        hashOpaqueToken(deviceCode),
        hashOpaqueToken(approvalToken),
        requestedScopes,
        requestedWalletAddresses,
        requestedVenues,
        input.requestedLimits ?? {},
        input.clientName ?? null,
        input.clientVersion ?? null,
        input.clientKind ?? null,
        metadata,
        expiresAt,
      ],
    );

    await recordAgentAudit(pool, {
      deviceAuthorizationId: rows[0].id,
      eventType: "agent_device_started",
      actorType: "agent",
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      metadata: {
        requestedScopes,
        requestedWalletCount: requestedWalletAddresses.length,
        requestedVenues,
        clientName: input.clientName ?? null,
        clientVersion: input.clientVersion ?? null,
        clientKind: input.clientKind ?? null,
      },
    });

    return {
      deviceCode,
      approvalUrl: buildApprovalUrl(approvalToken),
      approvalToken,
      expiresAt,
      pollIntervalSec: Math.ceil(env.agentAuthPollIntervalMs / 1000),
    };
  }

  static async getApprovalByToken(
    approvalToken: string,
  ): Promise<AgentDeviceAuthorization | null> {
    const auth = await fetchAuthorizationByHash(
      pool,
      "approval_token_hash",
      hashOpaqueToken(approvalToken),
    );
    if (!auth) return null;
    return expireAuthorizationIfNeeded(pool, auth);
  }

  static async approveDeviceAuthorization(input: {
    approvalToken: string;
    userId: string;
    scopes: AgentScope[];
    walletAddresses?: string[];
    venues?: string[];
    limits?: Record<string, unknown>;
    expiresInDays: 1 | 7 | 30 | 90;
    grantName?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const authRaw = await fetchAuthorizationByHash(
        client,
        "approval_token_hash",
        hashOpaqueToken(input.approvalToken),
        true,
      );
      if (!authRaw) {
        throw new AgentAuthError(
          "invalid_approval_token",
          "Invalid approval token",
          404,
        );
      }
      const auth = await expireAuthorizationIfNeeded(client, authRaw);
      if (auth.status !== "pending") {
        throw new AgentAuthError(
          `authorization_${auth.status}`,
          "Authorization is not pending",
          auth.status === "expired" ? 410 : 409,
        );
      }
      if (auth.approvalAttempts >= MAX_APPROVAL_ATTEMPTS) {
        throw new AgentAuthError(
          "too_many_approval_attempts",
          "Too many approval attempts",
          429,
        );
      }

      const scopes = normalizeScopes(input.scopes);
      const walletAddresses = uniqueWallets(input.walletAddresses);
      const venues = uniqueStrings(input.venues);
      assertSubset(scopes, auth.requestedScopes, "invalid_scope", "Scope");
      assertWalletApprovalAllowed({
        selectedWallets: walletAddresses,
        requestedWallets: auth.requestedWalletAddresses,
        approvedScopes: scopes,
      });
      assertSubset(venues, auth.requestedVenues, "invalid_venue", "Venue");
      await assertWalletsLinked(input.userId, walletAddresses);

      await client.query(
        `
          update agent_device_authorizations
          set
            status = 'approved',
            approved_scopes = $2,
            approved_wallet_addresses = $3,
            approved_venues = $4,
            approved_limits = $5,
            grant_expires_at = $6,
            approved_user_id = $7,
            approved_at = now(),
            approval_attempts = approval_attempts + 1,
            metadata = metadata || $8::jsonb
          where id = $1
        `,
        [
          auth.id,
          scopes,
          walletAddresses,
          venues,
          input.limits ?? {},
          expiresAtForDays(input.expiresInDays),
          input.userId,
          { grantName: input.grantName ?? null },
        ],
      );

      await recordAgentAudit(client, {
        userId: input.userId,
        deviceAuthorizationId: auth.id,
        eventType: "agent_device_approved",
        actorType: "user",
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        metadata: {
          scopes,
          walletCount: walletAddresses.length,
          venues,
          expiresInDays: input.expiresInDays,
        },
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  static async denyDeviceAuthorization(input: {
    approvalToken: string;
    userId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const authRaw = await fetchAuthorizationByHash(
        client,
        "approval_token_hash",
        hashOpaqueToken(input.approvalToken),
        true,
      );
      if (!authRaw) {
        throw new AgentAuthError(
          "invalid_approval_token",
          "Invalid approval token",
          404,
        );
      }
      const auth = await expireAuthorizationIfNeeded(client, authRaw);
      if (auth.status !== "pending") {
        throw new AgentAuthError(
          `authorization_${auth.status}`,
          "Authorization is not pending",
          auth.status === "expired" ? 410 : 409,
        );
      }
      await client.query(
        `
          update agent_device_authorizations
          set
            status = 'denied',
            denied_at = now(),
            approved_user_id = $2,
            approval_attempts = approval_attempts + 1
          where id = $1
        `,
        [auth.id, input.userId],
      );
      await recordAgentAudit(client, {
        userId: input.userId,
        deviceAuthorizationId: auth.id,
        eventType: "agent_device_denied",
        actorType: "user",
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  static async pollDeviceToken(deviceCode: string): Promise<
    | {
        ok: true;
        token: string;
        grant: AgentGrantSummary;
        expiresAt: string;
      }
    | {
        ok: false;
        error:
          | "authorization_pending"
          | "slow_down"
          | "access_denied"
          | "expired_token"
          | "token_already_issued";
        message: string;
        pollIntervalSec?: number;
      }
  > {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const authRaw = await fetchAuthorizationByHash(
        client,
        "device_code_hash",
        hashOpaqueToken(deviceCode),
        true,
      );
      if (!authRaw) {
        await client.query("commit");
        return {
          ok: false,
          error: "expired_token",
          message: "Device authorization is invalid or expired.",
        };
      }
      const auth = await expireAuthorizationIfNeeded(client, authRaw);

      if (auth.status === "denied") {
        await client.query("commit");
        return {
          ok: false,
          error: "access_denied",
          message: "The user denied this authorization request.",
        };
      }
      if (auth.status === "expired") {
        await client.query("commit");
        return {
          ok: false,
          error: "expired_token",
          message: "Device authorization expired.",
        };
      }
      if (auth.status === "token_issued") {
        await client.query("commit");
        return {
          ok: false,
          error: "token_already_issued",
          message:
            "This device authorization already issued a token. Reconnect to create a new grant.",
        };
      }

      const now = Date.now();
      const tooSoon =
        auth.lastPolledAt != null &&
        now - auth.lastPolledAt.getTime() < env.agentAuthPollIntervalMs;
      const pollCount = auth.pollCount + 1;
      await client.query(
        `
          update agent_device_authorizations
          set poll_count = poll_count + 1, last_polled_at = now()
          where id = $1
        `,
        [auth.id],
      );
      if (pollCount > env.agentAuthMaxPolls) {
        await client.query(
          `
            update agent_device_authorizations
            set status = 'expired'
            where id = $1 and status in ('pending', 'approved')
          `,
          [auth.id],
        );
        await client.query("commit");
        return {
          ok: false,
          error: "expired_token",
          message: "Device authorization exceeded the polling limit.",
        };
      }
      if (tooSoon) {
        await client.query("commit");
        return {
          ok: false,
          error: "slow_down",
          message: "Polling too quickly.",
          pollIntervalSec: Math.ceil(env.agentAuthPollIntervalMs / 1000),
        };
      }

      if (auth.status === "pending") {
        await client.query("commit");
        return {
          ok: false,
          error: "authorization_pending",
          message: "Authorization is still pending.",
          pollIntervalSec: Math.ceil(env.agentAuthPollIntervalMs / 1000),
        };
      }

      if (
        !auth.approvedUserId ||
        !auth.approvedScopes ||
        !auth.grantExpiresAt
      ) {
        throw new AgentAuthError(
          "invalid_authorization_state",
          "Approved authorization is incomplete",
          500,
        );
      }
      const user = await AuthService.getUserById(auth.approvedUserId);
      if (!user?.isActive) {
        throw new AgentAuthError("user_inactive", "User is inactive", 401);
      }

      const token = generateAgentToken();
      const grantDisplayName = grantName({
        grantName:
          typeof auth.metadata.grantName === "string"
            ? auth.metadata.grantName
            : null,
        profileLabel:
          typeof auth.metadata.profileLabel === "string"
            ? auth.metadata.profileLabel
            : null,
        clientName: auth.clientName,
      });
      const { rows } = await client.query<AgentGrantRow>(
        `
          insert into agent_grants (
            user_id,
            name,
            client_name,
            client_version,
            client_kind,
            token_hash,
            token_prefix,
            scopes,
            wallet_addresses,
            venues,
            limits,
            metadata,
            expires_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          returning
            id,
            user_id,
            name,
            client_name,
            client_version,
            client_kind,
            token_prefix,
            scopes,
            wallet_addresses,
            venues,
            allowed_chains,
            allowed_assets,
            confirmation_mode,
            limits,
            metadata,
            is_active,
            expires_at,
            last_used_at,
            revoked_at,
            created_at,
            updated_at
        `,
        [
          auth.approvedUserId,
          grantDisplayName,
          auth.clientName,
          auth.clientVersion,
          auth.clientKind,
          hashOpaqueToken(token),
          tokenPrefix(token),
          auth.approvedScopes,
          auth.approvedWalletAddresses ?? [],
          auth.approvedVenues ?? [],
          auth.approvedLimits ?? {},
          {
            deviceAuthorizationId: auth.id,
          },
          auth.grantExpiresAt,
        ],
      );
      const grant = mapGrant(rows[0]);
      await client.query(
        `
          update agent_device_authorizations
          set
            status = 'token_issued',
            approved_grant_id = $2,
            token_issued_at = now()
          where id = $1
        `,
        [auth.id, grant.id],
      );
      await recordAgentAudit(client, {
        userId: auth.approvedUserId,
        grantId: grant.id,
        deviceAuthorizationId: auth.id,
        eventType: "agent_token_issued",
        actorType: "agent",
        metadata: {
          tokenPrefix: tokenPrefix(token),
          scopes: grant.scopes,
        },
      });
      await client.query("commit");
      return {
        ok: true,
        token,
        grant: summarizeAgentGrant(grant),
        expiresAt: grant.expiresAt.toISOString(),
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  static async authenticateToken(token: string): Promise<{
    user: User;
    grant: AgentGrant;
  } | null> {
    const { rows } = await pool.query<AgentGrantRow>(
      `
        select
          id,
          user_id,
          name,
          client_name,
          client_version,
          client_kind,
          token_prefix,
          scopes,
          wallet_addresses,
          venues,
          allowed_chains,
          allowed_assets,
          confirmation_mode,
          limits,
          metadata,
          is_active,
          expires_at,
          last_used_at,
          revoked_at,
          created_at,
          updated_at
        from agent_grants
        where token_hash = $1
          and is_active = true
          and revoked_at is null
          and expires_at > now()
        limit 1
      `,
      [hashOpaqueToken(token)],
    );
    const row = rows[0];
    if (!row) return null;
    const grant = mapGrant(row);
    const user = await AuthService.getUserById(grant.userId);
    if (!user?.isActive) return null;
    await assertWalletsLinked(grant.userId, grant.walletAddresses);
    if (
      !grant.lastUsedAt ||
      Date.now() - grant.lastUsedAt.getTime() > 5 * 60 * 1000
    ) {
      void pool
        .query(`update agent_grants set last_used_at = now() where id = $1`, [
          grant.id,
        ])
        .catch(() => undefined);
    }
    return { user, grant };
  }

  static async listGrants(userId: string): Promise<AgentGrant[]> {
    const { rows } = await pool.query<AgentGrantRow>(
      `
        select
          id,
          user_id,
          name,
          client_name,
          client_version,
          client_kind,
          token_prefix,
          scopes,
          wallet_addresses,
          venues,
          allowed_chains,
          allowed_assets,
          confirmation_mode,
          limits,
          metadata,
          is_active,
          expires_at,
          last_used_at,
          revoked_at,
          created_at,
          updated_at
        from agent_grants
        where user_id = $1
        order by created_at desc
      `,
      [userId],
    );
    return rows.map(mapGrant);
  }

  static async revokeGrant(input: {
    userId: string;
    grantId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<boolean> {
    const { rows } = await pool.query<{ id: string }>(
      `
        update agent_grants
        set is_active = false, revoked_at = coalesce(revoked_at, now())
        where id = $1 and user_id = $2
        returning id
      `,
      [input.grantId, input.userId],
    );
    const revoked = Boolean(rows[0]);
    if (revoked) {
      await recordAgentAudit(pool, {
        userId: input.userId,
        grantId: input.grantId,
        eventType: "agent_grant_revoked",
        actorType: "user",
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
    }
    return revoked;
  }

  static async listAuditEvents(userId: string, limit: number) {
    const { rows } = await pool.query<{
      id: string;
      event_type: string;
      actor_type: "user" | "agent" | "system";
      grant_id: string | null;
      metadata: Record<string, unknown>;
      created_at: Date;
    }>(
      `
        select id, event_type, actor_type, grant_id, metadata, created_at
        from agent_audit_events
        where user_id = $1
        order by created_at desc
        limit $2
      `,
      [userId, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      actorType: row.actor_type,
      grantId: row.grant_id,
      createdAt: row.created_at.toISOString(),
      metadata: row.metadata ?? {},
    }));
  }
}

function readBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length ? token : null;
}

export function createAgentAuthMiddleware(
  options: { requiredScopes?: AgentScope[] } = {},
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!env.agentAuthEnabled) {
      reply.code(404);
      return reply.send({ error: "agent_auth_disabled" });
    }
    const token = readBearerToken(request);
    if (!token) {
      reply.code(401);
      return reply.send({
        error: "agent_auth_required",
        message: "Agent token required",
      });
    }
    const result = await AgentAuthService.authenticateToken(token);
    if (!result) {
      reply.code(401);
      return reply.send({
        error: "invalid_agent_token",
        message: "Invalid or expired agent token",
      });
    }
    const missingScope = options.requiredScopes?.find(
      (scope) => !result.grant.scopes.includes(scope),
    );
    if (missingScope) {
      reply.code(403);
      return reply.send({
        error: "agent_scope_required",
        message: `Missing required scope: ${missingScope}`,
      });
    }
    request.user = result.user;
    request.agentGrant = result.grant;
  };
}
