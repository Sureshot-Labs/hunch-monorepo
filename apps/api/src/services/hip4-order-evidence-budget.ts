import type { Pool } from "@hunch/infra";
import {
  hip4BackgroundRepairWeightLimit,
  hip4BackgroundRequestWeightLimit,
  type Hip4Environment,
  type Hip4ReadPolicy,
} from "@hunch/shared";
import { reserveHip4Request } from "./hip4-repository.js";

/** Existing-order status costs two and keeps its financial-drain priority.
 * Heavier periodic evidence must share the ordinary background quota instead
 * of spending the reserve intended for reviewed financial actions. Explicit
 * owned repair and the post-submit fast path never opt into periodic work. */
export function admitHip4OrderEvidenceRequest(
  db: Pick<Pool, "query">,
  input: {
    environment: Hip4Environment;
    weight: number;
    policy: Hip4ReadPolicy;
    periodic: boolean;
  },
) {
  return reserveHip4Request(
    db,
    input.environment,
    input.weight,
    input.policy.requestWeightPerMinute,
    input.periodic && input.weight > 2
      ? {
          scope: "background_repair",
          maximum: hip4BackgroundRepairWeightLimit(input.policy),
          backgroundMaximum: hip4BackgroundRequestWeightLimit(input.policy),
        }
      : undefined,
  );
}
