// Decisions accepts family IDs but returns concrete revisions. Keep mappings
// explicit: a pinned policy must not silently accept another model/revision.
export const DEFAULT_JEV_MODEL = "typesafe/jev-1.14-20261014";
const JEV_REVISIONS: Record<string, string> = {
  "typesafe/jev-1.13": "typesafe/jev-1.13-20260917",
  "typesafe/jev-1.14": "typesafe/jev-1.14-20261014",
};

export function jevRequestModel(model: string): string {
  return (
    Object.entries(JEV_REVISIONS).find(
      ([, revision]) => revision === model,
    )?.[0] ?? model
  );
}

export function jevResponseModelMatches(
  configured: string,
  actual: string,
): boolean {
  return actual === (JEV_REVISIONS[configured] ?? configured);
}
