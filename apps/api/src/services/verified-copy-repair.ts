import { tx, type Pool } from "@hunch/infra";
import {
  observeVerifiedBuySource,
  type VerifiedBuyObserverDependencies,
  type VerifiedBuySourceRow,
} from "./verified-buy-observer.js";
import { isRecord } from "../lib/type-guards.js";
import {
  verifiedBuyFactsSchema,
  type VerifiedBuyFacts,
} from "../schemas/social-trade.js";
import { observationFailureReason } from "./verified-buy.js";
import { copyPurchaseIsTimelySql } from "./copy-purchase-timing.js";
import { readLimitlessCopySubmission } from "./limitless-copy-submission.js";
import {
  storeOrderInTransaction,
  updateOrderFromHistory,
  type StoreOrderInput,
} from "../repos/orders-repo.js";
import type { RetainedLimitlessClobSubmission } from "./limitless-clob-evidence-identity.js";
import {
  inspectLimitlessFreshCollateralHistory,
  LIMITLESS_TRADE_ABSENCE_MIN_AGE_MS,
} from "../funding/reconciliation/limitless-trade-attempt-reconciler.js";
import { createLimitlessHistoryReceiptReader } from "./limitless-collateral-history-proof.js";
import {
  canonicalLimitlessTransactionHash,
  hasLimitlessSettlementSignals,
  isLimitlessFokNegativeCandidate,
  parseLimitlessOrderResult,
} from "./limitless-order-result.js";
import { fetchLimitlessHistoryReceiptLocators } from "../repos/limitless-history-receipt-locators.js";
import {
  readLimitlessObservedLocator,
  appendLimitlessObservedLocatorSql,
  type LimitlessHistoryObservation,
} from "../repos/limitless-observed-locator.js";

/** Only positive, exact, single-settlement FOK proof can materialize a lost
 * local order for fee reconciliation. No provider status or replay alone. */
export function buildRecoveredLimitlessCollateralCopyOrder(input: {
  userId: string;
  clientOrderId: string;
  submission: RetainedLimitlessClobSubmission;
  facts: VerifiedBuyFacts;
}): StoreOrderInput | null {
  const { facts, submission } = input;
  const providerOrderId = facts.canonicalPurchaseKey.match(
    /^limitless:clob:8453:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i,
  )?.[1];
  const hashes = facts.evidenceIds.map((id) =>
    id.match(/^8453:(0x[0-9a-f]{64}):\d+$/i)?.[1]?.toLowerCase(),
  );
  const txHash = hashes[0];
  const purchasedAt = new Date(facts.purchasedAt);
  if (
    !submission.context.collateralFeeModule ||
    submission.order.takerAmount !== "1" ||
    facts.instrument.venue !== "limitless" ||
    facts.instrument.tokenId !== `limitless:${submission.order.tokenId}` ||
    facts.owner.toLowerCase() !== submission.order.maker.toLowerCase() ||
    !providerOrderId ||
    !txHash ||
    hashes.some((hash) => hash !== txHash) ||
    !Number.isFinite(purchasedAt.getTime())
  )
    return null;
  return {
    userId: input.userId,
    walletAddress: submission.order.maker,
    signerAddress: submission.order.signer,
    venue: "limitless",
    venueOrderId: providerOrderId,
    tokenId: facts.instrument.tokenId,
    side: "BUY",
    orderType: "FOK",
    status: "filled",
    price: null,
    size: null,
    errorMessage: null,
    rawError: null,
    orderHash: txHash,
    filledAt: purchasedAt,
    postedAt: purchasedAt,
    lastUpdate: purchasedAt,
    orderPayload: {
      clientOrderId: input.clientOrderId,
      order: submission.order,
    },
    limitlessClobSubmissionContext: submission.context,
    fundingRecoveryMode: "explicit_only",
  };
}

/** A successful external submission can exist without any local order row.
 * Observe that retained exact identity directly; never manufacture/replay a buy.
 */
