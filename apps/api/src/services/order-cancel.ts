import type { Pool } from "@hunch/infra";
import { AuthService } from "../auth.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import { fetchStoredOrderWalletContext } from "../repos/orders-repo.js";
import {
  isLimitlessPartnerHmacConfigured,
  limitlessRequest,
} from "./limitless-client.js";
import {
  buildLimitlessRequestAuthInputs,
  loadLimitlessProfileForWallet,
  resolveLimitlessAuthContext,
  verifyLimitlessAuthContext,
} from "./limitless-auth.js";
import { polymarketL2Request } from "./polymarket-clob-l2.js";

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

type CancelOrderResult = {
  ok: true;
  venue: "polymarket" | "limitless";
  orderId: string;
  signer: string;
  status?: "cancelled" | "matched";
  reconciled?: boolean;
  payload: unknown;
};

function errorWithStatus(
  message: string,
  statusCode = 400,
  extra: Record<string, unknown> = {},
): Error {
  const error = new Error(message);
  Object.assign(error, extra, { statusCode });
  return error;
}

function isEvmAddress(value: string | null | undefined): value is string {
  return typeof value === "string" && EVM_ADDRESS_RE.test(value.trim());
}

function buildEvmSignerCandidates(inputs: {
  requestedWalletAddress: string | null | undefined;
  storedSignerAddress: string | null | undefined;
  storedWalletAddress: string | null | undefined;
}): string[] {
  return Array.from(
    new Map(
      [
        inputs.storedSignerAddress,
        inputs.requestedWalletAddress,
        inputs.storedWalletAddress,
      ]
        .filter(isEvmAddress)
        .map((address) => [address.toLowerCase(), address]),
    ).values(),
  );
}

function summarizePolymarketCancelPayload(inputs: {
  payload: unknown;
  orderId: string;
}): {
  canceled: string[];
  isCanceled: boolean;
  notCanceledReason: string | null;
} {
  const canceledRaw = isRecord(inputs.payload) ? inputs.payload.canceled : null;
  const canceled = Array.isArray(canceledRaw)
    ? canceledRaw.filter((value): value is string => typeof value === "string")
    : [];

  if (canceled.includes(inputs.orderId)) {
    return { canceled, isCanceled: true, notCanceledReason: null };
  }

  const notCanceled = isRecord(inputs.payload)
    ? inputs.payload.not_canceled
    : null;
  const notCanceledReason =
    isRecord(notCanceled) && typeof notCanceled[inputs.orderId] === "string"
      ? (notCanceled[inputs.orderId] as string)
      : canceled.length === 0
        ? `Order[${inputs.orderId}] was not canceled by Polymarket`
        : null;

  return { canceled, isCanceled: false, notCanceledReason };
}

function isPolymarketAlreadyClosedReason(
  reason: string | null | undefined,
): boolean {
  if (!reason) return false;
  const normalized = reason.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("already canceled") ||
    normalized.includes("already cancelled") ||
    normalized.includes("already matched") ||
    normalized.includes("can't be found") ||
    normalized.includes("cannot be found")
  );
}

async function reconcilePolymarketTerminalOrder(
  pool: Pool,
  inputs: {
    userId: string;
    venueOrderId: string;
  },
): Promise<"matched" | "cancelled" | null> {
  const { rows } = await pool.query<{
    id: string;
    token_id: string | null;
    order_hash: string | null;
    order_payload: unknown | null;
  }>(
    `
      select id, token_id, order_hash, order_payload
      from orders
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = $2
      order by posted_at desc nulls last, id desc
      limit 1
    `,
    [inputs.userId, inputs.venueOrderId],
  );
  const order = rows[0];
  if (!order) return null;

  let nextStatus: "matched" | "cancelled" = "cancelled";
  if (order.order_hash || order.order_payload) {
    nextStatus = "matched";
  }

  await pool.query(
    `
      update orders
      set status = $1,
          cancelled_at = case when $1 = 'cancelled' then coalesce(cancelled_at, now()) else cancelled_at end,
          filled_at = case when $1 = 'matched' then coalesce(filled_at, now()) else filled_at end,
          last_update = now()
      where user_id = $2
        and venue = 'polymarket'
        and venue_order_id = $3
    `,
    [nextStatus, inputs.userId, inputs.venueOrderId],
  );

  return nextStatus;
}

