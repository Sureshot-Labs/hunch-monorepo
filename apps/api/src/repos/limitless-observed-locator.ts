import { isRecord } from "../lib/type-guards.js";
import { canonicalLimitlessTransactionHash } from "../services/limitless-order-result.js";

const MAX_EXACT_LOCATOR_HASHES = 8;

export type LimitlessHistoryScan = { page: number; cursor?: string };

export type LimitlessHistoryObservation = {
  hashes: readonly string[];
  providerOrderId?: string;
  exactIdentityUnresolved?: true;
  scan?: {
    previous: LimitlessHistoryScan | null;
    next: LimitlessHistoryScan | null;
  };
};

function readHistoryScan(value: unknown): LimitlessHistoryScan | null {
  if (
    !isRecord(value) ||
    typeof value.page !== "number" ||
    !Number.isSafeInteger(value.page) ||
    value.page < 2 ||
    (value.cursor !== undefined &&
      (typeof value.cursor !== "string" ||
        !value.cursor.length ||
        value.cursor.length > 512))
  )
    return null;
  return {
    page: value.page,
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
  };
}

export function readLimitlessObservedLocator(value: unknown) {
  const saved = isRecord(value) ? value : null;
  const candidates = [
    saved?.txHash,
    ...(Array.isArray(saved?.txHashes) ? saved.txHashes : []),
  ];
  const hashes = [
    ...new Set(
      candidates
        .map(canonicalLimitlessTransactionHash)
        .filter((hash): hash is string => hash !== null),
    ),
  ];
  return {
    providerOrderId:
      typeof saved?.providerOrderId === "string" ? saved.providerOrderId : null,
    hashes,
    overflow:
      saved?.overflow === true || hashes.length > MAX_EXACT_LOCATOR_HASHES,
    exactIdentityUnresolved: saved?.exactIdentityUnresolved === true,
    historyScan: readHistoryScan(saved?.historyScan),
  };
}

/** All expressions are fixed, caller-owned SQL; values are bound separately. */
export function appendLimitlessObservedLocatorSql(
  existingSql: string,
  providerIdSql: string,
  txHashSql: string,
  historyObservationSql = "null::jsonb",
): string {
  const saved = `(${existingSql})`;
  const observation = `(${historyObservationSql})`;
  return `(select jsonb_build_object(
    'providerOrderId',coalesce(${saved}->>'providerOrderId',${providerIdSql},${observation}->>'providerOrderId'),
    'txHash',coalesce(${saved}->>'txHash',${txHashSql}),
    'txHashes',coalesce(to_jsonb((array_agg(locator_hash.tx_hash order by locator_hash.tx_hash))[1:${MAX_EXACT_LOCATOR_HASHES}]),'[]'::jsonb),
    'overflow',coalesce(${saved}->'overflow'='true'::jsonb,false) or count(*)>${MAX_EXACT_LOCATOR_HASHES})
    || case when coalesce(${saved}->'exactIdentityUnresolved'='true'::jsonb,false)
      or coalesce(${observation}->'exactIdentityUnresolved'='true'::jsonb,false)
      then '{"exactIdentityUnresolved":true}'::jsonb else '{}'::jsonb end
    || case when ${observation} ? 'scan' and
        ${saved}->'historyScan' is not distinct from nullif(${observation} #> '{scan,previous}','null'::jsonb)
      then jsonb_strip_nulls(jsonb_build_object('historyScan',${observation} #> '{scan,next}'))
      else jsonb_strip_nulls(jsonb_build_object('historyScan',${saved}->'historyScan')) end
    from (select distinct lower(literal_hash.tx_hash) as tx_hash from (
      select ${saved}->>'txHash' as tx_hash union all select ${txHashSql}
      union all select jsonb_array_elements_text(case when jsonb_typeof(${saved}->'txHashes')='array'
        then ${saved}->'txHashes' else '[]'::jsonb end)
      union all select jsonb_array_elements_text(coalesce(${observation}->'hashes','[]'::jsonb))
    ) literal_hash where literal_hash.tx_hash ~* '^0x[0-9a-f]{64}$') locator_hash)`;
}