export async function repairUnrecordedCopies(
  pool: Pool,
  deps: VerifiedBuyObserverDependencies,
  policy: {
    batchSize: number;
    concurrency: number;
    leaseSeconds: number;
    retrySeconds: number;
    recheckSeconds: number;
  },
): Promise<{
  checked: number;
  confirmed: number;
  revoked: number;
  pending: number;
  leaseLost: number;
  budgetExhausted: number;
}> {
  for (const value of Object.values(policy))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Invalid verification policy");
  const counts = {
    checked: 0,
    confirmed: 0,
    revoked: 0,
    pending: 0,
    leaseLost: 0,
    budgetExhausted: 0,
  };
  const seenIds: string[] = [];
  let historyRequestsLeft = 2;
  const readHistoryReceipt = createLimitlessHistoryReceiptReader();
  while (counts.checked < policy.batchSize && counts.budgetExhausted === 0) {
    const rows = await pool.query<{
      id: string;
      copier_user_id: string;
      provider_reference: string;
      instrument: unknown;
      source_snapshot: unknown;
      submission_started_at: Date | null;
      repair_lease_token: string;
    }>(
      `
    with due_copy as (
      select id from copy_attributions where copier_user_id is not null and order_id is null and execution_id is null
        and repair_due_at<=now() and (repair_lease_until is null or repair_lease_until<now())
        and not (id = any($3::uuid[]))
      order by repair_due_at,id limit $1 for update skip locked
    ) update copy_attributions copy_row set repair_lease_token=gen_random_uuid(),repair_lease_until=now()+$2*interval '1 second'
      from due_copy where copy_row.id=due_copy.id
      returning copy_row.id,copy_row.copier_user_id,copy_row.provider_reference,copy_row.instrument,copy_row.source_snapshot,
        copy_row.submission_started_at,copy_row.repair_lease_token
  `,
      [
        Math.min(policy.batchSize - counts.checked, policy.concurrency),
        policy.leaseSeconds,
        seenIds,
      ],
    );
    if (!rows.rows.length) break;
    seenIds.push(...rows.rows.map((row) => row.id));
    await Promise.all(
      rows.rows.map(async (row) => {
        counts.checked++;
        let result: Awaited<ReturnType<typeof observeVerifiedBuySource>> = {
          state: "pending",
          reason: "source_identity_missing",
        };
        let feeOrder: StoreOrderInput | null = null;
        let provenAbsent = false;
        let historyCapacityDeferred = false;
        let priorLocator: Record<string, unknown> | null = null;
        const recoveryEvidence: {
          locator: {
            providerOrderId: string | null;
            txHash: string | null;
            history?: LimitlessHistoryObservation;
          } | null;
        } = { locator: null };
        try {
          const parsed = verifiedBuyFactsSchema.shape.instrument.safeParse(
            row.instrument,
          );
          const snapshot = isRecord(row.source_snapshot)
            ? row.source_snapshot
            : {};
          const submission = isRecord(snapshot.submission)
            ? snapshot.submission
            : {};
          const locator = isRecord(submission.limitlessLocator)
            ? submission.limitlessLocator
            : null;
          priorLocator = locator;
          const retainedLocator = readLimitlessObservedLocator(locator);
          const signer =
            typeof submission.walletAddress === "string"
              ? submission.walletAddress
              : null;
          const owner =
            typeof submission.positionOwner === "string"
              ? submission.positionOwner
              : signer;
          if (parsed.success && signer && owner) {
            const instrument = parsed.data;
            const poly = row.provider_reference.match(
              /^polymarket:137:(0x[0-9a-f]{40}):(0x[0-9a-f]{64})$/i,
            );
            const dflow = row.provider_reference.match(
              /^dflow:mainnet:([^:]+):([^:]+)$/,
            );
            const clob = row.provider_reference.match(
              /^limitless:clob:8453:(.+)$/,
            );
            const amm = row.provider_reference.match(
              /^limitless:amm:8453:(0x[0-9a-f]{64}):(\d+)$/i,
            );
            const limitlessClob = readLimitlessCopySubmission(
              submission.limitlessClob,
              {
                walletAddress: signer,
                tokenId: instrument.tokenId,
              },
            );
            let marketMetadata: unknown = {
              marketAddress: submission.marketAddress,
            };
            let limitlessIdentityAvailable = true;
            if (clob && instrument.venue === "limitless") {
              if (submission.limitlessClob !== undefined) {
                // Invalid retained identity cannot fall back to a different
                // domain. Leave repair pending; never resubmit this buy.
                limitlessIdentityAvailable =
                  limitlessClob !== null &&
                  owner.toLowerCase() === signer.toLowerCase();
              } else {
                // Legacy retained copies predate frozen signing context. Read
                // only the exact market/token/outcome binding, bounded by its
                // indexed identities; provider-supplied exchanges are ignored.
                const market = await pool.query<{
                  metadata: unknown;
                }>(
                  `select market_row.metadata
                  from unified_markets market_row
                  join unified_tokens token_row on token_row.market_id=market_row.id
                    and token_row.token_id=$2 and token_row.side=$3
                  where market_row.id=$1 and market_row.venue='limitless' limit 1`,
                  [instrument.marketId, instrument.tokenId, instrument.outcome],
                );
                const current = market.rows[0];
                // Authorization already froze expiry. Later deadline metadata
                // must not invalidate a completed buy of this same ledger token.
                limitlessIdentityAvailable = !!current;
                marketMetadata = current?.metadata ?? {};
              }
            }
            const source: VerifiedBuySourceRow = {
              id: row.id,
              user_id: row.copier_user_id,
              venue: instrument.venue,
              wallet_address: owner,
              signer_address: signer,
              order_hash:
                poly?.[2] ??
                (clob && typeof locator?.txHash === "string"
                  ? locator.txHash
                  : null),
              order_type: submission.orderType === "FOK" ? "FOK" : null,
              venue_order_id: amm
                ? `amm:${amm[1]}:${instrument.tokenId}`
                : clob && typeof locator?.providerOrderId === "string"
                  ? locator.providerOrderId
                  : null,
              token_id: instrument.tokenId,
              side: "BUY",
              order_payload: {
                assetContext: submission.assetContext,
                marketAddress: submission.marketAddress,
                ...(limitlessClob
                  ? {
                      _hunchLimitlessClob: limitlessClob.context,
                      order: limitlessClob.order,
                      _hunchLimitlessHistoryTxHashes: retainedLocator.hashes,
                    }
                  : {}),
              },
              client_order_id: clob?.[1] ?? null,
              tx_signature: dflow?.[1] ?? null,
              market_id: instrument.marketId,
              outcome: instrument.outcome,
              expiration_time: instrument.expiry
                ? new Date(instrument.expiry)
                : null,
              market_metadata: marketMetadata,
              input_mint:
                instrument.venue === "kalshi"
                  ? deps.solanaCollateralMint
                  : null,
              output_mint:
                instrument.venue === "kalshi"
                  ? instrument.tokenId.replace(/^sol:/, "")
                  : null,
            };
            if (
              (poly && instrument.venue === "polymarket") ||
              ((clob || amm) &&
                instrument.venue === "limitless" &&
                limitlessIdentityAvailable) ||
              (dflow && instrument.venue === "kalshi" && dflow[2] === owner)
            ) {
              const clientOrderId = clob?.[1];
              const postedAt = row.submission_started_at;
              const readStatus = (payload: unknown) => {
                const status = isRecord(payload) ? payload : null;
                const exact =
                  typeof clientOrderId === "string" &&
                  status !== null &&
                  status.clientOrderId === clientOrderId &&
                  (!source.venue_order_id ||
                    status.orderId === source.venue_order_id);
                const parsedStatus = parseLimitlessOrderResult(status);
                const observedProviderOrderId =
                  exact && typeof status?.orderId === "string"
                    ? status.orderId
                    : null;
                return {
                  status,
                  exact,
                  parsedStatus,
                  observedProviderOrderId,
                  observedHash: exact
                    ? canonicalLimitlessTransactionHash(parsedStatus.txHash)
                    : null,
                };
              };
              const exactObservation: {
                result?: ReturnType<typeof readStatus>;
              } = {};
              const verificationDeps =
                clob && limitlessClob?.context.collateralFeeModule
                  ? {
                      ...deps,
                      readLimitlessOrder: async (
                        scope: Parameters<typeof deps.readLimitlessOrder>[0],
                      ) => {
                        const payload = await deps.readLimitlessOrder(scope);
                        const seen = readStatus(payload);
                        exactObservation.result = seen;
                        // The observer can exhaust its receipt budget after
                        // seeing status. Keep the candidate for the lease save.
                        if (
                          submission.orderType === "FOK" &&
                          postedAt instanceof Date &&
                          seen.exact &&
                          seen.status?.status === "found" &&
                          (seen.observedHash ||
                            (seen.observedProviderOrderId &&
                              hasLimitlessSettlementSignals(seen.parsedStatus)))
                        )
                          recoveryEvidence.locator = {
                            providerOrderId: seen.observedProviderOrderId,
                            txHash: seen.observedHash,
                          };
                        return payload;
                      },
                    }
                  : deps;
              result = await observeVerifiedBuySource(
                pool,
                verificationDeps,
                source,
              );
              const ownerId = submission.limitlessProviderOwnerId;
              const {
                status,
                exact,
                parsedStatus,
                observedProviderOrderId,
                observedHash,
              } = exactObservation.result ?? readStatus(null);
              const providerOrderId =
                source.venue_order_id ?? observedProviderOrderId;
              const readHistoryPage = deps.readLimitlessHistoryPage;
              const canReadFresh =
                result.state === "pending" &&
                limitlessClob?.context.collateralFeeModule &&
                submission.orderType === "FOK" &&
                clientOrderId &&
                typeof readHistoryPage === "function" &&
                typeof ownerId === "number" &&
                Number.isSafeInteger(ownerId) &&
                ownerId > 0 &&
                postedAt instanceof Date &&
                Date.now() - postedAt.getTime() >=
                  LIMITLESS_TRADE_ABSENCE_MIN_AGE_MS;
              historyCapacityDeferred =
                Boolean(canReadFresh) && historyRequestsLeft <= 0;
              if (canReadFresh && !historyCapacityDeferred) {
                const knownHashes = [
                  ...new Set(
                    [...retainedLocator.hashes, observedHash].filter(
                      (hash): hash is string => Boolean(hash),
                    ),
                  ),
                ];
                historyRequestsLeft--;
                deps.assertEvidenceBudget?.(1);
                const observed = await inspectLimitlessFreshCollateralHistory({
                  proofInput: {
                    db: pool,
                    readReceipt: readHistoryReceipt,
                    userId: source.user_id,
                    clientOrderId,
                    tokenId: instrument.tokenId,
                    side: "BUY",
                    submission: limitlessClob,
                    extraLocators: knownHashes.map((tx_hash) => ({
                      tx_hash,
                      provider_order_id: providerOrderId,
                    })),
                    observeUnboundLocators:
                      knownHashes.length > 0 && !providerOrderId,
                  },
                  scope: {
                    ownerId,
                    clientOrderId,
                    postedAt,
                    providerOrderId,
                    historyScan: retainedLocator.historyScan,
                    tokenId: instrument.tokenId,
                    side: "BUY",
                    marketSlug:
                      typeof submission.limitlessProviderMarketSlug === "string"
                        ? submission.limitlessProviderMarketSlug
                        : undefined,
                  },
                  readHistoryPage,
                  retain: async (history) => {
                    recoveryEvidence.locator = {
                      providerOrderId: null,
                      txHash: null,
                      ...recoveryEvidence.locator,
                      history,
                    };
                  },
                });
                if (observed.proof) {
                  recoveryEvidence.locator = {
                    ...recoveryEvidence.locator,
                    providerOrderId: observed.proof.providerOrderId,
                    txHash: observed.proof.txHash,
                  };
                  result = await observeVerifiedBuySource(
                    pool,
                    {
                      ...deps,
                      readLimitlessOrder: async () => null,
                    },
                    {
                      ...source,
                      venue_order_id: observed.proof.providerOrderId,
                      order_hash: observed.proof.txHash,
                    },
                    { verifyOnlyKnownLimitlessLocator: true },
                  );
                } else if (
                  observed.absenceClear &&
                  !retainedLocator.overflow &&
                  exact &&
                  status &&
                  (status.status === "not_found" ||
                    (status.status === "found" &&
                      isLimitlessFokNegativeCandidate(parsedStatus))) &&
                  (status.status !== "not_found" ||
                    (!retainedLocator.exactIdentityUnresolved &&
                      (!providerOrderId || knownHashes.length > 0)))
                ) {
                  provenAbsent =
                    (
                      await fetchLimitlessHistoryReceiptLocators(pool, {
                        userId: source.user_id,
                        walletAddress: signer,
                        tokenId: instrument.tokenId,
                        side: "BUY",
                        clientOrderId,
                        providerOrderId,
                      })
                    ).length === 0;
                }
              }
              if (
                result.state === "verified" &&
                JSON.stringify(result.facts.instrument) !==
                  JSON.stringify(instrument)
              )
                result = {
                  state: "pending",
                  reason: "source_instrument_mismatch",
                };
            }
            if (
              result.state === "verified" &&
              clob?.[1] &&
              limitlessClob &&
              submission.orderType === "FOK"
            ) {
              feeOrder = buildRecoveredLimitlessCollateralCopyOrder({
                userId: row.copier_user_id,
                clientOrderId: clob[1],
                submission: limitlessClob,
                facts: result.facts,
              });
            }
          }
        } catch (error) {
          result = {
            state: "pending",
            reason: observationFailureReason(error),
          };
        }
        const budgetExhausted =
          result.state === "pending" &&
          result.reason.startsWith("evidence_budget_exhausted:");
        if (budgetExhausted) counts.budgetExhausted++;
        const state = provenAbsent
          ? "failed"
          : result.state === "verified"
            ? "confirmed"
            : result.state;
        const timelyPurchase = copyPurchaseIsTimelySql(
          "($6::jsonb->>'purchasedAt')::timestamptz",
          "created_at",
        );
        const save = (
          db: Pick<Pool, "query">,
          recoveredOrderId: string | null = null,
        ) =>
          db.query<{ state: string }>(
            `update copy_attributions
      set state=case when $3='pending' then state
            when $3='confirmed' then case when ${timelyPurchase} then 'confirmed' else 'revoked' end else $3 end,
          canonical_purchase_key=case when $3='confirmed' then $4 else canonical_purchase_key end,
          facts_revision=case when $3='confirmed' then $5 else facts_revision end,
          execution_facts=case when $3='confirmed' then $6::jsonb else execution_facts end,
          confirmed_at=case when $3='confirmed' and ${timelyPurchase} then coalesce(confirmed_at,now()) else confirmed_at end,
          order_id=coalesce($9::uuid,order_id),
          source_snapshot=case when $10::jsonb is not null
            then jsonb_set(source_snapshot,'{submission,limitlessLocator}',
              ${appendLimitlessObservedLocatorSql("source_snapshot #> '{submission,limitlessLocator}'", "($10::jsonb->>'providerOrderId')", "($10::jsonb->>'txHash')", "($10::jsonb->'history')")})
            else source_snapshot end,
          repair_due_at=case when $12::boolean then repair_due_at else now()+$7*interval '1 second' end,
          repair_lease_token=null,repair_lease_until=null,updated_at=now()
      where id=$1 and repair_lease_token=$2 and repair_lease_until>clock_timestamp()
        and copier_user_id=$8 and order_id is null and execution_id is null
        and ($3<>'failed' or (source_snapshot #> '{submission,limitlessLocator}') is not distinct from $11::jsonb)
      returning state`,
            [
              row.id,
              row.repair_lease_token,
              state,
              result.state === "verified"
                ? result.facts.canonicalPurchaseKey
                : null,
              result.state === "verified"
                ? result.facts.evidenceRevision
                : null,
              result.state === "verified" ? JSON.stringify(result.facts) : null,
              result.state === "verified"
                ? policy.recheckSeconds
                : policy.retrySeconds,
              row.copier_user_id,
              recoveredOrderId,
              recoveryEvidence.locator
                ? JSON.stringify(recoveryEvidence.locator)
                : null,
              priorLocator ? JSON.stringify(priorLocator) : null,
              historyCapacityDeferred,
            ],
          );
        const recovered = feeOrder;
        const saved = recovered
          ? await tx(pool, async (client) => {
              // Use the same user-first lock order as Copy claim and erasure.
              const account = await client.query(
                `select id from users where id=$1 and is_active for update`,
                [row.copier_user_id],
              );
              if (!account.rowCount) return null;
              const lease = await client.query(
                `select id from copy_attributions
            where id=$1 and copier_user_id=$2 and repair_lease_token=$3
              and repair_lease_until>now() and order_id is null and execution_id is null for update`,
                [row.id, row.copier_user_id, row.repair_lease_token],
              );
              if (!lease.rowCount) return null;
              const stored = await storeOrderInTransaction(client, recovered);
              if (stored.kind === "exists")
                await updateOrderFromHistory(client, {
                  id: stored.order.id,
                  status: "filled",
                  price: null,
                  size: null,
                  filledAt: recovered.filledAt ?? null,
                  lastUpdate: recovered.lastUpdate ?? null,
                  orderHash: recovered.orderHash ?? null,
                });
              const saved = await save(client, stored.order.id);
              if (!saved.rowCount) throw new Error("Copy repair lease expired");
              return saved;
            }).catch(() => save(pool))
          : await save(pool);
        if (saved?.rows.length)
          counts[
            state === "failed" ||
            (state === "confirmed" && saved.rows[0]?.state === "revoked")
              ? "revoked"
              : state
          ]++;
        else counts.leaseLost++;
      }),
    );
  }
  return counts;
}
