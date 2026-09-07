import { ethers } from "ethers";
import { stableWalletOpaqueId } from "../../account-value/canonical.js";
import type { UserWallet } from "../../auth.js";
import {
  fetchEvmTransactionByHash,
  fetchEvmTransactionReceipt,
  fetchEvmBlockHash,
  fetchEvmBlockNumber,
} from "../../services/polygon-rpc.js";
import {
  fundingSidecarRuntimeConfig,
  fundingEvmRpcUrl,
  type FundingSidecarRuntimeConfig,
} from "../runtime/sidecar-runtime-config.js";
import {
  evaluateEvmActionReceipt,
  type EvmReceiptRecord,
  type EvmReceiptTransaction,
} from "../execution/step-receipt-reconciler.js";
import type { FundingPreparationRun } from "../persistence/funding-preparation-run-repository.js";
import { parsePrivyFundingTransactionReference } from "../execution/privy-transaction-reference.js";
import { createPrivyFundingReferenceResolver } from "../execution/privy-delegated-funding-driver.js";

const approvalInterface = new ethers.Interface([
  "function approve(address spender,uint256 amount)",
  "function setApprovalForAll(address operator,bool approved)",
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
  "event ApprovalForAll(address indexed account,address indexed operator,bool approved)",
]);

export type PreparationReceiptReader = (
  networkId: string,
  transactionHash: string,
) => Promise<{
  transaction: EvmReceiptTransaction | null;
  receipt: EvmReceiptRecord | null;
}>;

export async function readPreparationReceipt(
  networkId: string,
  transactionHash: string,
  config: FundingSidecarRuntimeConfig = fundingSidecarRuntimeConfig,
): ReturnType<PreparationReceiptReader> {
  const chainId = /^evm:[1-9]\d*$/u.test(networkId)
    ? Number(networkId.slice(4))
    : NaN;
  const rpcUrl = fundingEvmRpcUrl(chainId, config);
  if (!rpcUrl) throw new Error("preparation_receipt_rpc_unavailable");
  const providerReference =
    parsePrivyFundingTransactionReference(transactionHash);
  if (providerReference) {
    const resolve = createPrivyFundingReferenceResolver({
      appId: process.env.PRIVY_APP_ID ?? "",
      appSecret: process.env.PRIVY_APP_SECRET ?? "",
    });
    const result = await resolve?.(providerReference, networkId);
    if (result?.kind !== "submitted")
      return { transaction: null, receipt: null };
    transactionHash = result.transactionReference;
  }
  const rpc = { rpcUrl, timeoutMs: 6000, maxAttempts: 1 };
  const [transaction, receipt] = await Promise.all([
    fetchEvmTransactionByHash({ ...rpc, transactionHash }),
    fetchEvmTransactionReceipt({ ...rpc, transactionHash }),
  ]);
  if (!receipt) return { transaction, receipt: null };
  const [canonicalBlockHash, head] = await Promise.all([
    fetchEvmBlockHash({ ...rpc, blockNumber: receipt.blockNumber }),
    fetchEvmBlockNumber({ ...rpc, bypassCache: true }),
  ]);
  return {
    transaction,
    receipt: {
      ...receipt,
      canonicalBlockHash,
      confirmations: Number(head - BigInt(receipt.blockNumber) + 1n),
    },
  };
}

/** null means another preparation kind; false means evidence is still missing.
 * Historical approval execution is not current market/trading readiness. */
export async function verifyPreparationApprovalReceipts(
  run: FundingPreparationRun,
  wallets: readonly UserWallet[],
  read: PreparationReceiptReader,
): Promise<boolean | null> {
  if (run.actions.length === 0) return null;
  const approvals = run.actions.map((attempt) => {
    if (attempt.action.kind !== "evm_transaction") return null;
    const action = attempt.action;
    try {
      const call = approvalInterface.parseTransaction({ data: action.data });
      if (
        !call ||
        action.valueRaw !== "0" ||
        approvalInterface
          .encodeFunctionData(call.fragment, call.args)
          .toLowerCase() !== action.data.toLowerCase()
      )
        return null;
      return { attempt, action, call };
    } catch {
      return null;
    }
  });
  if (approvals.some((approval) => approval === null)) return null;
  for (const approval of approvals) {
    if (!approval) return false;
    const { attempt, action, call } = approval;
    if (attempt.state === "succeeded") continue;
    const reference = attempt.transactionReference;
    if (
      !reference ||
      !["submitted", "ambiguous"].includes(attempt.state) ||
      !attempt.broadcastMayHaveOccurred ||
      (!/^0x[\da-f]{64}$/iu.test(attempt.transactionReference ?? "") &&
        !parsePrivyFundingTransactionReference(
          attempt.transactionReference ?? "",
        ))
    )
      return false;
    const owners = wallets.filter(
      (wallet) =>
        wallet.walletType === "ethereum" &&
        wallet.isVerified &&
        (!run.controllerWalletRef || wallet.id === run.controllerWalletRef) &&
        stableWalletOpaqueId({
          walletType: wallet.walletType,
          networkId: action.networkId,
          address: wallet.walletAddress,
        }) === action.senderWalletId,
    );
    const owner = owners.length === 1 ? owners[0] : undefined;
    if (!owner) return false;
    const { transaction, receipt } = await read(action.networkId, reference);
    const verdict = evaluateEvmActionReceipt({
      action,
      transaction,
      receipt,
      previous: null,
      expectedSignerAddress: owner.walletAddress,
      executionEnvelope:
        transaction?.from.toLowerCase() === owner.walletAddress.toLowerCase()
          ? "direct"
          : "privy_erc4337",
    });
    if (
      verdict.status !== "finalized" ||
      !verdict.canonical ||
      !verdict.actionMatch ||
      !receipt
    )
      return false;
    const eventName = call.name === "approve" ? "Approval" : "ApprovalForAll";
    const matches = receipt.logs.filter((log) => {
      if (log.address.toLowerCase() !== action.to.toLowerCase()) return false;
      try {
        const event = approvalInterface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        return (
          event?.name === eventName &&
          String(event.args[0]).toLowerCase() ===
            owner.walletAddress.toLowerCase() &&
          String(event.args[1]).toLowerCase() ===
            String(call.args[0]).toLowerCase() &&
          event.args[2] === call.args[1]
        );
      } catch {
        return false;
      }
    });
    // Exact action bytes + signer + successful canonical execution are checked
    // above. Duplicate matching events are not accepted as unique evidence.
    if (matches.length !== 1) return false;
  }
  return true;
}
