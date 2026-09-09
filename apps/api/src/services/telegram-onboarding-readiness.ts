import { z } from "zod";
import type { DbQuery } from "../db.js";
import type { FundingPlanningRuntime } from "../funding/planner/runtime-service.js";
import {
  resolveTelegramFundingManagedWalletIdentity,
  telegramFundingManagedWalletControllerId,
} from "../funding/execution/telegram-funding-managed-wallet.js";
import { resolveTelegramFundingDestination } from "./telegram-funding-route.js";
import { resolveSignalBotTradingPolicyStateFromDb } from "./signal-bot-trading-policy.js";
import type { TelegramBotTradingStatus } from "./telegram-bot-trading.js";
import { resolveTelegramSolanaReceiveChoices } from "./telegram-bot-deposit.js";

export const telegramOnboardingReadinessSchema = z.object({
  version: z.literal(1),
  state: z.enum(["pending", "ready", "blocked"]),
  mode: z.enum(["mini_app", "bot", "account_only"]),
  policyRevision: z.string(),
  walletAddress: z.string().nullable(),
  walletChain: z.literal("ethereum"),
  reasonCode: z.string().nullable(),
  message: z.string().max(240).nullable(),
});

export type TelegramOnboardingReadiness = z.infer<
  typeof telegramOnboardingReadinessSchema
>;
type PolicyState = Awaited<
  ReturnType<typeof resolveSignalBotTradingPolicyStateFromDb>
>;
type ReadinessStatus = Pick<
  TelegramBotTradingStatus,
  | "linked"
  | "userId"
  | "telegramUserId"
  | "preference"
  | "authorizations"
  | "managedSetup"
>;

