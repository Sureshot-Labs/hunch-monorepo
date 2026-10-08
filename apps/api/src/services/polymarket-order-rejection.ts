import { isRecord } from "../lib/type-guards.js";

export type PolymarketSubmissionResponse = {
  ok: boolean;
  status?: number;
  payload: unknown;
  submissionAttempts: number;
};

const identityKeys = new Set([
  "id",
  "orderid",
  "orderids",
  "orderhash",
  "orderhashes",
  "venueorderid",
  "transactionhash",
  "transactionhashes",
  "transactionshashes",
  "txhash",
  "txhashes",
  "tradeid",
  "tradeids",
  "transactions",
]);
const messageKeys = new Set([
  "code",
  "errorcode",
  "error",
  "errors",
  "errormsg",
  "message",
  "msg",
  "detail",
  "reason",
  "status",
]);
const ambiguousMessage =
  /duplicat|already[\s_-]*(?:been[\s_-]*)?(?:exists?|placed|submitted|matched|filled|accepted)|order[\s_-]*delayed|delaying[\s_-]*order|partially (?:filled|matched)|\b(?:delayed|unconfirmed|pending|accepted)\b/i;
const knownRejection =
  /\b(?:INVALID_ORDER_(?:MIN_TICK_SIZE|MIN_SIZE|NOT_ENOUGH_BALANCE|EXPIRATION|INVALID_SIGNATURE)|FOK_ORDER_NOT_FILLED_ERROR|MARKET_NOT_READY)\b|(?:invalid|unauthorized)[\s/:-]*(?:api[\s_-]*key|signature)|signature (?:is )?invalid|(?:not enough|insufficient) (?:balance|allowance)|invalid amount for a marketable buy order|order (?:size|price).*(?:minimum|min[ -]tick)|(?:invalid|expired) (?:order )?expiration|order (?:has )?expired|(?:cannot|can't|couldn't|could not) be fully filled|no orders found to match|market (?:is )?not ready|trading (?:is )?paused/i;

/** Only positive no-acceptance evidence can end Copy recovery. In particular,
 * a rejection of a later HTTP attempt says nothing about an earlier attempt.
 */
export function isPolymarketDefinitiveRejection(
  response: PolymarketSubmissionResponse,
): boolean {
  if (response.submissionAttempts !== 1) return false;
  if (response.status === 408 || (response.status ?? 0) >= 500) return false;
  if (response.ok) {
    if (!isRecord(response.payload) || response.payload.success !== false)
      return false;
  } else if (
    response.status == null ||
    response.status < 400 ||
    response.status >= 500
  )
    return false;

  const messages: string[] = [];
  let ambiguous = false;
  let visited = 0;
  const visit = (value: unknown, key: string, depth: number): void => {
    if (++visited > 100 || depth > 6) {
      ambiguous = true;
      return;
    }
    if (
      ["takingamount", "makingamount", "filledsize", "sizematched"].includes(
        key,
      ) &&
      (typeof value === "string" || typeof value === "number") &&
      Number(value) > 0
    ) {
      ambiguous = true;
      return;
    }
    if (
      identityKeys.has(key) &&
      value != null &&
      (typeof value !== "string" || value.trim() !== "") &&
      (!Array.isArray(value) || value.length > 0)
    ) {
      ambiguous = true;
      return;
    }
    if (typeof value === "string") {
      if (
        key === "status" &&
        /^(?:matched|filled|live|delayed|unconfirmed|pending|accepted)$/i.test(
          value.trim(),
        )
      )
        ambiguous = true;
      if (depth === 0 || messageKeys.has(key)) messages.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key, depth + 1);
    } else if (isRecord(value)) {
      for (const [nestedKey, entry] of Object.entries(value))
        visit(entry, nestedKey.replaceAll("_", "").toLowerCase(), depth + 1);
    }
  };
  visit(response.payload, "", 0);
  if (ambiguous || messages.some((message) => ambiguousMessage.test(message)))
    return false;
  return messages.some((message) => knownRejection.test(message));
}

/** Shared by client-signed and prepared execution, with a persistence callback
 * that also checks retained-attempt certainty and fencing before changing state.
 */
export async function notifyPolymarketDefinitiveRejection(
  response: PolymarketSubmissionResponse,
  onRejected?: () => Promise<void> | void,
): Promise<void> {
  if (isPolymarketDefinitiveRejection(response)) await onRejected?.();
}
