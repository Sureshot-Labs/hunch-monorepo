import { ethers } from "ethers";
import type { Pool } from "@hunch/infra";
import {
  boundary,
  finish,
  type Account,
  type Action,
} from "./house-trader-store.js";
import {
  houseDepositSetupRetry,
  houseTraderAmount,
  usdRaw,
} from "./house-trader-policy.js";
import { exactTransfer, type HouseWallet } from "./house-trader-wallet.js";
import { houseApprovalBatchSettled } from "./house-trader-approvals.js";
import {
  houseReceiptMatchesFinalized,
  houseSweepBoundarySql,
  houseSweepRevertedSql,
  houseWithdrawalRecipient,
  houseWithdrawalPreviewMatches,
} from "./house-trader-withdrawal.js";
import { fetchEmbeddedEthereumTransactionReceipt } from "./embedded-ethereum.js";
import { collateralNet, positionNet } from "./house-trader-receipts.js";
import { POLYMARKET_DEPOSIT_WALLET_FACTORY } from "./polymarket-deposit-wallet-derivation.js";
import type { PolymarketAssetContext } from "@hunch/shared";
import {
  fetchPolymarketRelayerTransaction,
  polymarketRelayerTransactionHash,
  POLYMARKET_RELAYER_FAILED_STATES,
  type DepositWalletCall,
} from "./polymarket-deposit-wallet-relayer.js";

async function setController(pool: Pool, a: Account, wallet: HouseWallet) {
  if (a.controller && a.controller !== wallet.key.address)
    throw new Error("wallet_key_changed");
  if (a.controller) return;
  // The global wallet uniqueness constraint prevents binding anyone else's wallet.
  await pool.query(
    `insert into user_wallets(user_id,wallet_address,wallet_type,is_verified,is_primary)
       values($1,$2,'ethereum',true,true) on conflict do nothing`,
    [a.user_id, wallet.key.address.toLowerCase()],
  );
  const { rows } = await pool.query(
    "select user_id from user_wallets where lower(wallet_address)=lower($1) and wallet_type='ethereum'",
    [wallet.key.address],
  );
  if (rows.length !== 1 || rows[0].user_id !== a.user_id)
    throw new Error("wallet_already_linked");
  await pool.query(
    "update house_trader_account set controller=$1 where singleton and controller is null",
    [wallet.key.address],
  );
}

async function submitBatch(
  pool: Pool,
  wallet: HouseWallet,
  a: Account,
  job: Action,
  calls: DepositWalletCall[],
  phase: string,
  extra: Record<string, unknown> = {},
) {
  if (!a.deposit_wallet) throw new Error("wallet_not_ready");
  const searchFrom =
    phase === "handoff" || phase === "redeem"
      ? await wallet.provider.getBlockNumber()
      : null;
  const response = await wallet.submitBatch(
    a.deposit_wallet,
    calls,
    async (nonce, deadline) => {
      await boundary(pool, job, `batch:${nonce}:${deadline}`, {
        phase,
        ...(searchFrom === null ? {} : { searchFrom }),
        ...extra,
      });
    },
  );
  await finish(pool, job, "submitted", null, {
    relayerId: response.transactionID ?? null,
    transactionHash: /^0x[0-9a-f]{64}$/i.test(response.transactionHash ?? "")
      ? response.transactionHash
      : null,
  });
}