/** Read-only projection, not a setup job or permission to execute a trade. */
export async function inspectTelegramOnboardingReadiness(input: {
  db: DbQuery;
  runtime: Pick<FundingPlanningRuntime, "destinations" | "capabilities">;
  userId: string;
  policyState: PolicyState;
  status: ReadinessStatus;
  now?: Date;
}): Promise<TelegramOnboardingReadiness> {
  const { policy, policyRevision } = input.policyState;
  const status = input.status;
  const mode =
    policy.miniAppHandoffMode === "always"
      ? "mini_app"
      : status.preference?.desiredEnabled === false
        ? "account_only"
        : "bot";
  let walletAddress: string | null = null;
  const result = (
    state: TelegramOnboardingReadiness["state"],
    reasonCode: string | null,
    message: string | null,
  ): TelegramOnboardingReadiness => ({
    version: 1,
    state,
    mode,
    policyRevision,
    walletAddress,
    walletChain: "ethereum",
    reasonCode,
    message,
  });
  if (
    !status.linked ||
    status.userId !== input.userId ||
    !status.telegramUserId
  ) {
    return result(
      "blocked",
      "telegram_link_required",
      "Sign in to Hunch again to verify your Telegram account.",
    );
  }
  if (mode === "mini_app" && policy.miniAppHandoffContractVersion !== 2) {
    return result(
      "blocked",
      "setup_policy_unavailable",
      "Mini App trading is unavailable. Please try again later.",
    );
  }
  const link = (
    await input.db.query<{ id: string; linked_at: Date }>(
      `select id, linked_at from user_telegram_accounts
     where user_id = $1 and telegram_user_id = $2 limit 1`,
      [input.userId, status.telegramUserId],
    )
  ).rows[0];
  if (!link)
    return result(
      "blocked",
      "telegram_link_required",
      "Sign in to Hunch again to verify your Telegram account.",
    );
  const identityInput = {
    userId: input.userId,
    telegramAccountId: link.id,
    telegramUserId: status.telegramUserId,
  };
  const wallet = await resolveTelegramFundingManagedWalletIdentity(
    input.db,
    identityInput,
  );
  // Pending is bounded even if the client closed before starting preparation.
  // A later explicit retry can still turn blocked into ready from fresh facts.
  const linkAge =
    (input.now ?? new Date()).getTime() - new Date(link.linked_at).getTime();
  const preparing = linkAge >= 0 && linkAge < 60_000;
  const preparationFailure = (reason: string, message: string) =>
    result(preparing ? "pending" : "blocked", reason, message);
  if (!wallet)
    return preparationFailure(
      "receive_wallet_ambiguous",
      "Your receiving wallet could not be verified. Retry wallet setup in Hunch.",
    );
  walletAddress = wallet.walletAddress;
  if (!policy.fundingReceiveEnabled)
    return result(
      "blocked",
      "receive_unavailable",
      "Deposits are temporarily unavailable. Please try again later.",
    );

  try {
    if (
      !(await resolveTelegramSolanaReceiveChoices({
        db: input.db,
        telegramUserId: status.telegramUserId,
      }))
    )
      return preparationFailure(
        "receive_wallet_ambiguous",
        "Finish preparing your Solana receiving wallet in Hunch, then try again. Bot trading is not required.",
      );
    const capabilities = await input.runtime.capabilities();
    const venues = capabilities.destinationVenues.filter(
      (venue) => venue === "polymarket" || venue === "limitless",
    );
    if (capabilities.creationMode !== "on" || venues.length === 0)
      return result(
        "blocked",
        "receive_unavailable",
        "Deposits are temporarily unavailable. Please try again later.",
      );
    // Same resolver and controller binding as TelegramFundingService.open.
    // No session, quote, signer installation or approval is created here.
    const receiveOptions = await input.runtime.destinations(input.userId, {
      purpose: "fund",
      controllerWalletRef: wallet.userWalletId,
    });
    for (const venue of venues) {
      const destination = resolveTelegramFundingDestination({
        controllerWalletId: telegramFundingManagedWalletControllerId(
          wallet,
          venue === "polymarket" ? "evm:137" : "evm:8453",
        ),
        destinations: receiveOptions,
        venueId: venue,
      });
      if (!destination)
        return preparationFailure(
          "receive_unavailable",
          "Finish preparing your receiving wallet in Hunch, then try again. Bot trading is not required.",
        );
    }
    if (mode !== "account_only") {
      // Inspect venue classes without a market/order amount. Zero cash is valid;
      // market price, route quotes and funds are checked by the subsequent Buy.
      // AMM contracts are market-specific and remain checked by the actual Buy.
      const tradeVenues =
        mode === "bot"
          ? venues.filter((venue) => policy.tradingVenues.includes(venue))
          : venues;
      if (!policy.tradingEnabled || tradeVenues.length === 0)
        return result(
          "blocked",
          "setup_policy_unavailable",
          "Trading is temporarily unavailable. Deposits do not enable bot access.",
        );
      const scopes = tradeVenues.flatMap((venue) =>
        (venue === "polymarket"
          ? ["standard", "neg_risk"]
          : ["clob", "clob_neg_risk"]
        ).map((marketClass) => ({ venue, marketClass })),
      );
      const inspections = await Promise.all(
        scopes.map(async (scope) => ({
          ...scope,
          options: await input.runtime.destinations(input.userId, {
            purpose: "buy",
            marketClass: scope.marketClass,
            controllerWalletRef: wallet.userWalletId,
          }),
        })),
      );
      for (const { venue, marketClass, options } of inspections) {
        const controllerId = telegramFundingManagedWalletControllerId(
          wallet,
          venue === "polymarket" ? "evm:137" : "evm:8453",
        );
        const matching = options.filter(
          (option) =>
            option.venueId === venue &&
            option.marketClass === marketClass &&
            option.controllerWalletId === controllerId,
        );
        if (matching.length !== 1 || !matching[0]?.selectable) {
          return preparationFailure(
            "trade_preparation_unavailable",
            "Finish preparing your trading wallet in Hunch, then try again. No order has been submitted.",
          );
        }
      }
    }
  } catch {
    return result(
      "blocked",
      "trade_preparation_unavailable",
      "Wallet readiness could not be verified. Retry setup in Hunch shortly.",
    );
  }
  if (mode === "bot") {
    const authorized = status.authorizations.find(
      (entry) =>
        entry.enabled &&
        entry.privyWalletId === wallet.privyWalletId &&
        entry.walletAddress.toLowerCase() ===
          wallet.walletAddress.toLowerCase(),
    );
    if (!authorized || authorized.signerStatus?.state !== "ready") {
      const activeClaim =
        status.managedSetup.state === "in_progress" &&
        status.managedSetup.leaseExpiresAt &&
        Date.parse(status.managedSetup.leaseExpiresAt) >
          (input.now ?? new Date()).getTime();
      return result(
        activeClaim ? "pending" : "blocked",
        "bot_setup_required",
        "Finish Bot trading setup in Hunch, or turn off bot access to use your account without it.",
      );
    }
  }
  // A slow inspection must not certify a replaced link/controller or policy.
  const [currentWallet, currentPolicy] = await Promise.all([
    resolveTelegramFundingManagedWalletIdentity(input.db, identityInput),
    resolveSignalBotTradingPolicyStateFromDb(input.db),
  ]);
  if (
    currentWallet?.userWalletId !== wallet.userWalletId ||
    currentWallet.privyWalletId !== wallet.privyWalletId ||
    currentWallet.walletAddress !== wallet.walletAddress ||
    currentPolicy.policyRevision !== policyRevision
  ) {
    return result(
      "blocked",
      "setup_scope_changed",
      "Your account or settings changed. Retry setup in Hunch.",
    );
  }
  return result("ready", null, null);
}
