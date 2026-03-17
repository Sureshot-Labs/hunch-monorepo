import { AuthService } from "../auth.js";
import { pool } from "../db.js";

type ResolveRequestedWalletAddressesOptions = {
  allowPolymarketFunders?: boolean;
};

async function loadAllowedPolymarketFunderMap(
  userId: string,
  requestedWallets: string[],
): Promise<Map<string, string>> {
  if (requestedWallets.length === 0) return new Map();

  const normalizedRequested = requestedWallets
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean);
  if (normalizedRequested.length === 0) return new Map();

  const { rows } = await pool.query<{ funder_address: string }>(
    `
      select distinct funder_address
      from user_venue_credentials
      where user_id = $1
        and venue = 'polymarket'
        and is_active = true
        and funder_address is not null
        and lower(funder_address) = any($2::text[])
    `,
    [userId, normalizedRequested],
  );

  return new Map(
    rows.map((row) => [
      row.funder_address.toLowerCase(),
      row.funder_address,
    ]),
  );
}

export async function resolveRequestedWalletAddresses(
  userId: string,
  walletAddress: string | undefined,
  requestedWallets: string[] | undefined,
  options: ResolveRequestedWalletAddressesOptions = {},
): Promise<string[]> {
  if (requestedWallets && requestedWallets.length > 0) {
    const wallets = await AuthService.getUserWallets(userId);
    const walletMap = new Map(
      wallets.map((wallet) => [
        wallet.walletAddress.toLowerCase(),
        wallet.walletAddress,
      ]),
    );
    if (options.allowPolymarketFunders) {
      const funderMap = await loadAllowedPolymarketFunderMap(
        userId,
        requestedWallets,
      );
      for (const [normalized, canonical] of funderMap.entries()) {
        if (!walletMap.has(normalized)) {
          walletMap.set(normalized, canonical);
        }
      }
    }
    const resolved = requestedWallets
      .map((address) => address.trim().toLowerCase())
      .map((address) => walletMap.get(address))
      .filter((address): address is string => Boolean(address));
    return Array.from(new Set(resolved));
  }

  if (!walletAddress) return [];
  return [walletAddress];
}