export async function setupHouse(
  pool: Pool,
  wallet: HouseWallet,
  a: Account,
  job: Action,
) {
  await setController(pool, a, wallet);
  const dw = await wallet.inspect();
  if (!dw.deployed) {
    const tries =
      typeof job.result.deployTries === "number" ? job.result.deployTries : 0;
    if (job.state !== "working") {
      if (job.result.phase !== "deploy") return;
      const observed =
        typeof job.result.relayerId === "string"
          ? await fetchPolymarketRelayerTransaction(
              job.result.relayerId,
              (url, init) =>
                fetch(url, { ...init, signal: AbortSignal.timeout(12_000) }),
            ).catch(() => null)
          : null;
      const failed = POLYMARKET_RELAYER_FAILED_STATES.has(
        observed?.state ?? "",
      );
      const at = Date.parse(String(job.result.deploySentAt));
      // Repeating factory CREATE for one deterministic address cannot move
      // value. Never apply this restart rule to approvals or transfers.
      const decision = houseDepositSetupRetry({
        failed,
        hasRelayerObservation: Boolean(observed),
        elapsedMs: Date.now() - at,
        attempts: tries,
      });
      if (decision === "wait") return;
      if (decision === "review")
        return finish(pool, job, "review", "wallet_creation_retry_required");
      await pool.query(
        `update house_trader_actions set state='queued',claim_token=null,reference=null,
          result=result - 'relayerId',reason='wallet_creation_retry',updated_at=now()
          where id=$1 and claim_token=$2::uuid and reference=$3 and result->>'phase'='deploy'
            and state in ('submitting','submitted')`,
        [job.id, job.claim_token, job.reference],
      );
      return;
    }
    await boundary(pool, job, `deploy:${dw.address}`, {
      phase: "deploy",
      deployTries: tries + 1,
      deploySentAt: new Date().toISOString(),
    });
    const response = await wallet.deploy();
    return finish(pool, job, "submitted", null, {
      relayerId: response.transactionID ?? null,
    });
  }
  if (a.deposit_wallet && a.deposit_wallet !== dw.address)
    throw new Error("deposit_wallet_changed");
  const finalized = await wallet.provider.getBlock("finalized");
  if (
    !finalized ||
    (await wallet.provider.getCode(dw.address, finalized.number)) === "0x"
  ) {
    // Keep an observed CREATE pending until it is safe to publish the address.
    return;
  }
  await wallet.verifyDepositOwner(dw.address, finalized.number);
  await wallet.connect(a, dw.address);
  const missingAtFinality = await wallet.approvals(
    dw.address,
    finalized.number,
  );
  const approvals = missingAtFinality.length
    ? await wallet.approvals(dw.address)
    : [];
  // An approval seen at latest but not yet finalized must not be sent twice.
  if (missingAtFinality.length && !approvals.length) return;
  if (approvals.length) {
    const tries =
      typeof job.result.approvalTries === "number"
        ? job.result.approvalTries
        : 0;
    if (job.state === "working")
      return submitBatch(
        pool,
        wallet,
        { ...a, deposit_wallet: dw.address },
        job,
        approvals,
        "approvals",
        { approvalTries: tries + 1, relayerDiagnostic: null },
      );
    // A deployed wallet proves deployment; the next distinct action can start.
    if (job.result.phase === "deploy")
      return pool
        .query(
          `update house_trader_actions set state='queued',claim_token=null,reference=null,result='{}',updated_at=now()
            where id=$1 and reference=$2 and claim_token=$3::uuid and result->>'phase'='deploy'
              and state in ('submitting','submitted')`,
          [job.id, job.reference, job.claim_token],
        )
        .then(() => undefined);
    const observation = await batchReceipt(wallet, job);
    const finalizedNonce =
      job.result.phase === "approvals" &&
      observation?.status === 1 &&
      observation.blockNumber <= finalized.number
        ? await wallet.batchNonceAt(dw.address, finalized.number)
        : null;
    if (
      houseApprovalBatchSettled(
        observation,
        finalized.number,
        job.reference,
        finalizedNonce,
      ) ||
      (await wallet.expiredUnspentBatch(dw.address, job.reference))
    ) {
      if (tries >= 3)
        return finish(pool, job, "review", "wallet_approvals_retry_required");
      return pool
        .query(
          `update house_trader_actions set state='queued',claim_token=null,reference=null,
            result=result - 'relayerId' - 'transactionHash',
        reason='approval_not_executed',updated_at=now() where id=$1 and reference=$2
          and claim_token=$3::uuid and state in ('submitting','submitted')`,
          [job.id, job.reference, job.claim_token],
        )
        .then(() => undefined);
    }
    return;
  }
  await pool.query(
    "update house_trader_account set deposit_wallet=$1 where singleton",
    [dw.address],
  );
  await finish(pool, job, "done", null);
}

