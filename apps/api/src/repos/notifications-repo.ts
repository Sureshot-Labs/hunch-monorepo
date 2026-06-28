import type { DbQuery } from "../db.js";
import type { PgParams } from "../server-types.js";

export type NotificationSeverity = "info" | "success" | "warning" | "error";

export type NotificationRow = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  data: unknown;
  read_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type NotificationCursor = {
  createdAt: Date;
  id: string;
};

function encodeCursor(input: NotificationCursor): string {
  const raw = JSON.stringify({
    t: input.createdAt.toISOString(),
    id: input.id,
  });
  return Buffer.from(raw, "utf8").toString("base64");
}

function decodeCursor(cursor?: string | null): NotificationCursor | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64").toString("utf8");
    const parsed = JSON.parse(raw) as { t?: string; id?: string };
    if (!parsed.t || !parsed.id) return null;
    const createdAt = new Date(parsed.t);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

function readNotificationStringData(
  row: NotificationRow,
  key: string,
): string | null {
  if (!row.data || typeof row.data !== "object" || Array.isArray(row.data)) {
    return null;
  }
  const value = (row.data as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function buildOrderKey(venue: string, orderId: string): string {
  return `${venue}\u001f${orderId}`;
}

function resolveLegacyOrderDedupe(input: {
  dedupeKey: string | null;
}): { dedupeKey: string; venue: string } | null {
  const { dedupeKey } = input;
  if (!dedupeKey?.startsWith("order:")) return null;
  const firstSeparator = dedupeKey.indexOf(":", "order:".length);
  if (firstSeparator < 0) return null;
  const venue = dedupeKey.slice("order:".length, firstSeparator).trim();
  const orderId = dedupeKey.slice(firstSeparator + 1);
  if (!venue || !orderId) return null;
  return { dedupeKey: `order:${orderId}`, venue };
}

async function fetchTerminalOrderKeysForNotifications(
  db: DbQuery,
  inputs: { userId: string; rows: NotificationRow[] },
): Promise<Set<string>> {
  const pairs: Array<{ venue: string; orderId: string }> = [];
  const seen = new Set<string>();

  for (const row of inputs.rows) {
    if (row.type !== "order_created") continue;
    const venue = readNotificationStringData(row, "venue");
    const orderId = readNotificationStringData(row, "orderId");
    if (!venue || !orderId) continue;
    const key = buildOrderKey(venue, orderId);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ venue, orderId });
  }

  if (pairs.length === 0) return new Set();

  const valuesSql = pairs
    .map((_, index) => {
      const venueParam = index * 2 + 2;
      return `($${venueParam}::text, $${venueParam + 1}::text)`;
    })
    .join(", ");
  const params: PgParams = [inputs.userId];
  for (const pair of pairs) {
    params.push(pair.venue, pair.orderId);
  }

  const { rows } = await db.query<{
    venue: string;
    venue_order_id: string;
  }>(
    `
      select distinct o.venue, o.venue_order_id
      from orders o
      join (values ${valuesSql}) as target(venue, venue_order_id)
        on target.venue = o.venue
       and target.venue_order_id = o.venue_order_id
      where o.user_id = $1
        and o.status in (
          'cancelled',
          'canceled',
          'failed',
          'filled',
          'matched',
          'unmatched',
          'rejected',
          'expired'
        )
    `,
    params,
  );

  return new Set(
    rows.map((row) => buildOrderKey(row.venue, row.venue_order_id)),
  );
}

export async function insertNotification(
  db: DbQuery,
  inputs: {
    userId: string;
    type: string;
    title: string;
    body: string;
    severity?: NotificationSeverity;
    data?: unknown;
    dedupeKey?: string | null;
    replaceExisting?: boolean;
  },
): Promise<NotificationRow | null> {
  const severity = inputs.severity ?? "info";
  const dedupeKey = inputs.dedupeKey ?? null;
  const legacyDedupe =
    inputs.replaceExisting === true
      ? resolveLegacyOrderDedupe({ dedupeKey })
      : null;
  if (legacyDedupe && legacyDedupe.dedupeKey !== dedupeKey) {
    await db.query(
      `
        with existing_new as (
          select 1
          from notifications
          where user_id = $1
            and dedupe_key = $3
          limit 1
        ),
        deleted_legacy_duplicate as (
          delete from notifications
          where user_id = $1
            and dedupe_key = $2
            and lower(coalesce(data->>'venue', '')) = lower($4)
            and exists (select 1 from existing_new)
        )
        update notifications
        set dedupe_key = $3,
            updated_at = now()
        where user_id = $1
          and dedupe_key = $2
          and lower(coalesce(data->>'venue', '')) = lower($4)
          and not exists (select 1 from existing_new)
      `,
      [inputs.userId, legacyDedupe.dedupeKey, dedupeKey, legacyDedupe.venue],
    );
  }
  const conflictClause = inputs.replaceExisting
    ? `
      on conflict (user_id, dedupe_key) do update
      set
        type = excluded.type,
        title = excluded.title,
        body = excluded.body,
        severity = excluded.severity,
        data = coalesce(notifications.data, '{}'::jsonb)
          || jsonb_strip_nulls(coalesce(excluded.data, '{}'::jsonb)),
        read_at = null,
        created_at = now(),
        updated_at = now()
      where excluded.type = 'order_filled'
        or notifications.type not in ('order_filled', 'order_cancelled', 'order_failed')
    `
    : "on conflict (user_id, dedupe_key) do nothing";

  const { rows } = await db.query<NotificationRow>(
    `
      insert into notifications (
        id,
        user_id,
        type,
        title,
        body,
        severity,
        data,
        dedupe_key,
        created_at,
        updated_at
      )
      values (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        now(),
        now()
      )
      ${conflictClause}
      returning
        id,
        user_id,
        type,
        title,
        body,
        severity,
        data,
        read_at,
        created_at,
        updated_at
    `,
    [
      inputs.userId,
      inputs.type,
      inputs.title,
      inputs.body,
      severity,
      inputs.data ?? null,
      dedupeKey,
    ],
  );

  return rows[0] ?? null;
}

