import { createHash } from "node:crypto";
import { ethers } from "ethers";
import { tx, type Pool } from "@hunch/infra";
import type { PolymarketAssetContext } from "@hunch/shared";
import { env } from "../env.js";
import { costBasisForShares, priceExit } from "./house-trader-policy.js";
import {
  account,
  enqueue,
  finish,
  hasHouseExitInFlight,
  pollSignals,
  recordHouseWorker,
  type Account,
  type Action,
} from "./house-trader-store.js";
import { HouseWallet } from "./house-trader-wallet.js";
import {
  houseMarkKey,
  houseValuationContext,
  loadHousePositionMarks,
  summarizeHouseValuations,
  valueHousePosition,
  type HousePositionValuation,
} from "./house-trader-valuation.js";
import {
  doTrade,
  evidenceFor,
  observeTrade,
  contextFor,
  sellNet,
  sellQuote,
  indicativeSellQuote,
  trackedShares,
  repairHouseFillHistory,
} from "./house-trader-orders.js";
import {
  doWithdrawal,
  observeRedeem,
  setupHouse,
  submitRedeem,
} from "./house-trader-movements.js";
import { buildPolymarketRedemptionPlan } from "./polymarket-redemption-plan.js";
import { venueLifecycleAllowsTradingAction } from "./venue-lifecycle.js";
import { PolymarketQuoteError } from "./polymarket-quote.js";
import { EvidenceBudgetExhausted } from "./verified-buy.js";

const safePreflightReasons = new Set([
  "strategy_changed_or_paused",
  "venue_disabled",
  "signal_or_instrument_inactive",
  "signal_expired",
  "market_outside_close_window",
  "category_filtered",
  "position_open",
  "instrument_missing",
  "instrument_changed",
  "instrument_generation_changed",
  "position_binding_changed",
  "manual_confirmation_expired",
]);
const safeQuoteReasons = new Set([
  "stale_orderbook",
  "missing_top_of_book",
  "no_liquidity",
  "fee_unavailable",
  "market_not_accepting_orders",
  "invalid_orderbook",
  "amount_too_small",
]);

async function redemption(
  pool: Pool,
  wallet: HouseWallet,
  a: Account,
  job: Action,
) {
  const instrument = job.request.assetContext as PolymarketAssetContext;
  const funder = a.deposit_wallet;
  if (
    !funder ||
    !job.token_id ||
    !job.outcome ||
    !instrument ||
    instrument.marketId !== job.market_id ||
    instrument.assetId !== job.token_id ||
    !(await venueLifecycleAllowsTradingAction(pool, "polymarket", "REDEEM"))
  )
    return finish(pool, job, "skipped", "redeem_unavailable");
  const size = await wallet.position(
    funder,
    instrument.positionContract,
    instrument.assetId,
  );
  if (size <= 0n) return finish(pool, job, "skipped", "nothing_to_redeem");
  if (
    typeof job.request.positionId !== "string" ||
    size !==
      (await trackedShares(
        pool,
        a.user_id,
        job.request.positionId,
        instrument.assetId,
      ))
  )
    return finish(pool, job, "skipped", "redeem_position_balance_differs");
  const plan = await buildPolymarketRedemptionPlan({
    assetContext: instrument,
    positionSize: ethers.formatUnits(size, 6),
    rpcUrl: env.polygonRpcUrl,
    timeoutMs: env.polygonRpcTimeoutMs,
    funder,
    conditionalTokensAddress: env.polymarketConditionalTokensAddress,
    collateralTokenAddress: wallet.collateral,
    legacyCollateralTokenAddress: env.polymarketUsdceAddress,
    negRiskAdapterAddress: env.polymarketNegRiskAdapterAddress ?? null,
    ctfCollateralAdapterAddress:
      env.polymarketCtfCollateralAdapterAddress ?? null,
    negRiskCollateralAdapterAddress:
      env.polymarketNegRiskCollateralAdapterAddress ?? null,
    executionKind: "external_adapter",
    outcome: job.outcome,
    positionTokenId: instrument.assetId,
    conditionId: instrument.conditionId,
    isNegRisk: instrument.negRisk,
  });
  if (plan.reason === "resolved_zero_payout") {
    return tx(pool, async (db) => {
      const {
        rows: [currentRedeem],
      } = await db.query<Action>(
        "select * from house_trader_actions where id=$1 for update",
        [job.id],
      );
      if (
        currentRedeem.state !== "working" ||
        currentRedeem.claim_token !== job.claim_token
      )
        return;
      await finish(db, job, "done", "resolved_zero_payout", {
        cashDeltaRaw: "0",
        fillSharesRaw: size.toString(),
      });
      await db.query(
        `update house_trader_actions set state='done',reason='resolved_zero_payout',updated_at=now()
          where id=$1 and account_user_id=$2 and kind='buy' and state='filled'`,
        [job.request.positionId, a.user_id],
      );
    });
  }
  if (!plan.redeemable || !plan.targetAddress || !plan.data)
    return finish(pool, job, "skipped", "position_not_redeemable");
  if (
    instrument.protocolVersion === "v1" &&
    BigInt(
      (job.outcome === "YES" ? plan.noBalanceRaw : plan.yesBalanceRaw) ?? "0",
    ) > 0n
  )
    return finish(pool, job, "skipped", "redeem_has_untracked_sibling_balance");
  const expected = plan.expectedPayoutRaw ?? plan.payoutAmountRaw;
  if (expected == null)
    return finish(pool, job, "skipped", "redeem_payout_unknown");
  return submitRedeem(
    pool,
    wallet,
    a,
    job,
    { target: plan.targetAddress, value: "0", data: plan.data },
    size.toString(),
    expected,
  );
}

