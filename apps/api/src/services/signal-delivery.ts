import type { TelegramInputRichMessage } from "./telegram-rich-message.js";

export type SignalSourceView = {
  eventId: string | null;
  marketId: string | null;
  side: "NO" | "YES" | null;
  venue: string | null;
};

export type SignalTargetView = {
  action?: "buy" | "open_market";
  eventId: string;
  marketId: string;
  price: number;
  side: "NO" | "YES";
  tradeUrl: string;
  venue: string;
};

export type HolderView = {
  address: string | null;
  displayName: string | null;
  positionUsd: number | null;
  side: "NO" | "YES" | null;
};

export type SignalDeliveryView = {
  kind:
    | "initial"
    | "research-update"
    | "stats"
    | "resolved-win"
    | "resolved-loss";
  source: SignalSourceView;
  target: SignalTargetView | null;
  title: string;
  summary: string;
  contextLines: string[];
  credentialLines: string[];
  holder: HolderView | null;
  thread: { rootDeliveryId?: string };
};

export type TransportPayload = {
  buttons?: Array<{ label: string; url: string }>;
  destinationId?: string;
  embeds?: Array<{
    description: string;
    fields: Array<{ name: string; value: string }>;
    title: string;
  }>;
  text: string;
  telegram?: {
    disableWebPagePreview: boolean;
    parseMode: "MarkdownV2";
    replyMarkup?: unknown;
    richMessage?: TelegramInputRichMessage;
  };
  thread?: string[];
  replyToDeliveryId?: string;
};

export type TransportSendResult = {
  deliveryId: string | null;
  errorCode?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  ok: boolean;
  retryAfterSec?: number;
};

export type SignalTransport = {
  kind: "telegram" | "discord" | "x";
  capabilities: {
    buttons: boolean;
    edits: boolean;
    replies: boolean;
    maxLength: number;
  };
  render(view: SignalDeliveryView): TransportPayload;
  send(payload: TransportPayload): Promise<TransportSendResult>;
};

export type SignalTransportSender = (
  payload: TransportPayload,
) => Promise<TransportSendResult>;

function compactLines(view: SignalDeliveryView): string[] {
  return [
    view.title,
    view.summary,
    ...view.contextLines,
    ...view.credentialLines,
  ].filter((line) => line.trim().length > 0);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function escapeTelegramMarkdownV2(value: string): string {
  return value.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

export function renderTelegramSignalDelivery(
  view: SignalDeliveryView,
): TransportPayload {
  const lines = compactLines(view).map(escapeTelegramMarkdownV2);
  return {
    buttons: view.target
      ? [{ label: "Open in Hunch", url: view.target.tradeUrl }]
      : [],
    text: lines.join("\n\n"),
    telegram: {
      disableWebPagePreview: false,
      parseMode: "MarkdownV2",
    },
  };
}

export function renderDiscordSignalDelivery(
  view: SignalDeliveryView,
): TransportPayload {
  const fields = [
    view.target
      ? {
          name: "Trade",
          value: `${view.target.venue} · ${view.target.side} · ${(view.target.price * 100).toFixed(1)}¢`,
        }
      : null,
    view.holder?.displayName
      ? { name: "Wallet", value: view.holder.displayName }
      : null,
  ].filter((field): field is { name: string; value: string } => field != null);
  return {
    buttons: view.target
      ? [{ label: "Open in Hunch", url: view.target.tradeUrl }]
      : [],
    embeds: [
      {
        description: truncate(
          [...view.contextLines, ...view.credentialLines].join("\n"),
          3_500,
        ),
        fields,
        title: view.title,
      },
    ],
    text: view.summary,
  };
}

export function renderXSignalDelivery(
  view: SignalDeliveryView,
  maxLength = 280,
): TransportPayload {
  const lines = compactLines(view);
  if (view.target) lines.push(view.target.tradeUrl);
  const thread: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n\n${line}` : line;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }
    if (current) thread.push(current);
    current = truncate(line, maxLength);
  }
  if (current) thread.push(current);
  return { text: thread[0] ?? "", thread };
}

export function createDiscordSignalTransport(
  send: SignalTransportSender,
): SignalTransport {
  return {
    capabilities: {
      buttons: true,
      edits: false,
      maxLength: 4_000,
      replies: true,
    },
    kind: "discord",
    render: renderDiscordSignalDelivery,
    send,
  };
}

export function createTelegramSignalTransport(
  send: SignalTransportSender,
): SignalTransport {
  return {
    capabilities: {
      buttons: true,
      edits: true,
      maxLength: 4_096,
      replies: true,
    },
    kind: "telegram",
    render: renderTelegramSignalDelivery,
    send,
  };
}

export function createXSignalTransport(
  send: SignalTransportSender,
): SignalTransport {
  return {
    capabilities: {
      buttons: false,
      edits: false,
      maxLength: 280,
      replies: true,
    },
    kind: "x",
    render: (view) => renderXSignalDelivery(view, 280),
    send,
  };
}