export async function fetchNotifications(
  db: DbQuery,
  inputs: {
    userId: string;
    limit: number;
    cursor?: string | null;
    unreadOnly?: boolean;
  },
): Promise<{ rows: NotificationRow[]; nextCursor: string | null }> {
  const cursor = decodeCursor(inputs.cursor);
  let whereClause = `
    where n.user_id = $1
      and not (
        n.type = 'order_created'
        and n.data ? 'orderId'
        and (
          exists (
            select 1
            from notifications terminal
            where terminal.user_id = n.user_id
              and terminal.type in ('order_filled', 'order_cancelled', 'order_failed')
              and terminal.data ? 'orderId'
              and terminal.data->>'orderId' = n.data->>'orderId'
              and (
                nullif(lower(coalesce(terminal.data->>'venue', '')), '') is null
                or nullif(lower(coalesce(n.data->>'venue', '')), '') is null
                or lower(terminal.data->>'venue') = lower(n.data->>'venue')
              )
          )
        )
      )
      and not (
        n.type = 'order_filled'
        and lower(coalesce(n.data->>'venue', '')) = 'limitless'
        and coalesce(n.data->>'orderId', '') like 'history:%'
      )
  `;
  const params: PgParams = [inputs.userId];
  let paramCount = 1;

  if (inputs.unreadOnly) {
    whereClause += " and n.read_at is null";
  }

  if (cursor) {
    paramCount += 1;
    whereClause += ` and (n.created_at, n.id) < ($${paramCount}, $${paramCount + 1})`;
    params.push(cursor.createdAt);
    paramCount += 1;
    params.push(cursor.id);
  }

  const { rows } = await db.query<NotificationRow>(
    `
      select
        n.id,
        n.user_id,
        n.type,
        case
          when n.type = 'order_created'
            and lower(coalesce(n.data->>'status', '')) = 'delayed'
            then 'Order delayed'
          else n.title
        end as title,
        n.body,
        case
          when n.type = 'order_created'
            and lower(coalesce(n.data->>'status', '')) = 'delayed'
            then 'warning'
          else n.severity
        end as severity,
        case
          when n.type = 'order_created'
            and lower(coalesce(n.data->>'status', '')) = 'delayed'
            then jsonb_set(coalesce(n.data, '{}'::jsonb), '{status}', '"pending"'::jsonb, true)
          else n.data
        end as data,
        n.read_at,
        n.created_at,
        n.updated_at
      from notifications n
      ${whereClause}
      order by n.created_at desc, n.id desc
      limit $${paramCount + 1}
    `,
    [...params, inputs.limit + 21],
  );

  let terminalOrderKeys = new Set<string>();
  try {
    terminalOrderKeys = await fetchTerminalOrderKeysForNotifications(db, {
      userId: inputs.userId,
      rows,
    });
  } catch {
    terminalOrderKeys = new Set<string>();
  }

  const visibleRows = rows.filter((row) => {
    if (row.type !== "order_created") return true;
    const venue = readNotificationStringData(row, "venue");
    const orderId = readNotificationStringData(row, "orderId");
    if (!venue || !orderId) return true;
    return !terminalOrderKeys.has(buildOrderKey(venue, orderId));
  });

  const hasMore =
    visibleRows.length > inputs.limit || rows.length > inputs.limit + 20;
  const limitedRows = visibleRows.slice(0, inputs.limit);
  const last =
    limitedRows[limitedRows.length - 1] ??
    (hasMore ? rows[rows.length - 1] : undefined);
  const nextCursor =
    hasMore && last
      ? encodeCursor({ createdAt: last.created_at, id: last.id })
      : null;

  return { rows: limitedRows, nextCursor };
}

export async function markNotificationRead(
  db: DbQuery,
  inputs: { userId: string; id: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `
      update notifications
      set read_at = coalesce(read_at, now()), updated_at = now()
      where user_id = $1 and id = $2
    `,
    [inputs.userId, inputs.id],
  );
  return (rowCount ?? 0) > 0;
}

export async function markAllNotificationsRead(
  db: DbQuery,
  inputs: { userId: string },
): Promise<number> {
  const { rowCount } = await db.query(
    `
      update notifications
      set read_at = coalesce(read_at, now()), updated_at = now()
      where user_id = $1 and read_at is null
    `,
    [inputs.userId],
  );
  return rowCount ?? 0;
}
