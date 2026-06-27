export type AggMarketCredentialSource = "AGG_APP_ID";

export type AggMarketCredential = {
  apiKey: string | null;
  appId: string;
  source: AggMarketCredentialSource;
};

export function resolveAggMarketCredential(
  env: NodeJS.ProcessEnv = process.env,
): AggMarketCredential | null {
  const apiKey = env.AGG_API_KEY?.trim();
  const appId = env.AGG_APP_ID?.trim();
  if (appId) {
    return { apiKey: apiKey ?? null, appId, source: "AGG_APP_ID" };
  }

  return null;
}
