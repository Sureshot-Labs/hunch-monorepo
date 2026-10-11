/** Static SQL expressions only. Chain evidence has second precision: retaining
 * authorization within that second must not discard a legitimate immediate buy.
 * Compare the earliest executed fill, never observation/recovery time. Retrying
 * the exact submission keeps its original authorization timestamp.
 */
export function copyPurchaseIsTimelySql(
  purchasedAtSql: string,
  retainedAtSql: string,
): string {
  return `${purchasedAtSql} >= date_trunc('second', ${retainedAtSql})`;
}
