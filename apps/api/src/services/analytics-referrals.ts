import type { DbQuery } from "../db.js";

type ReferralVenue = "kalshi" | "limitless" | "polymarket";

export type ReferralSignupAttributionPayload = {
  referralCode: string;
  referredUserKey: string;
  source: "auth_privy";
  status: "attached";
};

export type ReferralFirstTradePayload = {
  referralCode: string;
  referredUserKey: string;
  source: "backend_trade";
  status: string;
  venue: ReferralVenue;
};

type ReferralFirstTradeConversionRow = {
  code: string;
  referred_user_id: string;
  status: string;
  venue: ReferralVenue;
};

function buildReferredUserKey(userId: string): string {
  return `user_${userId}`;
}

function buildReferralFirstTradePayloadFromRow(
  row: ReferralFirstTradeConversionRow,
): ReferralFirstTradePayload {
  return {
    referralCode: row.code,
    referredUserKey: buildReferredUserKey(row.referred_user_id),
    source: "backend_trade",
    status: row.status,
    venue: row.venue,
  };
}

export function buildReferralSignupAttributionPayload(inputs: {
  referralCode: string;
  userId: string;
}): ReferralSignupAttributionPayload {
  return {
    referralCode: inputs.referralCode,
    referredUserKey: buildReferredUserKey(inputs.userId),
    source: "auth_privy",
    status: "attached",
  };
}

export async function recordReferralFirstTradeConversion(
  pool: DbQuery,
  inputs: {
    userId: string;
    venue: ReferralVenue;
    status: string;
    sourceType: "amm" | "execution" | "order";
    sourceId: string;
    txHash?: string | null;
  },
): Promise<ReferralFirstTradePayload | null> {
  const { rows } = await pool.query<ReferralFirstTradeConversionRow>(
    `
      with referral_source as (
        select
          r.referrer_user_id,
          r.referred_user_id,
          r.code
        from referrals r
        where r.referred_user_id = $1
        limit 1
      ),
      inserted as (
        insert into referral_first_trade_conversions (
          referrer_user_id,
          referred_user_id,
          code,
          venue,
          status,
          source_type,
          source_id,
          tx_hash
        )
        select
          rs.referrer_user_id,
          rs.referred_user_id,
          rs.code,
          $2,
          $3,
          $4,
          $5,
          $6
        from referral_source rs
        on conflict (referred_user_id) do nothing
        returning code, referred_user_id, status, venue
      )
      select code, referred_user_id, status, venue
      from inserted
    `,
    [
      inputs.userId,
      inputs.venue,
      inputs.status,
      inputs.sourceType,
      inputs.sourceId,
      inputs.txHash ?? null,
    ],
  );

  const row = rows[0];
  return row ? buildReferralFirstTradePayloadFromRow(row) : null;
}

export async function tryRecordReferralFirstTradeConversion(
  pool: DbQuery,
  inputs: {
    userId: string;
    venue: ReferralVenue;
    status: string;
    sourceType: "amm" | "execution" | "order";
    sourceId: string;
    txHash?: string | null;
    logger?: {
      warn?: (payload: Record<string, unknown>, message: string) => void;
    } | null;
  },
): Promise<ReferralFirstTradePayload | null> {
  try {
    return await recordReferralFirstTradeConversion(pool, inputs);
  } catch (error) {
    inputs.logger?.warn?.(
      {
        error,
        userId: inputs.userId,
        venue: inputs.venue,
        status: inputs.status,
        sourceType: inputs.sourceType,
        sourceId: inputs.sourceId,
        txHash: inputs.txHash ?? null,
      },
      "Failed to record referral first trade conversion",
    );
    return null;
  }
}
