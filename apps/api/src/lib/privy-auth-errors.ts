import type { PrivyTerminalAuthErrorCode } from "../auth.js";

export const DEFAULT_PRIVY_TERMINAL_AUTH_MESSAGE =
  "Privy authentication could not be completed. Please contact support.";

const PRIVY_TERMINAL_AUTH_MESSAGES: Record<PrivyTerminalAuthErrorCode, string> =
  {
    account_recovery_required:
      "Account recovery required. Please contact support to recover this account.",
    account_merge_required:
      "Account merge required. Please contact support to merge these accounts before logging in.",
    email_conflict:
      "This email is already linked to another Hunch account. Please contact support to recover or merge the account.",
    wallet_conflict:
      "One of this Privy account's wallets is already linked to another Hunch account. Please contact support to recover or merge the account.",
    telegram_conflict:
      "This Telegram account is already linked to another Hunch account. Please contact support to recover or merge the account.",
    telegram_signup_blocked:
      "Telegram-only signup is not enabled yet. Sign in with an existing wallet or email account, then link Telegram.",
  };

export function getPrivyTerminalAuthMessage(
  code: PrivyTerminalAuthErrorCode | string | null | undefined,
): string {
  if (!code) return DEFAULT_PRIVY_TERMINAL_AUTH_MESSAGE;

  const message =
    PRIVY_TERMINAL_AUTH_MESSAGES[
      code as keyof typeof PRIVY_TERMINAL_AUTH_MESSAGES
    ];

  return typeof message === "string" && message.trim().length > 0
    ? message
    : DEFAULT_PRIVY_TERMINAL_AUTH_MESSAGE;
}
