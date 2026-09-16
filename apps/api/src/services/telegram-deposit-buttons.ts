/** Shared presentation only: callbacks and route availability stay with callers. */
export function telegramDepositButtonLabel(
  assets: readonly string[],
  network: string,
): string {
  return `${assets.join(" / ")} · ${network}`;
}

export function telegramDepositButtonRows<T>(buttons: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }
  return rows;
}