async function batchReceipt(wallet: HouseWallet, job: Action) {
  let hash =
    typeof job.result.transactionHash === "string"
      ? job.result.transactionHash
      : null;
  if (!hash && typeof job.result.relayerId === "string") {
    const id = job.result.relayerId;
    const result = await fetchPolymarketRelayerTransaction(id, (url, init) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(12_000) }),
    ).catch(() => null);
    hash = polymarketRelayerTransactionHash(id, result);
  }
  if (!hash) return null;
  const finalized = await fetchEmbeddedEthereumTransactionReceipt({
    chainId: 137,
    txHash: hash,
    requireFinalized: true,
  }).catch(() => null);
  if (!finalized) return null;
  const receipt = await wallet.provider
    .getTransactionReceipt(hash)
    .catch(() => null);
  return receipt && houseReceiptMatchesFinalized(receipt, finalized)
    ? receipt
    : null;
}

async function recoverDepositBatchReceipt(
  wallet: HouseWallet,
  job: Action,
  funder: string,
  filter: { address: string; topics: Array<string | string[] | null> },
  relevant: (log: ethers.Log) => boolean,
  matches: (receipt: ethers.TransactionReceipt) => boolean,
) {
  const match = /^batch:(\d+):(\d+)$/.exec(job.reference ?? "");
  const start = job.result.searchFrom;
  if (
    !match ||
    typeof start !== "number" ||
    !Number.isSafeInteger(start) ||
    start < 1
  )
    return null;
  const newest = await wallet.provider.getBlock("finalized");
  if (!newest || newest.number < start) return null;
  const logs = await wallet.provider.getLogs({
    ...filter,
    fromBlock: start,
    toBlock: Math.min(start + 1200, newest.number),
  });
  const possible = [
    ...new Set(logs.filter(relevant).map((log) => log.transactionHash)),
  ];
  if (!possible.length || possible.length > 12) return null;
  for (const txHash of possible) {
    const [stamp, tx] = await Promise.all([
      fetchEmbeddedEthereumTransactionReceipt({
        chainId: 137,
        txHash,
        requireFinalized: true,
      }),
      wallet.provider.getTransaction(txHash),
    ]);
    if (
      !stamp?.succeeded ||
      stamp.blockTimestamp == null ||
      stamp.blockTimestamp > BigInt(match[2]) ||
      tx?.to?.toLowerCase() !== POLYMARKET_DEPOSIT_WALLET_FACTORY.toLowerCase()
    )
      continue;
    const [before, after] = await Promise.all([
      wallet.batchNonceAt(funder, stamp.blockNumber - 1),
      wallet.batchNonceAt(funder, stamp.blockNumber),
    ]);
    if (before !== BigInt(match[1]) || after !== before + 1n) continue;
    const receipt = await wallet.provider.getTransactionReceipt(txHash);
    if (
      receipt &&
      houseReceiptMatchesFinalized(receipt, stamp) &&
      matches(receipt)
    )
      return receipt;
  }
  return null;
}

