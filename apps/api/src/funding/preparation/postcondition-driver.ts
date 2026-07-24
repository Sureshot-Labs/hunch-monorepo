import type { Pool } from "@hunch/infra";

export interface FundingPostconditionDriver {
  readonly driverId: string;
  pollOperation(
    pool: Pool,
    operationId: string,
    now: Date,
  ): Promise<Readonly<{ postconditionsPolled: number }>>;
}

export async function pollFundingPostconditions(
  drivers: readonly FundingPostconditionDriver[],
  pool: Pool,
  operationId: string,
  now: Date,
): Promise<Readonly<{ postconditionsPolled: number }>> {
  let postconditionsPolled = 0;
  for (const driver of drivers) {
    postconditionsPolled += (await driver.pollOperation(pool, operationId, now))
      .postconditionsPolled;
  }
  return { postconditionsPolled };
}
