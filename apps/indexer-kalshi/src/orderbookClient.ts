import { KalshiClient } from "./kalshiClient.js";
import { KalshiOrderbook } from "./types.js";

const c = new KalshiClient();

export type SideBook = {
  side: "YES" | "NO";
  bestBid: number | null;
  bestAsk: number | null;
  ts: Date;
};

export async function getOrderbookTop(
  marketTicker: string,
): Promise<SideBook[]> {
  const j = await c.get(
    `/trade-api/v2/markets/${encodeURIComponent(marketTicker)}/orderbook`,
  );

  // tolerate oddities gracefully
  const parsed = KalshiOrderbook.safeParse(j);
  const ob = parsed.success
    ? parsed.data.orderbook
    : {
        yes: [],
        no: [],
        yes_dollars: [],
        no_dollars: [] as [string, number][],
      };

  const yesBidC =
    Array.isArray(ob.yes) && ob.yes[0]?.[0] != null ? ob.yes[0][0] : null;
  const noBidC =
    Array.isArray(ob.no) && ob.no[0]?.[0] != null ? ob.no[0][0] : null;

  const yesBid = yesBidC != null ? yesBidC / 100 : null;
  const noBid = noBidC != null ? noBidC / 100 : null;

  // Kalshi gives bids only; asks are complements
  const yesAsk = noBid != null ? Math.max(0, 1 - noBid) : null;
  const noAsk = yesBid != null ? Math.max(0, 1 - yesBid) : null;

  const ts = new Date();
  return [
    { side: "YES", bestBid: yesBid, bestAsk: yesAsk, ts },
    { side: "NO", bestBid: noBid, bestAsk: noAsk, ts },
  ];
}