async function managePositions(pool: Pool, wallet: HouseWallet, a: Account) {
  if (!a.deposit_wallet) return;
  const positions = (
    await pool.query<Action>(
      `select * from house_trader_actions where account_user_id=$1 and kind='buy' and state='filled'
       and ($2::uuid is null or id>$2) order by id limit 20`,
      [a.user_id, a.position_cursor],
    )
  ).rows;
  const assets = new Map(
    positions.flatMap((position) => {
      const asset = houseValuationContext(position);
      return asset ? [[position.id, asset] as const] : [];
    }),
  );
  // Read only the existing 20-position page from local marks. A pricing
  // failure must not stop balance reconciliation, exits, or redemption.
  const marks = await loadHousePositionMarks(pool, [...assets.values()]).catch(
    () => null,
  );
  const prior = Array.isArray(a.snapshot?.positions)
    ? a.snapshot.positions.filter(
        (p): p is { id: string } => typeof p?.id === "string",
      )
    : [];
  const shown = new Map<
    string,
    Record<string, unknown> & {
      balanceUnavailable?: boolean;
      valuation?: HousePositionValuation | null;
    }
  >(prior.map((p) => [p.id, p]));
  for (const pos of positions) {
    if (
      !pos.market_id ||
      !pos.event_id ||
      !pos.token_id ||
      !pos.outcome ||
      !pos.result.assetContext
    )
      continue;
    const instrument = pos.result.assetContext as PolymarketAssetContext;
    let positionRefreshed = false;
    try {
      const observed = await wallet.position(
        a.deposit_wallet,
        instrument.positionContract,
        pos.token_id,
      );
      const balanceCheckedAt = Date.now();
      const tracked = await trackedShares(
        pool,
        a.user_id,
        pos.id,
        pos.token_id,
      );
      const available = observed < tracked ? observed : tracked;
      if (available <= 0n) {
        // Zero just after a CLOB fill can still mean settlement is pending.
        // Require an observed nonzero balance or confirmed debit evidence.
        if (tracked === 0n) {
          shown.delete(pos.id);
          await finish(pool, pos, "done", "position_closed");
        } else {
          const old = shown.get(pos.id);
          if (old) shown.set(pos.id, { ...old, balanceUnavailable: true });
        }
        continue;
      }
      if (pos.result.seenBalance !== true)
        await finish(pool, pos, "filled", null, { seenBalance: true });
      const {
        rows: [market],
      } = await pool.query<{
        title: string;
        status: string;
        resolved_outcome: string | null;
      }>(
        "select title,status,resolved_outcome from unified_markets where id=$1",
        [pos.market_id],
      );
      const purchased = Number(pos.result.fillSize);
      const fillPrice = Number(pos.result.fillPrice);
      const fullCost = costBasisForShares(
        -BigInt(String(pos.result.cashDeltaRaw)),
        BigInt(String(pos.result.fillSharesRaw)),
        available,
      );
      const asset = assets.get(pos.id);
      const positionValue = {
        id: pos.id,
        market: pos.market_id,
        title: market?.title ?? pos.market_id,
        side: pos.outcome,
        sharesRaw: available.toString(),
        fillPrice: pos.result.fillPrice,
        marketStatus: market?.status ?? null,
        checkedAt: new Date(balanceCheckedAt).toISOString(),
        balanceUnavailable: false,
        costRaw: fullCost?.toString() ?? null,
        valuation:
          asset && available === tracked
            ? valueHousePosition({
                asset,
                mark: marks?.get(houseMarkKey(asset)),
                shares: available,
                cost: fullCost,
                balanceCheckedAt,
                now: Date.now(),
              })
            : null,
      };
      shown.set(pos.id, positionValue);
      positionRefreshed = true;
      const base = {
        market: pos.market_id,
        event: pos.event_id,
        token: pos.token_id,
        outcome: pos.outcome,
      };
      if (
        market?.status?.toUpperCase() === "SETTLED" ||
        market?.resolved_outcome
      ) {
        await tx(pool, async (db) => {
          const current = await account(db, true);
          if (
            !current ||
            (await hasHouseExitInFlight(db, a.user_id, pos.id, true))
          )
            return;
          await enqueue(db, current, {
            ...base,
            kind: "redeem",
            key: `redeem:${pos.id}:${Math.floor(Date.now() / 300_000)}`,
            request: { assetContext: instrument, positionId: pos.id },
          });
        });
        continue;
      }
      const policy = a.settings;
      if (
        market?.status !== "ACTIVE" ||
        !a.active ||
        !policy ||
        (policy.takeProfitBps === null &&
          policy.stopLossBps === null &&
          !policy.aiExit)
      )
        continue;
      if (await hasHouseExitInFlight(pool, a.user_id, pos.id, true)) continue;
      if (
        !Number.isFinite(purchased) ||
        purchased <= 0 ||
        !Number.isFinite(fillPrice) ||
        fillPrice <= 0
      )
        continue;
      const { context } = await contextFor(pool, pos);
      const quote = indicativeSellQuote(
        context,
        pos.token_id,
        available,
        policy,
      );
      const net = sellNet(quote);
      // Use the canonical pUSD debit, including any charges present in the
      // fill receipt; the quote was a spending limit, not a fill.
      const purchasedRaw = BigInt(String(pos.result.fillSharesRaw));
      const paid = -BigInt(String(pos.result.cashDeltaRaw));
      if (paid <= 0n || purchasedRaw <= 0n || available > purchasedRaw)
        continue;
      if (net <= 0n || BigInt(quote.makerAmount) > available) continue;
      const cost = costBasisForShares(
        paid,
        purchasedRaw,
        BigInt(quote.makerAmount),
      );
      const priceCause = cost === null ? null : priceExit(net, cost, policy);
      if (priceCause) {
        sellQuote(context, pos.token_id, available, policy);
        await tx(pool, async (db) => {
          const current = await account(db, true);
          if (
            !current?.active ||
            current.revision !== a.revision ||
            (await hasHouseExitInFlight(db, a.user_id, pos.id, true))
          )
            return;
          await enqueue(db, current, {
            ...base,
            kind: "sell",
            key: `exit-price:${pos.id}:${available}:${Math.floor(Date.now() / 60_000)}`,
            request: {
              automatic: true,
              positionId: pos.id,
              assetContext: instrument,
              trigger: "price",
            },
          });
        });
      } else if (policy.aiExit) {
        const published = await evidenceFor(pool, pos.market_id, pos.event_id);
        const fingerprint = createHash("sha256")
          .update(JSON.stringify(published))
          .digest("hex");
        const priceBps = Number((net * 10_000n) / available);
        await tx(pool, async (db) => {
          const current = await account(db, true);
          if (
            !current?.active ||
            current.revision !== a.revision ||
            (await hasHouseExitInFlight(db, a.user_id, pos.id, true))
          )
            return;
          const data = (
            await db.query<Action>(
              "select * from house_trader_actions where id=$1",
              [pos.id],
            )
          ).rows[0];
          const old = data.result.lastExitReview as
            | {
                hash: string;
                price: number;
                sequence: number;
                revision?: number;
              }
            | undefined;
          if (
            old?.revision === current.revision &&
            old.hash === fingerprint &&
            Math.abs(old.price - priceBps) < policy.aiPriceChangeBps
          ) {
            return;
          }
          const sequence = (old?.sequence ?? 0) + 1;
          const job = await enqueue(db, current, {
            ...base,
            kind: "sell",
            key: `exit-ai:${pos.id}:${sequence}`,
            request: {
              automatic: true,
              positionId: pos.id,
              assetContext: instrument,
              trigger: "ai",
            },
          });
          if (job)
            await finish(db, data, "filled", null, {
              lastExitReview: {
                hash: fingerprint,
                price: priceBps,
                sequence,
                revision: current.revision,
              },
            });
        });
      }
    } catch {
      /* A missing book or RPC response is not a liquidation signal. */
      const old = shown.get(pos.id);
      if (!positionRefreshed && old)
        shown.set(pos.id, { ...old, balanceUnavailable: true });
    }
  }
  const balance = await wallet.balance(a.deposit_wallet);
  const controllerBalance = await wallet.balance(wallet.key.address);
  const {
    rows: [totals],
  } = await pool.query(
    `with actions as materialized (
       select * from house_trader_actions where account_user_id=$1
     ), exits as (
       select request->>'positionId' as position_id,
         sum((result->>'cashDeltaRaw')::numeric) as proceeds,
         sum((result->>'fillSharesRaw')::numeric) as shares
       from actions where kind in ('sell','redeem') and state='done'
         and result ? 'cashDeltaRaw' and result ? 'fillSharesRaw'
       group by request->>'positionId'
     ), pnl as (
       select count(*) as covered, sum(exits.proceeds + trunc(
         (entry.result->>'cashDeltaRaw')::numeric * exits.shares /
         nullif((entry.result->>'fillSharesRaw')::numeric,0))) as realized
       from exits join actions entry on entry.id::text=exits.position_id and entry.kind='buy'
       where exits.shares <= (entry.result->>'fillSharesRaw')::numeric and entry.result ? 'cashDeltaRaw'
     )
     select (select case when covered>0 then (realized/1000000)::numeric(24,6)::text end from pnl) as "pnlUsd",
       coalesce(sum(budget_raw) filter(where kind='buy' and state in ('submitting','submitted','filled')),0)::text as "reservedRaw",
       coalesce(sum((result->>'aiChargedRaw')::bigint),0)::text as "aiChargedRaw",
       coalesce(sum((result->>'aiReservedRaw')::bigint) filter(where not result ? 'aiChargedRaw'),0)::text as "aiUnconfirmedRaw"
       from actions`,
    [a.user_id],
  );
  const tracked = (
    await pool.query<{ id: string }>(
      `select id from house_trader_actions
      where account_user_id=$1 and kind='buy' and state='filled'`,
      [a.user_id],
    )
  ).rows;
  const openIds = tracked.map((p) => p.id);
  const trackedIds = new Set(openIds);
  const snapshotAt = Date.now();
  await pool.query(
    "update house_trader_account set snapshot=$1,position_cursor=$2 where singleton",
    [
      {
        asOf: new Date(snapshotAt).toISOString(),
        pusdRaw: balance.toString(),
        collateral: wallet.collateral,
        chainId: 137,
        controllerPusdRaw: controllerBalance.toString(),
        positions: [...shown]
          .filter(([id]) => trackedIds.has(id))
          .map(([, value]) => value),
        positionsAwaitingBalance: tracked.reduce(
          (count, position) => count + Number(!shown.has(position.id)),
          0,
        ),
        valuation: summarizeHouseValuations(openIds, shown, snapshotAt),
        ...totals,
      },
      positions.length === 20 ? positions.at(-1)?.id : null,
    ],
  );
}

