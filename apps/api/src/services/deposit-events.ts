import { z as zod } from "zod";
import type { DbQuery } from "../db.js";
import {
  buildDepositNotification,
  createNotificationSafe,
} from "./notifications.js";

type Logger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

type DepositEventStatus =
  | "recorded"
  | "notified"
  | "ignored_bridge"
  | "unresolved";

type UserWalletMatch = {
  user_id: string;
  wallet_address: string;
  wallet_type: string;
};

type BridgeOrderMatch = {
  id: string;
  user_id: string;
  provider: string;
  status: string;
  swap_type: string;
};

type DepositEventRow = {
  id: string;
  source: string;
  source_event_type: string;
  source_idempotency_key: string;
  user_id: string | null;
  status: DepositEventStatus;
};

type NotificationIdRow = {
  id: string;
};

const privyAssetSchema = zod
  .object({
    type: zod.string().optional(),
    address: zod.string().nullable().optional(),
    mint: zod.string().nullable().optional(),
  })
  .passthrough();

const privyFundsDepositedSchema = zod
  .object({
    type: zod.literal("wallet.funds_deposited"),
    wallet_id: zod.string().min(1),
    idempotency_key: zod.string().min(1),
    caip2: zod.string().min(1),
    asset: privyAssetSchema,
    amount: zod.string().min(1),
    transaction_hash: zod.string().nullable().optional(),
    sender: zod.string().nullable().optional(),
    recipient: zod.string().nullable().optional(),
    block: zod
      .object({
        number: zod.union([zod.string(), zod.number()]).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type PrivyFundsDepositedWebhook = zod.infer<
  typeof privyFundsDepositedSchema
>;

function readWebhookType(payload: unknown): string | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const type = record.type ?? record.event;
  return typeof type === "string" ? type : null;
}

function normalizePrivyWebhookPayload(payload: unknown): unknown {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return payload;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.type === "string") return payload;
  if (
    typeof record.event === "string" &&
    typeof record.data === "object" &&
    record.data !== null &&
    !Array.isArray(record.data)
  ) {
    return { ...(record.data as Record<string, unknown>), type: record.event };
  }
  return payload;
}

function resolveWalletType(
  caip2: string,
  address?: string | null,
): string | null {
  const normalizedCaip2 = caip2.toLowerCase();
  if (normalizedCaip2.startsWith("solana:")) return "solana";
  if (normalizedCaip2.startsWith("eip155:")) return "ethereum";
  if (address?.startsWith("0x")) return "ethereum";
  return null;
}

function normalizeWalletAddress(walletType: string, address: string): string {
  return walletType === "ethereum" ? address.toLowerCase() : address;
}

async function resolveUserWallet(
  db: DbQuery,
  input: { walletType: string; address: string },
): Promise<UserWalletMatch | null> {
  const normalized = normalizeWalletAddress(input.walletType, input.address);
  const { rows } = await db.query<UserWalletMatch>(
    `
      select user_id, wallet_address, wallet_type
      from user_wallets
      where wallet_type = $1
        and wallet_address_norm = $2
      limit 1
    `,
    [input.walletType, normalized],
  );
  return rows[0] ?? null;
}

async function findBridgeOrderByTxHash(
  db: DbQuery,
  txHash?: string | null,
): Promise<BridgeOrderMatch | null> {
  const trimmed = txHash?.trim();
  if (!trimmed) return null;

  const params = [trimmed];
  const evmMatch = trimmed.startsWith("0x")
    ? "or lower(tx_hash_src) = lower($1) or lower(tx_hash_dst) = lower($1)"
    : "";
  const { rows } = await db.query<BridgeOrderMatch>(
    `
      select id, user_id, provider, status, swap_type
      from bridge_orders
      where tx_hash_src = $1
        or tx_hash_dst = $1
        ${evmMatch}
      order by created_at desc
      limit 1
    `,
    params,
  );
  return rows[0] ?? null;
}

async function insertDepositEvent(
  db: DbQuery,
  input: {
    status: DepositEventStatus;
    userId: string | null;
    walletAddress: string | null;
    walletType: string | null;
    bridgeOrderId: string | null;
    payload: PrivyFundsDepositedWebhook;
  },
): Promise<DepositEventRow | null> {
  const blockNumber = input.payload.block?.number;
  const { rows } = await db.query<DepositEventRow>(
    `
      insert into deposit_events (
        source,
        source_event_type,
        source_idempotency_key,
        privy_wallet_id,
        user_id,
        wallet_address,
        wallet_type,
        caip2,
        asset,
        amount_raw,
        transaction_hash,
        sender,
        recipient,
        block_number,
        status,
        bridge_order_id,
        payload,
        created_at,
        updated_at
      )
      values (
        'privy',
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        now(),
        now()
      )
      on conflict (source, source_idempotency_key) do nothing
      returning id, source, source_event_type, source_idempotency_key, user_id, status
    `,
    [
      input.payload.type,
      input.payload.idempotency_key,
      input.payload.wallet_id,
      input.userId,
      input.walletAddress,
      input.walletType,
      input.payload.caip2,
      input.payload.asset,
      input.payload.amount,
      input.payload.transaction_hash ?? null,
      input.payload.sender ?? null,
      input.payload.recipient ?? null,
      blockNumber == null ? null : String(blockNumber),
      input.status,
      input.bridgeOrderId,
      input.payload,
    ],
  );
  return rows[0] ?? null;
}

async function fetchDepositEventByKey(
  db: DbQuery,
  idempotencyKey: string,
): Promise<DepositEventRow | null> {
  const { rows } = await db.query<DepositEventRow>(
    `
      select id, source, source_event_type, source_idempotency_key, user_id, status
      from deposit_events
      where source = 'privy'
        and source_idempotency_key = $1
      limit 1
    `,
    [idempotencyKey],
  );
  return rows[0] ?? null;
}

async function updateDepositEventStatus(
  db: DbQuery,
  input: {
    eventId: string;
    status: DepositEventStatus;
    userId?: string | null;
    bridgeOrderId?: string | null;
    walletAddress?: string | null;
    walletType?: string | null;
  },
): Promise<void> {
  await db.query(
    `
      update deposit_events
      set status = $2,
          user_id = coalesce($3::uuid, user_id),
          bridge_order_id = coalesce($4::uuid, bridge_order_id),
          wallet_address = coalesce($5::text, wallet_address),
          wallet_type = coalesce($6::text, wallet_type),
          updated_at = now()
      where id = $1
    `,
    [
      input.eventId,
      input.status,
      input.userId ?? null,
      input.bridgeOrderId ?? null,
      input.walletAddress ?? null,
      input.walletType ?? null,
    ],
  );
}

async function markDepositEventNotified(
  db: DbQuery,
  input: { eventId: string; notificationId: string },
): Promise<void> {
  await db.query(
    `
      update deposit_events
      set status = 'notified',
          notification_id = $2,
          notified_at = now(),
          updated_at = now()
      where id = $1
    `,
    [input.eventId, input.notificationId],
  );
}

async function findNotificationIdByDedupeKey(
  db: DbQuery,
  input: { userId: string; dedupeKey: string | null | undefined },
): Promise<string | null> {
  if (!input.dedupeKey) return null;
  const { rows } = await db.query<NotificationIdRow>(
    `
      select id
      from notifications
      where user_id = $1
        and dedupe_key = $2
      limit 1
    `,
    [input.userId, input.dedupeKey],
  );
  return rows[0]?.id ?? null;
}

export async function handlePrivyDepositWebhook(
  db: DbQuery,
  payload: unknown,
  logger?: Logger,
): Promise<{
  ok: boolean;
  ignored?: boolean;
  duplicate?: boolean;
  notified?: boolean;
  status?: DepositEventStatus;
}> {
  const normalizedPayload = normalizePrivyWebhookPayload(payload);
  const eventType = readWebhookType(normalizedPayload);
  if (eventType !== "wallet.funds_deposited") {
    return { ok: true, ignored: true };
  }

  const event = privyFundsDepositedSchema.parse(normalizedPayload);
  const recipient = event.recipient?.trim() || null;
  const walletType = resolveWalletType(event.caip2, recipient);
  const wallet =
    recipient && walletType
      ? await resolveUserWallet(db, { walletType, address: recipient })
      : null;
  const bridgeOrder = await findBridgeOrderByTxHash(db, event.transaction_hash);
  const status: DepositEventStatus = bridgeOrder
    ? "ignored_bridge"
    : wallet
      ? "recorded"
      : "unresolved";

  const insertedRow = await insertDepositEvent(db, {
    status,
    userId: wallet?.user_id ?? bridgeOrder?.user_id ?? null,
    walletAddress: wallet?.wallet_address ?? recipient,
    walletType: wallet?.wallet_type ?? walletType,
    bridgeOrderId: bridgeOrder?.id ?? null,
    payload: event,
  });
  const row =
    insertedRow ?? (await fetchDepositEventByKey(db, event.idempotency_key));

  if (!row) {
    return { ok: true, duplicate: true };
  }
  const duplicate = !insertedRow;

  if (bridgeOrder) {
    if (row.status !== "ignored_bridge") {
      await updateDepositEventStatus(db, {
        eventId: row.id,
        status: "ignored_bridge",
        userId: bridgeOrder.user_id,
        bridgeOrderId: bridgeOrder.id,
      });
    }
    logger?.info?.(
      {
        depositEventId: row.id,
        txHash: event.transaction_hash ?? null,
        bridgeOrderId: bridgeOrder?.id ?? null,
      },
      "Privy deposit webhook ignored because it matched a bridge order",
    );
    return { ok: true, duplicate, ignored: true, status: "ignored_bridge" };
  }

  if (!wallet) {
    if (row.status !== "unresolved") {
      await updateDepositEventStatus(db, {
        eventId: row.id,
        status: "unresolved",
      });
    }
    logger?.warn?.(
      {
        depositEventId: row.id,
        recipient,
        walletType,
        txHash: event.transaction_hash ?? null,
      },
      "Privy deposit webhook could not be matched to a user wallet",
    );
    return { ok: true, duplicate, status: "unresolved" };
  }

  if (row.status === "notified") {
    return { ok: true, duplicate, notified: true, status: "notified" };
  }

  if (
    row.status !== "recorded" ||
    row.user_id !== wallet.user_id ||
    duplicate
  ) {
    await updateDepositEventStatus(db, {
      eventId: row.id,
      status: "recorded",
      userId: wallet.user_id,
      walletAddress: wallet.wallet_address,
      walletType: wallet.wallet_type,
    });
  }

  const notificationInput = buildDepositNotification({
    userId: wallet.user_id,
    source: "privy",
    walletAddress: wallet.wallet_address,
    walletType: wallet.wallet_type,
    caip2: event.caip2,
    asset: event.asset,
    amountRaw: event.amount,
    txHash: event.transaction_hash ?? null,
    idempotencyKey: event.idempotency_key,
  });
  const notification = await createNotificationSafe(
    db,
    notificationInput,
    logger?.warn ? { warn: (obj, msg) => logger.warn?.(obj, msg) } : undefined,
  );
  const notificationId =
    notification?.id ??
    (await findNotificationIdByDedupeKey(db, {
      userId: wallet.user_id,
      dedupeKey: notificationInput.dedupeKey,
    }));

  if (notificationId) {
    await markDepositEventNotified(db, {
      eventId: row.id,
      notificationId,
    });
  } else {
    throw new Error("Deposit notification was not created");
  }

  return {
    ok: true,
    duplicate,
    notified: Boolean(notificationId),
    status: notificationId ? "notified" : status,
  };
}
