import { Interface, ethers } from "ethers";
import { fetchEvmCall, fetchEvmCode } from "./polygon-rpc.js";

export type SafeEvmReadFailureReason =
  | "invalid_target"
  | "no_code"
  | "empty_result"
  | "decode_failed"
  | "reverted"
  | "rpc_error";

export class SafeEvmReadError extends Error {
  readonly reason: SafeEvmReadFailureReason;
  readonly targetAddress: string;
  readonly functionName: string;
  readonly rawResult: string | null;

  constructor(inputs: {
    reason: SafeEvmReadFailureReason;
    message: string;
    targetAddress: string;
    functionName: string;
    rawResult?: string | null;
    cause?: unknown;
  }) {
    super(inputs.message, inputs.cause ? { cause: inputs.cause } : undefined);
    this.name = "SafeEvmReadError";
    this.reason = inputs.reason;
    this.targetAddress = inputs.targetAddress;
    this.functionName = inputs.functionName;
    this.rawResult = inputs.rawResult ?? null;
  }
}

function classifyReadFailure(error: unknown): SafeEvmReadFailureReason {
  if (!(error instanceof Error)) return "rpc_error";
  const message = error.message.toLowerCase();
  if (
    message.includes("execution reverted") ||
    message.includes("revert") ||
    message.includes("invalid opcode") ||
    message.includes("panic")
  ) {
    return "reverted";
  }
  return "rpc_error";
}

function defaultDecode<T>(decoded: unknown): T {
  if (Array.isArray(decoded)) {
    return decoded[0] as T;
  }
  return decoded as T;
}

export async function safeEvmReadContract<T>(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  target: string;
  iface: Interface;
  functionName: string;
  args?: readonly unknown[];
  decode?: (decoded: unknown) => T;
}): Promise<T> {
  let targetAddress: string;
  try {
    targetAddress = ethers.getAddress(inputs.target);
  } catch (error) {
    throw new SafeEvmReadError({
      reason: "invalid_target",
      message: `Invalid contract address for ${inputs.functionName}.`,
      targetAddress: inputs.target,
      functionName: inputs.functionName,
      cause: error,
    });
  }

  const code = await fetchEvmCode({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    address: targetAddress,
  });
  if (!code || code === "0x" || code === "0x0") {
    throw new SafeEvmReadError({
      reason: "no_code",
      message: `Contract unavailable for ${inputs.functionName}.`,
      targetAddress,
      functionName: inputs.functionName,
      rawResult: code ?? null,
    });
  }

  const data = inputs.iface.encodeFunctionData(inputs.functionName, [
    ...(inputs.args ?? []),
  ]);

  let rawResult: string;
  try {
    rawResult = await fetchEvmCall({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      to: targetAddress,
      data,
    });
  } catch (error) {
    throw new SafeEvmReadError({
      reason: classifyReadFailure(error),
      message:
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : `Unable to read ${inputs.functionName}.`,
      targetAddress,
      functionName: inputs.functionName,
      cause: error,
    });
  }

  if (!rawResult || rawResult === "0x" || rawResult === "0x0") {
    throw new SafeEvmReadError({
      reason: "empty_result",
      message: `Empty result for ${inputs.functionName}.`,
      targetAddress,
      functionName: inputs.functionName,
      rawResult,
    });
  }

  try {
    const decoded = inputs.iface.decodeFunctionResult(
      inputs.functionName,
      rawResult,
    ) as unknown;
    return (inputs.decode ?? defaultDecode<T>)(decoded);
  } catch (error) {
    throw new SafeEvmReadError({
      reason: "decode_failed",
      message: `Invalid response for ${inputs.functionName}.`,
      targetAddress,
      functionName: inputs.functionName,
      rawResult,
      cause: error,
    });
  }
}
