import crypto from "node:crypto";
import type { Pool } from "@hunch/infra";
import { AuthService, type User, type UserWallet } from "../auth.js";
import { env } from "../env.js";
import {
  AgentAuthError,
  AgentAuthService,
  type AgentGrant,
} from "./agent-auth.js";
import {
  buildAgentDepositTargets,
  type AgentWalletVenue,
  venuesForWallet,
} from "./agent-deposit-targets.js";
import {
  prepareAgentBridgeQuote,
  prepareAgentRedeemPlan,
  prepareAgentTradeQuote,
  resolveAgentTradeOutcomeSide,
  resolveAgentTradeOutcomeToken,
  type AgentIntentPreparationDeps,
} from "./agent-intent-preparation.js";
import {
  fetchMarketDetails,
  type MarketDetailsRow,
} from "../repos/unified-read.js";
import { fetchUnifiedOrderById } from "../repos/unified-orders.js";
import {
  mapUnifiedOrder,
  OPEN_ORDER_STATUSES,
} from "./unified-order-presenter.js";
import type {
  AgentFundingPlanRequest,
  AgentIntentRequest,
} from "../schemas/agent-intents.js";
import { agentIntentRequestSchema } from "../schemas/agent-intents.js";
import { cancelVenueOrder } from "./order-cancel.js";
import { createRewardsClaimForUser } from "./rewards-claim.js";

type AgentIntentStatus =
  | "pending_confirmation"
  | "blocked"
  | "expired"
  | "cancelled"
  | "approved"
  | "rejected"
  | "executing"
  | "executed"
  | "failed";
type PolicyDecision = "allowed_with_confirmation" | "blocked";

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const INTENT_TTL_MS = 30 * 60 * 1000;

type AgentIntentRow = {
  id: string;
  user_id: string;
  grant_id: string;
  kind: AgentIntentRequest["kind"];
  status: AgentIntentStatus;
  idempotency_key: string;
  venue: string | null;
  wallet_address: string | null;
  market_id: string | null;
  event_id: string | null;
  order_id: string | null;
  token_id: string | null;
  request_payload: Record<string, unknown>;
  resolved_payload: Record<string, unknown>;
  funding_plan: Record<string, unknown>;
  policy_result: Record<string, unknown>;
  execution_result: Record<string, unknown>;
  execution_attempts: Record<string, unknown>[];
  blockers: string[];
  warnings: string[];
  approved_by_user_id: string | null;
  approved_payload_hash: string | null;
  last_execution_error: string | null;
  terminal_order_id: string | null;
  terminal_tx_hash: string | null;
  approved_at: Date | null;
  rejected_at: Date | null;
  executed_at: Date | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
};

type ExistingAgentIntentRow = AgentIntentRow & {
  request_matches: boolean;
};

type CreateIntentResult = {
  intent: ReturnType<typeof mapIntent>;
  preview: IntentPreview;
  created: boolean;
};

type IntentPreview = {
  kind: AgentIntentRequest["kind"];
  market: Record<string, unknown> | null;
  wallet: Record<string, unknown> | null;
  quote: Record<string, unknown> | null;
  readiness: Record<string, unknown> | null;
  fundingPlan: Record<string, unknown> | null;
  policy: {
    decision: PolicyDecision;
    reasons: string[];
    limitsChecked: Record<string, unknown>;
  };
  blockers: string[];
  warnings: string[];
};

