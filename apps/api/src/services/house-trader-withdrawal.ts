import { getAddress, ZeroAddress } from "ethers";

export const houseSweepBoundarySql = `update house_trader_actions
  set reference=$2,reason=null,state='submitting',
  result=result || jsonb_build_object(
    'phase','sweep','handoffReference',$3::text,'sweepNonce',$5::int,'transactionHash',$6::text),
  protected_submission=$4,updated_at=now()
  where id=$1 and result->>'phase'='handoff' and reference=$3
    and state in ('submitting','submitted')`;

export const houseSweepRevertedSql = `update house_trader_actions
  set result=result || jsonb_build_object('phase','handoff'),
  reference=result->>'handoffReference',
  protected_submission=null,reason='treasury_step_reverted',state='submitted',updated_at=now()
  where id=$1 and reference=$2 and result->>'phase'='sweep'
    and (result->>'handoffReference') ~ '^batch:[0-9]+:[0-9]+$'`;

export function houseWithdrawalRecipient(
  value: unknown,
  excluded: readonly (string | null)[] = [],
) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value.trim()))
    return null;
  try {
    const recipient = getAddress(value.trim());
    if (
      recipient === ZeroAddress ||
      excluded.some(
        (address) => address?.toLowerCase() === recipient.toLowerCase(),
      )
    )
      return null;
    return recipient;
  } catch {
    return null;
  }
}

export function houseWithdrawalPreviewMatches(
  quote: unknown,
  recipient: string,
  amount: bigint,
) {
  if (!quote || typeof quote !== "object") return false;
  const preview = quote as Record<string, unknown>;
  return (
    preview.chainId === 137 &&
    preview.recipient === recipient &&
    preview.amountRaw === amount.toString()
  );
}

export function houseReceiptMatchesFinalized(
  receipt: { blockHash: string; status: number | null },
  finalized: { blockHash: string; succeeded: boolean } | null,
): boolean {
  return (
    finalized !== null &&
    receipt.blockHash.toLowerCase() === finalized.blockHash.toLowerCase() &&
    receipt.status === (finalized.succeeded ? 1 : 0)
  );
}
