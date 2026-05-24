import { z as zod } from "zod";
import type { DbQuery } from "../db.js";
import { env } from "../env.js";
import {
  buildBridgeNotification,
  buildDepositNotification,
  createNotificationSafe,
} from "./notifications.js";
import { canonicalizeBridgeOrderStatus } from "./bridge-status.js";

type Logger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

type DepositEventStatus =
  | "recorded"
  | "notified"
  | "ignored_bridge"
  | "ignored_venue"
  | "ignored_internal"
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
  src_chain_id: string | null;
  dst_chain_id: string | null;
  order_id: string | null;
  tx_hash_src: string | null;
  tx_hash_dst: string | null;
};

type BridgeOrderDepositMatch = BridgeOrderMatch & {
  matchKind: "tx" | "intent";
  matchedTxSide: "src" | "dst" | null;
};

type ExecutionMatch = {
  id: string;
  user_id: string;
  venue: string;
  status: string | null;
};

type InternalDepositMatch = {
  userId: string;
  walletAddress: string | null;
  walletType: string | null;
  reason: string;
};

type PolymarketFunderMovementMatch = {
  user_id: string;
  signer_address: string;
  funder_address: string;
  direction: string;
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

const HUNCH_SOLANA_CHAIN_ID = "7565164";
const POLYGON_CHAIN_ID = "137";
const BASE_CHAIN_ID = "8453";
const ACROSS_SOLANA_DEPOSIT_SENDER =
  "E4bX4nCwe2GcKqt9NpofnXVrCeRp37PAMaiZtV9x3kxC";
const ACROSS_BASE_WITHDRAW_SENDER =
  "0xcad97616f91872c02ba3553db315db4015cbe850";
const ACROSS_BASE_SPOKE_POOL_SENDER =
  "0xfd03abcadaf3f930fa4e37eb2f6ea3a44a41b7f0";
const ACROSS_POLYGON_DEPOSIT_SENDER =
  "0xb5b25e9b8c5c2d4e03ca0a79e42aa226cdec3ff2";
const ACROSS_POLYGON_ENTRYPOINT_SENDER =
  "0x0000000071727de22e5e9d8baf0edac6f37da032";
const KNOWN_ACROSS_DEPOSIT_SENDERS_BY_CHAIN: Record<string, Set<string>> = {
  [HUNCH_SOLANA_CHAIN_ID]: new Set([ACROSS_SOLANA_DEPOSIT_SENDER]),
  [BASE_CHAIN_ID]: new Set([
    ACROSS_BASE_WITHDRAW_SENDER,
    ACROSS_BASE_SPOKE_POOL_SENDER,
  ]),
  [POLYGON_CHAIN_ID]: new Set([
    ACROSS_POLYGON_DEPOSIT_SENDER,
    ACROSS_POLYGON_ENTRYPOINT_SENDER,
  ]),
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

function normalizeKnownAcrossSender(chainId: string, sender: string): string {
  return chainId === HUNCH_SOLANA_CHAIN_ID ? sender.trim() : sender.toLowerCase();
}

function isKnownAcrossBridgeDeposit(event: PrivyFundsDepositedWebhook): boolean {
  const chainId = resolveBridgeChainIdFromCaip2(event.caip2);
  const sender = event.sender?.trim();
  if (!chainId || !sender) return false;
  return (
    KNOWN_ACROSS_DEPOSIT_SENDERS_BY_CHAIN[chainId]?.has(
      normalizeKnownAcrossSender(chainId, sender),
    ) ?? false
  );
}

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

function normalizeEvmAddress(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function resolveBridgeChainIdFromCaip2(caip2: string): string | null {
  const normalized = caip2.trim().toLowerCase();
  if (normalized.startsWith("eip155:")) {
    const chainId = normalized.slice("eip155:".length).trim();
    return chainId || null;
  }
  if (normalized.startsWith("solana:")) {
    return HUNCH_SOLANA_CHAIN_ID;
  }
  return null;
}

function resolveDepositAssetAddress(
  event: PrivyFundsDepositedWebhook,
): string | null {
  const raw =
    event.asset.address?.trim() || event.asset.mint?.trim() || null;
  return raw || null;
}

function buildAddressSet(
  values: Array<string | null | undefined>,
): Set<string> {
  return new Set(
    values
      .map((value) => normalizeEvmAddress(value))
      .filter((value): value is string => Boolean(value)),
  );
}

function isVenueCashDeposit(event: PrivyFundsDepositedWebhook): boolean {
  const caip2 = event.caip2.toLowerCase();
  const sender = normalizeEvmAddress(event.sender);
  const assetAddress = normalizeEvmAddress(event.asset.address);
  if (!sender || !assetAddress) return false;

  if (caip2 === "eip155:137") {
    const cashAssets = buildAddressSet([
      env.polymarketPusdAddress,
      env.polymarketUsdcAddress,
      env.polymarketUsdceAddress,
    ]);
    const venueSenders = buildAddressSet([
      env.polymarketExchangeAddress,
      env.polymarketNegRiskExchangeAddress,
      env.polymarketNegRiskAdapterAddress,
      env.polymarketCollateralOnrampAddress,
      env.polymarketCollateralOfframpAddress,
    ]);
    return cashAssets.has(assetAddress) && venueSenders.has(sender);
  }

  if (caip2 === "eip155:8453") {
    const cashAssets = buildAddressSet([env.limitlessUsdcAddress]);
    const venueSenders = buildAddressSet([
      env.limitlessClobAddress,
      env.limitlessNegRiskAddress,
    ]);
    return cashAssets.has(assetAddress) && venueSenders.has(sender);
  }

  return false;
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

async function findPolymarketFunderMovement(
  db: DbQuery,
  input: { sender: string | null; recipient: string | null },
): Promise<PolymarketFunderMovementMatch | null> {
  const sender = normalizeEvmAddress(input.sender);
  const recipient = normalizeEvmAddress(input.recipient);
  if (!sender || !recipient) return null;

  const { rows } = await db.query<PolymarketFunderMovementMatch>(
    `
      select
        user_id,
        wallet_address as signer_address,
        funder_address,
        case
          when lower(funder_address) = $1 and lower(wallet_address) = $2
            then 'funder_to_signer'
          when lower(wallet_address) = $1 and lower(funder_address) = $2
            then 'signer_to_funder'
        end as direction
      from user_venue_credentials
      where venue = 'polymarket'
        and is_active = true
        and funder_address is not null
        and (
          (lower(funder_address) = $1 and lower(wallet_address) = $2)
          or (lower(wallet_address) = $1 and lower(funder_address) = $2)
        )
      order by updated_at desc
      limit 1
    `,
    [sender, recipient],
  );
  return rows[0] ?? null;
}

async function findInternalDepositMovement(
  db: DbQuery,
  input: {
    event: PrivyFundsDepositedWebhook;
    recipientWallet: UserWalletMatch | null;
    recipientWalletType: string | null;
    recipient: string | null;
  },
): Promise<InternalDepositMatch | null> {
  const sender = input.event.sender?.trim() || null;
  if (!sender || !input.recipient) return null;

  const senderWalletType = resolveWalletType(input.event.caip2, sender);
  const senderWallet =
    senderWalletType != null
      ? await resolveUserWallet(db, {
          walletType: senderWalletType,
          address: sender,
        })
      : null;

  if (
    senderWallet &&
    input.recipientWallet &&
    senderWallet.user_id === input.recipientWallet.user_id
  ) {
    return {
      userId: input.recipientWallet.user_id,
      walletAddress: input.recipientWallet.wallet_address,
      walletType: input.recipientWallet.wallet_type,
      reason: "same_user_wallet",
    };
  }

  const funderMovement = await findPolymarketFunderMovement(db, {
    sender,
    recipient: input.recipient,
  });
  if (funderMovement?.user_id) {
    return {
      userId: funderMovement.user_id,
      walletAddress: input.recipientWallet?.wallet_address ?? input.recipient,
      walletType: input.recipientWallet?.wallet_type ?? input.recipientWalletType,
      reason: `polymarket_${funderMovement.direction || "funder_movement"}`,
    };
  }

  return null;
}

async function findBridgeOrderByTxHash(
  db: DbQuery,
  txHash?: string | null,
): Promise<BridgeOrderDepositMatch | null> {
  const trimmed = txHash?.trim();
  if (!trimmed) return null;

  const params = [trimmed];
  const evmMatch = trimmed.startsWith("0x")
    ? "or lower(tx_hash_src) = lower($1) or lower(tx_hash_dst) = lower($1)"
    : "";
  const { rows } = await db.query<BridgeOrderMatch>(
    `
      select
        id,
        user_id,
        provider,
        status,
        swap_type,
        src_chain_id,
        dst_chain_id,
        order_id,
        tx_hash_src,
        tx_hash_dst
      from bridge_orders
      where tx_hash_src = $1
        or tx_hash_dst = $1
        ${evmMatch}
      order by created_at desc
      limit 1
    `,
    params,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    matchKind: "tx",
    matchedTxSide: resolveMatchedBridgeTxSide(row, trimmed),
  };
}

function normalizeBridgeTxHashForCompare(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : trimmed;
}

function bridgeTxHashMatches(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left?.trim() || !right?.trim()) return false;
  return (
    normalizeBridgeTxHashForCompare(left) ===
    normalizeBridgeTxHashForCompare(right)
  );
}

function resolveMatchedBridgeTxSide(
  bridgeOrder: BridgeOrderMatch,
  txHash: string,
): "src" | "dst" | null {
  if (bridgeTxHashMatches(bridgeOrder.tx_hash_dst, txHash)) return "dst";
  if (bridgeTxHashMatches(bridgeOrder.tx_hash_src, txHash)) return "src";
  return null;
}

async function findBridgeOrderByDepositIntent(
  db: DbQuery,
  input: {
    event: PrivyFundsDepositedWebhook;
    userId: string | null | undefined;
    recipient: string | null;
    logger?: Logger;
  },
): Promise<BridgeOrderDepositMatch | null> {
  if (!input.userId) return null;
  const dstChainId = resolveBridgeChainIdFromCaip2(input.event.caip2);
  if (
    dstChainId !== HUNCH_SOLANA_CHAIN_ID ||
    input.event.sender?.trim() !== ACROSS_SOLANA_DEPOSIT_SENDER
  ) {
    return null;
  }
  const dstToken = resolveDepositAssetAddress(input.event);
  const amountRaw = input.event.amount.trim();
  if (!dstChainId || !dstToken || !amountRaw) return null;

  const recipient = input.recipient?.trim() || "";
  const { rows } = await db.query<BridgeOrderMatch>(
    `
      select
        id,
        user_id,
        provider,
        status,
        swap_type,
        src_chain_id,
        dst_chain_id,
        order_id,
        tx_hash_src,
        tx_hash_dst
      from bridge_orders
      where user_id = $1
        and provider = 'across'
        and dst_chain_id = $2
        and lower(dst_token) = lower($3)
        and status not in ('failed', 'expired', 'refunded')
        and created_at > now() - interval '24 hours'
        and (
          metadata #>> '{across,expectedOutputAmount}' = $4
          or metadata #>> '{across,minOutputAmount}' = $4
          or metadata #>> '{across,providerPayload,outputAmount}' = $4
          or metadata #>> '{across,statusPayload,outputAmount}' = $4
        )
        and (
          coalesce(
            metadata #>> '{recipientAddress}',
            metadata #>> '{across,recipientAddress}'
          ) is null
          or $5 = ''
          or lower(coalesce(
            metadata #>> '{recipientAddress}',
            metadata #>> '{across,recipientAddress}'
          )) = lower($5)
        )
      order by created_at desc
      limit 2
    `,
    [input.userId, dstChainId, dstToken, amountRaw, recipient],
  );
  if (rows.length > 1) {
    input.logger?.warn?.(
      {
        userId: input.userId,
        dstChainId,
        dstToken,
        amountRaw,
        recipient,
        candidateIds: rows.map((row) => row.id),
      },
      "Across Solana deposit intent match was ambiguous",
    );
    return null;
  }
  const row = rows[0];
  if (!row) return null;
  return { ...row, matchKind: "intent", matchedTxSide: "dst" };
}

async function findConfirmedBridgeOrderForDeposit(
  db: DbQuery,
  input: {
    event: PrivyFundsDepositedWebhook;
    userId: string | null | undefined;
    recipient: string | null;
    logger?: Logger;
  },
): Promise<BridgeOrderDepositMatch | null> {
  const exactBridgeOrder = await findBridgeOrderByTxHash(
    db,
    input.event.transaction_hash,
  );
  if (exactBridgeOrder) return exactBridgeOrder;

  const intentBridgeOrder = await findBridgeOrderByDepositIntent(db, {
    event: input.event,
    userId: input.userId,
    recipient: input.recipient,
    logger: input.logger,
  });
  return intentBridgeOrder;
}

function resolveBridgeNotificationDedupeId(
  bridgeOrder: BridgeOrderMatch,
): string {
  return bridgeOrder.provider === "across"
    ? bridgeOrder.id
    : (bridgeOrder.order_id ?? bridgeOrder.id);
}

async function markBridgeOrderDestinationFill(
  db: DbQuery,
  input: {
    bridgeOrder: BridgeOrderDepositMatch;
    txHash: string | null;
    depositEventId: string;
    eventChainId: string | null;
  },
): Promise<void> {
  const bridgeOrder = input.bridgeOrder;
  const nextStatus =
    shouldCompleteBridgeFromDeposit(bridgeOrder, input.eventChainId)
      ? "fulfilled"
      : bridgeOrder.status;

  await db.query(
    `
      update bridge_orders
      set
        tx_hash_dst = case
          when $5::text is not null and $5::text = dst_chain_id
            then coalesce(tx_hash_dst, $2::text)
          else tx_hash_dst
        end,
        status = $3::text,
        metadata = jsonb_set(
          coalesce(metadata, '{}'::jsonb),
          '{depositFill}',
          coalesce(metadata->'depositFill', '{}'::jsonb)
            || jsonb_strip_nulls(jsonb_build_object(
              'privyDepositEventId', $4::text,
              'txHash', $2::text,
              'matchedAt', to_jsonb(now())
            )),
          true
        ),
        updated_at = now()
      where id = $1
    `,
    [
      bridgeOrder.id,
      input.txHash,
      nextStatus,
      input.depositEventId,
      input.eventChainId,
    ],
  );
}

function shouldCompleteBridgeFromDeposit(
  bridgeOrder: BridgeOrderDepositMatch,
  eventChainId: string | null,
): boolean {
  const status = canonicalizeBridgeOrderStatus(bridgeOrder.status, "submitted");
  if (status === "failed" || status === "expired" || status === "refunded") {
    return false;
  }
  if (!eventChainId || eventChainId !== bridgeOrder.dst_chain_id) return false;
  if (bridgeOrder.matchKind === "tx") {
    return bridgeOrder.matchedTxSide === "dst";
  }
  return bridgeOrder.matchKind === "intent";
}

async function findExecutionByTxHash(
  db: DbQuery,
  txHash?: string | null,
): Promise<ExecutionMatch | null> {
  const trimmed = txHash?.trim();
  if (!trimmed) return null;

  const evmMatch = trimmed.startsWith("0x")
    ? "or lower(tx_signature) = lower($1)"
    : "";
  const exact = await db.query<ExecutionMatch>(
    `
      select id, user_id, venue, status
      from executions
      where tx_signature = $1
        ${evmMatch}
      order by created_at desc
      limit 1
    `,
    [trimmed],
  );
  if (exact.rows[0]) return exact.rows[0];

  const settlement = await db.query<ExecutionMatch>(
    `
      select id, user_id, venue, status
      from executions
      where venue = 'kalshi'
        and exists (
          select 1
          from jsonb_array_elements(
            (
              case
                when jsonb_typeof(raw #> '{settlement,fills}') = 'array'
                  then raw #> '{settlement,fills}'
                else '[]'::jsonb
              end
            ) ||
            (
              case
                when jsonb_typeof(raw #> '{settlement,reverts}') = 'array'
                  then raw #> '{settlement,reverts}'
                else '[]'::jsonb
              end
            )
          ) settlement(entry)
          where settlement.entry->>'signature' = $1
             or settlement.entry->>'txSignature' = $1
             or settlement.entry->>'tx_signature' = $1
        )
      order by created_at desc
      limit 1
    `,
    [trimmed],
  );
  return settlement.rows[0] ?? null;
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
  const knownAcrossBridgeDeposit = isKnownAcrossBridgeDeposit(event);
  const recipient = event.recipient?.trim() || null;
  const walletType = resolveWalletType(event.caip2, recipient);
  const wallet =
    recipient && walletType
      ? await resolveUserWallet(db, { walletType, address: recipient })
      : null;
  const bridgeOrder = await findConfirmedBridgeOrderForDeposit(db, {
    event,
    userId: wallet?.user_id,
    recipient,
    logger,
  });
  const execution = bridgeOrder || knownAcrossBridgeDeposit
    ? null
    : await findExecutionByTxHash(db, event.transaction_hash);
  const venueCashDeposit =
    !bridgeOrder &&
    !knownAcrossBridgeDeposit &&
    (Boolean(execution) || isVenueCashDeposit(event));
  const internalMovement =
    !bridgeOrder && !knownAcrossBridgeDeposit && !venueCashDeposit
      ? await findInternalDepositMovement(db, {
          event,
          recipientWallet: wallet,
          recipientWalletType: walletType,
          recipient,
        })
      : null;
  const status: DepositEventStatus = bridgeOrder || knownAcrossBridgeDeposit
    ? "ignored_bridge"
    : venueCashDeposit
      ? "ignored_venue"
      : internalMovement
        ? "ignored_internal"
        : wallet
          ? "recorded"
          : "unresolved";

  const insertedRow = await insertDepositEvent(db, {
    status,
    userId:
      wallet?.user_id ??
      bridgeOrder?.user_id ??
      execution?.user_id ??
      internalMovement?.userId ??
      null,
    walletAddress:
      wallet?.wallet_address ?? internalMovement?.walletAddress ?? recipient,
    walletType: wallet?.wallet_type ?? internalMovement?.walletType ?? walletType,
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
    const eventChainId = resolveBridgeChainIdFromCaip2(event.caip2);
    const shouldNotifyCompleted = shouldCompleteBridgeFromDeposit(
      bridgeOrder,
      eventChainId,
    );
    await markBridgeOrderDestinationFill(db, {
      bridgeOrder,
      txHash: event.transaction_hash ?? null,
      depositEventId: row.id,
      eventChainId,
    });
    await updateDepositEventStatus(db, {
      eventId: row.id,
      status: "ignored_bridge",
      userId: bridgeOrder.user_id,
      bridgeOrderId: bridgeOrder.id,
    });
    if (shouldNotifyCompleted) {
      void createNotificationSafe(
        db,
        buildBridgeNotification({
          userId: bridgeOrder.user_id,
          provider: bridgeOrder.provider,
          status: "completed",
          srcChainId: bridgeOrder.src_chain_id,
          dstChainId: bridgeOrder.dst_chain_id,
          bridgeOrderId: resolveBridgeNotificationDedupeId(bridgeOrder),
          txHash: bridgeOrder.tx_hash_src ?? event.transaction_hash ?? null,
        }),
        logger?.warn
          ? { warn: (obj, msg) => logger.warn?.(obj, msg) }
          : undefined,
      );
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

  if (knownAcrossBridgeDeposit) {
    if (row.status !== "ignored_bridge") {
      await updateDepositEventStatus(db, {
        eventId: row.id,
        status: "ignored_bridge",
        userId: wallet?.user_id ?? row.user_id,
        walletAddress: wallet?.wallet_address ?? recipient,
        walletType: wallet?.wallet_type ?? walletType,
      });
    }
    logger?.info?.(
      {
        depositEventId: row.id,
        sender: event.sender ?? null,
        txHash: event.transaction_hash ?? null,
      },
      "Privy deposit webhook ignored because sender is Across bridge",
    );
    return { ok: true, duplicate, ignored: true, status: "ignored_bridge" };
  }

  if (venueCashDeposit) {
    if (row.status !== "ignored_venue") {
      await updateDepositEventStatus(db, {
        eventId: row.id,
        status: "ignored_venue",
        userId: wallet?.user_id ?? execution?.user_id ?? null,
        walletAddress: wallet?.wallet_address ?? recipient,
        walletType: wallet?.wallet_type ?? walletType,
      });
    }
    logger?.info?.(
      {
        depositEventId: row.id,
        sender: event.sender ?? null,
        asset: event.asset,
        txHash: event.transaction_hash ?? null,
        executionId: execution?.id ?? null,
        venue: execution?.venue ?? null,
      },
      "Privy deposit webhook ignored because it matched venue cash movement",
    );
    return { ok: true, duplicate, ignored: true, status: "ignored_venue" };
  }

  if (internalMovement) {
    if (row.status !== "ignored_internal") {
      await updateDepositEventStatus(db, {
        eventId: row.id,
        status: "ignored_internal",
        userId: internalMovement.userId,
        walletAddress: internalMovement.walletAddress,
        walletType: internalMovement.walletType,
      });
    }
    logger?.info?.(
      {
        depositEventId: row.id,
        sender: event.sender ?? null,
        recipient,
        asset: event.asset,
        txHash: event.transaction_hash ?? null,
        reason: internalMovement.reason,
      },
      "Privy deposit webhook ignored because it matched an internal wallet movement",
    );
    return { ok: true, duplicate, ignored: true, status: "ignored_internal" };
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