export async function doWithdrawal(
  pool: Pool,
  wallet: HouseWallet,
  a: Account,
  job: Action,
) {
  if (!a.deposit_wallet) throw new Error("wallet_not_ready");
  const recipient = houseWithdrawalRecipient(job.request.recipient, [
    wallet.key.address,
    a.deposit_wallet,
  ]);
  const requestedAmount = houseTraderAmount.safeParse(job.request.amount);
  if (!recipient || !requestedAmount.success) {
    if (job.state === "working")
      return finish(pool, job, "skipped", "invalid_withdrawal_request");
    return finish(pool, job, "submitted", "withdrawal_requires_manual_review");
  }
  const amount = usdRaw(requestedAmount.data);
  const previewMatches = houseWithdrawalPreviewMatches(
    job.result.quote,
    recipient,
    amount,
  );
  if (job.state === "working") {
    const native = await wallet.provider.getBalance(wallet.key.address);
    const fees = await wallet.provider.getFeeData();
    const gasPrice = fees.maxFeePerGas ?? fees.gasPrice;
    if (!gasPrice) return finish(pool, job, "skipped", "gas_price_unavailable");
    const gasReserve = 100_000n * gasPrice;
    if (!job.request.confirmedBy)
      return finish(pool, job, "review", "confirm_preview", {
        quote: {
          chainId: 137,
          recipient,
          amountRaw: amount.toString(),
          nativeRaw: native.toString(),
          gasReserveRaw: gasReserve.toString(),
        },
      });
    if (!previewMatches)
      return finish(pool, job, "skipped", "withdrawal_preview_changed");
    if (native < gasReserve)
      return finish(pool, job, "skipped", "controller_needs_polygon_gas");
    const {
      rows: [pending],
    } = await pool.query<{ raw: string }>(
      `select coalesce(sum(budget_raw),0)::text as raw from house_trader_actions
      where account_user_id=$1 and kind='buy' and state in ('working','submitting','submitted')`,
      [a.user_id],
    );
    if ((await wallet.balance(a.deposit_wallet)) < amount + BigInt(pending.raw))
      return finish(pool, job, "skipped", "insufficient_unreserved_pusd");
    return submitBatch(
      pool,
      wallet,
      a,
      job,
      [wallet.transfer(wallet.key.address, amount)],
      "handoff",
    );
  }
  if (!previewMatches)
    return finish(pool, job, "submitted", "withdrawal_preview_changed");
  if (job.result.phase === "handoff") {
    const observed = await batchReceipt(wallet, job);
    const funder = a.deposit_wallet;
    const receipt =
      observed ??
      (await recoverDepositBatchReceipt(
        wallet,
        job,
        funder,
        {
          address: wallet.collateral,
          topics: [
            ethers.id("Transfer(address,address,uint256)"),
            ethers.zeroPadValue(funder, 32),
            ethers.zeroPadValue(wallet.key.address, 32),
          ],
        },
        (log) =>
          /^0x[0-9a-f]{64}$/i.test(log.data) && BigInt(log.data) === amount,
        (receipt) =>
          exactTransfer(
            receipt,
            wallet.collateral,
            funder,
            wallet.key.address,
            amount,
          ),
      ));
    if (!receipt) {
      if (await wallet.expiredUnspentBatch(a.deposit_wallet, job.reference))
        return finish(
          pool,
          job,
          "skipped",
          "handoff_expired_without_execution",
        );
      return;
    }
    if (receipt.status === 0)
      return finish(pool, job, "skipped", "handoff_reverted");
    if (
      !exactTransfer(
        receipt,
        wallet.collateral,
        a.deposit_wallet,
        wallet.key.address,
        amount,
      )
    )
      return finish(pool, job, "submitted", "handoff_transfer_unproven");
    // Save the proven handoff locator even when the relayer originally
    // returned only a request ID, before gas/signing can defer the sweep.
    if (job.result.transactionHash !== receipt.hash)
      await pool.query(
        `update house_trader_actions set result=result || jsonb_build_object('transactionHash',$2::text)
         where id=$1 and reference=$3 and result->>'phase'='handoff'`,
        [job.id, receipt.hash, job.reference],
      );
    let signed: string;
    try {
      signed = await wallet.signSweep(recipient, amount);
    } catch {
      return finish(
        pool,
        job,
        "submitted",
        "treasury_step_needs_polygon_gas_or_rpc",
      );
    }
    const tx = ethers.Transaction.from(signed);
    if (!tx.hash || (!tx.gasPrice && !tx.maxFeePerGas))
      throw new Error("signed_transfer_invalid");
    const reserve = tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n);
    if ((await wallet.provider.getBalance(wallet.key.address)) < reserve)
      return finish(pool, job, "submitted", "treasury_step_needs_polygon_gas");
    const updated = await pool.query(houseSweepBoundarySql, [
      job.id,
      tx.hash,
      job.reference,
      wallet.sealSweep(signed),
      tx.nonce,
      receipt.hash,
    ]);
    if (updated.rowCount !== 1) return;
    await wallet.provider.broadcastTransaction(signed);
    return finish(pool, job, "submitted", null);
  }
  if (job.result.phase !== "sweep" || !job.reference) return;
  const receipt = await wallet.provider.getTransactionReceipt(job.reference);
  if (!receipt && job.protected_submission) {
    const { tx, raw } = wallet.openSweep(
      job.protected_submission,
      job.reference,
      recipient,
      amount,
    );
    if (
      (await wallet.provider.getTransactionCount(
        wallet.key.address,
        "finalized",
      )) > tx.nonce
    )
      return finish(
        pool,
        job,
        "submitted",
        "treasury_nonce_consumed_needs_review",
      );
    if (!(await wallet.provider.getTransaction(job.reference))) {
      // Only replay identical bytes using the SAME nonce/hash, never create
      // a replacement while its effect is uncertain.
      await wallet.provider.broadcastTransaction(raw);
    }
    return;
  }
  if (!receipt) return;
  const finalizedSweep = await fetchEmbeddedEthereumTransactionReceipt({
    chainId: 137,
    txHash: job.reference,
    requireFinalized: true,
  });
  if (!houseReceiptMatchesFinalized(receipt, finalizedSweep)) return;
  if (receipt.status === 0) {
    // Canonical revert proves no transfer; preserve the first leg and try again.
    await pool.query(houseSweepRevertedSql, [job.id, job.reference]);
    return;
  }
  if (
    !exactTransfer(
      receipt,
      wallet.collateral,
      wallet.key.address,
      recipient,
      amount,
    )
  )
    return finish(pool, job, "submitted", "treasury_transfer_unproven");
  await pool.query(
    "update house_trader_actions set protected_submission=null where id=$1 and reference=$2",
    [job.id, job.reference],
  );
  return finish(pool, job, "done", null, {
    withdrawnRaw: amount.toString(),
    treasuryHash: receipt.hash,
  });
}

