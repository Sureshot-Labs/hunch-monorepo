export function telegramFundingUnavailableLines(input: {
  reasonCodes: readonly string[];
  venue: string;
  balance?: { requiredUsd: string; availableUsd: string; shortfallUsd: string };
}): string[] {
  const reasons = input.reasonCodes;
  const lines: string[] = [];
  if (input.balance) {
    lines.push(
      `Required on ${input.venue}: $${input.balance.requiredUsd} including fees and the quote's price-movement allowance. Available there: $${input.balance.availableUsd}. To move there: $${input.balance.shortfallUsd}.`,
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

export function telegramDepositShortfallLines(input: {
  venue: string;
  balance?: { requiredUsd: string; availableUsd: string; shortfallUsd: string };
}): string[] {
  return [
    ...(input.balance
      ? [
          `Required on ${input.venue}: $${input.balance.requiredUsd} including fees and the quote's price-movement allowance.`,
          `Available there: $${input.balance.availableUsd}. Shortfall: $${input.balance.shortfallUsd}.`,
        ]
      : []),
    "No usable route from your other balances was found. Add funds or review a smaller Buy in Hunch. The market minimum still applies.",
    "Retry balance check refreshes the balance. Nothing was submitted.",
  ];
}

export function telegramQuoteFailureCopy(code: string): {
  heading: string;
  lines: string[];
} {
  if (code === "market_orderbook_unavailable") {
    return {
      heading: "Trading this outcome is currently unavailable.",
      lines: [
        "The venue has no available orderbook for this outcome. Adding funds will not fix this. Return to the market or choose another market. Nothing was submitted.",
      ],
    };
  }
  if (
    code === "market_not_accepting_orders" ||
    code === "market_not_orderable"
  ) {
    return {
      heading: "The market is not accepting orders.",
      lines: [
        "Trading is currently unavailable on the venue. Adding funds will not fix this. Nothing was submitted.",
      ],
    };
  }
  if (code === "quote_expired" || code === "intent_expired") {
    return {
      heading: "Quote expired.",
      lines: [
        "Refresh the quote and review the current price before confirming. Nothing was submitted.",
      ],
    };
  }
  return {
    heading: "Could not check the current price.",
    lines: [
      "The price check did not complete. Nothing was submitted. Return to the market to retry; adding funds is not a verified solution.",
    ],
  };
}
