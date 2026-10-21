import { tx, type Pool } from "@hunch/infra";
import type { DbQuery } from "../db.js";
import {
  paperBuySnapshotSchema,
  type PaperBuySnapshot,
  type SocialBuySnapshot,
} from "../schemas/social-trade.js";
import { resolveAgentThesesPolicy } from "./agent-theses-policy.js";
import { resolveSocialPolicy } from "./social-policy.js";
import {
  readSocialMarket,
  socialInstrumentMatches,
  socialMarketAccepting,
} from "./social-service.js";
import {
  compareSocialDecimal,
  divideSocialDecimal,
  socialFingerprint,
  socialText,
  SocialError,
} from "./social-primitives.js";

export function validatePaperQuote(input: {
  ask: string | null;
  asOf: Date | string | null;
  now: Date;
  maxAgeSeconds: number;
  maxEntryPrice: string;
}): { ask: string; asOf: string } {
  const { ask, maxEntryPrice } = input;
  if (
    ask === null ||
    !/^\d+(?:\.\d+)?$/.test(ask) ||
    compareSocialDecimal(ask, "0") <= 0 ||
    compareSocialDecimal(ask, "1") > 0
  )
    throw new SocialError("quote_unavailable", 409);
  if (
    !/^\d+(?:\.\d+)?$/.test(maxEntryPrice) ||
    compareSocialDecimal(maxEntryPrice, "0") <= 0 ||
    compareSocialDecimal(maxEntryPrice, "1") > 0
  )
    throw new SocialError("invalid_max_entry_price");
  const at = input.asOf ? new Date(input.asOf).getTime() : NaN;
  const age = input.now.getTime() - at;
  if (!Number.isFinite(age) || age < 0 || age > input.maxAgeSeconds * 1000)
    throw new SocialError("stale_quote", 409);
  if (compareSocialDecimal(ask, maxEntryPrice) > 0)
    throw new SocialError("price_changed", 409);
  return { ask, asOf: new Date(at).toISOString() };
}

export async function recentAgentTheses(
  db: DbQuery,
  userId: string,
  limit = 24,
) {
  const { rows } = await db.query<{
    id: string;
    market_id: string;
    outcome: "YES" | "NO";
    body: string;
    published_at: Date;
    buy_snapshot: unknown;
  }>(
    `select id,market_id,outcome,body,published_at,buy_snapshot from user_theses
      where author_id=$1 order by published_at desc,id desc limit $2`,
    [userId, Math.min(limit, 100)],
  );
  return rows;
}

/** Internal only. No HTTP route accepts this input or treats it as trade proof. */
export async function publishAgentThesis(input: {
  db: Pool;
  userId: string;
  idempotencyKey: string;
  body: string;
  instrument: SocialBuySnapshot["instrument"];
  maxEntryPrice: string;
  provenance: PaperBuySnapshot["provenance"];
  assertLease: () => Promise<void>;
  limitlessPositionContract?: string;
}) {
  const hash = socialFingerprint({
    body: input.body.normalize("NFC").trim(),
    instrument: input.instrument,
    maxEntryPrice: input.maxEntryPrice,
    provenance: input.provenance,
  });
  return tx(input.db, async (db) => {
    await db.query("set local statement_timeout='10s'");
    await db.query("set local lock_timeout='2s'");
    await input.assertLease();
    const users = await db.query(
      `select is_agent,is_active,social_suspended_at from users where id=$1 for update`,
      [input.userId],
    );
    const user = users.rows[0];
    if (!user?.is_agent || !user.is_active || user.social_suspended_at)
      throw new SocialError("agent_unavailable", 403);
    const prior = await db.query(
      `select id,payload_hash from user_theses where author_id=$1 and idempotency_key=$2`,
      [input.userId, input.idempotencyKey],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].payload_hash !== hash)
        throw new SocialError("idempotency_conflict", 409);
      return { id: prior.rows[0].id as string, replayed: true };
    }
    const { policy, revision } = await resolveAgentThesesPolicy(db);
    const author = policy.authors.find(
      (a) => a.userId === input.userId && a.enabled,
    );
    if (!policy.enabled || !author)
      throw new SocialError("agent_disabled", 403);
    const social = await resolveSocialPolicy(db);
    if (!social.policy.enabled || !social.policy.publicationsEnabled)
      throw new SocialError("publications_disabled", 503);
    if (revision !== input.provenance.policyRevision)
      throw new SocialError("policy_changed", 409);
    const last = (await recentAgentTheses(db, input.userId, 1))[0];
    if (
      last &&
      Date.now() - new Date(last.published_at).getTime() <
        policy.publishIntervalSeconds * 1000
    )
      throw new SocialError("publication_cooldown", 409);
    const { body, selected, quote, shares, now } =
      await evaluateAgentPaperEntry(db, {
        ...input,
        lock: true,
        maxThesisGraphemes: author.maxThesisGraphemes,
        paperAmountUsd: author.paperAmountUsd,
        maxQuoteAgeSeconds: social.policy.markMaxAgeSeconds,
      });
    const snapshot = paperBuySnapshotSchema.parse({
      version: 1,
      canonicalPurchaseKey: `paper:${input.userId}:${input.idempotencyKey}`,
      instrument: input.instrument,
      grossNotionalUsd: author.paperAmountUsd,
      grossShares: shares,
      netShares: shares,
      entryPrice: quote.ask,
      feesUsd: null,
      purchasedAt: now.toISOString(),
      quoteAsOf: quote.asOf,
      simulation: "top_ask_no_depth_fees_or_slippage",
      provenance: input.provenance,
    });
    await input.assertLease();
    const created = await db.query(
      `insert into user_theses(author_id,canonical_purchase_key,market_id,event_id,token_id,outcome,
       instrument_generation,expiry,body,buy_snapshot,policy_revision,qualifying_notional,
       idempotency_key,payload_hash,purchase_mode,published_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::numeric,$13,$14,'paper',$15) returning id`,
      [
        input.userId,
        snapshot.canonicalPurchaseKey,
        input.instrument.marketId,
        selected.event_id,
        input.instrument.tokenId,
        input.instrument.outcome,
        input.instrument.generation,
        input.instrument.expiry,
        body,
        JSON.stringify(snapshot),
        `${revision}:${social.revision}`,
        author.paperAmountUsd,
        input.idempotencyKey,
        hash,
        now,
      ],
    );
    await input.assertLease();
    return { id: created.rows[0].id as string, replayed: false };
  });
}

