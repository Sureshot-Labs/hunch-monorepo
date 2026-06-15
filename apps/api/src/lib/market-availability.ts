type ComputeAcceptingOrdersInput = {
  venue?: string | null;
  status: string | null | undefined;
  closeTime?: unknown;
  expirationTime?: unknown;
  eventEndTime?: unknown;
  pmAcceptingOrders?: boolean | null;
  dflowNativeAcceptingOrders?: boolean | null;
  nowMs?: number;
};

export const POLYMARKET_ACCEPTING_ORDERS_GRACE_MS = 6 * 60 * 60 * 1000;
const POLYMARKET_ACCEPTING_ORDERS_GRACE_INTERVAL = "interval '6 hours'";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readDflowNativeAcceptingOrders(
  metadata: unknown,
): boolean | null {
  const parsed = (() => {
    if (!metadata) return null;
    if (isRecord(metadata)) return metadata;
    if (typeof metadata !== "string") return null;
    try {
      const value = JSON.parse(metadata);
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  })();
  if (!parsed) return null;

  const value = parsed.dflowNativeAcceptingOrders;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

function parseTimestampMs(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

export function computeAcceptingOrders(
  input: ComputeAcceptingOrdersInput,
): boolean {
  const nowMs = input.nowMs ?? Date.now();
  const status = input.status ?? null;
  const normalizedStatus =
    typeof status === "string" ? status.toUpperCase() : null;
  const inactiveByStatus =
    normalizedStatus != null && normalizedStatus !== "ACTIVE";

  const closeMs = parseTimestampMs(input.closeTime);
  const expirationMs = parseTimestampMs(input.expirationTime);
  const eventEndMs = parseTimestampMs(input.eventEndTime);
  const terminalCandidates = [closeMs, expirationMs, eventEndMs].filter(
    (value): value is number => value != null,
  );
  const terminalMs =
    terminalCandidates.length > 0 ? Math.min(...terminalCandidates) : null;
  const closedByTime =
    (closeMs != null && closeMs <= nowMs) ||
    (expirationMs != null && expirationMs <= nowMs) ||
    (eventEndMs != null && eventEndMs <= nowMs);

  const activeByUnified =
    normalizedStatus == null
      ? !closedByTime
      : normalizedStatus === "ACTIVE" && !closedByTime;

  const venue =
    typeof input.venue === "string" ? input.venue.toLowerCase() : null;
  if (venue === "kalshi") {
    if (!activeByUnified) return false;
    return input.dflowNativeAcceptingOrders === true;
  }

  // Fail-closed override for Polymarket-specific availability.
  if (input.pmAcceptingOrders === false) return false;

  // If Polymarket explicitly says orders are accepted, trust that signal unless
  // unified status is explicitly non-active.
  if (input.pmAcceptingOrders === true) {
    if (inactiveByStatus) return false;
    if (
      terminalMs != null &&
      terminalMs <= nowMs - POLYMARKET_ACCEPTING_ORDERS_GRACE_MS
    ) {
      return false;
    }
    return true;
  }

  return activeByUnified;
}

export function buildPolymarketOrderableSql(args: {
  marketAlias: string;
  pmAlias?: string;
  fallbackSql?: string;
  freshnessSql?: string;
}): string {
  const { marketAlias: m, pmAlias: pm } = args;
  const metadataAcceptingOrders = `lower(coalesce(${m}.metadata->>'acceptingOrders', 'false')) = 'true'`;
  const freshMetadataAcceptingOrders = args.freshnessSql
    ? `(${metadataAcceptingOrders} and ${args.freshnessSql})`
    : metadataAcceptingOrders;
  const fallbackSql = args.fallbackSql
    ? `(${freshMetadataAcceptingOrders} or (${args.fallbackSql}))`
    : freshMetadataAcceptingOrders;
  if (!pm) return fallbackSql;
  const freshnessSql = args.freshnessSql ? `and ${args.freshnessSql}` : "";

  return `(
    (
      ${pm}.id is not null
      and ${pm}.accepting_orders = true
      and coalesce(${pm}.active, true) = true
      and coalesce(${pm}.closed, false) = false
      and coalesce(${pm}.archived, false) = false
      ${freshnessSql}
    )
    or (
      ${pm}.id is null
      and ${fallbackSql}
    )
  )`;
}

export function buildNativeTradableMarketSql(alias: string): string {
  return `(
    ${alias}.venue <> 'kalshi'
    or lower(coalesce(${alias}.metadata->>'dflowNativeAcceptingOrders', 'false')) = 'true'
  )`;
}

function buildMarketTimeSql(args: {
  marketAlias: string;
  nowParam: string;
  nowCloseParam?: string;
}): string {
  const { marketAlias: m, nowParam } = args;
  const nowCloseParam = args.nowCloseParam ?? nowParam;
  return `(
    (${m}.expiration_time is null or ${m}.expiration_time > ${nowParam}::timestamptz)
    and (${m}.close_time is null or ${m}.close_time > ${nowCloseParam}::timestamptz)
  )`;
}

function buildActiveEventSql(eventAlias: string | undefined): string {
  return eventAlias ? `${eventAlias}.status = 'ACTIVE'` : "true";
}

function buildEventTimeSql(args: {
  eventAlias?: string;
  nowParam: string;
}): string {
  return args.eventAlias
    ? `(${args.eventAlias}.end_date is null or ${args.eventAlias}.end_date > ${args.nowParam}::timestamptz)`
    : "true";
}

function buildPolymarketTerminalSql(args: {
  marketAlias: string;
  eventAlias?: string;
}): string {
  const { marketAlias: m, eventAlias: e } = args;
  return `least(
    coalesce(${m}.close_time, 'infinity'::timestamptz),
    coalesce(${m}.expiration_time, 'infinity'::timestamptz)${
      e ? `,\n    coalesce(${e}.end_date, 'infinity'::timestamptz)` : ""
    }
  )`;
}

function buildPolymarketFreshnessSql(args: {
  marketAlias: string;
  eventAlias?: string;
  nowParam: string;
}): string {
  const terminalSql = buildPolymarketTerminalSql(args);
  return `(
    ${terminalSql} = 'infinity'::timestamptz
    or ${terminalSql} > (${args.nowParam}::timestamptz - ${POLYMARKET_ACCEPTING_ORDERS_GRACE_INTERVAL})
  )`;
}

export function buildStrictIndexedMarketSql(args: {
  marketAlias: string;
  eventAlias?: string;
  nowParam: string;
  nowCloseParam?: string;
}): string {
  const { marketAlias: m } = args;
  return `(
    ${m}.status = 'ACTIVE'
    and ${buildActiveEventSql(args.eventAlias)}
    and ${buildEventTimeSql(args)}
    and ${buildMarketTimeSql(args)}
    and ${buildNativeTradableMarketSql(m)}
  )`;
}

export function buildPolymarketGraceMarketSql(args: {
  marketAlias: string;
  eventAlias?: string;
  nowParam: string;
  pmAlias: string;
}): string {
  const { marketAlias: m, pmAlias: pm } = args;
  const strictTimeSql = `(
    ${buildEventTimeSql(args)}
    and ${buildMarketTimeSql(args)}
  )`;
  return `(
    ${m}.venue = 'polymarket'
    and ${m}.status = 'ACTIVE'
    and ${buildActiveEventSql(args.eventAlias)}
    and ${pm}.id is not null
    and ${pm}.accepting_orders = true
    and coalesce(${pm}.active, true) = true
    and coalesce(${pm}.closed, false) = false
    and coalesce(${pm}.archived, false) = false
    and ${buildPolymarketFreshnessSql(args)}
    and not ${strictTimeSql}
  )`;
}

export function buildBroadOrderableMarketSql(args: {
  marketAlias: string;
  eventAlias?: string;
  nowParam: string;
  nowCloseParam?: string;
  pmAlias: string;
}): string {
  return `(
    ${buildStrictIndexedMarketSql(args)}
    or ${buildPolymarketGraceMarketSql(args)}
  )`;
}

export function buildEventHasBroadOrderableMarketSql(args: {
  eventAlias?: string;
  nowParam: string;
  nowCloseParam?: string;
  renderableMarketSql?: string;
}): string {
  const eventAlias = args.eventAlias ?? "e";
  const renderable = args.renderableMarketSql
    ? `and ${args.renderableMarketSql}`
    : "";
  return `(
    exists (
      select 1
      from unified_markets om
      where om.event_id = ${eventAlias}.id
        and ${buildStrictIndexedMarketSql({
          marketAlias: "om",
          eventAlias,
          nowParam: args.nowParam,
          nowCloseParam: args.nowCloseParam,
        })}
        ${renderable}
    )
    or exists (
      select 1
      from unified_markets om
      join polymarket_markets pm_om
        on pm_om.id = om.venue_market_id
       and om.venue = 'polymarket'
      where om.event_id = ${eventAlias}.id
        and ${buildPolymarketGraceMarketSql({
          marketAlias: "om",
          eventAlias,
          nowParam: args.nowParam,
          pmAlias: "pm_om",
        })}
        ${renderable}
    )
  )`;
}

export function buildOrderableMarketSql(args: {
  marketAlias: string;
  eventAlias?: string;
  nowParam: string;
  nowCloseParam?: string;
  pmAlias?: string;
}): string {
  const { marketAlias: m, eventAlias: e, nowParam } = args;
  const activeEventSql = buildActiveEventSql(e);
  const eventTimeSql = buildEventTimeSql({ eventAlias: e, nowParam });
  const polymarketFreshnessSql = buildPolymarketFreshnessSql({
    marketAlias: m,
    eventAlias: e,
    nowParam,
  });
  const marketTimeSql = buildMarketTimeSql(args);

  return `(
    ${m}.status = 'ACTIVE'
    and (
      (
        ${m}.venue = 'polymarket'
        and ${buildPolymarketOrderableSql({
          marketAlias: m,
          pmAlias: args.pmAlias,
          freshnessSql: polymarketFreshnessSql,
          fallbackSql: `(${activeEventSql} and ${eventTimeSql} and ${marketTimeSql})`,
        })}
      )
      or (
        ${m}.venue = 'kalshi'
        and ${activeEventSql}
        and ${eventTimeSql}
        and ${marketTimeSql}
        and lower(coalesce(${m}.metadata->>'dflowNativeAcceptingOrders', 'false')) = 'true'
      )
      or (
        ${m}.venue <> 'polymarket'
        and ${m}.venue <> 'kalshi'
        and ${activeEventSql}
        and ${eventTimeSql}
        and ${marketTimeSql}
      )
    )
  )`;
}
