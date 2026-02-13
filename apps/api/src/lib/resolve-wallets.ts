import { AuthService } from "../auth.js";

export async function resolveRequestedWalletAddresses(
  userId: string,
  walletAddress: string | undefined,
  requestedWallets: string[] | undefined,
): Promise<string[]> {
  if (requestedWallets && requestedWallets.length > 0) {
    const wallets = await AuthService.getUserWallets(userId);
    const walletMap = new Map(
      wallets.map((wallet) => [
        wallet.walletAddress.toLowerCase(),
        wallet.walletAddress,
      ]),
    );
    const resolved = requestedWallets
      .map((address) => address.trim().toLowerCase())
      .map((address) => walletMap.get(address))
      .filter((address): address is string => Boolean(address));
    return Array.from(new Set(resolved));
  }

  if (!walletAddress) return [];
  return [walletAddress];
}