export async function cancelPolymarketOrder(
  pool: Pool,
  inputs: {
    userId: string;
    orderId: string;
    requestedWalletAddress?: string | null;
  },
): Promise<CancelOrderResult> {
  const storedOrderWalletContext = await fetchStoredOrderWalletContext(pool, {
    userId: inputs.userId,
    venue: "polymarket",
    venueOrderId: inputs.orderId,
  });

  const signerCandidates = buildEvmSignerCandidates({
    requestedWalletAddress: inputs.requestedWalletAddress,
    storedSignerAddress: storedOrderWalletContext?.signerAddress,
    storedWalletAddress: storedOrderWalletContext?.walletAddress,
  });

  if (signerCandidates.length === 0) {
    throw errorWithStatus(
      "Polymarket cancel requires an EVM signer wallet address",
    );
  }

  let resolvedSigner: string | null = null;
  let resolvedPayload: unknown = null;
  let lastUpstreamFailure: { status: number; payload: unknown } | null = null;
  let lastCancelRejection: {
    signer: string;
    reason: string;
    payload: unknown;
  } | null = null;
  let hasPolymarketCredentials = false;

  for (const signer of signerCandidates) {
    const creds = await AuthService.getVenueCredentials(
      inputs.userId,
      "polymarket",
      signer,
    );
    if (
      !creds ||
      !creds.apiKey ||
      !creds.apiSecret ||
      !creds.apiPassphrase
    ) {
      continue;
    }
    hasPolymarketCredentials = true;

    const upstream = await polymarketL2Request({
      baseUrl: env.polymarketClobBase,
      timeoutMs: 10_000,
      address: signer,
      creds: {
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        apiPassphrase: creds.apiPassphrase,
      },
      method: "DELETE",
      requestPath: "/order",
      body: { orderID: inputs.orderId },
    });

    if (!upstream.ok) {
      lastUpstreamFailure = {
        status: upstream.status,
        payload: upstream.payload,
      };
      continue;
    }

    const cancelSummary = summarizePolymarketCancelPayload({
      payload: upstream.payload,
      orderId: inputs.orderId,
    });

    if (cancelSummary.isCanceled) {
      resolvedSigner = signer;
      resolvedPayload = upstream.payload;
      break;
    }

    if (cancelSummary.notCanceledReason) {
      lastCancelRejection = {
        signer,
        reason: cancelSummary.notCanceledReason,
        payload: upstream.payload,
      };
    }
  }

  if (!resolvedSigner) {
    if (!hasPolymarketCredentials) {
      throw errorWithStatus("Polymarket credentials not found (connect first)");
    }

    if (lastCancelRejection) {
      if (isPolymarketAlreadyClosedReason(lastCancelRejection.reason)) {
        const reconciledStatus = await reconcilePolymarketTerminalOrder(pool, {
          userId: inputs.userId,
          venueOrderId: inputs.orderId,
        });
        return {
          ok: true,
          venue: "polymarket",
          orderId: inputs.orderId,
          signer: lastCancelRejection.signer,
          status: reconciledStatus ?? "cancelled",
          reconciled: true,
          payload: lastCancelRejection.payload,
        };
      }

      throw errorWithStatus("Polymarket cancel rejected", 409, {
        signer: lastCancelRejection.signer,
        reason: lastCancelRejection.reason,
        payload: lastCancelRejection.payload,
      });
    }

    if (lastUpstreamFailure) {
      throw errorWithStatus("Polymarket cancel failed", 502, {
        status: lastUpstreamFailure.status,
        payload: lastUpstreamFailure.payload,
      });
    }

    throw errorWithStatus("Polymarket cancel failed", 502);
  }

  await pool.query(
    `
      update orders
      set status = 'cancelled',
          cancelled_at = now(),
          last_update = now()
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = $2
    `,
    [inputs.userId, inputs.orderId],
  );

  return {
    ok: true,
    venue: "polymarket",
    orderId: inputs.orderId,
    signer: resolvedSigner,
    status: "cancelled",
    payload: resolvedPayload,
  };
}

