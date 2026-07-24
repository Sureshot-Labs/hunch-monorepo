import { tx, type Pool } from "@hunch/infra";

import { acquireRewardsUserAdvisoryXactLock } from "../lib/rewards-user-lock.js";
import { countReferralsForUser } from "../repos/rewards.js";
import {
  attachReferralCodeForExistingUser,
  getOrCreateReferralCode,
  getReferralAttachmentStatus,
  getRewardsReferrals,
  getRewardsSummary,
  normalizeReferralCode,
  setReferralCodeForUser,
  type ReferralAttachmentStatus,
} from "./rewards.js";
import {
  buildSignalBotMiniAppUrl,
  buildSignalBotReferralStartParam,
} from "./signal-bot-mini-app-links.js";
import { buildHunchMiniAppWebButton } from "./telegram-mini-app-buttons.js";
import {
  escapeTelegramMarkdownV2,
  formatTelegramBoldMarkdownV2,
  formatTelegramCalloutMarkdownV2,
  formatTelegramCodeMarkdownV2,
  formatTelegramFieldMarkdownV2,
  formatTelegramFieldWithMarkdownV2,
  formatTelegramItalicMarkdownV2,
  joinTelegramMarkdownV2Lines,
} from "./telegram-bot-trading-presentation.js";

const REFERRALS_PER_PAGE = 5;

export type TelegramBotRewardsSort = "bonus" | "createdAt" | "points";

export type TelegramBotRewardsView =
  | { kind: "earnings" }
  | { kind: "help" }
  | { kind: "overview" }
  | {
      kind: "referrals";
      page: number;
      sortBy: TelegramBotRewardsSort;
    };

export type TelegramBotRewardsCallbackRoute =
  | { action: "attach" | "change"; kind: "rewards_begin_input" }
  | { action: "attach" | "change"; kind: "rewards_confirm" }
  | { kind: "rewards_cancel_input" }
  | { kind: "rewards_view"; view: TelegramBotRewardsView };

type RewardsInlineKeyboardButton =
  | { callback_data: string; text: string }
  | { icon_custom_emoji_id?: string; text: string; url: string }
  | {
      icon_custom_emoji_id?: string;
      text: string;
      web_app: { url: string };
    };

export type TelegramBotRewardsMessage = {
  parse_mode: "MarkdownV2";
  reply_markup: {
    inline_keyboard: RewardsInlineKeyboardButton[][];
  };
  text: string;
};

export type TelegramBotReferralCodeChangeResult =
  | { code: string; status: "changed" }
  | {
      status:
        | "invalid"
        | "reserved"
        | "retired"
        | "same"
        | "taken"
        | "unavailable"
        | "unlinked";
    };

export type TelegramBotReferralAttachResult =
  | { code: string | null; status: ReferralAttachmentStatus }
  | { code: null; status: "unavailable" | "unlinked" };

type RewardsSummary = Awaited<ReturnType<typeof getRewardsSummary>>;

function callbackButton(
  callbackPrefix: string,
  route: string,
  text: string,
): RewardsInlineKeyboardButton {
  return { callback_data: `${callbackPrefix}${route}`, text };
}

function nativeTitle(title: string): string {
  return `🎁 ${formatTelegramBoldMarkdownV2(title)}`;
}

function formatIconFieldMarkdownV2(
  icon: string,
  label: string,
  value: string,
): string {
  return `${icon} ${formatTelegramFieldMarkdownV2(label, value)}`;
}

function formatIconFieldWithMarkdownV2(
  icon: string,
  label: string,
  markdownValue: string,
): string {
  return `${icon} ${formatTelegramFieldWithMarkdownV2(label, markdownValue)}`;
}

function formatTelegramUrlMarkdownV2(url: string): string {
  const target = url.replace(/[)\\]/g, (character) => `\\${character}`);
  return `[${escapeTelegramMarkdownV2(url)}](${target})`;
}

function formatUsd(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(safe);
}

function formatPoints(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(Math.max(0, Math.floor(value)));
}

