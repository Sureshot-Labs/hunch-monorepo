import type { JsonObject } from "../domain/types.js";
import type { SourcePlanningEvidence } from "../planner/destination-adapters.js";

export const POLYMARKET_FUNDING_SOURCE_ADAPTER_ID =
  "polymarket_funding_router_v1";
export const POLYMARKET_FUNDING_EVIDENCE_REVISION =
  "polymarket_funding_snapshot_v1";

export type PolymarketRouterFundingSnapshot = Readonly<{
  signerAddress: string;
  depositWallet: string;
  depositPusdRaw: string;
  depositLockedRaw: string;
  depositUsdceRaw: string;
  signerPusdRaw: string;
  signerUsdceRaw: string;
  fundingCapRaw: string;
  routerAddress: string;
  routerNonceRaw: string;
  depositRouterUsdceAllowanceRaw: string;
  routerPusdAllowanceRaw: string;
  routerUsdceAllowanceRaw: string;
  clobPusdRaw: string | null;
  observedAt: string;
}>;

const STRING_FIELDS = [
  "signerAddress",
  "depositWallet",
  "depositPusdRaw",
  "depositLockedRaw",
  "depositUsdceRaw",
  "signerPusdRaw",
  "signerUsdceRaw",
  "fundingCapRaw",
  "routerAddress",
  "routerNonceRaw",
  "depositRouterUsdceAllowanceRaw",
  "routerPusdAllowanceRaw",
  "routerUsdceAllowanceRaw",
  "observedAt",
] as const;

export function polymarketFundingEvidence(
  snapshot: PolymarketRouterFundingSnapshot,
): SourcePlanningEvidence {
  return {
    adapterId: POLYMARKET_FUNDING_SOURCE_ADAPTER_ID,
    schemaRevision: POLYMARKET_FUNDING_EVIDENCE_REVISION,
    payload: snapshot as JsonObject,
  };
}

export function parsePolymarketFundingEvidence(
  evidence: SourcePlanningEvidence | null,
): PolymarketRouterFundingSnapshot | null {
  if (
    evidence?.adapterId !== POLYMARKET_FUNDING_SOURCE_ADAPTER_ID ||
    evidence.schemaRevision !== POLYMARKET_FUNDING_EVIDENCE_REVISION
  ) {
    return null;
  }
  const payload = evidence.payload;
  if (
    STRING_FIELDS.some(
      (field) =>
        typeof payload[field] !== "string" || payload[field].length === 0,
    ) ||
    (payload.clobPusdRaw !== null && typeof payload.clobPusdRaw !== "string")
  ) {
    return null;
  }
  return payload as PolymarketRouterFundingSnapshot;
}