export async function houseTick(pool: Pool, wallet: HouseWallet) {
  const lease = await pool.connect();
  let locked = false;
  let userId: string | undefined;
  let stage = "account";
  try {
    locked = (
      await lease.query("select pg_try_advisory_lock(1363429702) as locked")
    ).rows[0].locked;
    if (!locked) return;
    const a = await account(pool);
    if (!a) return;
    userId = a.user_id;
    const startedAt = new Date().toISOString();
    if (a.controller && a.controller !== wallet.key.address) {
      await recordHouseWorker(pool, userId, {
        startedAt,
        status: "failed",
        failedAt: startedAt,
        failureStage: "controller_mismatch",
      });
      return;
    }
    await recordHouseWorker(pool, userId, { startedAt, status: "running" });
    stage = "credentials";
    let clobReady: boolean | null = null;
    if (a.deposit_wallet) {
      // Normal wallet-owned CLOB credential repair only. If the provider is
      // down, order observers stay pending; cash-out and redemption can run.
      clobReady = await wallet.connect(a, a.deposit_wallet).then(
        () => true,
        () => false,
      );
    }
    stage = "reconciliation";
    // A restart before the send boundary can safely resume. Beyond the boundary
    // never run the original command again, only its observation path.
    await pool.query(
      "update house_trader_actions set state='queued',claim_token=null where account_user_id=$1 and state='working' and reference is null",
      [a.user_id],
    );
    const pending = (
      await pool.query<Action>(
        `select * from house_trader_actions where account_user_id=$1
      and state in ('submitting','submitted') order by updated_at,id limit 20`,
        [a.user_id],
      )
    ).rows;
    let observed = 0;
    let observationErrors = 0;
    const evidenceBudget = { remaining: 36, receiptsRemaining: 36 };
    for (const job of pending) {
      const trade = job.kind === "buy" || job.kind === "sell";
      if (trade && evidenceBudget.remaining <= 0) continue;
      await pool.query(
        "update house_trader_actions set updated_at=now() where id=$1",
        [job.id],
      );
      observed++;
      try {
        if (job.kind === "setup") await setupHouse(pool, wallet, a, job);
        else if (job.kind === "withdraw")
          await doWithdrawal(pool, wallet, a, job);
        else if (job.kind === "redeem")
          await observeRedeem(pool, wallet, a, job);
        else await observeTrade(pool, a, job, evidenceBudget);
      } catch (error) {
        if (!(error instanceof EvidenceBudgetExhausted)) observationErrors++;
        // Preserve reference and reserve on an uncertain or deferred result.
        await finish(
          pool,
          job,
          "submitted",
          error instanceof EvidenceBudgetExhausted
            ? error.required > 32
              ? "fill_evidence_limit_review"
              : "fill_evidence_budget_deferred"
            : (job.reason ?? "reconciliation_dependency_unavailable"),
        );
      }
    }
    stage = "signals";
    const signals = await pollSignals(pool);
    stage = "actions";
    const jobs = (
      await pool.query<Action>(
        `select queued.* from house_trader_actions queued where queued.account_user_id=$1 and queued.state='queued'
       and not exists (
         select 1 from house_trader_actions pending_row
         where pending_row.account_user_id=queued.account_user_id
           and pending_row.state in ('submitting','submitted')
           and (pending_row.kind='setup' or (pending_row.kind='withdraw'
              and (queued.kind='withdraw' or coalesce(pending_row.result->>'phase','')<>'sweep')) or
              (queued.kind='withdraw' and pending_row.kind='redeem') or
              (queued.kind='redeem' and pending_row.kind='redeem') or pending_row.token_id=queued.token_id)
       )
       order by case when queued.kind='buy' then 1 else 0 end, queued.created_at,queued.id limit 6`,
        [a.user_id],
      )
    ).rows;
    for (const job of jobs) {
      const fresh = await account(pool);
      if (!fresh) break;
      if (
        job.request.automatic === true &&
        (!fresh.active || fresh.revision !== job.revision)
      ) {
        await finish(pool, job, "skipped", "strategy_changed_or_paused");
        continue;
      }
      const blocked = await pool.query(
        `select 1 from house_trader_actions where account_user_id=$1
        and state in ('submitting','submitted') and
        (kind='setup' or (kind='withdraw' and ($2='withdraw' or coalesce(result->>'phase','')<>'sweep')) or
          (kind='redeem' and $2 in ('withdraw','redeem')) or token_id=$3) limit 1`,
        [a.user_id, job.kind, job.token_id],
      );
      if (blocked.rows.length) {
        if (job.kind === "buy")
          await finish(pool, job, "skipped", "outstanding_submission");
        continue;
      }
      const {
        rows: [claim],
      } = await pool.query<Action>(
        `update house_trader_actions set state='working',claim_token=gen_random_uuid(),reason=null,updated_at=now()
          where id=$1 and state='queued' and reference is null returning *`,
        [job.id],
      );
      if (!claim) continue;
      try {
        if (job.kind === "setup") await setupHouse(pool, wallet, fresh, claim);
        else if (job.kind === "withdraw")
          await doWithdrawal(pool, wallet, fresh, claim);
        else if (job.kind === "redeem")
          await redemption(pool, wallet, fresh, claim);
        else await doTrade(pool, wallet, fresh, claim);
      } catch (error) {
        const current = (
          await pool.query<Action>(
            "select * from house_trader_actions where id=$1",
            [job.id],
          )
        ).rows[0];
        if (current.claim_token !== claim.claim_token) continue;
        if (current.state === "working" && claim.kind === "setup")
          await finish(pool, claim, "queued", "setup_retry");
        else if (current.state === "working")
          await finish(
            pool,
            claim,
            "skipped",
            error instanceof PolymarketQuoteError &&
              safeQuoteReasons.has(error.reason)
              ? error.reason
              : error instanceof Error &&
                  safePreflightReasons.has(error.message)
                ? error.message
                : "preflight_unavailable",
          );
        else if (current.state === "submitting")
          await finish(
            pool,
            claim,
            "submitted",
            "submission_requires_reconciliation",
          );
      }
    }
    const fresh = await account(pool);
    stage = "portfolio";
    if (fresh?.deposit_wallet) await managePositions(pool, wallet, fresh);
    stage = "fill_history";
    const historyReady =
      !fresh ||
      (await repairHouseFillHistory(pool, fresh).then(
        () => true,
        () => false,
      ));
    stage = "checkpoint";
    await recordHouseWorker(pool, userId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      clobReady,
      signals,
      observed,
      pendingExamined: pending.length,
      observationErrors,
      fillHistoryCheckAvailable: historyReady,
    });
  } catch (error) {
    if (locked && userId)
      await recordHouseWorker(pool, userId, {
        status: "failed",
        failedAt: new Date().toISOString(),
        failureStage: stage,
      }).catch(() => {});
    throw error;
  } finally {
    let discard = false;
    if (locked) {
      try {
        await lease.query("select pg_advisory_unlock(1363429702)");
      } catch {
        discard = true;
      }
    }
    lease.release(discard);
  }
}
