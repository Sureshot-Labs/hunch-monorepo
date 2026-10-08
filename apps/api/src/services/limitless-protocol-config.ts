/** Optional venue-only configuration; safe in research/sidecar import graphs. */
export function resolveLimitlessPositionContract(
  source: NodeJS.ProcessEnv = process.env,
): string {
  return (
    source.LIMITLESS_CONDITIONAL_TOKENS_ADDRESS?.trim() ||
    "0xc9c98965297bc527861c898329ee280632b76e18"
  );
}