export async function submitRedeem(
  pool: Pool,
  wallet: HouseWallet,
  a: Account,
  job: Action,
  call: DepositWalletCall,
  sharesRaw: string,
  expectedPayoutRaw: string,
) {
  return submitBatch(pool, wallet, a, job, [call], "redeem", {
    sharesRaw,
    expectedPayoutRaw,
  });
}

export async function observeRedeem(
  pool: Pool,
  wallet: HouseWallet,
  a: Account,
  job: Action,
) {
  const instrument = job.request.assetContext as PolymarketAssetContext;
  const funder = a.deposit_wallet;
  if (!funder || !instrument) return;
  const paid = BigInt(String(job.result.expectedPayoutRaw));
  const units = BigInt(String(job.result.sharesRaw));
  const matches = (rcpt: ethers.TransactionReceipt) =>
    collateralNet(rcpt.logs, wallet.collateral, funder) === paid &&
    positionNet(
      rcpt.logs,
      instrument.positionContract,
      instrument.assetId,
      funder,
    ) === -units;
  const receipt =
    (await batchReceipt(wallet, job)) ??
    (await recoverDepositBatchReceipt(
      wallet,
      job,
      funder,
      {
        address: instrument.positionContract,
        topics: [
          [
            ethers.id(
              "TransferSingle(address,address,address,uint256,uint256)",
            ),
            ethers.id(
              "TransferBatch(address,address,address,uint256[],uint256[])",
            ),
          ],
          null,
          ethers.zeroPadValue(funder, 32),
        ],
      },
      (log) =>
        positionNet(
          [log],
          instrument.positionContract,
          instrument.assetId,
          funder,
        ) < 0n,
      matches,
    ));
  if (!receipt) {
    if (typeof job.result.relayerId === "string") {
      const observed = await fetchPolymarketRelayerTransaction(
        job.result.relayerId,
        (url, init) =>
          fetch(url, { ...init, signal: AbortSignal.timeout(12_000) }),
      ).catch(() => null);
      if (POLYMARKET_RELAYER_FAILED_STATES.has(observed?.state ?? ""))
        await finish(pool, job, "submitted", "redeem_relayer_requires_review");
    }
    if (
      a.deposit_wallet &&
      (await wallet.expiredUnspentBatch(a.deposit_wallet, job.reference))
    )
      return finish(pool, job, "skipped", "redeem_expired_without_execution");
    return;
  }
  if (receipt.status !== 1)
    return finish(pool, job, "skipped", "redeem_reverted", {
      txHash: receipt.hash,
    });
  if (!matches(receipt))
    return finish(
      pool,
      job,
      "submitted",
      "redeem_payout_or_consumption_unproven",
    );
  return finish(pool, job, "done", null, {
    txHash: receipt.hash,
    cashDeltaRaw: paid.toString(),
    fillSharesRaw: units.toString(),
  });
}
