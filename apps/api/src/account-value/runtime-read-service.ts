import { pool } from "../db.js";
import { buildAccountValueReadModel } from "./runtime-service.js";
import { createAccountValueSnapshotLoader } from "./snapshot-loader.js";
import { accountValueDisplayPriceAdapters } from "./display-price-adapters.js";
export { estimateNativeSolUsd } from "./display-price-adapters.js";

export const accountValueReadService = createAccountValueSnapshotLoader(
  (userId) =>
    buildAccountValueReadModel({
      pool,
      userId,
      additionalPriceAdapters: accountValueDisplayPriceAdapters,
    }),
  { maxEntries: 500, ttlMs: 2_000 },
);
