import crypto from "node:crypto";

import { pool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";

const PROFILE_VERSION = "v2";

type WhaleProfile = {
  label_short?: string;
  label_long?: string;
  archetype?: string;
  theme_focus?: string[];
  risk_style?: string;
  confidence?: number;
  evidence?: string[];
  notes?: string;
};

type WhaleProfileInput = {
  context: {
    purpose: "wallet_whale_profile";
    ui: string;
    top_markets_limit: number;
    window_days: number;
    currency: "USD";
    display_notes: string;
  };
  wallet: {
    address: string;
    chain: string;
    label: string | null;
    is_safe: boolean;
    owner_address: string | null;
    owner_label: string | null;
  };
  metrics: {
    volume_30d: number | null;
    trades_30d: number | null;
    roi: number | null;
    win_rate: number | null;
    last_trade_at: string | null;
  };
  inferred: {
    win_rate: number | null;
    resolved_count: number | null;
  };
  exposure_usd: number | null;
  activity: {
    last_activity_at: string | null;
    kind: "trade" | "holder" | "mixed" | "unknown";
  };
  summary: {
    top_market_concentration: number | null;
    side_bias: { yes: number; no: number; ratio: number | null };
    category_counts: Record<string, number>;
  };
  top_markets: Array<{
    market_id: string;
    market_title: string | null;
    event_title: string | null;
    venue: string;
    category: string | null;
    volume_usd: number | null;
    activity_count: number;
    last_activity_at: string | null;
    avg_price: number | null;
    best_bid: number | null;
    best_ask: number | null;
    last_price: number | null;
    position_side: string | null;
    position_shares: number | null;
    position_value_usd: number | null;
    position_price: number | null;
  }>;
};

type WhaleRow = {
  id: string;
  address: string;
  chain: string;
  label: string | null;
  is_safe: boolean;
  owner_address: string | null;
  owner_label: string | null;
  metrics_volume: string | null;
  metrics_trades: number | null;
  metrics_roi: string | null;
  metrics_win_rate: string | null;
  metrics_last_trade_at: Date | null;
  exposure_usd: string | null;
  last_activity_at: Date | null;
  has_trade_activity: boolean | null;
  has_holder_activity: boolean | null;
  inferred_wins: number | null;
  inferred_total: number | null;
};

type WhaleMarketRow = {
  wallet_id: string;
  market_id: string;
  market_title: string | null;
  event_title: string | null;
  venue: string;
  category: string | null;
  volume_usd: string | null;
  activity_count: number;
  last_activity_at: Date | null;
  avg_price: string | null;
  best_bid: string | null;
  best_ask: string | null;
  last_price: string | null;
  position_side: string | null;
  position_shares: string | null;
  position_value_usd: string | null;
  position_price: string | null;
};

type WhaleProfileOptions = {
  limit: number;
  marketLimit: number;
  windowDays: number;
  force?: boolean;
  dryRun?: boolean;
};

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const parseNumber = (value: string | number | null | undefined): number | null => {
  if (value == null) return null;
  const num = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(num) ? num : null;
};

function hashProfileInput(input: WhaleProfileInput): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function normalizeProfile(raw: unknown): WhaleProfile | null {
  if (!isRecord(raw)) return null;
  const labelShort =
    typeof raw.label_short === "string" ? raw.label_short.trim() : null;
  const labelLong =
    typeof raw.label_long === "string" ? raw.label_long.trim() : null;
  const archetype =
    typeof raw.archetype === "string" ? raw.archetype.trim() : null;
  const riskStyle =
    typeof raw.risk_style === "string" ? raw.risk_style.trim() : null;
  const notes = typeof raw.notes === "string" ? raw.notes.trim() : null;
  const confidenceRaw = raw.confidence;
  const confidence =
    typeof confidenceRaw === "number"
      ? clampNumber(confidenceRaw, 0, 1)
      : null;
  const themeFocus = Array.isArray(raw.theme_focus)
    ? raw.theme_focus
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];

  return {
    ...(labelShort ? { label_short: labelShort } : {}),
    ...(labelLong ? { label_long: labelLong } : {}),
    ...(archetype ? { archetype } : {}),
    ...(themeFocus.length ? { theme_focus: themeFocus } : {}),
    ...(riskStyle ? { risk_style: riskStyle } : {}),
    ...(confidence != null ? { confidence } : {}),
    ...(evidence.length ? { evidence } : {}),
    ...(notes ? { notes } : {}),
  };
}

