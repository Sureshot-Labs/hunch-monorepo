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
  const conflictClause = inputs.replaceExisting
    ? `
      on conflict (user_id, dedupe_key) do update
      set
        type = excluded.type,
        title = excluded.title,
        body = excluded.body,
        severity = excluded.severity,
        data = excluded.data,
        read_at = null,
        created_at = now(),
        updated_at = now()
      where notifications.type not in ('order_filled', 'order_cancelled', 'order_failed')
        or excluded.type in ('order_filled', 'order_cancelled', 'order_failed')
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
        and exists (
          select 1
          from notifications terminal
          where terminal.user_id = n.user_id
            and terminal.type in ('order_filled', 'order_cancelled', 'order_failed')
            and terminal.data ? 'orderId'
            and terminal.data->>'orderId' = n.data->>'orderId'
        )
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
        n.title,
        n.body,
        n.severity,
        n.data,
        n.read_at,
        n.created_at,
        n.updated_at
      from notifications n
      ${whereClause}
      order by n.created_at desc, n.id desc
      limit $${paramCount + 1}
    `,
    [...params, inputs.limit + 1],
  );
  const hasMore = rows.length > inputs.limit;
  const limitedRows = hasMore ? rows.slice(0, inputs.limit) : rows;
  const last = limitedRows[limitedRows.length - 1];
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
