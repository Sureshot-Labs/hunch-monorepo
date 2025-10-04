// apps/indexer-kalshi/src/kalshiClient.ts
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { env } from "./env";
import { getRedis } from "../indexer-polymarket/src/redis"; // Assuming shared redis
import { createExchangeRateLimiters, RateLimitError, parseRetryAfter } from "@hunch/shared/rate-limiter/distributed-rate-limiter";

const pkPem = fs.readFileSync(path.resolve(env.kalshiPrivateKeyPath), "utf8");

let rateLimiters: ReturnType<typeof createExchangeRateLimiters> | null = null;

async function getRateLimiters() {
  if (!rateLimiters) {
    const redis = await getRedis();
    rateLimiters = createExchangeRateLimiters(redis);
  }
  return rateLimiters;
}

function sign(method: string, pathOnly: string, tsMs: string) {
  const msg = tsMs + method.toUpperCase() + pathOnly;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(msg);
  sign.end();
  const sig = sign.sign({
    key: pkPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return sig.toString("base64");
}

export class KalshiClient {
  private async signedFetch(
    method: string,
    pathOnly: string,
    init: RequestInit = {},
    write = false
  ) {
    const limiters = await getRateLimiters();
    const limiter = write ? limiters.kalshiWrite : limiters.kalshiRead;
    
    // Wait for rate limit token with exponential backoff
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Acquire rate limit token
        await limiter.waitForTokens(1, 'api');
        
        const ts = Date.now().toString();
        const sig = sign(method, pathOnly, ts);
        const headers = {
          ...(init.headers as any),
          "KALSHI-ACCESS-KEY": env.kalshiKeyId,
          "KALSHI-ACCESS-TIMESTAMP": ts,
          "KALSHI-ACCESS-SIGNATURE": sig,
          accept: "application/json",
        };
        const url = new URL(pathOnly, env.kalshiBase).toString();

        const r = await fetch(url, { ...init, method, headers });
        
        // Handle rate limiting with Retry-After
        if (r.status === 429) {
          const retryAfterMs = parseRetryAfter(r.headers.get('Retry-After'));
          const backoffMs = retryAfterMs || Math.min(1000 * Math.pow(2, attempt), 32000);
          
          if (attempt < maxRetries) {
            console.warn(`Kalshi rate limited. Waiting ${backoffMs}ms before retry ${attempt + 1}/${maxRetries}`);
            await new Promise((res) => setTimeout(res, backoffMs));
            continue;
          } else {
            throw new RateLimitError(backoffMs, 'kalshi');
          }
        }
        
        if (!r.ok) {
          throw new Error(`${method} ${pathOnly} ${r.status}: ${await r.text()}`);
        }
        
        return r.json();
      } catch (error) {
        if (error instanceof RateLimitError && attempt === maxRetries) {
          throw error;
        }
        if (attempt === maxRetries) {
          throw error;
        }
        // Continue to next retry
      }
    }
  }

  get(pathOnly: string, params?: Record<string, any>) {
    if (params) {
      const u = new URL(pathOnly, "http://x");
      Object.entries(params).forEach(
        ([k, v]) => v != null && u.searchParams.set(k, String(v))
      );
      pathOnly = u.pathname + (u.search || "");
    }
    return this.signedFetch("GET", pathOnly);
  }

  post(pathOnly: string, body: any) {
    return this.signedFetch(
      "POST",
      pathOnly,
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      },
      true
    );
  }
}