function normalizeWalletAddress(input: string | null | undefined): string {
  const trimmed = input?.trim() ?? "";
  if (EVM_ADDRESS_RE.test(trimmed)) return trimmed.toLowerCase();
  return trimmed;
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

function stringArrayField(
  record: Record<string, unknown> | null,
  field: string,
): string[] {
  const value = record?.[field];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hashIntentToken(token: string): string {
  const secret = env.agentTokenHashSecret;
  if (!secret) {
    throw new AgentAuthError(
      "agent_auth_disabled",
      "Agent auth is not configured",
      503,
    );
  }
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(",")}}`;
}

function buildApprovedPayloadHash(row: AgentIntentRow): string {
  return crypto
    .createHash("sha256")
    .update(
      stableJsonStringify({
        request: row.request_payload,
        preview: row.resolved_payload,
        fundingPlan: row.funding_plan,
        policy: row.policy_result,
        blockers: row.blockers,
        warnings: row.warnings,
      }),
    )
    .digest("hex");
}

function deterministicReviewToken(input: {
  grantId: string;
  idempotencyKey: string;
}): string {
  const secret = env.agentTokenHashSecret;
  if (!secret) {
    throw new AgentAuthError(
      "agent_auth_disabled",
      "Agent auth is not configured",
      503,
    );
  }
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`agent-intent-review:${input.grantId}:${input.idempotencyKey}`)
    .digest("base64url");
  return `air_${digest}`;
}

function buildReviewUrl(reviewToken: string): string {
  const base = env.agentAppBaseUrl.replace(/\/+$/, "");
  return `${base}/agent/intents/${encodeURIComponent(reviewToken)}`;
}

function buildReviewUrlForIntent(
  row: Pick<AgentIntentRow, "grant_id" | "idempotency_key">,
): string {
  return buildReviewUrl(
    deterministicReviewToken({
      grantId: row.grant_id,
      idempotencyKey: row.idempotency_key,
    }),
  );
}

async function loadApprovedWallets(input: {
  userId: string;
  grant: AgentGrant;
  walletAddress?: string;
  wallets?: string[];
}): Promise<UserWallet[]> {
  const requested = uniqueStrings([
    ...(input.walletAddress ? [input.walletAddress] : []),
    ...(input.wallets ?? []),
  ]).map(normalizeWalletAddress);
  const approved = new Set(
    input.grant.walletAddresses.map((wallet) => normalizeWalletAddress(wallet)),
  );
  if (approved.size === 0) {
    if (requested.length > 0) {
      throw new AgentAuthError(
        "wallet_not_in_grant",
        "Wallet is not approved for this agent grant",
        403,
      );
    }
    return [];
  }
  const linked = await AuthService.getUserWallets(input.userId);
  const approvedWallets = linked.filter((wallet) =>
    approved.has(normalizeWalletAddress(wallet.walletAddress)),
  );
  if (requested.length === 0) return approvedWallets;

  const byAddress = new Map(
    approvedWallets.map((wallet) => [
      normalizeWalletAddress(wallet.walletAddress),
      wallet,
    ]),
  );
  return requested.map((walletAddress) => {
    const wallet = byAddress.get(walletAddress);
    if (!wallet) {
      throw new AgentAuthError(
        "wallet_not_in_grant",
        "Wallet is not approved for this agent grant",
        403,
      );
    }
    return wallet;
  });
}

function assertVenueAllowed(grant: AgentGrant, venue: string | null): string[] {
  if (!venue || grant.venues.length === 0 || grant.venues.includes(venue)) {
    return [];
  }
  return ["venue_not_in_grant"];
}

function marketExpired(row: MarketDetailsRow): boolean {
  const raw = row.expiration_time ?? row.close_time;
  if (!raw) return false;
  const date = raw instanceof Date ? raw : new Date(String(raw));
  return Number.isFinite(date.getTime()) && date.getTime() <= Date.now();
}

function mapMarket(row: MarketDetailsRow): Record<string, unknown> {
  return {
    marketId: row.market_id,
    eventId: row.event_id,
    venue: row.venue,
    venueMarketId: row.venue_market_id,
    title: row.market_title,
    eventTitle: row.event_title,
    status: row.market_status,
    acceptingOrders: row.pm_accepting_orders,
    category: row.market_category ?? row.event_category,
    tokens: {
      yes: row.token_yes,
      no: row.token_no,
    },
    prices: {
      yesBid: asNumber(row.best_bid_yes ?? row.best_bid),
      yesAsk: asNumber(row.best_ask_yes ?? row.best_ask),
      noBid: asNumber(row.best_bid_no),
      noAsk: asNumber(row.best_ask_no),
      last: asNumber(row.last_price),
    },
    links: {
      marketUrl: `${env.agentAppBaseUrl.replace(/\/+$/, "")}/events/${encodeURIComponent(row.event_id)}?market=${encodeURIComponent(row.market_id)}`,
    },
  };
}

function maxTradeUsdFromLimits(limits: Record<string, unknown>): number | null {
  for (const key of ["maxTradeUsd", "maxOrderUsd", "tradeUsd", "perTradeUsd"]) {
    const value = asNumber(limits[key]);
    if (value != null && value >= 0) return value;
  }
  return null;
}

function evaluatePolicy(input: {
  grant: AgentGrant;
  notionalUsd: number | null;
  blockers: string[];
}): IntentPreview["policy"] {
  const blockers = [...input.blockers];
  const limitsChecked: Record<string, unknown> = {};
  const maxTradeUsd = maxTradeUsdFromLimits(input.grant.limits);
  if (maxTradeUsd != null) {
    limitsChecked.maxTradeUsd = maxTradeUsd;
    limitsChecked.notionalUsd = input.notionalUsd;
    if (input.notionalUsd != null && input.notionalUsd > maxTradeUsd) {
      blockers.push("limit_exceeded");
    }
  }
  return {
    decision: blockers.length ? "blocked" : "allowed_with_confirmation",
    reasons: blockers,
    limitsChecked,
  };
}

async function resolveMarket(input: {
  db: Pool;
  marketId?: string;
}): Promise<MarketDetailsRow | null> {
  if (!input.marketId) return null;
  const rows = await fetchMarketDetails(input.db, input.marketId);
  return rows[0] ?? null;
}

export async function buildAgentFundingPlan(input: {
  db: Pool;
  user: User;
  grant: AgentGrant;
  request: AgentFundingPlanRequest;
}): Promise<Record<string, unknown>> {
  const wallets = await loadApprovedWallets({
    userId: input.user.id,
    grant: input.grant,
    walletAddress: input.request.walletAddress,
    wallets: input.request.wallets,
  });
  const market = await resolveMarket({
    db: input.db,
    marketId: input.request.marketId,
  });
  const venue = (input.request.venue ?? market?.venue ?? undefined) as
    | AgentWalletVenue
    | undefined;
  const blockers = assertVenueAllowed(input.grant, venue ?? null);
  if (wallets.length === 0) blockers.push("missing_wallet");
  const depositTargetResult = blockers.length
    ? { items: [], blockers: [], warnings: [] }
    : await buildAgentDepositTargets({
        userId: input.user.id,
        wallets,
        venue,
        asset: input.request.asset,
      });
  const finalBlockers = uniqueStrings([
    ...blockers,
    ...depositTargetResult.blockers,
  ]);
  return {
    venue: venue ?? null,
    market: market ? mapMarket(market) : null,
    requestedAmount: input.request.amount ?? null,
    missingAmount: null,
    balanceStatus: "not_checked",
    depositTargets: depositTargetResult.items,
    bridgeSuggestions: [],
    blockers: finalBlockers,
    warnings: uniqueStrings([
      ...(wallets.length === 0
        ? ["No approved wallet is available for this funding plan."]
        : []),
      ...depositTargetResult.warnings,
    ]),
    note: "Funding plans are guidance only in Phase 3; no deposit or bridge order was created.",
  };
}

export async function previewAgentIntent(input: {
  db: Pool;
  user: User;
  grant: AgentGrant;
  request: AgentIntentRequest;
  preparation?: AgentIntentPreparationDeps;
}): Promise<IntentPreview> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const wallets = await loadApprovedWallets({
    userId: input.user.id,
    grant: input.grant,
    walletAddress: input.request.walletAddress,
  });
  const wallet = wallets[0] ?? null;
  if (!wallet) blockers.push("missing_wallet");

  const market = await resolveMarket({
    db: input.db,
    marketId: input.request.marketId,
  });
  if (input.request.marketId && !market) blockers.push("market_not_found");

  const venue = (input.request.venue ?? market?.venue ?? undefined) as
    | AgentWalletVenue
    | undefined;
  blockers.push(...assertVenueAllowed(input.grant, venue ?? null));
  if (venue && wallet && !venuesForWallet(wallet).includes(venue)) {
    blockers.push("wallet_type_mismatch");
  }

  let quote: Record<string, unknown> | null = null;
  let notionalUsd: number | null = null;
  let fundingPlan: Record<string, unknown> | null = null;
  const readiness: Record<string, unknown> | null = null;

  if (input.request.kind === "trade") {
    if (!market) blockers.push("market_required");
    if (market && market.market_status !== "ACTIVE") {
      blockers.push("market_not_accepting_orders");
    }
    if (market && marketExpired(market)) blockers.push("market_expired");
    if (market?.pm_accepting_orders === false) {
      blockers.push("market_not_accepting_orders");
    }
    const resolvedOutcome = market
      ? resolveAgentTradeOutcomeSide({
          row: market,
          outcome: input.request.outcome,
          tokenId: input.request.tokenId,
        })
      : input.request.outcome;
    const tokenId =
      input.request.tokenId ??
      (market ? resolveAgentTradeOutcomeToken(market, resolvedOutcome) : null);
    if (!tokenId) blockers.push("token_required");
    if (market && input.request.tokenId && !resolvedOutcome) {
      blockers.push("token_not_in_market");
    }
    if (market && resolvedOutcome && tokenId) {
      const prepared = await prepareAgentTradeQuote({
        db: input.db,
        user: input.user,
        wallet,
        market,
        venue,
        request: input.request,
        outcome: resolvedOutcome,
        tokenId,
        preparation: input.preparation,
      });
      quote = prepared.quote;
      notionalUsd = prepared.notionalUsd;
      blockers.push(...prepared.blockers);
      warnings.push(...prepared.warnings);
    }
    if (venue && wallet) {
      fundingPlan = await buildAgentFundingPlan({
        db: input.db,
        user: input.user,
        grant: input.grant,
        request: {
          venue,
          walletAddress: wallet.walletAddress,
          marketId: market?.market_id,
          asset: undefined,
          amount: notionalUsd ?? undefined,
        },
      });
    }
  } else if (input.request.kind === "bridge") {
    const prepared = await prepareAgentBridgeQuote({
      db: input.db,
      user: input.user,
      wallet,
      venue,
      request: input.request,
      preparation: input.preparation,
    });
    quote = prepared.quote;
    fundingPlan = prepared.fundingPlan;
    blockers.push(...prepared.blockers);
    warnings.push(...prepared.warnings);
  } else if (input.request.kind === "cancel_order") {
    if (!wallet) {
      blockers.push("missing_wallet");
    } else {
      const row = await fetchUnifiedOrderById(input.db, {
        userId: input.user.id,
        walletAddresses: wallets.map((item) => item.walletAddress),
        id: input.request.orderId,
      });
      if (!row) {
        blockers.push("order_not_found");
      } else {
        quote = {
          action: "cancel_order",
          order: mapUnifiedOrder(row),
        };
        if (!OPEN_ORDER_STATUSES.includes((row.status ?? "").toLowerCase())) {
          blockers.push("order_not_open");
        }
      }
    }
  } else if (input.request.kind === "redeem") {
    const prepared = await prepareAgentRedeemPlan({
      db: input.db,
      user: input.user,
      wallet,
      market,
      venue,
      request: input.request,
      preparation: input.preparation,
    });
    quote = prepared.quote;
    blockers.push(...prepared.blockers);
    warnings.push(...prepared.warnings);
  } else if (input.request.kind === "rewards_claim") {
    quote = {
      action: "rewards_claim",
      chainId: input.request.chainId,
      amount: input.request.amount ?? null,
      walletAddress: wallet?.walletAddress ?? input.request.walletAddress ?? null,
      note: "Creates a pending rewards claim if approved and executed. It does not sign a payout transaction.",
    };
  } else if (
    input.request.kind === "transfer" ||
    input.request.kind === "convert" ||
    input.request.kind === "withdraw"
  ) {
    quote = {
      action: input.request.kind,
      srcChainId: input.request.srcChainId ?? null,
      srcToken: input.request.srcToken ?? null,
      dstToken:
        input.request.kind === "convert" ? input.request.dstToken ?? null : null,
      amountIn: input.request.amountIn ?? null,
      recipientAddress:
        input.request.kind === "transfer" ||
        input.request.kind === "withdraw"
          ? input.request.recipientAddress ?? null
          : null,
      note: "This intent kind is modeled for future execution, but execution is not enabled yet.",
    };
    blockers.push("execution_not_supported");
  }

  blockers.push(...stringArrayField(fundingPlan, "blockers"));
  warnings.push(...stringArrayField(fundingPlan, "warnings"));

  const uniqueBlockers = uniqueStrings(blockers);
  const policy = evaluatePolicy({
    grant: input.grant,
    notionalUsd,
    blockers: uniqueBlockers,
  });
  const finalBlockers = uniqueStrings(policy.reasons);

  return {
    kind: input.request.kind,
    market: market ? mapMarket(market) : null,
    wallet: wallet
      ? {
          walletAddress: wallet.walletAddress,
          walletType: wallet.walletType,
        }
      : null,
    quote,
    readiness,
    fundingPlan,
    policy: {
      ...policy,
      reasons: finalBlockers,
    },
    blockers: finalBlockers,
    warnings: uniqueStrings(warnings),
  };
}

function mapIntent(row: AgentIntentRow, reviewUrl?: string | null) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    venue: row.venue,
    walletAddress: row.wallet_address,
    marketId: row.market_id,
    eventId: row.event_id,
    orderId: row.order_id,
    tokenId: row.token_id,
    request: row.request_payload,
    preview: row.resolved_payload,
    fundingPlan: row.funding_plan,
    policy: row.policy_result,
    executionResult: row.execution_result,
    executionAttempts: row.execution_attempts,
    lastExecutionError: row.last_execution_error,
    terminalOrderId: row.terminal_order_id,
    terminalTxHash: row.terminal_tx_hash,
    blockers: row.blockers,
    warnings: row.warnings,
    approvedByUserId: row.approved_by_user_id,
    approvedAt: row.approved_at?.toISOString() ?? null,
    rejectedAt: row.rejected_at?.toISOString() ?? null,
    executedAt: row.executed_at?.toISOString() ?? null,
    reviewUrl: reviewUrl ?? null,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function loadExistingIntentByIdempotency(input: {
  db: Pool;
  grantId: string;
  idempotencyKey: string;
  request: AgentIntentRequest;
}): Promise<{ row: AgentIntentRow; requestMatches: boolean } | null> {
  const { rows } = await input.db.query<ExistingAgentIntentRow>(
    `
      select *,
        request_payload = $3::jsonb as request_matches
      from agent_intents
      where grant_id = $1
        and idempotency_key = $2
      limit 1
    `,
    [input.grantId, input.idempotencyKey, input.request],
  );
  const row = rows[0];
  return row ? { row, requestMatches: row.request_matches } : null;
}

function assertIdempotentIntentRequest(
  existing: { row: AgentIntentRow; requestMatches: boolean } | null,
): AgentIntentRow | null {
  if (!existing) return null;
  if (!existing.requestMatches) {
    throw new AgentAuthError(
      "idempotency_key_reused",
      "Idempotency key was already used for a different agent intent request",
      409,
    );
  }
  return existing.row;
}

export async function createAgentIntent(input: {
  db: Pool;
  user: User;
  grant: AgentGrant;
  request: AgentIntentRequest;
  preparation?: AgentIntentPreparationDeps;
}): Promise<CreateIntentResult> {
  const existing = assertIdempotentIntentRequest(
    await loadExistingIntentByIdempotency({
      db: input.db,
      grantId: input.grant.id,
      idempotencyKey: input.request.idempotencyKey,
      request: input.request,
    }),
  );
  if (existing) {
    return {
      intent: mapIntent(existing, buildReviewUrlForIntent(existing)),
      preview: existing.resolved_payload as IntentPreview,
      created: false,
    };
  }

  const preview = await previewAgentIntent(input);
  const reviewToken = deterministicReviewToken({
    grantId: input.grant.id,
    idempotencyKey: input.request.idempotencyKey,
  });
  const status: AgentIntentStatus =
    preview.policy.decision === "blocked" ? "blocked" : "pending_confirmation";
  const market = preview.market;
  const quote = preview.quote;
  const quoteOrder = asRecord(quote?.order);
  const resolvedVenue =
    input.request.venue ??
    (typeof market?.venue === "string" ? market.venue : null) ??
    (typeof quoteOrder.venue === "string" ? quoteOrder.venue : null);
  const { rows } = await input.db.query<AgentIntentRow>(
    `
      insert into agent_intents (
        user_id,
        grant_id,
        kind,
        status,
        idempotency_key,
        venue,
        wallet_address,
        market_id,
        event_id,
        order_id,
        token_id,
        request_payload,
        resolved_payload,
        funding_plan,
        policy_result,
        blockers,
        warnings,
        review_token_hash,
        expires_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19
      )
      on conflict (grant_id, idempotency_key)
      do nothing
      returning *
    `,
    [
      input.user.id,
      input.grant.id,
      input.request.kind,
      status,
      input.request.idempotencyKey,
      resolvedVenue,
      input.request.walletAddress ?? null,
      input.request.marketId ??
        (typeof market?.marketId === "string" ? market.marketId : null),
      input.request.eventId ??
        (typeof market?.eventId === "string" ? market.eventId : null),
      input.request.kind === "cancel_order" ? input.request.orderId : null,
      input.request.kind === "trade" && typeof quote?.tokenId === "string"
        ? quote.tokenId
        : input.request.kind === "redeem"
          ? (input.request.tokenId ?? null)
          : null,
      input.request,
      preview,
      preview.fundingPlan ?? {},
      preview.policy,
      preview.blockers,
      preview.warnings,
      hashIntentToken(reviewToken),
      new Date(Date.now() + INTENT_TTL_MS),
    ],
  );
  let row: AgentIntentRow | null = rows[0] ?? null;
  const created = Boolean(row);
  if (!row) {
    row = assertIdempotentIntentRequest(
      await loadExistingIntentByIdempotency({
        db: input.db,
        grantId: input.grant.id,
        idempotencyKey: input.request.idempotencyKey,
        request: input.request,
      }),
    );
  }
  if (!row) {
    throw new AgentAuthError(
      "intent_create_failed",
      "Unable to create or load agent intent",
      500,
    );
  }
  if (created) {
    await AgentAuthService.recordAuditEvent({
      userId: input.user.id,
      grantId: input.grant.id,
      eventType:
        status === "blocked" ? "agent_intent_blocked" : "agent_intent_created",
      actorType: "agent",
      metadata: {
        intentId: row.id,
        kind: row.kind,
        status: row.status,
        venue: row.venue,
        marketId: row.market_id,
        blockers: row.blockers,
      },
    });
  }
  const persistedPreview = row.resolved_payload as IntentPreview;
  return {
    intent: mapIntent(row, buildReviewUrlForIntent(row)),
    preview: persistedPreview,
    created,
  };
}

export async function getAgentIntentById(input: {
  db: Pool;
  user: User;
  grant: AgentGrant;
  id: string;
}) {
  const { rows } = await input.db.query<AgentIntentRow>(
    `
      select *
      from agent_intents
      where id = $1
        and user_id = $2
      limit 1
    `,
    [input.id, input.user.id],
  );
  const row = rows[0];
  if (!row) return null;
  const accessible = await grantCanAccessIntent({
    user: input.user,
    grant: input.grant,
    row,
  });
  return accessible ? mapIntent(row, buildReviewUrlForIntent(row)) : null;
}

export async function getAgentIntentReview(input: {
  db: Pool;
  user: User;
  reviewToken: string;
}) {
  const { rows } = await input.db.query<AgentIntentRow>(
    `
      select *
      from agent_intents
      where review_token_hash = $1
        and user_id = $2
      limit 1
    `,
    [hashIntentToken(input.reviewToken), input.user.id],
  );
  const row = rows[0];
  if (!row) return null;
  const status =
    row.expires_at.getTime() <= Date.now() &&
    row.status === "pending_confirmation"
      ? "expired"
      : row.status;
  return mapIntent({ ...row, status }, buildReviewUrlForIntent(row));
}

async function loadIntentForUser(input: {
  db: Pool;
  userId: string;
  id: string;
}): Promise<AgentIntentRow | null> {
  const { rows } = await input.db.query<AgentIntentRow>(
    `
      select *
      from agent_intents
      where id = $1
        and user_id = $2
      limit 1
    `,
    [input.id, input.userId],
  );
  return rows[0] ?? null;
}

function assertIntentPendingForApproval(row: AgentIntentRow): void {
  if (row.expires_at.getTime() <= Date.now()) {
    throw new AgentAuthError(
      "agent_intent_expired",
      "Agent intent expired. Ask the agent to prepare a fresh intent.",
      409,
    );
  }
  if (row.status !== "pending_confirmation") {
    throw new AgentAuthError(
      "agent_intent_not_pending",
      `Agent intent cannot be approved from status ${row.status}.`,
      409,
    );
  }
  if (row.blockers.length > 0) {
    throw new AgentAuthError(
      "agent_intent_blocked",
      "Blocked agent intents cannot be approved.",
      409,
    );
  }
}

export async function approveAgentIntent(input: {
  db: Pool;
  user: User;
  id: string;
  userAgent?: string | null;
}) {
  const row = await loadIntentForUser({
    db: input.db,
    userId: input.user.id,
    id: input.id,
  });
  if (!row) return null;
  assertIntentPendingForApproval(row);
  const approvedPayloadHash = buildApprovedPayloadHash(row);
  const { rows } = await input.db.query<AgentIntentRow>(
    `
      update agent_intents
      set status = 'approved',
          approved_by_user_id = $3,
          approved_payload_hash = $4,
          approved_at = now(),
          rejected_at = null,
          last_execution_error = null
      where id = $1
        and user_id = $2
        and status = 'pending_confirmation'
      returning *
    `,
    [input.id, input.user.id, input.user.id, approvedPayloadHash],
  );
  const updated = rows[0];
  if (!updated) {
    throw new AgentAuthError(
      "agent_intent_state_changed",
      "Agent intent changed before approval completed.",
      409,
    );
  }
  await AgentAuthService.recordAuditEvent({
    userId: input.user.id,
    grantId: updated.grant_id,
    eventType: "agent_intent_approved",
    actorType: "user",
    userAgent: input.userAgent ?? undefined,
    metadata: {
      intentId: updated.id,
      kind: updated.kind,
      venue: updated.venue,
      marketId: updated.market_id,
    },
  });
  return mapIntent(updated, buildReviewUrlForIntent(updated));
}

export async function rejectAgentIntent(input: {
  db: Pool;
  user: User;
  id: string;
  userAgent?: string | null;
}) {
  const row = await loadIntentForUser({
    db: input.db,
    userId: input.user.id,
    id: input.id,
  });
  if (!row) return null;
  if (
    ![
      "pending_confirmation",
      "approved",
      "blocked",
      "expired",
    ].includes(row.status)
  ) {
    throw new AgentAuthError(
      "agent_intent_terminal",
      `Agent intent cannot be rejected from status ${row.status}.`,
      409,
    );
  }
  const { rows } = await input.db.query<AgentIntentRow>(
    `
      update agent_intents
      set status = 'rejected',
          rejected_at = now()
      where id = $1
        and user_id = $2
        and status in ('pending_confirmation', 'approved', 'blocked', 'expired')
      returning *
    `,
    [input.id, input.user.id],
  );
  const updated = rows[0];
  if (!updated) {
    throw new AgentAuthError(
      "agent_intent_state_changed",
      "Agent intent changed before rejection completed.",
      409,
    );
  }
  await AgentAuthService.recordAuditEvent({
    userId: input.user.id,
    grantId: updated.grant_id,
    eventType: "agent_intent_rejected",
    actorType: "user",
    userAgent: input.userAgent ?? undefined,
    metadata: {
      intentId: updated.id,
      kind: updated.kind,
      venue: updated.venue,
      marketId: updated.market_id,
    },
  });
  return mapIntent(updated, buildReviewUrlForIntent(updated));
}

function mapExecutionError(error: unknown): {
  message: string;
  statusCode: number;
  details: Record<string, unknown>;
} {
  if (error instanceof AgentAuthError) {
    return {
      message: error.message,
      statusCode: error.statusCode,
      details: { code: error.code },
    };
  }
  if (error instanceof Error) {
    const record = error as Error & {
      statusCode?: number;
      status?: number;
      payload?: unknown;
      reason?: unknown;
      signer?: unknown;
    };
    const statusCode =
      typeof record.statusCode === "number" && Number.isFinite(record.statusCode)
        ? record.statusCode
        : 500;
    return {
      message: error.message || "Agent intent execution failed",
      statusCode,
      details: {
        status: record.status ?? null,
        reason: record.reason ?? null,
        signer: record.signer ?? null,
        payload: record.payload ?? null,
      },
    };
  }
  return {
    message: "Agent intent execution failed",
    statusCode: 500,
    details: {},
  };
}

async function runApprovedIntentExecution(input: {
  db: Pool;
  user: User;
  row: AgentIntentRow;
  request: AgentIntentRequest;
}): Promise<{
  result: Record<string, unknown>;
  terminalOrderId: string | null;
  terminalTxHash: string | null;
}> {
  const request = input.request;

  if (request.kind === "cancel_order") {
    const venue = input.row.venue ?? request.venue ?? null;
    if (!venue) {
      throw new AgentAuthError(
        "agent_intent_missing_venue",
        "Cancel intent is missing a resolved venue.",
        409,
      );
    }
    const cancelled = await cancelVenueOrder(input.db, {
      userId: input.user.id,
      venue,
      orderId: request.orderId,
      requestedWalletAddress: input.row.wallet_address ?? request.walletAddress,
    });
    return {
      result: {
        action: "cancel_order",
        ...cancelled,
      },
      terminalOrderId: cancelled.orderId,
      terminalTxHash: null,
    };
  }

  if (request.kind === "rewards_claim") {
    const claim = await createRewardsClaimForUser(input.db, {
      userId: input.user.id,
      fallbackWalletAddress: input.row.wallet_address,
      walletAddress: request.walletAddress,
      chainId: request.chainId,
      amount: request.amount,
    });
    return {
      result: {
        action: "rewards_claim",
        claim: {
          id: claim.claimId,
          amount: Number(claim.amountUsd),
          amountUsd: claim.amountUsd,
          status: "pending",
          chainId: claim.chainId,
          walletAddress: claim.walletAddress,
        },
      },
      terminalOrderId: claim.claimId,
      terminalTxHash: null,
    };
  }

  throw new AgentAuthError(
    "agent_intent_execution_not_supported",
    `${request.kind} execution is not enabled for agent intents yet.`,
    409,
  );
}

export async function executeAgentIntent(input: {
  db: Pool;
  user: User;
  grant: AgentGrant;
  id: string;
  userAgent?: string | null;
}) {
  const row = await getAgentIntentRowForExecution(input);
  if (!row) return null;
  const request = await assertGrantCanAccessIntent({
    user: input.user,
    grant: input.grant,
    row,
  });

  if (["executed", "failed", "rejected", "expired"].includes(row.status)) {
    return {
      intent: mapIntent(row, buildReviewUrlForIntent(row)),
      terminal: true,
    };
  }
  if (row.status !== "approved") {
    throw new AgentAuthError(
      "agent_intent_not_approved",
      `Agent intent cannot be executed from status ${row.status}.`,
      409,
    );
  }
  if (row.expires_at.getTime() <= Date.now()) {
    const expired = await updateAgentIntentStatus(input.db, row, {
      status: "expired",
      executionResult: row.execution_result,
    });
    return {
      intent: mapIntent(expired, buildReviewUrlForIntent(expired)),
      terminal: true,
    };
  }

  const approvedPayloadHash = row.approved_payload_hash;
  if (!approvedPayloadHash) {
    throw new AgentAuthError(
      "agent_intent_missing_approval_hash",
      "Approved intent is missing its approval payload hash.",
      409,
    );
  }
  if (approvedPayloadHash !== buildApprovedPayloadHash(row)) {
    throw new AgentAuthError(
      "agent_intent_payload_changed",
      "Approved intent payload changed after approval.",
      409,
    );
  }

  const executing = await markAgentIntentExecuting(input.db, row);
  try {
    const execution = await runApprovedIntentExecution({
      db: input.db,
      user: input.user,
      row: executing,
      request,
    });
    const updated = await updateAgentIntentStatus(input.db, executing, {
      status: "executed",
      executionResult: execution.result,
      terminalOrderId: execution.terminalOrderId,
      terminalTxHash: execution.terminalTxHash,
    });
    await AgentAuthService.recordAuditEvent({
      userId: input.user.id,
      grantId: input.grant.id,
      eventType: "agent_intent_executed",
      actorType: "agent",
      userAgent: input.userAgent ?? undefined,
      metadata: {
        intentId: updated.id,
        kind: updated.kind,
        venue: updated.venue,
        terminalOrderId: updated.terminal_order_id,
        terminalTxHash: updated.terminal_tx_hash,
      },
    });
    return {
      intent: mapIntent(updated, buildReviewUrlForIntent(updated)),
      terminal: true,
    };
  } catch (error) {
    const mappedError = mapExecutionError(error);
    const updated = await updateAgentIntentStatus(input.db, executing, {
      status: "failed",
      executionResult: {
        ok: false,
        error: mappedError.message,
        details: mappedError.details,
      },
      lastExecutionError: mappedError.message,
    });
    await AgentAuthService.recordAuditEvent({
      userId: input.user.id,
      grantId: input.grant.id,
      eventType: "agent_intent_failed",
      actorType: "agent",
      userAgent: input.userAgent ?? undefined,
      metadata: {
        intentId: updated.id,
        kind: updated.kind,
        venue: updated.venue,
        error: mappedError.message,
      },
    });
    return {
      intent: mapIntent(updated, buildReviewUrlForIntent(updated)),
      terminal: true,
      failed: true,
    };
  }
}

async function assertGrantCanAccessIntent(input: {
  user: User;
  grant: AgentGrant;
  row: AgentIntentRow;
}): Promise<AgentIntentRequest> {
  const request = agentIntentRequestSchema.parse(input.row.request_payload);
  await loadApprovedWallets({
    userId: input.user.id,
    grant: input.grant,
    walletAddress: input.row.wallet_address ?? request.walletAddress,
  });
  const venueBlockers = assertVenueAllowed(input.grant, input.row.venue);
  if (venueBlockers.length > 0) {
    throw new AgentAuthError(
      "agent_intent_venue_not_allowed",
      "Intent venue is not allowed by this grant.",
      403,
    );
  }
  return request;
}

async function grantCanAccessIntent(input: {
  user: User;
  grant: AgentGrant;
  row: AgentIntentRow;
}): Promise<boolean> {
  try {
    await assertGrantCanAccessIntent(input);
    return true;
  } catch (error) {
    if (
      error instanceof AgentAuthError &&
      (error.code === "wallet_not_in_grant" ||
        error.code === "agent_intent_venue_not_allowed")
    ) {
      return false;
    }
    throw error;
  }
}

async function getAgentIntentRowForExecution(input: {
  db: Pool;
  user: User;
  grant: AgentGrant;
  id: string;
}): Promise<AgentIntentRow | null> {
  const { rows } = await input.db.query<AgentIntentRow>(
    `
      select *
      from agent_intents
      where id = $1
        and user_id = $2
      limit 1
    `,
    [input.id, input.user.id],
  );
  return rows[0] ?? null;
}

async function markAgentIntentExecuting(
  db: Pool,
  row: AgentIntentRow,
): Promise<AgentIntentRow> {
  const attempt = {
    status: "executing",
    at: new Date().toISOString(),
  };
  const { rows } = await db.query<AgentIntentRow>(
    `
      update agent_intents
      set status = 'executing',
          execution_attempts = execution_attempts || $2::jsonb,
          last_execution_error = null
      where id = $1
        and status = 'approved'
      returning *
    `,
    [row.id, JSON.stringify([attempt])],
  );
  const updated = rows[0];
  if (!updated) {
    throw new AgentAuthError(
      "agent_intent_state_changed",
      "Agent intent changed before execution started.",
      409,
    );
  }
  return updated;
}

async function updateAgentIntentStatus(
  db: Pool,
  row: AgentIntentRow,
  input: {
    status: AgentIntentStatus;
    executionResult: Record<string, unknown>;
    lastExecutionError?: string | null;
    terminalOrderId?: string | null;
    terminalTxHash?: string | null;
  },
): Promise<AgentIntentRow> {
  const { rows } = await db.query<AgentIntentRow>(
    `
      update agent_intents
      set status = $2,
          execution_result = $3::jsonb,
          last_execution_error = $4,
          terminal_order_id = $5,
          terminal_tx_hash = $6,
          executed_at = case when $2 = 'executed' then now() else executed_at end
      where id = $1
      returning *
    `,
    [
      row.id,
      input.status,
      input.executionResult,
      input.lastExecutionError ?? null,
      input.terminalOrderId ?? row.terminal_order_id,
      input.terminalTxHash ?? row.terminal_tx_hash,
    ],
  );
  const updated = rows[0];
  if (!updated) {
    throw new AgentAuthError(
      "agent_intent_update_failed",
      "Agent intent status update failed.",
      500,
    );
  }
  return updated;
}
