// apps/api/src/polymarket/markets.ts

type MarketInfo = {
  yesToken: string;
  noToken: string;
  tickSize: string;
  negRisk: boolean;
};

export async function getMarketInfoBySlug(slug: string): Promise<MarketInfo> {
  const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(
    slug
  )}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma /markets failed: ${res.status}`);
  const arr = await res.json();
  const m = arr?.[0];
  if (!m) throw new Error(`Market not found for slug ${slug}`);

  // clobTokenIds is usually a comma-separated string of the two outcome token IDs
  let yesToken = "";
  let noToken = "";

  const ids = m.clobTokenIds ?? m.clob_token_ids;
  if (ids) {
    const pair = (typeof ids === "string" ? ids.split(",") : ids).map(
      (s: string) => s.trim()
    );
    // In practice, Gamma provides the Yes/No pair; if you need to be absolutely certain,
    // also inspect m.tokens (when present) for outcome labels. :contentReference[oaicite:3]{index=3}
    yesToken = pair[0];
    noToken = pair[1];
  }

  if ((!yesToken || !noToken) && Array.isArray(m.tokens)) {
    for (const t of m.tokens) {
      const outcome = String(t.outcome ?? "").toLowerCase();
      if (outcome === "yes") yesToken = t.token_id ?? t.tokenId;
      if (outcome === "no") noToken = t.token_id ?? t.tokenId;
    }
  }

  const tickSize = String(
    m.orderPriceMinTickSize ?? m.minimum_tick_size ?? "0.001"
  );

  // negRisk can sit on market or its parent event depending on feed
  const negRisk = Boolean(m.negRisk ?? m.events?.[0]?.negRisk ?? false);

  if (!yesToken || !noToken) {
    throw new Error(
      `Could not resolve token IDs for ${slug}. Inspect payload:\n${JSON.stringify(
        m,
        null,
        2
      )}`
    );
  }
  return { yesToken, noToken, tickSize, negRisk };
}