function mapLimitlessUpstreamStatus(status: number): number {
  if (status === 401 || status === 403) return 400;
  if (status >= 400 && status < 500) return status;
  return 502;
}

export async function cancelLimitlessOrder(
  pool: Pool,
  inputs: {
    userId: string;
    orderId: string;
    requestedWalletAddress?: string | null;
  },
): Promise<CancelOrderResult> {
  if (!isLimitlessPartnerHmacConfigured()) {
    throw errorWithStatus("Limitless partner auth is not configured", 503);
  }

  const storedOrderWalletContext = await fetchStoredOrderWalletContext(pool, {
    userId: inputs.userId,
    venue: "limitless",
    venueOrderId: inputs.orderId,
  });
  const signerCandidates = buildEvmSignerCandidates({
    requestedWalletAddress: inputs.requestedWalletAddress,
    storedSignerAddress: storedOrderWalletContext?.signerAddress,
    storedWalletAddress: storedOrderWalletContext?.walletAddress,
  });
  if (signerCandidates.length === 0) {
    throw errorWithStatus(
      "Limitless cancel requires an EVM signer wallet address",
    );
  }

  let lastError: Error | null = null;
  for (const signer of signerCandidates) {
    const creds = await AuthService.getVenueCredentials(
      inputs.userId,
      "limitless",
      signer,
    );
    const authContext = await resolveLimitlessAuthContext(
      inputs.userId,
      signer,
    );
    if (!authContext || !creds) {
      lastError = errorWithStatus("Connect Limitless for this wallet first.");
      continue;
    }

    const verification = await verifyLimitlessAuthContext({
      authContext,
      walletAddress: signer,
    });
    if (!verification.ok) {
      lastError = errorWithStatus(
        verification.message ??
          "Limitless connection is invalid for the selected wallet.",
        mapLimitlessUpstreamStatus(verification.status),
        { status: verification.status, payload: verification.payload },
      );
      continue;
    }

    const profile = await loadLimitlessProfileForWallet({
      walletAddress: signer,
      authContext,
      additionalData: creds.additionalData ?? null,
      baseProfile: verification.profile,
    });
    if (!profile?.id) {
      lastError = errorWithStatus(
        "Limitless profile mapping is missing for this wallet.",
      );
      continue;
    }

    const upstream = await limitlessRequest({
      method: "DELETE",
      requestPath: `/orders/${inputs.orderId}`,
      ...buildLimitlessRequestAuthInputs(authContext),
    });

    if (!upstream.ok) {
      lastError = errorWithStatus(
        "Limitless cancel failed",
        mapLimitlessUpstreamStatus(upstream.status),
        { status: upstream.status, payload: upstream.payload },
      );
      continue;
    }

    await pool.query(
      `
        update orders
        set status = 'cancelled',
            cancelled_at = now(),
            last_update = now()
        where user_id = $1
          and (wallet_address = $2 or signer_address = $2)
          and venue = 'limitless'
          and venue_order_id = $3
      `,
      [inputs.userId, signer, inputs.orderId],
    );

    return {
      ok: true,
      venue: "limitless",
      orderId: inputs.orderId,
      signer,
      status: "cancelled",
      payload: upstream.payload,
    };
  }

  throw lastError ?? errorWithStatus("Limitless cancel failed", 502);
}

export async function cancelVenueOrder(
  pool: Pool,
  inputs: {
    userId: string;
    venue: string;
    orderId: string;
    requestedWalletAddress?: string | null;
  },
): Promise<CancelOrderResult> {
  if (inputs.venue === "polymarket") {
    return cancelPolymarketOrder(pool, inputs);
  }
  if (inputs.venue === "limitless") {
    return cancelLimitlessOrder(pool, inputs);
  }
  throw errorWithStatus(`Cancel is not supported for ${inputs.venue}`, 409);
}
