import type { PoolClient } from "@hunch/infra";

type FundingAuthorizationReservationScope = Readonly<{
  authorizationId: string;
  userId: string;
}>;

const FUNDING_AUTHORIZATION_RESERVATION_SCOPE_KEY = `
  funding_authorization.wallet_chain || ':' ||
  lower(funding_authorization.wallet_address) || ':' ||
  funding_authorization.security_class
`;

export async function lockFundingAuthorizationReservationScope(
  client: PoolClient,
  input: FundingAuthorizationReservationScope,
): Promise<boolean> {
  const locked = await client.query(
    `select pg_advisory_xact_lock(
              hashtextextended(
                ${FUNDING_AUTHORIZATION_RESERVATION_SCOPE_KEY},
                0
              )
            )
       from telegram_funding_authorizations funding_authorization
      where funding_authorization.id = $1::uuid
        and funding_authorization.user_id = $2::uuid
        and funding_authorization.security_class = 'routed_value_movement'`,
    [input.authorizationId, input.userId],
  );
  return locked.rowCount === 1;
}

export async function tryLockFundingAuthorizationReservationScope(
  client: PoolClient,
  input: FundingAuthorizationReservationScope,
): Promise<boolean> {
  const locked = await client.query<{ locked: boolean }>(
    `select pg_try_advisory_xact_lock(
              hashtextextended(
                ${FUNDING_AUTHORIZATION_RESERVATION_SCOPE_KEY},
                0
              )
            ) as locked
       from telegram_funding_authorizations funding_authorization
      where funding_authorization.id = $1::uuid
        and funding_authorization.user_id = $2::uuid
        and funding_authorization.security_class = 'routed_value_movement'`,
    [input.authorizationId, input.userId],
  );
  return locked.rows[0]?.locked === true;
}
