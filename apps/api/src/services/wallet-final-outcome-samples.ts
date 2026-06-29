export const WALLET_FINAL_OUTCOME_SAMPLE_ACTIONS = [
  "OPENED",
  "INCREASED",
  "BUY",
] as const;

const WALLET_FINAL_OUTCOME_SAMPLE_ACTION_SET = new Set<string>(
  WALLET_FINAL_OUTCOME_SAMPLE_ACTIONS,
);

export function isWalletFinalOutcomeSampleAction(
  action: string | null | undefined,
): boolean {
  return WALLET_FINAL_OUTCOME_SAMPLE_ACTION_SET.has(
    action?.trim().toUpperCase() ?? "",
  );
}

export function buildWalletFinalOutcomeSampleActionSql(
  actionExpression: string,
): string {
  const actions = WALLET_FINAL_OUTCOME_SAMPLE_ACTIONS.map(
    (action) => `'${action}'`,
  ).join(", ");

  // Final-outcome samples are entry-like actions. Exits stay in ledger PnL only.
  return `upper(coalesce(${actionExpression}, '')) in (${actions})`;
}
