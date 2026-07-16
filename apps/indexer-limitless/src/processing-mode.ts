export type LimitlessProcessingMode = "discovery" | "hot";

export type LimitlessProcessingCapabilities = {
  publishLiveUpdates: boolean;
  refreshOrderbookTop: boolean;
};

export function resolveLimitlessProcessingCapabilities(input: {
  mode: LimitlessProcessingMode;
  refreshOrderbookTop?: boolean;
}): LimitlessProcessingCapabilities {
  // Discovery owns durable market metadata only. Live quotes remain the
  // responsibility of hot/WS/on-demand refresh paths.
  if (input.mode === "discovery") {
    return {
      publishLiveUpdates: false,
      refreshOrderbookTop: false,
    };
  }

  return {
    publishLiveUpdates: true,
    refreshOrderbookTop: input.refreshOrderbookTop ?? true,
  };
}
