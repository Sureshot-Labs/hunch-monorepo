import { Interface, ethers } from "ethers";
import { env } from "../env.js";
import { fetchEvmMulticall } from "./polygon-rpc.js";

const conditionalTokensIface = new Interface([
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)",
]);

type PayoutSnapshot = {
  conditionId: string;
  payoutDenominator: bigint;
  payoutNumerators: [bigint, bigint];
};

export type PayoutSummary = {
  conditionId: string;
  payoutDenominator: string;
  payoutNumerators: [string, string];
  resolvedOutcome: "YES" | "NO" | null;
  resolvedOutcomePct: number | null;
  redeemable: boolean;
};

function decodeBigInt(iface: Interface, fn: string, data: string): bigint {
  const decoded = iface.decodeFunctionResult(fn, data) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "bigint") {
    throw new Error(`Invalid ${fn} result`);
  }
  return value;
}

function summarizeSnapshot(snapshot: PayoutSnapshot): PayoutSummary {
  const [yesNum, noNum] = snapshot.payoutNumerators;
  const denom = snapshot.payoutDenominator;
  let resolvedOutcome: "YES" | "NO" | null = null;
  let resolvedOutcomePct: number | null = null;

  if (denom > 0n) {
    if (yesNum > noNum) resolvedOutcome = "YES";
    else if (noNum > yesNum) resolvedOutcome = "NO";

    const pct = Number((yesNum * 10_000n) / denom);
    resolvedOutcomePct = Number.isFinite(pct) ? pct : null;
  }

  return {
    conditionId: snapshot.conditionId,
    payoutDenominator: denom.toString(),
    payoutNumerators: [yesNum.toString(), noNum.toString()],
    resolvedOutcome,
    resolvedOutcomePct,
    redeemable: denom > 0n,
  };
}

export async function fetchConditionalTokensPayouts(inputs: {
  conditionIds: string[];
}): Promise<PayoutSummary[]> {
  if (inputs.conditionIds.length === 0) return [];

  const contractAddress = ethers.getAddress(
    env.limitlessConditionalTokensAddress,
  );
  const calls = inputs.conditionIds.flatMap((conditionId) => [
    {
      target: contractAddress,
      callData: conditionalTokensIface.encodeFunctionData("payoutDenominator", [
        conditionId,
      ]),
    },
    {
      target: contractAddress,
      callData: conditionalTokensIface.encodeFunctionData("payoutNumerators", [
        conditionId,
        0,
      ]),
    },
    {
      target: contractAddress,
      callData: conditionalTokensIface.encodeFunctionData("payoutNumerators", [
        conditionId,
        1,
      ]),
    },
  ]);

  const results = await fetchEvmMulticall({
    rpcUrl: env.baseRpcUrl,
    timeoutMs: env.baseRpcTimeoutMs,
    multicallAddress: env.baseMulticallAddress,
    calls,
  });

  const snapshots: PayoutSnapshot[] = [];
  let cursor = 0;
  for (const conditionId of inputs.conditionIds) {
    const denomResult = results[cursor++];
    const yesResult = results[cursor++];
    const noResult = results[cursor++];

    const payoutDenominator = denomResult?.success
      ? decodeBigInt(
          conditionalTokensIface,
          "payoutDenominator",
          denomResult.returnData,
        )
      : 0n;
    const payoutYes = yesResult?.success
      ? decodeBigInt(
          conditionalTokensIface,
          "payoutNumerators",
          yesResult.returnData,
        )
      : 0n;
    const payoutNo = noResult?.success
      ? decodeBigInt(
          conditionalTokensIface,
          "payoutNumerators",
          noResult.returnData,
        )
      : 0n;

    snapshots.push({
      conditionId,
      payoutDenominator,
      payoutNumerators: [payoutYes, payoutNo],
    });
  }

  return snapshots.map((snapshot) => summarizeSnapshot(snapshot));
}
