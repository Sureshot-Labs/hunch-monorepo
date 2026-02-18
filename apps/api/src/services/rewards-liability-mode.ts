export type RewardsLiabilityMode = "event_time_frozen";

export function resolveRewardsLiabilityMode(): RewardsLiabilityMode {
  return "event_time_frozen";
}

export function isFrozenLiabilityModeActive(): true {
  return true;
}
