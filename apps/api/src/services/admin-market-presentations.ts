import type { DbQuery } from "../db.js";
import {
  readTelegramMarketPresentationOverride,
  resolveTelegramMarketPresentation,
  type TelegramMarketPresentationOverrideV1,
} from "./telegram-market-presentation.js";

type AdminMarketPresentationRow = {
  id: string;
  venue: string;
  title: string;
  description: string | null;
  slug: string | null;
  outcomes: string | null;
  close_time: Date | string | null;
  expiration_time: Date | string | null;
  metadata: unknown;
  event_id: string;
  event_title: string | null;
  event_description: string | null;
};

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function parseOutcomes(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function presentAdminMarketRow(row: AdminMarketPresentationRow) {
  const input = {
    eventDescription: row.event_description,
    eventTitle: row.event_title,
    marketDescription: row.description,
    marketSlug: row.slug,
    marketTitle: row.title,
    outcomes: parseOutcomes(row.outcomes),
    closeTime: toIso(row.close_time),
    expirationTime: toIso(row.expiration_time),
    metadata: row.metadata,
  };
  const resolved = resolveTelegramMarketPresentation(input);
  return {
    market: {
      id: row.id,
      eventId: row.event_id,
      venue: row.venue,
      title: row.title,
      eventTitle: row.event_title,
      outcomes: parseOutcomes(row.outcomes),
      closeTime: toIso(row.close_time),
      expirationTime: toIso(row.expiration_time),
    },
    override: readTelegramMarketPresentationOverride(row.metadata).value,
    resolved: resolved.presentation,
    diagnostics: resolved.diagnostics,
  };
}

const MARKET_PRESENTATION_SELECT = `
  select
    m.id,
    m.venue,
    m.title,
    m.description,
    m.slug,
    m.outcomes,
    m.close_time,
    m.expiration_time,
    m.metadata,
    m.event_id,
    e.title as event_title,
    e.description as event_description
  from unified_markets m
  join unified_events e on e.id = m.event_id
`;

export async function searchAdminMarketPresentations(
  db: DbQuery,
  query: string,
) {
  const normalized = query.trim();
  const { rows } = await db.query<AdminMarketPresentationRow>(
    `
      ${MARKET_PRESENTATION_SELECT}
      where m.status = 'ACTIVE'
        and e.status = 'ACTIVE'
        and (
          m.id = $1
          or m.venue_market_id = $1
          or m.title ilike '%' || $1 || '%'
          or e.title ilike '%' || $1 || '%'
        )
      order by
        (m.id = $1) desc,
        greatest(coalesce(m.volume_24h, 0), coalesce(m.liquidity, 0)) desc,
        m.id asc
      limit 20
    `,
    [normalized],
  );
  return rows.map(presentAdminMarketRow);
}

export async function getAdminMarketPresentation(
  db: DbQuery,
  marketId: string,
) {
  const { rows } = await db.query<AdminMarketPresentationRow>(
    `${MARKET_PRESENTATION_SELECT} where m.id = $1 limit 1`,
    [marketId],
  );
  const row = rows[0];
  return row ? presentAdminMarketRow(row) : null;
}

export async function putAdminMarketPresentation(input: {
  db: DbQuery;
  marketId: string;
  override: Omit<
    TelegramMarketPresentationOverrideV1,
    "provenance" | "reviewStatus"
  >;
  reviewedBy: string;
}) {
  const value: TelegramMarketPresentationOverrideV1 = {
    ...input.override,
    reviewStatus: "approved",
    provenance: {
      reviewedBy: input.reviewedBy,
      reviewedAt: new Date().toISOString(),
    },
  };
  const { rows } = await input.db.query<AdminMarketPresentationRow>(
    `
      update unified_markets m
      set metadata = jsonb_set(
        jsonb_set(
          coalesce(m.metadata, '{}'::jsonb),
          '{hunch}',
          coalesce(m.metadata->'hunch', '{}'::jsonb),
          true
        ),
        '{hunch,telegramPresentationV1}',
        $2::jsonb,
        true
      )
      from unified_events e
      where m.id = $1
        and e.id = m.event_id
      returning
        m.id,
        m.venue,
        m.title,
        m.description,
        m.slug,
        m.outcomes,
        m.close_time,
        m.expiration_time,
        m.metadata,
        m.event_id,
        e.title as event_title,
        e.description as event_description
    `,
    [input.marketId, JSON.stringify(value)],
  );
  const row = rows[0];
  return row ? presentAdminMarketRow(row) : null;
}

export async function deleteAdminMarketPresentation(
  db: DbQuery,
  marketId: string,
) {
  const { rows } = await db.query<AdminMarketPresentationRow>(
    `
      update unified_markets m
      set metadata = coalesce(m.metadata, '{}'::jsonb)
        #- '{hunch,telegramPresentationV1}'::text[]
      from unified_events e
      where m.id = $1
        and e.id = m.event_id
      returning
        m.id,
        m.venue,
        m.title,
        m.description,
        m.slug,
        m.outcomes,
        m.close_time,
        m.expiration_time,
        m.metadata,
        m.event_id,
        e.title as event_title,
        e.description as event_description
    `,
    [marketId],
  );
  const row = rows[0];
  return row ? presentAdminMarketRow(row) : null;
}
