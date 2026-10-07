import {
  hasUsableTopOfBook,
  type FreshMarketPriceMarketState,
} from "@hunch/infra";

export function holderResearchPriceCheckDiagnostics(
  state: FreshMarketPriceMarketState,
  timedOut: boolean,
  nowMs = Date.now(),
) {
  const tops = state.observedTops ?? state.tops;
  const age = (side: "YES" | "NO") =>
    tops[side] ? Math.max(0, nowMs - Date.parse(tops[side].asOf)) : null;
  return {
    marketId: state.marketId,
    fresh: state.fresh,
    YES: age("YES"),
    NO: age("NO"),
    usable: {
      YES: hasUsableTopOfBook(tops.YES?.bid, tops.YES?.ask),
      NO: hasUsableTopOfBook(tops.NO?.bid, tops.NO?.ask),
    },
    refresh: state.fresh ? "fresh" : timedOut ? "timed_out" : "incomplete",
  };
}
