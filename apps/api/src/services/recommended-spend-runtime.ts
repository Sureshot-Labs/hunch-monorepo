import { pool } from "../db.js";
import { AuthService } from "../auth.js";
import { env } from "../env.js";
import { buildAccountValueReadModel } from "../account-value/runtime-service.js";
import { createAccountValueSnapshotLoader } from "../account-value/snapshot-loader.js";
import { WalletPreparationRuntimeService } from "../funding/preparation/runtime-service.js";
import { findTradeMarketById, isOrderable } from "./api-trading-market-repo.js";
import { venueLifecycleAllowsTradingAction } from "./venue-lifecycle.js";
import { loadPolymarketQuoteContext } from "./polymarket-quote.js";
import { loadLimitlessBook } from "./limitless-book.js";
import {
  createRecommendedSpendService,
  type ReadySpendFunds,
} from "./recommended-spend.js";
import {
  selectedReadyCollateral,
  readyForDirectCollateral,
} from "./recommended-spend-account.js";
import { polymarketL2Request } from "./polymarket-clob-l2.js";
import { readRecommendedSpendOrderPage } from "./recommended-spend-orders.js";

const accountReader = createAccountValueSnapshotLoader((userId) =>
  buildAccountValueReadModel({ pool, userId }),
);
const readiness = new WalletPreparationRuntimeService(pool);
const unavailable = (
  status: ReadySpendFunds["status"],
  walletId: string | null = null,
): ReadySpendFunds => ({ status, walletId, availableRaw: null, asOf: null });

export const recommendedSpendService = createRecommendedSpendService({
  market: (id) => findTradeMarketById(pool, id),
  orderable: async (market) =>
    isOrderable(market) &&
    (await venueLifecycleAllowsTradingAction(pool, market.venue, "BUY")),
  polyContext: (tokenId) => loadPolymarketQuoteContext(pool, { tokenId }),
  limitlessBook: loadLimitlessBook,
  funds: async (input, user, market) => {
    const wallets = (await AuthService.getUserWallets(user.userId)).filter(
      (wallet) => wallet.isVerified && wallet.walletType === "ethereum",
    );
    const selected = input.walletId
      ? wallets.filter((wallet) => wallet.id === input.walletId)
      : user.signer
        ? wallets.filter(
            (wallet) =>
              wallet.walletAddress.toLowerCase() === user.signer?.toLowerCase(),
          )
        : wallets;
    if (selected.length !== 1)
      return unavailable(
        selected.length > 1
          ? "wallet_selection_required"
          : "wallet_unavailable",
      );
    const wallet = selected[0];
    if (!wallet) return unavailable("wallet_unavailable");
    const [account, destinations] = await Promise.all([
      accountReader.load(user.userId),
      readiness.frozenDestinations(
        {
          accountId: user.userId,
          purpose: "buy",
          marketContextId: market.id,
          marketClass: null,
          controllerWalletRef: wallet.id,
          positionActionRef: null,
          compatibleVenueBindingOptionIds: null,
        },
        market,
        true,
      ),
    ]);
    const matching = destinations.filter((row) => row.venueId === market.venue);
    if (matching.length !== 1)
      return unavailable("wallet_selection_required", wallet.id);
    const destination = matching[0];
    if (!destination) return unavailable("wallet_unavailable", wallet.id);
    if (
      !readyForDirectCollateral(destination.preparation, Date.now()) ||
      destination.target.kind !== "owned_location"
    )
      return unavailable("wallet_unavailable", wallet.id);
    const address = destination.target.location.details.address;
    if (typeof address !== "string")
      return unavailable("wallet_unavailable", wallet.id);
    let liveLockedRaw = 0n;
    if (market.venue === "polymarket") {
      const creds = await AuthService.getVenueCredentials(
        user.userId,
        "polymarket",
        wallet.walletAddress,
      );
      if (!creds?.apiKey || !creds.apiSecret || !creds.apiPassphrase)
        return unavailable("wallet_unavailable", wallet.id);
      const orderIds = new Set<string>();
      const seen = new Set<string>();
      let cursor = "";
      const deadline = Date.now() + 2_000;
      do {
        if (Date.now() >= deadline || seen.has(cursor))
          return unavailable("balance_unavailable", wallet.id);
        seen.add(cursor);
        const response = await polymarketL2Request({
          baseUrl: env.polymarketClobBase,
          timeoutMs: Math.max(1, deadline - Date.now()),
          address: wallet.walletAddress,
          creds: {
            apiKey: creds.apiKey,
            apiSecret: creds.apiSecret,
            apiPassphrase: creds.apiPassphrase,
          },
          method: "GET",
          requestPath: `/data/orders${cursor ? `?next_cursor=${encodeURIComponent(cursor)}` : ""}`,
        });
        if (!response.ok) return unavailable("balance_unavailable", wallet.id);
        const page = readRecommendedSpendOrderPage(
          response.payload,
          address,
          orderIds,
        );
        liveLockedRaw += page.lockedRaw;
        cursor = page.nextCursor;
      } while (cursor && cursor !== "LTE=");
    }
    const allowance =
      destination.preparation.evidence.facts.directCollateralAllowanceRaw;
    if (
      market.venue === "limitless" &&
      (typeof allowance !== "string" || !/^\d+$/.test(allowance))
    )
      return unavailable("balance_unavailable", wallet.id);
    const selectedCash = selectedReadyCollateral({
      account,
      address,
      asset: destination.requiredAsset,
      observedRaw: destination.spendability.observedAmount.raw,
      liveLockedRaw,
      allowanceRaw:
        market.venue === "limitless" ? BigInt(allowance as string) : undefined,
      now: Date.now(),
    });
    return selectedCash
      ? {
          status: "ready",
          walletId: wallet.id,
          ...selectedCash,
          openOrderCoverage:
            market.venue === "limitless"
              ? "hunch_recorded"
              : "venue_live_and_hunch",
        }
      : unavailable("balance_unavailable", wallet.id);
  },
});
