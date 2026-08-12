import type { Pool } from "@hunch/infra";
import { Interface } from "ethers";

import { decryptCredentialsString } from "../../lib/credentials-encryption.js";
import { polymarketL2Request } from "../../services/polymarket-clob-l2.js";
import { POLYMARKET_FUNDING_ROUTER_ABI } from "../../services/polymarket-funding-router.js";
import {
  fetchErc20BalanceOf,
  fetchEvmCall,
} from "../../services/polygon-rpc.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import type { PolymarketFundingObservation } from "./polymarket-funding-followup.js";

const fundingRouterInterface = new Interface(POLYMARKET_FUNDING_ROUTER_ABI);

function raw(value: unknown): string | null {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)
    ? value
    : null;
}

async function clobBalance(input: {
  db: Pick<Pool, "query">;
  encryptionKey: Buffer;
  userId: string;
  signerAddress: string;
}): Promise<string | null> {
  const { rows } = await input.db.query<{
    api_key: string | null;
    api_secret_enc: string | null;
    api_passphrase_enc: string | null;
  }>(
    `
      select api_key, api_secret_enc, api_passphrase_enc
      from user_venue_credentials
      where user_id = $1
        and venue = 'polymarket'
        and funding_account_identifier_equal(
              'ethereum',
              wallet_address,
              $2
            )
        and is_active = true
      order by last_used_at desc nulls last, updated_at desc, created_at desc
      limit 1
    `,
    [input.userId, input.signerAddress],
  );
  const credential = rows[0];
  if (
    !credential?.api_key ||
    !credential.api_secret_enc ||
    !credential.api_passphrase_enc
  ) {
    return null;
  }
  const response = await polymarketL2Request({
    baseUrl: fundingSidecarRuntimeConfig.polymarketClobBase,
    timeoutMs: 10_000,
    address: input.signerAddress,
    creds: {
      apiKey: credential.api_key,
      apiSecret: decryptCredentialsString(
        credential.api_secret_enc,
        input.encryptionKey,
      ),
      apiPassphrase: decryptCredentialsString(
        credential.api_passphrase_enc,
        input.encryptionKey,
      ),
    },
    method: "GET",
    requestPath: "/balance-allowance?asset_type=COLLATERAL&signature_type=3",
  });
  if (
    !response.ok ||
    !response.payload ||
    typeof response.payload !== "object"
  ) {
    return null;
  }
  return raw((response.payload as Record<string, unknown>).balance);
}

export async function observePolymarketFundingRuntimeSidecar(input: {
  db: Pick<Pool, "query">;
  encryptionKey: Buffer;
  userId: string;
  signerAddress: string;
  depositWallet: string;
}): Promise<PolymarketFundingObservation | null> {
  const routerAddress =
    fundingSidecarRuntimeConfig.polymarketFundingRouterAddress;
  if (!routerAddress) return null;
  const rpc = {
    rpcUrl: fundingSidecarRuntimeConfig.polygonRpcUrl,
    timeoutMs: fundingSidecarRuntimeConfig.polygonRpcTimeoutMs,
  };
  try {
    const [depositPusdRaw, nonceResult, clobPusdRaw] = await Promise.all([
      fetchErc20BalanceOf({
        ...rpc,
        tokenAddress: fundingSidecarRuntimeConfig.polymarketPusdAddress,
        owner: input.depositWallet,
      }),
      fetchEvmCall({
        ...rpc,
        to: routerAddress,
        data: fundingRouterInterface.encodeFunctionData("fundingNonce", [
          input.signerAddress,
        ]),
      }),
      clobBalance(input).catch(() => null),
    ]);
    const decoded = fundingRouterInterface.decodeFunctionResult(
      "fundingNonce",
      nonceResult,
    ) as unknown;
    const nonce = Array.isArray(decoded) ? decoded[0] : null;
    if (typeof nonce !== "bigint") return null;
    return {
      routerNonceRaw: nonce.toString(),
      depositPusdRaw: depositPusdRaw.toString(),
      clobPusdRaw,
      observedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
