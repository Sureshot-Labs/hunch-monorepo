import { pool } from "../db.js";
import { TraderRepository } from "../repos/trader-collections.js";
import {
  calculateWalletCloses,
  RecentCloseCache,
} from "./wallet-recent-closes.js";

const repo = new TraderRepository(pool);
export const walletRecentCloses = new RecentCloseCache((id, end, signal) =>
  calculateWalletCloses(repo, id, end, signal),
);

// Decorate both cache hits and misses after reading the base profile. Never
// freeze a preparing status inside the longer-lived, personalized profile cache.
export function withWalletRecentCloses(body: string) {
  const base: {
    ok: true;
    wallet: { walletId: string; chain: string; [key: string]: unknown };
  } = JSON.parse(body);
  return {
    ...base,
    wallet: {
      ...base.wallet,
      recentCloses: walletRecentCloses.read(
        base.wallet.walletId,
        base.wallet.chain,
      ),
    },
  };
}
