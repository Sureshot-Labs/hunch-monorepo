import type { DbQuery } from "../db.js";
import type { PolymarketOpenOrder } from "./polymarket-clob-l2.js";

// One compact record per signed direct FOK, using the existing unique
// (user_id, endpoint, idempotency_key). Never store signatures or credentials.
const endpoint = "/trade/polymarket/order:direct-fok:v1";
export type DirectFokState =
  | "not_submitted"
  | "unknown"
  | "accepted"
  | "filled"
  | "no_fill"
  | "closed_unknown";
type Binding = {
  maker: string;
  tokenId: string;
  side: string;
  exchangeAddress?: string;
  makerAmount?: string;
};
export type DirectFokKey = {
  userId: string;
  signer: string;
  orderHash: string;
  binding?: Binding;
};
type Fact = {
  state: DirectFokState;
  orderId: string | null;
  binding?: Binding;
};
const fact = (state: DirectFokState, orderId: string | null = null): Fact => ({
  state,
  orderId,
});
export function directFokView(hash: string, result: Fact) {
  const { state } = result;
  const nextAction: "check_original" | "show_result" | "new_review" =
    state === "unknown" || state === "accepted"
      ? "check_original"
      : state === "filled"
        ? "show_result"
        : "new_review";
  return {
    orderHash: hash.toLowerCase(),
    state,
    orderId: result.orderId,
    nextAction,
  };
}
const keyValues = (k: DirectFokKey) => [
  k.userId,
  endpoint,
  k.signer.toLowerCase() + ":" + k.orderHash.toLowerCase(),
  k.signer.toLowerCase(),
];
export async function readDirectFok(
  db: DbQuery,
  k: DirectFokKey,
): Promise<Fact | null> {
  const { rows } = await db.query<{ response: Fact }>(
    `select response from idempotency where user_id=$1 and endpoint=$2 and idempotency_key=$3 and request_hash=$4`,
    keyValues(k),
  );
  return rows[0]?.response ?? null;
}
export async function claimDirectFok(
  db: DbQuery,
  k: DirectFokKey,
  initial: "unknown" | "not_submitted",
) {
  const result = await db.query(
    `insert into idempotency (user_id,endpoint,idempotency_key,request_hash,status,response)
     values ($1,$2,$3,$4,$5,$6::jsonb) on conflict (user_id,endpoint,idempotency_key) do nothing`,
    [
      ...keyValues(k),
      initial === "unknown" ? 0 : 2,
      JSON.stringify({ ...fact(initial), binding: k.binding }),
    ],
  );
  return result.rowCount === 1;
}
export async function advanceDirectFok(
  db: DbQuery,
  k: DirectFokKey,
  next: Fact,
) {
  await db.query(
    `update idempotency set response=response || $5::jsonb, status=$6, updated_at=now()
     where user_id=$1 and endpoint=$2 and idempotency_key=$3 and request_hash=$4
       and (response->>'state'='unknown' or (response->>'state'='accepted' and $5::jsonb->>'state' in ('filled','no_fill','closed_unknown')))`,
    [...keyValues(k), JSON.stringify(next), next.state === "no_fill" ? 2 : 1],
  );
}

// Only exact, owned venue evidence can refine the observed result. A GET miss
// (or expiry of a local timer) proves neither non-dispatch nor non-execution.
export function observeDirectFok(
  prior: Fact | null,
  venueOrder: PolymarketOpenOrder | null,
  orderId: string,
  maker: string,
): Fact {
  const fallback = prior ?? fact("unknown");
  if (
    !venueOrder ||
    !maker ||
    !orderId ||
    venueOrder.id?.toLowerCase() !== orderId.toLowerCase() ||
    venueOrder.makerAddress?.toLowerCase() !== maker.toLowerCase()
  )
    return fallback;
  if (
    prior?.binding &&
    (venueOrder.assetId !== prior.binding.tokenId ||
      venueOrder.side?.toUpperCase() !== prior.binding.side)
  )
    return fallback;
  const state = venueOrder.status?.trim().toLowerCase();
  const matched = venueOrder.sizeMatched?.trim();
  const positive =
    matched != null && /^\d+(?:\.\d+)?$/.test(matched) && /[1-9]/.test(matched);
  if ((state === "filled" || state === "matched") && positive)
    return fact("filled", orderId);
  if (
    [
      "expired",
      "unmatched",
      "cancelled",
      "canceled",
      "canceled_by_user",
      "cancelled_by_user",
    ].includes(state ?? "")
  ) {
    return fact(
      matched &&
        /^0+(?:\.0+)?$/.test(matched) &&
        venueOrder.explicitEmptyTrades === true
        ? "no_fill"
        : "closed_unknown",
      orderId,
    );
  }
  return fact("accepted", orderId);
}
