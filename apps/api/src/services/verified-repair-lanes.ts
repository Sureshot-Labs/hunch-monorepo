/** No API env, providers, or database imports: scheduling only. The finance
 * worker's existing single-flight owns each invocation through completion.
 */
export function createVerifiedRepairLaneRunner() {
  let copiesFirst = true;
  return async function runLanes<Purchases, Copies>(input: {
    purchases: () => Promise<Purchases>;
    copies: () => Promise<Copies>;
    hasBudget: () => boolean;
  }): Promise<{
    purchases: Purchases | null;
    copies: Copies | null;
    firstLane: "purchases" | "copies";
  }> {
    const firstLane = copiesFirst ? "copies" : "purchases";
    // Advance before awaiting so a failed lane does not always run first after
    // retries. A process restart favors unrecorded copies for its first run.
    copiesFirst = !copiesFirst;
    let purchases: Purchases | null = null;
    let copies: Copies | null = null;
    const lanes =
      firstLane === "copies"
        ? (["copies", "purchases"] as const)
        : (["purchases", "copies"] as const);
    for (const lane of lanes) {
      // Never claim fresh work merely to defer it after another lane spent the
      // shared allowance. Do not split the budget: one proof may need all of it.
      if (!input.hasBudget()) break;
      if (lane === "copies") copies = await input.copies();
      else purchases = await input.purchases();
    }
    return { purchases, copies, firstLane };
  };
}
