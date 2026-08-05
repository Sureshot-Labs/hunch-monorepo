import {
  buildTelegramBotReferralCodeConfirmation,
  buildTelegramBotReferralCodeInputPrompt,
  buildTelegramBotRewardsUnavailableMessage,
  normalizeTelegramBotReferralCode,
  type TelegramBotReferralAttachResult,
  type TelegramBotReferralCodeChangeResult,
  type TelegramBotRewardsCallbackRoute,
  type TelegramBotRewardsMessage,
  type TelegramBotRewardsView,
} from "./telegram-bot-rewards.js";
import {
  clearSignalBotMenuInput,
  readSignalBotMenuInput,
  writeSignalBotRewardsMenuInput,
} from "./telegram-bot-menu-state.js";
import {
  sendOrEditTelegramBotMenuMessage,
  type TelegramBotMenuTransport,
} from "./telegram-bot-menu-delivery.js";

type RewardsMenuRedis = {
  del(key: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
};

export type TelegramBotRewardsMenuDependencies = {
  attachRewardsReferralCode?: (input: {
    code: string;
    telegramUserId: number;
  }) => Promise<TelegramBotReferralAttachResult>;
  loadRewards?: (input: {
    notice?: string | null;
    telegramUserId: number;
    view: TelegramBotRewardsView;
  }) => Promise<TelegramBotRewardsMessage>;
  prepareRewardsReferralCodeChange?: (input: {
    code: string;
    telegramUserId: number;
  }) => Promise<
    | { currentCode: string; nextCode: string; status: "ready" }
    | { status: "invalid" | "same" | "unavailable" | "unlinked" }
  >;
  updateRewardsReferralCode?: (input: {
    code: string;
    telegramUserId: number;
  }) => Promise<TelegramBotReferralCodeChangeResult>;
};

async function renderRewardsView(input: {
  appBaseUrl: string;
  callbackPrefix: string;
  chatId: string;
  loadRewards?: TelegramBotRewardsMenuDependencies["loadRewards"];
  messageId: number | null;
  miniAppEnabled: boolean;
  notice?: string | null;
  telegramUserId: number;
  transport: TelegramBotMenuTransport;
  view: TelegramBotRewardsView;
}) {
  let message: TelegramBotRewardsMessage;
  try {
    message = input.loadRewards
      ? await input.loadRewards({
          notice: input.notice,
          telegramUserId: input.telegramUserId,
          view: input.view,
        })
      : buildTelegramBotRewardsUnavailableMessage(input);
  } catch {
    message = buildTelegramBotRewardsUnavailableMessage(input);
  }
  return sendOrEditTelegramBotMenuMessage({
    chatId: input.chatId,
    message,
    messageId: input.messageId,
    transport: input.transport,
  });
}

function referralCodeChangeErrorMessage(
  status: Exclude<TelegramBotReferralCodeChangeResult["status"], "changed">,
): string {
  switch (status) {
    case "invalid":
      return "Use 3–10 letters or numbers.";
    case "reserved":
      return "That code is reserved. Choose another one.";
    case "retired":
      return "That code is retired. Choose another one.";
    case "same":
      return "That is already your active referral code.";
    case "taken":
      return "That code is already taken. Choose another one.";
    case "unlinked":
      return "Reconnect your Telegram account to Hunch first.";
    case "unavailable":
    default:
      return "The code could not be changed. Try again.";
  }
}

function referralAttachErrorMessage(
  status: TelegramBotReferralAttachResult["status"],
): string {
  switch (status) {
    case "invalid_code":
      return "Use a valid 3–10 character invite code.";
    case "not_found":
      return "That invite code was not found or is no longer active.";
    case "self_referral":
      return "You cannot attach your own referral code.";
    case "already_attached":
      return "An invite code is already attached to this account.";
    case "unlinked":
      return "Reconnect your Telegram account to Hunch first.";
    case "unavailable":
      return "The invite code could not be attached. Try again.";
    case "attached":
    default:
      return "The invite code could not be attached.";
  }
}

export async function handleTelegramBotRewardsCallback(
  input: TelegramBotRewardsMenuDependencies & {
    appBaseUrl: string;
    callbackPrefix: string;
    chatId: string;
    messageId: number | null;
    miniAppEnabled: boolean;
    redis: RewardsMenuRedis;
    route: TelegramBotRewardsCallbackRoute;
    telegramUserId: number;
    transport: TelegramBotMenuTransport;
  },
): Promise<boolean> {
  const render = (view: TelegramBotRewardsView, notice?: string | null) =>
    renderRewardsView({ ...input, notice, view });
  if (input.route.kind === "rewards_view") {
    await clearSignalBotMenuInput(input);
    await render(input.route.view);
    return true;
  }
  if (input.route.kind === "rewards_begin_input") {
    await writeSignalBotRewardsMenuInput({
      ...input,
      state: {
        action: input.route.action,
        kind: "awaiting",
        menuMessageId: input.messageId,
      },
    });
    await sendOrEditTelegramBotMenuMessage({
      ...input,
      message: buildTelegramBotReferralCodeInputPrompt({
        action: input.route.action,
        callbackPrefix: input.callbackPrefix,
      }),
    });
    return true;
  }
  if (input.route.kind === "rewards_cancel_input") {
    await clearSignalBotMenuInput(input);
    await render({ kind: "overview" }, "Referral input cancelled.");
    return true;
  }

  const state = await readSignalBotMenuInput(input);
  const expectedKind =
    input.route.action === "change"
      ? "confirming_rewards_code_change"
      : "confirming_rewards_code_attach";
  if (!state || state.kind !== expectedKind) {
    await clearSignalBotMenuInput(input);
    await render(
      { kind: "overview" },
      "That confirmation expired. Start again.",
    );
    return true;
  }
  if (input.route.action === "change") {
    const result = input.updateRewardsReferralCode
      ? await input
          .updateRewardsReferralCode({
            code: state.code,
            telegramUserId: input.telegramUserId,
          })
          .catch(
            (): TelegramBotReferralCodeChangeResult => ({
              status: "unavailable",
            }),
          )
      : ({ status: "unavailable" } as const);
    if (result.status === "changed") {
      await clearSignalBotMenuInput(input);
      await render(
        { kind: "overview" },
        `Referral code changed to ${result.code}.`,
      );
      return true;
    }
    await writeSignalBotRewardsMenuInput({
      ...input,
      state: {
        action: "change",
        kind: "awaiting",
        menuMessageId: input.messageId,
      },
    });
    await sendOrEditTelegramBotMenuMessage({
      ...input,
      message: buildTelegramBotReferralCodeInputPrompt({
        action: "change",
        callbackPrefix: input.callbackPrefix,
        errorMessage: referralCodeChangeErrorMessage(result.status),
      }),
    });
    return true;
  }

  const result = input.attachRewardsReferralCode
    ? await input
        .attachRewardsReferralCode({
          code: state.code,
          telegramUserId: input.telegramUserId,
        })
        .catch(
          (): TelegramBotReferralAttachResult => ({
            code: null,
            status: "unavailable",
          }),
        )
    : ({ code: null, status: "unavailable" } as const);
  if (result.status === "attached" || result.status === "already_attached") {
    await clearSignalBotMenuInput(input);
    await render(
      { kind: "overview" },
      result.status === "attached"
        ? `Invite code ${result.code ?? state.code} attached.`
        : "This account already has an invite attached.",
    );
    return true;
  }
  await writeSignalBotRewardsMenuInput({
    ...input,
    state: {
      action: "attach",
      kind: "awaiting",
      menuMessageId: input.messageId,
    },
  });
  await sendOrEditTelegramBotMenuMessage({
    ...input,
    message: buildTelegramBotReferralCodeInputPrompt({
      action: "attach",
      callbackPrefix: input.callbackPrefix,
      errorMessage: referralAttachErrorMessage(result.status),
    }),
  });
  return true;
}

export async function handleTelegramBotRewardsInput(
  input: Pick<
    TelegramBotRewardsMenuDependencies,
    "prepareRewardsReferralCodeChange"
  > & {
    callbackPrefix: string;
    chatId: string;
    redis: RewardsMenuRedis;
    telegramUserId: number;
    text: string;
    transport: TelegramBotMenuTransport;
  },
): Promise<boolean> {
  const state = await readSignalBotMenuInput(input);
  if (!state || state.kind === "awaiting_market_query") return false;

  const action = state.kind.includes("change") ? "change" : "attach";
  const code = normalizeTelegramBotReferralCode(input.text);
  if (!code) {
    await writeSignalBotRewardsMenuInput({
      ...input,
      state: {
        action,
        kind: "awaiting",
        menuMessageId: state.menuMessageId,
      },
    });
    await sendOrEditTelegramBotMenuMessage({
      chatId: input.chatId,
      message: buildTelegramBotReferralCodeInputPrompt({
        action,
        callbackPrefix: input.callbackPrefix,
        errorMessage: "Use 3–10 letters or numbers.",
      }),
      messageId: state.menuMessageId,
      transport: input.transport,
    });
    return true;
  }

  let currentCode: string | null = null;
  if (action === "change") {
    const prepared = input.prepareRewardsReferralCodeChange
      ? await input
          .prepareRewardsReferralCodeChange({
            code,
            telegramUserId: input.telegramUserId,
          })
          .catch(() => ({ status: "unavailable" as const }))
      : ({ status: "unavailable" } as const);
    if (prepared.status !== "ready") {
      await writeSignalBotRewardsMenuInput({
        ...input,
        state: {
          action,
          kind: "awaiting",
          menuMessageId: state.menuMessageId,
        },
      });
      await sendOrEditTelegramBotMenuMessage({
        chatId: input.chatId,
        message: buildTelegramBotReferralCodeInputPrompt({
          action,
          callbackPrefix: input.callbackPrefix,
          errorMessage: referralCodeChangeErrorMessage(prepared.status),
        }),
        messageId: state.menuMessageId,
        transport: input.transport,
      });
      return true;
    }
    currentCode = prepared.currentCode;
  }

  await writeSignalBotRewardsMenuInput({
    ...input,
    state: {
      action,
      code,
      currentCode,
      kind: "confirming",
      menuMessageId: state.menuMessageId,
    },
  });
  await sendOrEditTelegramBotMenuMessage({
    chatId: input.chatId,
    message: buildTelegramBotReferralCodeConfirmation({
      action,
      callbackPrefix: input.callbackPrefix,
      code,
      currentCode,
    }),
    messageId: state.menuMessageId,
    transport: input.transport,
  });
  return true;
}
