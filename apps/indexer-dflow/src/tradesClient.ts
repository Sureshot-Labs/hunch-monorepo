import { z } from "zod";
import { env } from "./env";

const DflowTrade = z
  .object({
    tradeId: z.string().optional(),
    count: z.union([z.number(), z.string()]).optional(),
    createdTime: z.union([z.number(), z.string()]).optional(),
    yesPrice: z.union([z.number(), z.string()]).optional(),
    yesPriceDollars: z.union([z.number(), z.string()]).optional(),
    noPrice: z.union([z.number(), z.string()]).optional(),
    noPriceDollars: z.union([z.number(), z.string()]).optional(),
    price: z.union([z.number(), z.string()]).optional(),
    priceDollars: z.union([z.number(), z.string()]).optional(),
    takerSide: z.string().optional(),
    ticker: z.string().optional(),
  })
  .passthrough();

const DflowTradesResponse = z.object({
  trades: z.array(DflowTrade).default([]),
  cursor: z.string().nullable().optional(),
});

export type TDflowTrade = z.infer<typeof DflowTrade>;

export async function fetchTradesByMint(inputs: {
  mint: string;
  limit?: number;
  minTs?: number;
  maxTs?: number;
  cursor?: string;
}): Promise<{ trades: TDflowTrade[]; cursor?: string | null }> {
  const params = new URLSearchParams();
  if (inputs.limit != null) params.set("limit", String(inputs.limit));
  if (inputs.minTs != null) params.set("minTs", String(inputs.minTs));
  if (inputs.maxTs != null) params.set("maxTs", String(inputs.maxTs));
  if (inputs.cursor) params.set("cursor", inputs.cursor);

  const base = env.dflowPredictionMarketsBase.replace(/\/+$/, "");
  const url = new URL(
    `/api/v1/trades/by-mint/${inputs.mint}`,
    `${base}/`,
  );
  if (params.toString()) url.search = params.toString();

  const headers: Record<string, string> = {};
  if (env.dflowApiKey) headers["x-api-key"] = env.dflowApiKey;

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DFlow trades ${res.status}: ${body.slice(0, 500)}`);
  }

  const raw = await res.json();
  const parsed = DflowTradesResponse.parse(raw);
  return { trades: parsed.trades, cursor: parsed.cursor ?? undefined };
}
