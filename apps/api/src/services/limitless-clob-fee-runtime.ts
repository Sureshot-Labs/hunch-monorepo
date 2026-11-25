import { fundingSidecarRuntimeConfig } from "../funding/runtime/sidecar-runtime-config.js";
import {
  assertLimitlessFeeModuleAllowance,
  assertLimitlessMarketPayloadSlug,
  readLimitlessClobFeePolicy,
  unavailableLimitlessFeePolicy,
  type LimitlessClobFeePolicy,
} from "./limitless-clob-fees.js";
import { limitlessRequest } from "./limitless-client.js";
import { fetchErc20Allowance } from "./polygon-rpc.js";

export function marketLimitlessFeePolicy(
  payload: unknown,
  profileFeeRateBps?: number | null,
): LimitlessClobFeePolicy {
  return readLimitlessClobFeePolicy(
    payload,
    fundingSidecarRuntimeConfig.limitlessUsdcAddress,
    profileFeeRateBps,
  );
}

export async function fetchLimitlessClobMarket(
  slug: string,
  auth?: Pick<
    Parameters<typeof limitlessRequest>[0],
    "auth" | "headers" | "timeoutMs"
  >,
): Promise<unknown> {
  const result = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(slug)}`,
    ...auth,
    allowRetry: false,
  }).catch(() => null);
  if (!result?.ok) throw unavailableLimitlessFeePolicy();
  assertLimitlessMarketPayloadSlug(result.payload, slug);
  return result.payload;
}

export function verifyLimitlessFeeModuleAllowance(
  policy: LimitlessClobFeePolicy,
  owner: string,
  postOnly?: boolean,
) {
  return assertLimitlessFeeModuleAllowance({
    policy,
    owner,
    postOnly,
    readAllowance: readBaseUsdcAllowance,
  });
}

export function readBaseUsdcAllowance(input: {
  tokenAddress: string;
  owner: string;
  spender: string;
}) {
  return fetchErc20Allowance({
    ...input,
    rpcUrl: fundingSidecarRuntimeConfig.baseRpcUrl,
    timeoutMs: fundingSidecarRuntimeConfig.baseRpcTimeoutMs,
  });
}
