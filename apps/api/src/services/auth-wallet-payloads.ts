import type { User, UserWallet } from "../auth.js";
import { PrivyService, type PrivyWalletProfile } from "../privy-service.js";

function normalizeWalletType(input?: string): string {
  const raw = (input ?? "").trim().toLowerCase();
  return raw.length ? raw : "ethereum";
}

function normalizeWalletAddressForType(
  walletType: string,
  address: string,
): string {
  const trimmed = address.trim();
  if (walletType === "ethereum") return trimmed.toLowerCase();
  return trimmed;
}

function buildPrivyWalletProfileLookup(
  walletProfiles: PrivyWalletProfile[] | null | undefined,
): Map<string, PrivyWalletProfile> {
  const lookup = new Map<string, PrivyWalletProfile>();
  for (const profile of walletProfiles ?? []) {
    const walletType = normalizeWalletType(profile.walletType);
    const normalizedAddress = normalizeWalletAddressForType(
      walletType,
      profile.address,
    );
    lookup.set(`${walletType}:${normalizedAddress}`, profile);
  }
  return lookup;
}

export function buildAuthWalletPayloads(
  wallets: UserWallet[],
  walletProfiles?: PrivyWalletProfile[] | null,
) {
  const walletProfileLookup = buildPrivyWalletProfileLookup(walletProfiles);
  return wallets.map((wallet) => {
    const walletType = normalizeWalletType(wallet.walletType);
    const normalizedAddress = normalizeWalletAddressForType(
      walletType,
      wallet.walletAddress,
    );
    const profile = walletProfileLookup.get(
      `${walletType}:${normalizedAddress}`,
    );
    const isEmbeddedWallet = profile?.source === "embedded";
    const isSmartWallet = profile?.source === "smart";
    const isInternalWallet = profile?.isInternalWallet;

    return {
      id: wallet.id,
      walletAddress: wallet.walletAddress,
      walletType: wallet.walletType,
      walletSource: profile?.source ?? "unknown",
      isEmbeddedWallet,
      isSmartWallet,
      isInternalWallet,
      name: isInternalWallet ? "Trading Wallet" : wallet.name,
      isPrimary: wallet.isPrimary,
      isVerified: wallet.isVerified,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  });
}

export async function loadPrivyWalletProfilesForUser(
  user: Pick<User, "id" | "privyUserId">,
  log?: {
    warn: (obj: unknown, message: string) => void;
  },
): Promise<PrivyWalletProfile[] | null> {
  if (!user.privyUserId) return null;
  try {
    const privyUser = await PrivyService.getUserById(user.privyUserId);
    return PrivyService.classifyWallets(privyUser);
  } catch (error) {
    log?.warn(
      { error, userId: user.id, privyUserId: user.privyUserId },
      "Failed to enrich auth wallets with Privy wallet profiles",
    );
    return null;
  }
}