function formatBonusBps(value: number): string {
  const percent = Math.max(0, Number.isFinite(value) ? value : 0) / 100;
  return `${percent.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

function formatWalletAddress(value: string | null): string {
  if (!value) return "Hunch user";
  const trimmed = value.trim();
  if (trimmed.length <= 14) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

function buildShareUrl(inviteLink: string, code: string): string {
  const url = new URL("https://t.me/share/url");
  url.searchParams.set("url", inviteLink);
  url.searchParams.set("text", `Join me on Hunch. Use my invite code ${code}.`);
  return url.toString();
}

function buildTelegramReferralLink(input: {
  code: string;
  miniAppLinkBase: string | null;
}): string | null {
  return buildSignalBotMiniAppUrl({
    base: input.miniAppLinkBase,
    startParam: buildSignalBotReferralStartParam(input.code),
  });
}

function buildRewardsMiniAppButton(input: {
  appBaseUrl: string;
  miniAppEnabled: boolean;
}): RewardsInlineKeyboardButton | null {
  return buildHunchMiniAppWebButton({
    appBaseUrl: input.appBaseUrl,
    enabled: input.miniAppEnabled,
    path: "/rewards",
    text: "Open Rewards",
  });
}

function buildRewardsNavigationRows(input: {
  callbackPrefix: string;
  includeBackToRewards: boolean;
}): RewardsInlineKeyboardButton[][] {
  return input.includeBackToRewards
    ? [
        [
          callbackButton(input.callbackPrefix, "rewards", "⬅️ Back"),
          callbackButton(input.callbackPrefix, "home", "🏠 Home"),
        ],
      ]
    : [[callbackButton(input.callbackPrefix, "home", "⬅️ Back")]];
}

function nextReferralBonus(summary: RewardsSummary) {
  return [...summary.policy.referralBonus]
    .sort((a, b) => a.minReferrals - b.minReferrals)
    .find((entry) => entry.minReferrals > summary.referralBonus.qualifiedCount);
}

function buildOverviewMessage(input: {
  appBaseUrl: string;
  callbackPrefix: string;
  code: string;
  hasReferrer: boolean;
  miniAppEnabled: boolean;
  miniAppLinkBase: string | null;
  notice?: string | null;
  summary: RewardsSummary;
  totalReferrals: number;
}): TelegramBotRewardsMessage {
  const inviteLink = buildTelegramReferralLink(input);
  const nextBonus = nextReferralBonus(input.summary);
  const pointsRequired =
    input.summary.policy.referralQualification.pointsRequired;
  const qualificationPoints = input.summary.clout.qualificationPoints;
  const miniAppButton = buildRewardsMiniAppButton(input);
  const rows: RewardsInlineKeyboardButton[][] = [
    ...(inviteLink
      ? [
          [
            {
              text: "📨 Share invite",
              url: buildShareUrl(inviteLink, input.code),
            } satisfies RewardsInlineKeyboardButton,
          ],
        ]
      : []),
    [
      callbackButton(input.callbackPrefix, "rw:r:b:0", "👥 My referrals"),
      callbackButton(input.callbackPrefix, "rw:e", "💰 Earnings"),
    ],
    [
      callbackButton(input.callbackPrefix, "rw:c", "✏️ Change code"),
      callbackButton(input.callbackPrefix, "rw:h", "❓ How it works"),
    ],
    ...(!input.hasReferrer
      ? [[callbackButton(input.callbackPrefix, "rw:a", "🏷 Enter invite code")]]
      : []),
    ...(miniAppButton ? [[miniAppButton]] : []),
    ...buildRewardsNavigationRows({
      callbackPrefix: input.callbackPrefix,
      includeBackToRewards: false,
    }),
  ];

  const overview = [
    formatIconFieldWithMarkdownV2(
      "🏷",
      "Code",
      formatTelegramCodeMarkdownV2(input.code),
    ),
    ...(inviteLink
      ? [
          formatIconFieldWithMarkdownV2(
            "🔗",
            "Invite link",
            formatTelegramUrlMarkdownV2(inviteLink),
          ),
        ]
      : []),
    "",
    formatIconFieldMarkdownV2(
      "👥",
      "Referrals",
      `${input.totalReferrals} total · ${input.summary.referralBonus.qualifiedCount} qualified`,
    ),
    formatIconFieldMarkdownV2(
      "🎁",
      "Bonus rate",
      formatBonusBps(input.summary.referralBonus.bonusBps),
    ),
    formatIconFieldMarkdownV2(
      "💰",
      "Referral earnings",
      formatUsd(input.summary.referralBonus.collected),
    ),
    formatIconFieldMarkdownV2(
      "⏳",
      "Pending",
      formatUsd(input.summary.referralBonus.pending),
    ),
  ];

  const progress = nextBonus
    ? `Need ${Math.max(
        0,
        nextBonus.minReferrals - input.summary.referralBonus.qualifiedCount,
      )} more qualified referrals to unlock ${formatBonusBps(
        nextBonus.bonusBps,
      )}.`
    : `You unlocked the maximum referral bonus: ${formatBonusBps(
        input.summary.referralBonus.bonusBps,
      )}.`;
  const qualificationWarning =
    qualificationPoints < pointsRequired
      ? formatTelegramCalloutMarkdownV2({
          bodyMarkdownV2: [
            formatTelegramFieldMarkdownV2(
              "Your progress",
              `${formatPoints(qualificationPoints)} / ${formatPoints(pointsRequired)} qualification points`,
            ),
            escapeTelegramMarkdownV2(
              "Referrals remain Pending until both you and the invited user qualify.",
            ),
          ],
          icon: "⚠️",
          title: "Qualification required",
        })
      : null;

  return {
    parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: rows },
    text: joinTelegramMarkdownV2Lines([
      nativeTitle("Rewards & referrals"),
      "",
      ...overview,
      "",
      formatTelegramItalicMarkdownV2(progress),
      ...(qualificationWarning ? ["", qualificationWarning] : []),
      ...(input.notice
        ? ["", `ℹ️ ${formatTelegramItalicMarkdownV2(input.notice)}`]
        : []),
    ]),
  };
}

function referralSortRoute(sortBy: TelegramBotRewardsSort): string {
  if (sortBy === "points") return "p";
  if (sortBy === "createdAt") return "n";
  return "b";
}

function referralSortLabel(sortBy: TelegramBotRewardsSort): string {
  if (sortBy === "points") return "Points";
  if (sortBy === "createdAt") return "Newest";
  return "Referral earnings";
}

function referralStatusPresentation(status: string): {
  icon: string;
  label: string;
} {
  if (status === "qualified") return { icon: "✅", label: "Qualified" };
  if (status === "blocked") return { icon: "🚫", label: "Blocked" };
  return { icon: "⏳", label: "Pending" };
}

function buildReferralsMessage(input: {
  callbackPrefix: string;
  data: Awaited<ReturnType<typeof getRewardsReferrals>>;
  page: number;
  sortBy: TelegramBotRewardsSort;
  summary: RewardsSummary;
}): TelegramBotRewardsMessage {
  const totalPages = Math.max(
    1,
    Math.ceil(input.data.total / REFERRALS_PER_PAGE),
  );
  const page = Math.min(Math.max(0, input.page), totalPages - 1);
  const pageLines = input.data.referrals.flatMap((referral, index) => {
    const status = referralStatusPresentation(referral.status);
    const number = page * REFERRALS_PER_PAGE + index + 1;
    return [
      formatTelegramBoldMarkdownV2(
        `${number}. ${formatWalletAddress(referral.walletAddress)}`,
      ),
      escapeTelegramMarkdownV2(
        `${status.icon} ${status.label} · ${formatPoints(referral.points)} pts`,
      ),
      formatIconFieldMarkdownV2(
        "💰",
        "Your earnings",
        formatUsd(referral.bonus),
      ),
      "",
    ];
  });
  const sortKey = referralSortRoute(input.sortBy);
  const sortButtons = (
    [
      { label: "💰 Earnings", sortBy: "bonus" },
      { label: "⭐ Points", sortBy: "points" },
      { label: "🕒 Newest", sortBy: "createdAt" },
    ] as const
  )
    .filter((option) => option.sortBy !== input.sortBy)
    .map((option) =>
      callbackButton(
        input.callbackPrefix,
        `rw:r:${referralSortRoute(option.sortBy)}:0`,
        option.label,
      ),
    );
  const paginationRow: RewardsInlineKeyboardButton[] = [];
  if (page > 0) {
    paginationRow.push(
      callbackButton(
        input.callbackPrefix,
        `rw:r:${sortKey}:${page - 1}`,
        "⬅️ Prev",
      ),
    );
  }
  if (page + 1 < totalPages) {
    paginationRow.push(
      callbackButton(
        input.callbackPrefix,
        `rw:r:${sortKey}:${page + 1}`,
        "Next ➡️",
      ),
    );
  }

  const pointsRequired =
    input.summary.policy.referralQualification.pointsRequired;
  const userNeedsQualification =
    input.summary.clout.qualificationPoints < pointsRequired;
  const emptyLines =
    input.data.total === 0
      ? [
          `👥 ${formatTelegramBoldMarkdownV2("No referrals yet")}`,
          escapeTelegramMarkdownV2(
            "Share your invite link to start building your referral bonus.",
          ),
        ]
      : pageLines.slice(0, -1);

  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        ...(input.data.total > 0 ? [sortButtons] : []),
        ...(totalPages > 1 ? [paginationRow] : []),
        ...buildRewardsNavigationRows({
          callbackPrefix: input.callbackPrefix,
          includeBackToRewards: true,
        }),
      ],
    },
    text: joinTelegramMarkdownV2Lines([
      nativeTitle("My referrals"),
      "",
      formatIconFieldMarkdownV2("👥", "Referrals", `${input.data.total} total`),
      formatIconFieldMarkdownV2(
        "✅",
        "Qualified",
        String(input.summary.referralBonus.qualifiedCount),
      ),
      ...(input.data.total > 0
        ? [
            formatIconFieldMarkdownV2(
              "↕️",
              "Sorted by",
              referralSortLabel(input.sortBy),
            ),
            ...(totalPages > 1
              ? [
                  formatIconFieldMarkdownV2(
                    "📄",
                    "Page",
                    `${page + 1} / ${totalPages}`,
                  ),
                ]
              : []),
          ]
        : []),
      ...(userNeedsQualification
        ? [
            "",
            formatTelegramCalloutMarkdownV2({
              bodyMarkdownV2: escapeTelegramMarkdownV2(
                `You also need ${formatPoints(pointsRequired)} qualification points before referrals can become Qualified.`,
              ),
              icon: "⚠️",
              title: "Your qualification is pending",
            }),
          ]
        : []),
      "",
      ...emptyLines,
    ]),
  };
}

function buildEarningsMessage(input: {
  appBaseUrl: string;
  callbackPrefix: string;
  miniAppEnabled: boolean;
  summary: RewardsSummary;
}): TelegramBotRewardsMessage {
  const miniAppButton = buildRewardsMiniAppButton(input);
  const referralCollected = input.summary.referralBonus.collected;
  const baseCashbackCollected = Math.max(
    0,
    input.summary.cashback.collected - referralCollected,
  );
  const chainLines = Object.entries(input.summary.cashback.byChain)
    .filter(([, values]) => values.claimable > 0)
    .sort(([, left], [, right]) => right.claimable - left.claimable)
    .map(([chainId, values]) =>
      formatIconFieldMarkdownV2("⛓", chainId, formatUsd(values.claimable)),
    );
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [callbackButton(input.callbackPrefix, "rw:r:b:0", "👥 My referrals")],
        ...(miniAppButton ? [[miniAppButton]] : []),
        ...buildRewardsNavigationRows({
          callbackPrefix: input.callbackPrefix,
          includeBackToRewards: true,
        }),
      ],
    },
    text: joinTelegramMarkdownV2Lines([
      nativeTitle("Referral earnings"),
      "",
      formatIconFieldMarkdownV2(
        "🎁",
        "Current bonus",
        formatBonusBps(input.summary.referralBonus.bonusBps),
      ),
      formatIconFieldMarkdownV2(
        "✅",
        "Qualified referrals",
        String(input.summary.referralBonus.qualifiedCount),
      ),
      "",
      formatIconFieldMarkdownV2(
        "💵",
        "Cashback earned",
        formatUsd(baseCashbackCollected),
      ),
      formatIconFieldMarkdownV2(
        "💰",
        "Referral earned",
        formatUsd(referralCollected),
      ),
      formatIconFieldMarkdownV2(
        "⏳",
        "Referral pending",
        formatUsd(input.summary.referralBonus.pending),
      ),
      formatIconFieldMarkdownV2(
        "💳",
        "All rewards available",
        formatUsd(input.summary.cashback.claimable),
      ),
      ...(chainLines.length
        ? [
            "",
            `🌐 ${formatTelegramBoldMarkdownV2("Available by network")}`,
            ...chainLines,
          ]
        : []),
      "",
      formatTelegramItalicMarkdownV2(
        "Referral earnings are included in your total claimable rewards. Claims are completed in the Mini App.",
      ),
    ]),
  };
}

function buildHelpMessage(input: {
  callbackPrefix: string;
  summary: RewardsSummary;
}): TelegramBotRewardsMessage {
  const pointsRequired =
    input.summary.policy.referralQualification.pointsRequired;
  const bonusLines = [...input.summary.policy.referralBonus]
    .sort((a, b) => a.minReferrals - b.minReferrals)
    .map((entry) =>
      formatIconFieldMarkdownV2(
        "🔸",
        `${entry.minReferrals}+ qualified`,
        formatBonusBps(entry.bonusBps),
      ),
    );
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: buildRewardsNavigationRows({
        callbackPrefix: input.callbackPrefix,
        includeBackToRewards: true,
      }),
    },
    text: joinTelegramMarkdownV2Lines([
      nativeTitle("How referrals work"),
      "",
      escapeTelegramMarkdownV2("1️⃣ Share your invite link or code."),
      escapeTelegramMarkdownV2(
        `2️⃣ Both you and the invited user need ${formatPoints(pointsRequired)} qualification points.`,
      ),
      escapeTelegramMarkdownV2(
        "3️⃣ Qualified referrals increase your rate on future eligible trading fees.",
      ),
      "",
      `🎁 ${formatTelegramBoldMarkdownV2("Referral bonus rates")}`,
      ...bonusLines,
      "",
      formatTelegramCalloutMarkdownV2({
        bodyMarkdownV2: escapeTelegramMarkdownV2(
          "Changing your code disables the old link for new users. Existing referrals and earnings remain attached.",
        ),
        icon: "⚠️",
        title: "Changing your code",
      }),
    ]),
  };
}

export function buildTelegramBotRewardsUnavailableMessage(input: {
  appBaseUrl: string;
  callbackPrefix: string;
  miniAppEnabled: boolean;
}): TelegramBotRewardsMessage {
  const miniAppButton = buildRewardsMiniAppButton(input);
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [callbackButton(input.callbackPrefix, "rewards", "🔄 Retry")],
        ...(miniAppButton ? [[miniAppButton]] : []),
        ...buildRewardsNavigationRows({
          callbackPrefix: input.callbackPrefix,
          includeBackToRewards: false,
        }),
      ],
    },
    text: joinTelegramMarkdownV2Lines([
      nativeTitle("Rewards & referrals"),
      "",
      formatTelegramCalloutMarkdownV2({
        bodyMarkdownV2: escapeTelegramMarkdownV2(
          "Try again shortly or open Rewards in the Mini App.",
        ),
        icon: "⚠️",
        title: "Rewards unavailable",
      }),
    ]),
  };
}

async function resolveTelegramRewardsUserId(input: {
  pool: Pool;
  telegramUserId: number | string;
}): Promise<string | null> {
  const { rows } = await input.pool.query<{ user_id: string }>(
    `
      select uta.user_id
      from user_telegram_accounts uta
      join users u on u.id = uta.user_id
      where uta.telegram_user_id = $1
        and coalesce(u.is_active, true) = true
      limit 1
    `,
    [String(input.telegramUserId)],
  );
  return rows[0]?.user_id ?? null;
}

export async function loadTelegramBotRewardsMessage(input: {
  appBaseUrl: string;
  callbackPrefix: string;
  miniAppEnabled: boolean;
  miniAppLinkBase: string | null;
  notice?: string | null;
  pool: Pool;
  telegramUserId: number;
  view: TelegramBotRewardsView;
}): Promise<TelegramBotRewardsMessage> {
  const userId = await resolveTelegramRewardsUserId(input);
  if (!userId) {
    return buildTelegramBotRewardsUnavailableMessage(input);
  }
  if (input.view.kind === "overview") {
    const [code, summary, referral, totalReferrals] = await Promise.all([
      getOrCreateReferralCode(input.pool, userId),
      getRewardsSummary(input.pool, { userId }),
      getReferralAttachmentStatus(input.pool, { userId }),
      countReferralsForUser(input.pool, userId),
    ]);
    return buildOverviewMessage({
      ...input,
      code,
      hasReferrer: referral.hasReferrer,
      summary,
      totalReferrals,
    });
  }
  if (input.view.kind === "referrals") {
    const requestedPage = Math.max(0, Math.floor(input.view.page));
    const [summary, data] = await Promise.all([
      getRewardsSummary(input.pool, { userId }),
      getRewardsReferrals(input.pool, {
        limit: REFERRALS_PER_PAGE,
        offset: requestedPage * REFERRALS_PER_PAGE,
        sortBy: input.view.sortBy,
        sortDir: "desc",
        userId,
      }),
    ]);
    const lastPage = Math.max(
      0,
      Math.ceil(data.total / REFERRALS_PER_PAGE) - 1,
    );
    if (requestedPage > lastPage) {
      const corrected = await getRewardsReferrals(input.pool, {
        limit: REFERRALS_PER_PAGE,
        offset: lastPage * REFERRALS_PER_PAGE,
        sortBy: input.view.sortBy,
        sortDir: "desc",
        userId,
      });
      return buildReferralsMessage({
        callbackPrefix: input.callbackPrefix,
        data: corrected,
        page: lastPage,
        sortBy: input.view.sortBy,
        summary,
      });
    }
    return buildReferralsMessage({
      callbackPrefix: input.callbackPrefix,
      data,
      page: requestedPage,
      sortBy: input.view.sortBy,
      summary,
    });
  }
  if (input.view.kind === "earnings") {
    return buildEarningsMessage({
      ...input,
      summary: await getRewardsSummary(input.pool, { userId }),
    });
  }
  return buildHelpMessage({
    callbackPrefix: input.callbackPrefix,
    summary: await getRewardsSummary(input.pool, { userId }),
  });
}

export function normalizeTelegramBotReferralCode(value: string): string | null {
  return normalizeReferralCode(value);
}

export async function prepareTelegramBotReferralCodeChange(input: {
  code: string;
  pool: Pool;
  telegramUserId: number;
}): Promise<
  | { currentCode: string; nextCode: string; status: "ready" }
  | { status: "invalid" | "same" | "unavailable" | "unlinked" }
> {
  const nextCode = normalizeReferralCode(input.code);
  if (!nextCode) return { status: "invalid" };
  const userId = await resolveTelegramRewardsUserId(input);
  if (!userId) return { status: "unlinked" };
  try {
    const currentCode = await getOrCreateReferralCode(input.pool, userId);
    if (normalizeReferralCode(currentCode) === nextCode) {
      return { status: "same" };
    }
    return { currentCode, nextCode, status: "ready" };
  } catch {
    return { status: "unavailable" };
  }
}

function referralCodeChangeFailure(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("reserved")) return "reserved" as const;
  if (message.includes("retired")) return "retired" as const;
  if (message.includes("already taken")) return "taken" as const;
  if (message.includes("invalid")) return "invalid" as const;
  return "unavailable" as const;
}

export async function updateTelegramBotReferralCode(input: {
  code: string;
  pool: Pool;
  telegramUserId: number;
}): Promise<TelegramBotReferralCodeChangeResult> {
  const code = normalizeReferralCode(input.code);
  if (!code) return { status: "invalid" };
  const userId = await resolveTelegramRewardsUserId(input);
  if (!userId) return { status: "unlinked" };
  try {
    const currentCode = await getOrCreateReferralCode(input.pool, userId);
    if (normalizeReferralCode(currentCode) === code) return { status: "same" };
    const result = await tx(input.pool, async (client) => {
      await acquireRewardsUserAdvisoryXactLock(client, userId);
      return setReferralCodeForUser(client, {
        forceTransfer: false,
        referralCode: code,
        userId,
      });
    });
    return { code: result.code, status: "changed" };
  } catch (error) {
    return { status: referralCodeChangeFailure(error) };
  }
}

export async function attachTelegramBotReferralCode(input: {
  code: string;
  pool: Pool;
  telegramUserId: number;
}): Promise<TelegramBotReferralAttachResult> {
  const code = normalizeReferralCode(input.code);
  if (!code) return { code: null, status: "invalid_code" };
  const userId = await resolveTelegramRewardsUserId(input);
  if (!userId) return { code: null, status: "unlinked" };
  try {
    const result = await tx(input.pool, async (client) => {
      await acquireRewardsUserAdvisoryXactLock(client, userId);
      return attachReferralCodeForExistingUser(client, {
        referralCode: code,
        userId,
      });
    });
    return { code: result.referral.code, status: result.status };
  } catch {
    return { code: null, status: "unavailable" };
  }
}

export function parseTelegramBotRewardsCallbackRoute(
  route: string,
): TelegramBotRewardsCallbackRoute | null {
  if (route === "rewards") {
    return { kind: "rewards_view", view: { kind: "overview" } };
  }
  if (route === "rw:e") {
    return { kind: "rewards_view", view: { kind: "earnings" } };
  }
  if (route === "rw:h") {
    return { kind: "rewards_view", view: { kind: "help" } };
  }
  if (route === "rw:i") {
    return { kind: "rewards_view", view: { kind: "overview" } };
  }
  if (route === "rw:c" || route === "rw:a") {
    return {
      action: route === "rw:c" ? "change" : "attach",
      kind: "rewards_begin_input",
    };
  }
  if (route === "rw:ok:c" || route === "rw:ok:a") {
    return {
      action: route === "rw:ok:c" ? "change" : "attach",
      kind: "rewards_confirm",
    };
  }
  if (route === "rw:x") return { kind: "rewards_cancel_input" };
  const parts = route.split(":");
  if (parts.length !== 4 || parts[0] !== "rw" || parts[1] !== "r") {
    return null;
  }
  const sortBy: TelegramBotRewardsSort | null =
    parts[2] === "p"
      ? "points"
      : parts[2] === "n"
        ? "createdAt"
        : parts[2] === "b"
          ? "bonus"
          : null;
  const page = Number(parts[3]);
  if (!sortBy || !Number.isInteger(page) || page < 0 || page > 10_000) {
    return null;
  }
  return {
    kind: "rewards_view",
    view: { kind: "referrals", page, sortBy },
  };
}

export function buildTelegramBotReferralCodeInputPrompt(input: {
  action: "attach" | "change";
  callbackPrefix: string;
  errorMessage?: string | null;
}): TelegramBotRewardsMessage {
  const isChange = input.action === "change";
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [callbackButton(input.callbackPrefix, "rw:x", "❌ Cancel")],
      ],
    },
    text: joinTelegramMarkdownV2Lines([
      nativeTitle(isChange ? "Change referral code" : "Enter invite code"),
      "",
      escapeTelegramMarkdownV2(
        isChange
          ? "Send the new referral code in your next message."
          : "Send the invite code in your next message.",
      ),
      "",
      ...(isChange
        ? [
            formatIconFieldMarkdownV2(
              "✏️",
              "Code format",
              "3–10 letters or numbers; converted to uppercase",
            ),
          ]
        : [
            formatTelegramCalloutMarkdownV2({
              bodyMarkdownV2: escapeTelegramMarkdownV2(
                "An account can only have one referrer. You will confirm the code before it is attached.",
              ),
              icon: "⚠️",
              title: "One-time attachment",
            }),
          ]),
      ...(input.errorMessage
        ? [
            "",
            formatTelegramCalloutMarkdownV2({
              bodyMarkdownV2: escapeTelegramMarkdownV2(input.errorMessage),
              icon: "⚠️",
              title: "Code not accepted",
            }),
          ]
        : []),
    ]),
  };
}

export function buildTelegramBotReferralCodeConfirmation(input: {
  action: "attach" | "change";
  callbackPrefix: string;
  code: string;
  currentCode?: string | null;
}): TelegramBotRewardsMessage {
  const isChange = input.action === "change";
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [
          callbackButton(
            input.callbackPrefix,
            isChange ? "rw:ok:c" : "rw:ok:a",
            isChange ? "✅ Change code" : "✅ Attach code",
          ),
          callbackButton(input.callbackPrefix, "rw:x", "❌ Cancel"),
        ],
      ],
    },
    text: joinTelegramMarkdownV2Lines([
      nativeTitle(isChange ? "Confirm referral code" : "Confirm invite"),
      "",
      ...(isChange && input.currentCode
        ? [
            formatIconFieldWithMarkdownV2(
              "🏷",
              "Current",
              formatTelegramCodeMarkdownV2(input.currentCode),
            ),
          ]
        : []),
      formatIconFieldWithMarkdownV2(
        isChange ? "✏️" : "🏷",
        isChange ? "New" : "Invite code",
        formatTelegramCodeMarkdownV2(input.code),
      ),
      "",
      formatTelegramCalloutMarkdownV2({
        bodyMarkdownV2: escapeTelegramMarkdownV2(
          isChange
            ? "The old link will stop accepting new users. Existing referrals and earnings remain attached."
            : "This account cannot switch or remove its referrer later.",
        ),
        icon: "⚠️",
        title: isChange ? "Before you change it" : "Before you attach it",
      }),
    ]),
  };
}

export const telegramBotRewardsTestHooks = {
  buildEarningsMessage,
  buildHelpMessage,
  buildOverviewMessage,
  buildReferralsMessage,
};