async function callOpenRouter(
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  maxTokens: number,
): Promise<string> {
  if (!env.openRouterKey) {
    throw new Error("OPENROUTER_API_KEY missing");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openRouterKey}`,
      "Content-Type": "application/json",
      "X-Title": "Hunch Whale Profiles",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
      reasoning: { effort: "low" },
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${text}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

function toActivityKind(
  hasTrade: boolean | null,
  hasHolder: boolean | null,
): "trade" | "holder" | "mixed" | "unknown" {
  if (hasTrade && hasHolder) return "mixed";
  if (hasTrade) return "trade";
  if (hasHolder) return "holder";
  return "unknown";
}

function buildProfileInput(
  wallet: WhaleRow,
  topMarkets: WhaleMarketRow[],
  context: { marketLimit: number; windowDays: number },
): WhaleProfileInput {
  const markets = topMarkets.map((market) => ({
    market_id: market.market_id,
    market_title: market.market_title,
    event_title: market.event_title,
    venue: market.venue,
    category: market.category,
    volume_usd: parseNumber(market.volume_usd),
    activity_count: market.activity_count,
    last_activity_at: market.last_activity_at
      ? market.last_activity_at.toISOString()
      : null,
    avg_price: parseNumber(market.avg_price),
    best_bid: parseNumber(market.best_bid),
    best_ask: parseNumber(market.best_ask),
    last_price: parseNumber(market.last_price),
    position_side: market.position_side,
    position_shares: parseNumber(market.position_shares),
    position_value_usd: parseNumber(market.position_value_usd),
    position_price: parseNumber(market.position_price),
  }));

  const totalVolume = markets.reduce(
    (sum, market) => sum + (market.volume_usd ?? 0),
    0,
  );
  const topVolume = markets[0]?.volume_usd ?? null;
  const concentration =
    topVolume != null && totalVolume > 0 ? topVolume / totalVolume : null;

  let yesValue = 0;
  let noValue = 0;
  for (const market of markets) {
    const value =
      market.position_value_usd ??
      market.position_shares ??
      market.volume_usd ??
      0;
    if (market.position_side?.toUpperCase() === "YES") {
      yesValue += value;
    } else if (market.position_side?.toUpperCase() === "NO") {
      noValue += value;
    }
  }
  const totalSide = yesValue + noValue;
  const sideRatio = totalSide > 0 ? yesValue / totalSide : null;

  const categoryCounts = markets.reduce<Record<string, number>>((acc, market) => {
    const category = market.category?.trim();
    if (!category) return acc;
    acc[category] = (acc[category] ?? 0) + 1;
    return acc;
  }, {});

  return {
    context: {
      purpose: "wallet_whale_profile",
      ui: "Shown in a whale list and a detail modal on the Wallets/Trackers page.",
      top_markets_limit: context.marketLimit,
      window_days: context.windowDays,
      currency: "USD",
      display_notes:
        "Write for end-users. Avoid jargon, avoid market IDs, no insider claims.",
    },
    wallet: {
      address: wallet.address,
      chain: wallet.chain,
      label: wallet.label,
      is_safe: wallet.is_safe,
      owner_address: wallet.owner_address,
      owner_label: wallet.owner_label,
    },
    metrics: {
      volume_30d: parseNumber(wallet.metrics_volume),
      trades_30d: wallet.metrics_trades ?? null,
      roi: parseNumber(wallet.metrics_roi),
      win_rate: parseNumber(wallet.metrics_win_rate),
      last_trade_at: wallet.metrics_last_trade_at
        ? wallet.metrics_last_trade_at.toISOString()
        : null,
    },
    inferred: {
      win_rate:
        wallet.inferred_total && wallet.inferred_total > 0
          ? wallet.inferred_wins / wallet.inferred_total
          : null,
      resolved_count:
        wallet.inferred_total != null ? Number(wallet.inferred_total) : null,
    },
    exposure_usd: parseNumber(wallet.exposure_usd),
    activity: {
      last_activity_at: wallet.last_activity_at
        ? wallet.last_activity_at.toISOString()
        : null,
      kind: toActivityKind(
        wallet.has_trade_activity,
        wallet.has_holder_activity,
      ),
    },
    summary: {
      top_market_concentration: concentration,
      side_bias: {
        yes: yesValue,
        no: noValue,
        ratio: sideRatio,
      },
      category_counts: categoryCounts,
    },
    top_markets: markets,
  };
}

export async function runWhaleProfiles(options: WhaleProfileOptions) {
  if (!env.openRouterKey) {
    console.warn("[whale-profile] OPENROUTER_API_KEY missing, skipping");
    return { processed: 0, updated: 0, skipped: 0, failed: 0 };
  }

  const limit = Math.max(1, options.limit);
  const marketLimit = Math.max(1, options.marketLimit);
  const windowDays = Math.max(1, options.windowDays);
  const client = await pool.connect();
  try {
    const whaleRows = await client.query<WhaleRow>(
      `
        select
          w.id,
          w.address,
          w.chain,
          w.label,
          (w.metadata->>'kind' = 'safe') as is_safe,
          owner.owner_address,
          owner.owner_label,
          metrics.metrics_volume,
          metrics.metrics_trades,
          metrics.metrics_roi,
          metrics.metrics_win_rate,
          metrics.metrics_last_trade_at,
          exposure.exposure_usd,
          activity.last_activity_at,
          activity.has_trade_activity,
          activity.has_holder_activity,
          inferred.wins as inferred_wins,
          inferred.total as inferred_total
        from wallets w
        join wallet_tag_map tm on tm.wallet_id = w.id
        join wallet_tags t on t.id = tm.tag_id and t.slug = 'whale'
        left join lateral (
          select
            s.volume_usd as metrics_volume,
            s.trades_count as metrics_trades,
            s.roi as metrics_roi,
            s.win_rate as metrics_win_rate,
            s.last_trade_at as metrics_last_trade_at
          from wallet_metrics_snapshots s
          where s.wallet_id = w.id and s.period = '30d'
          order by s.as_of desc
          limit 1
        ) metrics on true
        left join lateral (
          select
            max(wa.occurred_at) as last_activity_at,
            bool_or(wa.activity_type in ('delta', 'trade')) as has_trade_activity,
            bool_or(wa.activity_type = 'holder') as has_holder_activity
          from wallet_activity_events wa
          where wa.wallet_id = w.id
            and wa.activity_type in ('delta', 'trade', 'holder')
            and wa.occurred_at >= now() - ($1::text || ' days')::interval
        ) activity on true
        left join lateral (
          select
            sum(coalesce(ws.size_usd, 0)) as exposure_usd
          from wallet_position_snapshots ws
          join (
            select venue, max(snapshot_at) as snapshot_at
            from wallet_position_snapshots
            where wallet_id = w.id
            group by venue
          ) latest on latest.venue = ws.venue and latest.snapshot_at = ws.snapshot_at
          where ws.wallet_id = w.id
        ) exposure on true
        left join lateral (
          select
            w2.address as owner_address,
            w2.label as owner_label
          from wallets w2
          where w.metadata->>'kind' = 'safe'
            and w2.metadata->>'kind' = 'safe_owner'
            and w2.metadata->>'derivedFrom' = w.address
            and w2.chain = w.chain
          limit 1
        ) owner on true
        left join lateral (
          with latest as (
            select distinct on (ws.market_id, ws.outcome_side)
              ws.market_id,
              ws.outcome_side,
              ws.shares
            from wallet_position_snapshots ws
            where ws.wallet_id = w.id
              and ws.shares > 0
            order by ws.market_id, ws.outcome_side, ws.snapshot_at desc
          ),
          agg as (
            select
              market_id,
              sum(case when outcome_side = 'YES' then shares else 0 end) as yes_shares,
              sum(case when outcome_side = 'NO' then shares else 0 end) as no_shares
            from latest
            group by market_id
          ),
          resolved as (
            select
              agg.market_id,
              agg.yes_shares,
              agg.no_shares,
              upper(m.resolved_outcome) as resolved_outcome
            from agg
            join unified_markets m on m.id = agg.market_id
            where m.resolved_outcome is not null
              and upper(m.resolved_outcome) in ('YES', 'NO')
          ),
          eligible as (
            select *
            from resolved
            where (yes_shares > 0 and coalesce(no_shares, 0) = 0)
               or (no_shares > 0 and coalesce(yes_shares, 0) = 0)
          )
          select
            count(*) filter (
              where (resolved_outcome = 'YES' and yes_shares > 0 and no_shares = 0)
                 or (resolved_outcome = 'NO' and no_shares > 0 and yes_shares = 0)
            ) as wins,
            count(*)::int as total
          from eligible
        ) inferred on true
        order by
          activity.last_activity_at desc nulls last,
          case
            when w.chain = 'solana'
              then coalesce(nullif(metrics.metrics_volume, 0), exposure.exposure_usd, 0)
            else coalesce(metrics.metrics_volume, 0)
          end desc nulls last,
          w.last_seen_at desc
        limit $2
      `,
      [windowDays, limit],
    );

    if (whaleRows.rows.length === 0) {
      return { processed: 0, updated: 0, skipped: 0, failed: 0 };
    }

    const whaleIds = whaleRows.rows.map((row) => row.id);
    const marketRows = await client.query<WhaleMarketRow>(
      `
        select
          ranked.*,
          pos.outcome_side as position_side,
          pos.shares as position_shares,
          pos.size_usd as position_value_usd,
          pos.price as position_price
        from (
          select
            wa.wallet_id,
            wa.market_id,
            um.title as market_title,
            ue.title as event_title,
            wa.venue,
            um.category,
            sum(wa.size_usd) as volume_usd,
            count(*)::int as activity_count,
            max(wa.occurred_at) as last_activity_at,
            case
              when sum(wa.delta_shares) is null or sum(wa.delta_shares) = 0
                then null
              else sum(wa.price * wa.delta_shares) / nullif(sum(wa.delta_shares), 0)
            end as avg_price,
            um.best_bid,
            um.best_ask,
            um.last_price,
            row_number() over (
              partition by wa.wallet_id
              order by sum(wa.size_usd) desc nulls last,
                       count(*) desc,
                       max(wa.occurred_at) desc
            ) as rn
          from wallet_activity_events wa
          left join unified_markets um on um.id = wa.market_id
          left join unified_events ue on ue.id = um.event_id
          where wa.wallet_id = any($1::uuid[])
            and wa.activity_type in ('delta', 'trade', 'holder')
            and wa.occurred_at >= now() - ($3::text || ' days')::interval
          group by
            wa.wallet_id,
            wa.market_id,
            um.title,
            ue.title,
            wa.venue,
            um.category,
            um.best_bid,
            um.best_ask,
            um.last_price
        ) ranked
        left join lateral (
          select
            ws.outcome_side,
            ws.shares,
            ws.size_usd,
            ws.price
          from wallet_position_snapshots ws
          where ws.wallet_id = ranked.wallet_id
            and ws.market_id = ranked.market_id
            and ws.shares > 0
          order by ws.snapshot_at desc, ws.size_usd desc nulls last, ws.shares desc
          limit 1
        ) pos on true
        where ranked.rn <= $2
        order by ranked.wallet_id, ranked.rn
      `,
      [whaleIds, marketLimit, windowDays],
    );

    const marketMap = new Map<string, WhaleMarketRow[]>();
    for (const row of marketRows.rows) {
      const list = marketMap.get(row.wallet_id) ?? [];
      list.push(row);
      marketMap.set(row.wallet_id, list);
    }

    const existingRows = await client.query<{
      wallet_id: string;
      features_hash: string;
    }>(
      `
        select wallet_id, features_hash
        from wallet_profiles
        where wallet_id = any($1::uuid[])
      `,
      [whaleIds],
    );
    const existingMap = new Map<string, string>();
    for (const row of existingRows.rows) {
      existingMap.set(row.wallet_id, row.features_hash);
    }

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const whale of whaleRows.rows) {
      processed += 1;
      const topMarkets = marketMap.get(whale.id) ?? [];
      const input = buildProfileInput(whale, topMarkets, {
        marketLimit,
        windowDays,
      });
      const featuresHash = hashProfileInput(input);
      if (!options.force && existingMap.get(whale.id) === featuresHash) {
        skipped += 1;
        continue;
      }

      const system =
        "You are a market analyst writing concise, user-facing whale profiles. Return strict JSON only.";
      const user = `Create a compact whale profile for display in a product UI.
Output JSON with:
- label_short: short name (<= 40 chars), no venue names, no chain names.
- label_long: 1–2 sentences (<= 220 chars) summarizing the main behavior pattern.
- archetype: short snake_case tag.
- theme_focus: array of up to 3 lowercase tags.
- risk_style: short phrase (<= 60 chars).
- confidence: number 0–1.
- evidence: array of 2–4 short market or event titles (prefer event titles if multiple markets share the same event).
- notes: optional 2–3 sentences (<= 300 chars) with extra context for the detail view.

Rules:
- Use ONLY provided data. Do NOT mention wallet IDs or addresses.
- No claims of insider or informed intent.
- Be factual, pattern-based, and neutral in tone.
- If data is limited or mixed, keep confidence <= 0.55 and mention uncertainty.
- If activity kind is "holder" (no trades), emphasize exposure/holdings vs trade timing.

Whale data (JSON):\n${JSON.stringify(input)}`;

      let profileRaw = "";
      try {
        profileRaw = await callOpenRouter(
          env.aiWhaleProfileModel,
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          520,
        );
      } catch (error) {
        failed += 1;
        console.warn("[whale-profile] openrouter error", {
          walletId: whale.id,
          error,
        });
        continue;
      }

      const parsed = (() => {
        try {
          return JSON.parse(profileRaw);
        } catch {
          return null;
        }
      })();
      const normalized = normalizeProfile(parsed);
      if (!normalized) {
        failed += 1;
        console.warn("[whale-profile] invalid json", {
          walletId: whale.id,
          raw: profileRaw.slice(0, 500),
        });
        continue;
      }

      if (options.dryRun) {
        updated += 1;
        continue;
      }

      await client.query(
        `
          insert into wallet_profiles (
            wallet_id,
            profile,
            features_hash,
            model,
            version
          )
          values ($1, $2, $3, $4, $5)
          on conflict (wallet_id)
          do update set
            profile = excluded.profile,
            features_hash = excluded.features_hash,
            model = excluded.model,
            version = excluded.version,
            updated_at = now()
        `,
        [
          whale.id,
          JSON.stringify(normalized),
          featuresHash,
          env.aiWhaleProfileModel,
          PROFILE_VERSION,
        ],
      );
      updated += 1;
    }

    return { processed, updated, skipped, failed };
  } finally {
    client.release();
  }
}