/** Shared read-only evaluation; publication requests row locks inside its existing transaction. */
export async function evaluateAgentPaperEntry(
  db: DbQuery,
  input: {
    userId: string;
    body: string;
    instrument: SocialBuySnapshot["instrument"];
    maxEntryPrice: string;
    provenance: PaperBuySnapshot["provenance"];
    maxThesisGraphemes: number;
    paperAmountUsd: string;
    maxQuoteAgeSeconds: number;
    limitlessPositionContract?: string;
    lock?: boolean;
  },
) {
  // Market index, exact contract. The latest public thesis is not necessarily the author's last post overall.
  const history = await db.query(
    `select id,outcome,body,buy_snapshot from user_theses where author_id=$1 and market_id=$2
     order by published_at desc,id desc limit 1`,
    [input.userId, input.instrument.marketId],
  );
  const previous = history.rows[0];
  if ((previous?.id ?? null) !== input.provenance.previousThesisId)
    throw new SocialError("previous_thesis_changed", 409);
  const body = socialText(input.body, input.maxThesisGraphemes);
  if (
    previous &&
    (previous.body === body ||
      previous.buy_snapshot?.provenance?.argumentKey ===
        input.provenance.argumentKey)
  )
    throw new SocialError("repeated_argument", 409);
  if (previous && !input.provenance.changeReason?.trim())
    throw new SocialError("change_reason_required", 409);
  const selected = await readSocialMarket(
    db,
    input.instrument.marketId,
    input.lock ?? false,
  );
  if (!selected || !socialMarketAccepting(selected))
    throw new SocialError("market_closed", 409);
  const tokens = await db.query(
    `select token_id from unified_tokens where token_id=$1 and market_id=$2 and side=$3 ${input.lock ? "for share" : ""}`,
    [
      input.instrument.tokenId,
      input.instrument.marketId,
      input.instrument.outcome,
    ],
  );
  selected.current_token_id = tokens.rows[0]?.token_id ?? null;
  if (
    !socialInstrumentMatches(
      input.instrument,
      selected,
      input.limitlessPositionContract,
    )
  )
    throw new SocialError("instrument_changed", 409);
  const quotes = await db.query(
    `select best_ask::text,ts from unified_token_top_latest where token_id=$1`,
    [input.instrument.tokenId],
  );
  // A quote may advance while earlier reads are in flight. Validate against
  // observation time, not transaction-start time; genuinely future quotes fail.
  const now = new Date();
  const quote = validatePaperQuote({
    ask: quotes.rows[0]?.best_ask ?? null,
    asOf: quotes.rows[0]?.ts ?? null,
    now,
    maxAgeSeconds: input.maxQuoteAgeSeconds,
    maxEntryPrice: input.maxEntryPrice,
  });
  const shares = divideSocialDecimal(input.paperAmountUsd, quote.ask);
  if (!shares) throw new SocialError("invalid_paper_amount", 409);

  return { body, selected, quote, shares, now };
}
