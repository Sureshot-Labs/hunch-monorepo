export type SignalBotCommand =
  | "disable_signals"
  | "enable_signals"
  | "help"
  | "market"
  | "menu"
  | "settings"
  | "signal_venues"
  | "start"
  | "stats"
  | "status"
  | "trade_status"
  | "disable_trading"
  | "test_followthrough"
  | "test_rich"
  | "test_signal"
  | "test_trade";

export type SignalBotFollowthroughPreviewKind =
  | "resolved_loss"
  | "resolved_win"
  | "stats";

export type SignalBotFollowthroughPreviewRequest = {
  kind: SignalBotFollowthroughPreviewKind;
  targetChatId: string | null;
};

export type SignalBotRichPreviewKind =
  | "all"
  | "headings"
  | "production"
  | "references";

export type SignalBotStatsPeriod = "24h" | "30d" | "7d";

export type SignalBotStatsRequest = {
  detail: boolean;
  period: SignalBotStatsPeriod;
};

export type SignalBotTestSignalSelector =
  | "initial"
  | "latest"
  | "update"
  | string;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseSignalBotCommand(
  text: string | null | undefined,
  botUsername?: string | null,
): SignalBotCommand | null {
  if (!text) return null;
  const firstToken = text.trim().split(/\s+/)[0];
  if (!firstToken?.startsWith("/")) return null;
  const raw = firstToken.slice(1);
  const [command, mention] = raw.split("@");
  if (!command) return null;
  if (
    mention &&
    botUsername &&
    mention.toLowerCase() !== botUsername.toLowerCase()
  ) {
    return null;
  }
  switch (command.toLowerCase()) {
    case "disable_signals":
    case "enable_signals":
    case "help":
    case "market":
    case "menu":
    case "settings":
    case "signal_venues":
    case "start":
    case "stats":
    case "status":
    case "trade_status":
    case "disable_trading":
    case "test_followthrough":
    case "test_rich":
    case "test_signal":
    case "test_trade":
      return command.toLowerCase() as SignalBotCommand;
    default:
      return null;
  }
}

export function parseSignalBotStatsPeriod(
  text: string | null | undefined,
): SignalBotStatsPeriod | null {
  return parseSignalBotStatsRequest(text)?.period ?? null;
}

export function parseSignalBotStatsRequest(
  text: string | null | undefined,
): SignalBotStatsRequest | null {
  if (!text) return { detail: false, period: "7d" };
  const [, ...rawArgs] = text.trim().split(/\s+/);
  let period: SignalBotStatsPeriod = "7d";
  let detail = false;
  for (const rawArg of rawArgs) {
    const normalized = rawArg.trim().toLowerCase();
    if (!normalized) continue;
    if (normalized === "detail" || normalized === "details") {
      detail = true;
      continue;
    }
    if (normalized === "24h" || normalized === "7d" || normalized === "30d") {
      period = normalized;
      continue;
    }
    return null;
  }
  return { detail, period };
}

export function parseSignalBotCommandTargetChatId(
  text: string | null | undefined,
): string | null {
  if (!text) return null;
  const [, rawTarget] = text.trim().split(/\s+/, 2);
  return normalizeSignalBotCommandTargetChatId(rawTarget);
}

export function parseSignalBotTestSignalRequest(
  text: string | null | undefined,
): {
  selector: SignalBotTestSignalSelector;
  targetChatId: string | null;
} {
  const parts = text?.trim().split(/\s+/).slice(1) ?? [];
  const targetChatId = normalizeSignalBotCommandTargetChatId(parts[0]);
  const rawSelector = targetChatId ? parts[1] : parts[0];
  const selector =
    rawSelector === "initial" ||
    rawSelector === "update" ||
    rawSelector === "latest" ||
    (rawSelector != null && UUID_RE.test(rawSelector))
      ? rawSelector
      : "latest";
  return { selector, targetChatId };
}

export function parseSignalBotRichPreviewRequest(
  text: string | null | undefined,
): { kind: SignalBotRichPreviewKind; targetChatId: string | null } | null {
  const parts = text?.trim().split(/\s+/).slice(1) ?? [];
  let kind: SignalBotRichPreviewKind = "all";
  let targetChatId: string | null = null;
  for (const part of parts) {
    const normalizedTarget = normalizeSignalBotCommandTargetChatId(part);
    if (normalizedTarget) {
      if (targetChatId) return null;
      targetChatId = normalizedTarget;
      continue;
    }
    const normalizedKind = part.toLowerCase();
    if (
      normalizedKind === "all" ||
      normalizedKind === "production" ||
      normalizedKind === "headings" ||
      normalizedKind === "references"
    ) {
      kind = normalizedKind;
      continue;
    }
    return null;
  }
  return { kind, targetChatId };
}

export function parseSignalBotCommandFirstArg(
  text: string | null | undefined,
): string | null {
  if (!text) return null;
  const [, rawArg] = text.trim().split(/\s+/, 2);
  const arg = rawArg?.trim();
  return arg ? arg : null;
}

function normalizeSignalBotCommandTargetChatId(
  rawTarget: string | null | undefined,
): string | null {
  if (!rawTarget) return null;
  const target = rawTarget.trim();
  if (/^-100\d{5,}$/.test(target)) return target;
  if (/^-\d{5,}$/.test(target)) return target;
  if (/^\d{5,}$/.test(target)) return `-100${target}`;
  return null;
}

export function parseSignalBotDestinationPolicyRequest(
  text: string | null | undefined,
): { rawVenues: string[] | "all"; targetChatId: string | null } | null {
  if (!text) return null;
  const [, ...args] = text.trim().split(/\s+/);
  if (args.length < 1 || args.length > 2) return null;
  const targetChatId =
    args.length === 2 ? normalizeSignalBotCommandTargetChatId(args[1]) : null;
  if (args.length === 2 && !targetChatId) return null;
  const raw = args[0]?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "all") return { rawVenues: "all", targetChatId };
  const rawVenues = raw
    .split(",")
    .map((venue) => venue.trim())
    .filter(Boolean);
  return rawVenues.length > 0 ? { rawVenues, targetChatId } : null;
}

function parseSignalBotFollowthroughPreviewKind(
  value: string | null | undefined,
): SignalBotFollowthroughPreviewKind | null {
  switch (value?.trim().toLowerCase()) {
    case "stats":
      return "stats";
    case "resolved_win":
    case "win":
      return "resolved_win";
    case "resolved_loss":
    case "loss":
      return "resolved_loss";
    default:
      return null;
  }
}

export function parseSignalBotFollowthroughPreviewRequest(
  text: string | null | undefined,
): SignalBotFollowthroughPreviewRequest | null {
  if (!text) return { kind: "stats", targetChatId: null };
  const [, ...args] = text.trim().split(/\s+/);
  let kind: SignalBotFollowthroughPreviewKind = "stats";
  let sawKind = false;
  let targetChatId: string | null = null;
  for (const rawArg of args) {
    const parsedKind = parseSignalBotFollowthroughPreviewKind(rawArg);
    if (parsedKind && !sawKind) {
      kind = parsedKind;
      sawKind = true;
      continue;
    }
    const parsedTarget = normalizeSignalBotCommandTargetChatId(rawArg);
    if (parsedTarget && !targetChatId) {
      targetChatId = parsedTarget;
      continue;
    }
    return null;
  }
  return { kind, targetChatId };
}
