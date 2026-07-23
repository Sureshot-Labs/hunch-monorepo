import type {
  AssetRef,
  FundingReasonCode,
  ObservedAsset,
  UsdEstimate,
  ValuedAssetComponent,
} from "../funding/domain/types.js";
import type { PriceAdapter } from "../funding/domain/contracts.js";
import { canonicalAssetKey } from "./canonical.js";

export const EXACT_STABLE_PRICE_POLICY_ID = "exact-stable-policy-v1";
export const STABLE_IMPAIRED_PRICE_POLICY_ID = "stable-impaired-v1";

export type StableImpairmentState =
  | Readonly<{ status: "healthy" }>
  | Readonly<{
      status: "impaired";
      reasonCode: FundingReasonCode;
      observedAt: string;
    }>;

export function resolveStableImpairmentState(
  pricePolicyId: string,
  observedAt: string,
): StableImpairmentState {
  return pricePolicyId === STABLE_IMPAIRED_PRICE_POLICY_ID
    ? {
        status: "impaired",
        reasonCode: "trusted_price_unavailable",
        observedAt,
      }
    : { status: "healthy" };
}

export type AssetValuationPolicy = Readonly<{
  asset: AssetRef;
  category: "cash" | "token" | "in_transit";
  pricePolicyId: string;
  maximumObservationAgeMs: number;
  executionEligibility: ValuedAssetComponent["executionEligibility"];
}>;

export class ExactStablePriceAdapter implements PriceAdapter {
  readonly adapterId = EXACT_STABLE_PRICE_POLICY_ID;
  readonly #states: ReadonlyMap<string, StableImpairmentState>;

  constructor(states: ReadonlyMap<string, StableImpairmentState>) {
    this.#states = states;
  }

  async value(input: {
    amount: ObservedAsset["amount"];
    observedAt: string;
    policyId: string;
  }): Promise<UsdEstimate | null> {
    if (input.policyId !== this.adapterId) return null;
    const state = this.#states.get(canonicalAssetKey(input.amount.asset));
    if (!state || state.status === "impaired") return null;
    return {
      value: formatStableAmount(input.amount.raw, input.amount.asset.decimals),
      asOf: input.observedAt,
      priceSource: this.adapterId,
      confidence: "high",
      policyId: input.policyId,
    };
  }
}

function formatStableAmount(raw: string, decimals: number): string {
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`invalid raw stable amount: ${raw}`);
  }
  const rawValue = BigInt(raw);
  const divisor = 10n ** BigInt(decimals);
  const whole = rawValue / divisor;
  if (decimals === 0) return whole.toString();
  const fraction = (rawValue % divisor)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export class ValuationService {
  readonly #policies: ReadonlyMap<string, AssetValuationPolicy>;
  readonly #adapters: readonly PriceAdapter[];
  readonly #stableStates: ReadonlyMap<string, StableImpairmentState>;

  constructor(inputs: {
    policies: readonly AssetValuationPolicy[];
    adapters: readonly PriceAdapter[];
    stableStates?: ReadonlyMap<string, StableImpairmentState>;
  }) {
    this.#policies = new Map(
      inputs.policies.map((policy) => [
        canonicalAssetKey(policy.asset),
        policy,
      ]),
    );
    this.#adapters = inputs.adapters;
    this.#stableStates = inputs.stableStates ?? new Map();
  }

  async value(
    observations: readonly ObservedAsset[],
    now = new Date(),
  ): Promise<readonly ValuedAssetComponent[]> {
    return Promise.all(
      observations.map(async (observation) => {
        const policy = this.#policies.get(
          canonicalAssetKey(observation.amount.asset),
        );
        const base = {
          componentId: observation.componentId,
          location: observation.location,
          amount: observation.amount,
          observedAt: observation.observedAt,
          observationFreshness: observation.observationFreshness,
          observationError: observation.observationError,
        } as const;

        if (!policy || observation.metadataRisk === "spam") {
          return {
            ...base,
            category: policy?.category ?? "token",
            estimatedUsd: null,
            valuationEligibility: "excluded",
            executionEligibility: "ineligible",
            reasonCodes: [
              observation.metadataRisk === "spam"
                ? "asset_metadata_spam"
                : "asset_not_registered",
            ],
          } satisfies ValuedAssetComponent;
        }

        const observedAtMs = Date.parse(observation.observedAt);
        const stale =
          observation.observationFreshness !== "fresh" ||
          !Number.isFinite(observedAtMs) ||
          now.getTime() - observedAtMs > policy.maximumObservationAgeMs;
        if (stale) {
          const ambiguousReason =
            observation.observationError?.code ===
            "ambiguous_duplicate_observation"
              ? (["ambiguous_duplicate_observation"] as const)
              : [];
          return {
            ...base,
            category: policy.category,
            estimatedUsd: null,
            observationFreshness: "stale",
            valuationEligibility: "stale",
            executionEligibility: "temporarily_unavailable",
            reasonCodes: ["balance_observation_stale", ...ambiguousReason],
          } satisfies ValuedAssetComponent;
        }

        const stableState = this.#stableStates.get(
          canonicalAssetKey(policy.asset),
        );
        if (stableState?.status === "impaired") {
          return {
            ...base,
            category: policy.category,
            estimatedUsd: null,
            valuationEligibility: "unpriced",
            executionEligibility: "ineligible",
            reasonCodes: ["stable_asset_impaired", stableState.reasonCode],
          } satisfies ValuedAssetComponent;
        }

        let estimate: UsdEstimate | null = null;
        for (const adapter of this.#adapters) {
          estimate = await adapter.value({
            amount: observation.amount,
            observedAt: observation.observedAt,
            policyId: policy.pricePolicyId,
          });
          if (estimate) break;
        }
        if (!estimate) {
          return {
            ...base,
            category: policy.category,
            estimatedUsd: null,
            valuationEligibility: "unpriced",
            executionEligibility: policy.executionEligibility,
            reasonCodes: ["trusted_price_unavailable"],
          } satisfies ValuedAssetComponent;
        }

        const priceAt = Date.parse(estimate.asOf);
        const priceStale =
          !Number.isFinite(priceAt) ||
          now.getTime() - priceAt > policy.maximumObservationAgeMs;
        if (priceStale) {
          return {
            ...base,
            category: policy.category,
            estimatedUsd: estimate,
            valuationEligibility: "stale",
            executionEligibility: "temporarily_unavailable",
            reasonCodes: ["trusted_price_stale"],
          } satisfies ValuedAssetComponent;
        }

        return {
          ...base,
          category: policy.category,
          estimatedUsd: estimate,
          valuationEligibility: "included",
          executionEligibility: policy.executionEligibility,
          reasonCodes: [],
        } satisfies ValuedAssetComponent;
      }),
    );
  }
}
