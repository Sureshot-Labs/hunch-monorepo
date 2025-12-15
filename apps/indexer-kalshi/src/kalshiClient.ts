// apps/indexer-kalshi/src/kalshiClient.ts
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import PQueue from "p-queue";
import { env } from "./env";

let cachedKeyPem: string | undefined;
let cachedKeyPath: string | undefined;

function requireKalshiAuth(): { keyId: string; privateKeyPath: string } {
  if (!env.kalshiKeyId || !env.kalshiPrivateKeyPath) {
    const extra =
      env.kalshiIssues.length > 0 ? ` (${env.kalshiIssues.join("; ")})` : "";
    throw new Error(`[kalshi] Missing auth env${extra}`);
  }

  return { keyId: env.kalshiKeyId, privateKeyPath: env.kalshiPrivateKeyPath };
}

function getPrivateKeyPem(): string {
  const { privateKeyPath } = requireKalshiAuth();
  const resolved = path.resolve(privateKeyPath);
  if (cachedKeyPem && cachedKeyPath === resolved) return cachedKeyPem;

  cachedKeyPem = fs.readFileSync(resolved, "utf8");
  cachedKeyPath = resolved;
  return cachedKeyPem;
}

function sign(method: string, pathOnly: string, tsMs: string) {
  const msg = tsMs + method.toUpperCase() + pathOnly;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(msg);
  sign.end();
  const sig = sign.sign({
    key: getPrivateKeyPem(),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return sig.toString("base64");
}

export class KalshiClient {
  private qRead = new PQueue({ interval: 1000, intervalCap: env.rpsRead });
  private qWrite = new PQueue({ interval: 1000, intervalCap: env.rpsWrite });

  private async signedFetch(
    method: string,
    pathOnly: string,
    init: RequestInit = {},
    write = false,
  ) {
    const { keyId } = requireKalshiAuth();
    const ts = Date.now().toString();
    const sig = sign(method, pathOnly, ts);
    const headers = new Headers(init.headers);
    headers.set("KALSHI-ACCESS-KEY", keyId);
    headers.set("KALSHI-ACCESS-TIMESTAMP", ts);
    headers.set("KALSHI-ACCESS-SIGNATURE", sig);
    headers.set("accept", "application/json");
    const url = new URL(pathOnly, env.kalshiBase).toString();

    const run = async () => {
      const r = await fetch(url, { ...init, method, headers });
      if (r.status === 429) throw new Error("rate_limited");
      if (!r.ok)
        throw new Error(`${method} ${pathOnly} ${r.status}: ${await r.text()}`);
      return r.json();
    };

    const q = write ? this.qWrite : this.qRead;
    // poor man's backoff
    for (let i = 0; i < 4; i++) {
      try {
        return await q.add(run);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes("rate_limited"))
          await new Promise((res) => setTimeout(res, (i + 1) * 200));
        else if (i === 3) throw e;
      }
    }
  }

  get(
    pathOnly: string,
    params?: Record<string, string | number | boolean | null | undefined>,
  ) {
    if (params) {
      const u = new URL(pathOnly, "http://x");
      Object.entries(params).forEach(
        ([k, v]) => v != null && u.searchParams.set(k, String(v)),
      );
      pathOnly = u.pathname + (u.search || "");
    }
    return this.signedFetch("GET", pathOnly);
  }

  post(pathOnly: string, body: unknown) {
    return this.signedFetch(
      "POST",
      pathOnly,
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      },
      true,
    );
  }
}
