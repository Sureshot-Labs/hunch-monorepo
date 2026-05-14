import {
  enqueuePriceRefreshTokens,
  type PriceRefreshRedis,
  type PriceRefreshVenue,
} from "@hunch/infra";

import { env } from "../env.js";
import { getRedis } from "../redis.js";

export type RequestPriceRefreshInputs = {
  tokenIds: Array<string | null | undefined>;
  venue?: PriceRefreshVenue;
  maxTokens?: number;
};

export type PriceRefreshTokenSource = {
  venue?: string | null;
  tokenId?: string | null;
  token_id?: string | null;
  mint?: string | null;
  inputMint?: string | null;
  input_mint?: string | null;
  outputMint?: string | null;
  output_mint?: string | null;
};

type CollectPriceRefreshTokenInputs = {
  solanaUsdcMint?: string | null;
};

type RequestPriceRefreshSourceInputs = {
  sources: PriceRefreshTokenSource[];
  maxTokens?: number;
};

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function stripSolPrefix(value: string): string {
  return value.toLowerCase().startsWith("sol:") ? value.slice(4) : value;
}

function normalizeSolToken(
  value: string | null | undefined,
  solanaUsdcMint?: string | null,
): string | null {
  const token = normalizeText(value);
  if (!token) return null;
  const mint = stripSolPrefix(token);
  if (solanaUsdcMint && mint === stripSolPrefix(solanaUsdcMint)) return null;
  return token.toLowerCase().startsWith("sol:") ? token : `sol:${token}`;
}

function normalizePriceRefreshToken(
  value: string | null | undefined,
  venue: string | null,
  solanaUsdcMint?: string | null,
): string | null {
  const token = normalizeText(value);
  if (!token) return null;

  if (venue === "limitless") {
    return token.startsWith("limitless:") ? token : `limitless:${token}`;
  }
  if (venue === "kalshi" || venue === "dflow") {
    return normalizeSolToken(token, solanaUsdcMint);
  }
  if (venue === "polymarket") {
    return /^\d+$/.test(token) ? token : null;
  }

  if (token.toLowerCase().startsWith("sol:")) {
    return normalizeSolToken(token, solanaUsdcMint);
  }
  if (token.startsWith("limitless:") || /^\d+$/.test(token)) return token;
  return null;
}

export function collectPriceRefreshTokenIdsFromSources(
  sources: PriceRefreshTokenSource[],
  inputs: CollectPriceRefreshTokenInputs = {},
): string[] {
  const tokenIds = new Map<string, string>();
  const add = (tokenId: string | null) => {
    if (tokenId) tokenIds.set(tokenId, tokenId);
  };

  for (const source of sources) {
    const venue = normalizeText(source.venue)?.toLowerCase() ?? null;
    add(
      normalizePriceRefreshToken(
        source.tokenId ?? source.token_id,
        venue,
        inputs.solanaUsdcMint,
      ),
    );
    if (venue === "kalshi" || venue === "dflow" || venue == null) {
      add(normalizeSolToken(source.mint, inputs.solanaUsdcMint));
      add(
        normalizeSolToken(
          source.inputMint ?? source.input_mint,
          inputs.solanaUsdcMint,
        ),
      );
      add(
        normalizeSolToken(
          source.outputMint ?? source.output_mint,
          inputs.solanaUsdcMint,
        ),
      );
    }
  }

  return Array.from(tokenIds.values());
}

export async function requestPriceRefreshForTokens(
  inputs: RequestPriceRefreshInputs,
): Promise<void> {
  if (!env.priceRefreshQueueEnabled) return;
  if (!inputs.tokenIds.length) return;

  try {
    const redis = await getRedis();
    if (!redis) return;

    await enqueuePriceRefreshTokens(redis as unknown as PriceRefreshRedis, {
      tokenIds: inputs.tokenIds,
      venue: inputs.venue,
      maxQueueSize: env.priceRefreshQueueMax,
      maxTokens: inputs.maxTokens ?? env.priceRefreshEnqueueMaxPerRequest,
    });
  } catch (error) {
    console.warn("[price-refresh] failed to enqueue tokens", error);
  }
}

export async function requestPriceRefreshForTokenSources(
  inputs: RequestPriceRefreshSourceInputs,
): Promise<void> {
  const tokenIds = collectPriceRefreshTokenIdsFromSources(inputs.sources, {
    solanaUsdcMint: env.solanaUsdcMint,
  });
  if (!tokenIds.length) return;
  await requestPriceRefreshForTokens({
    tokenIds,
    maxTokens: inputs.maxTokens,
  });
}
