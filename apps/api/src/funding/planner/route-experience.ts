import type { FundingReasonCode } from "../domain/types.js";
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
import { compareUnsignedDecimals } from "../../account-value/decimal.js";

export type RouteExperienceObservation = Readonly<{
  observationCount: number;
  succeededCount: number;
  p95LatencyMs: number | null;
}>;

export type RouteExperienceClassification = Readonly<{
  mode: "inline_funding" | "prepare_first" | "unavailable";
  evidence: RouteExperienceObservation | null;
  successBps: number | null;
  reasonCodes: readonly FundingReasonCode[];
}>;

export type RouteExperienceRoutePolicy = FundingRuntimePolicy["routes"][number];

export function classifyRouteExperience(
  input: Readonly<{
    route: RouteExperienceRoutePolicy;
    global: FundingRuntimePolicy["routeExperience"];
    observation: RouteExperienceObservation | null;
  }>,
): RouteExperienceClassification {
  if (!input.route.enabled) {
    return {
      mode: "unavailable",
      evidence: input.observation,
      successBps: null,
      reasonCodes: ["route_not_allowlisted"],
    };
  }
  if (input.route.experienceMode === "prepare_first") {
    return {
      mode: "prepare_first",
      evidence: input.observation,
      successBps: null,
      reasonCodes: [],
    };
  }

  const observation = input.observation;
  const minimumCount = Math.max(
    input.route.minimumInlineObservationCount,
    input.global.minimumInlineObservationCount,
  );
  if (
    !observation ||
    observation.observationCount < minimumCount ||
    observation.p95LatencyMs == null
  ) {
    return {
      mode: "prepare_first",
      evidence: observation,
      successBps: observation
        ? Math.floor(
            (observation.succeededCount * 10_000) /
              Math.max(1, observation.observationCount),
          )
        : null,
      reasonCodes: ["provider_status_unknown"],
    };
  }

  const successBps = Math.floor(
    (observation.succeededCount * 10_000) / observation.observationCount,
  );
  if (
    observation.p95LatencyMs > input.global.maximumInlineP95Ms ||
    successBps < input.global.minimumInlineSuccessBps
  ) {
    return {
      mode: "prepare_first",
      evidence: observation,
      successBps,
      reasonCodes: [],
    };
  }
  return {
    mode: "inline_funding",
    evidence: observation,
    successBps,
    reasonCodes: [],
  };
}

export function routeAmountBand(estimatedUsd: string | null): string {
  if (estimatedUsd == null || !/^(0|[1-9]\d*)(\.\d+)?$/.test(estimatedUsd)) {
    return "unknown";
  }
  if (compareUnsignedDecimals(estimatedUsd, "100") < 0) {
    return "usd_lt_100";
  }
  if (compareUnsignedDecimals(estimatedUsd, "500") <= 0) {
    return "usd_100_500";
  }
  return "usd_gt_500";
}
