export function telegramFundingUnavailableLines(input: {
  reasonCodes: readonly string[];
  venue: string;
  balance?: { requiredUsd: string; availableUsd: string; shortfallUsd: string };
}): string[] {
  const reasons = input.reasonCodes;
  const lines: string[] = [];
  if (input.balance) {
    lines.push(
      `Required on ${input.venue}: $${input.balance.requiredUsd} including trade fees. Available there: $${input.balance.availableUsd}. To move there: $${input.balance.shortfallUsd}.`,
      "This is the venue shortfall, not necessarily an amount you need to deposit.",
    );
  }
  lines.push(
    reasons.includes("destination_unavailable")
      ? "Finish wallet setup in Hunch, then retry. Bot trading is not required."
      : reasons.includes("funding_planner_provider_unavailable") ||
          reasons.includes("provider_unavailable") ||
          reasons.includes("provider_status_unknown")
        ? "The network or route check did not complete. Fee coverage could not be confirmed; adding funds is not a verified solution. Retry the check."
        : reasons.includes("insufficient_gas")
          ? "A funding source needs native gas and fee sponsorship was not confirmed. Open Hunch to check the source wallet and exact fee before adding funds."
          : "No usable funding route was verified. Open Hunch to review your balances and route details, or retry the check.",
    "Nothing was submitted; no background check is running.",
  );
  return lines;
}
