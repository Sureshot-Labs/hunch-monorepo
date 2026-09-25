import { SIGNAL_BOT_QUOTE_MAX_AGE_MS } from "./signal-bot-delivery-policy.js";
import type {
  TelegramInputRichMessage,
  TelegramRichText,
} from "./telegram-rich-message.js";

export function signalBotPositionPriceLabel(input: {
  side: "NO" | "YES";
  sideLabel: string;
}): string {
  const sideLabel = input.sideLabel.trim();
  if (
    !sideLabel ||
    sideLabel.toUpperCase() === input.side ||
    /^(?:YES|NO)\s+on\b|^against\b/i.test(sideLabel)
  ) {
    return `${input.side} price`;
  }
  return `${sideLabel} price`;
}

function snapshotPriceLanguage(value: string): string {
  return value
    .replace(/(\d+(?:\\?\.\d+)?¢)\s+(?:now|live)\b/gi, "$1 at snapshot")
    .replace(/\b(?:is )?now trading at\b/gi, "was quoted at")
    .replace(/\bnow trades at\b/gi, "was quoted at")
    .replace(/\bnow (?:sit|sits) at\b/gi, "were quoted at")
    .replace(/\b(?:live|current) (price|odds)\b/gi, "snapshot $1");
}

function richTextContent(value: TelegramRichText): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(richTextContent).join("");
  return richTextContent(value.text);
}

function snapshotRichText(
  value: TelegramRichText,
  precedingText = "",
): TelegramRichText {
  if (typeof value === "string") {
    const text = snapshotPriceLanguage(value);
    return /¢\s*$/.test(precedingText)
      ? text.replace(/^(\s*)(?:now|live)\b/i, "$1at snapshot")
      : text;
  }
  if (Array.isArray(value)) {
    let previous = precedingText;
    return value.map((part) => {
      const updated = snapshotRichText(part, previous);
      previous += richTextContent(updated);
      return updated;
    });
  }
  return { ...value, text: snapshotRichText(value.text, precedingText) };
}

export function withSignalBotNotificationSnapshotContext<
  T extends { richMessage: TelegramInputRichMessage; text: string },
>(rendered: T, asOf: string, now: Date): T {
  const snapshotMs = Date.parse(asOf);
  if (
    !Number.isFinite(snapshotMs) ||
    now.getTime() - snapshotMs <= SIGNAL_BOT_QUOTE_MAX_AGE_MS
  ) {
    return rendered;
  }
  const timestamp = new Date(snapshotMs)
    .toISOString()
    .slice(0, 16)
    .replaceAll("-", "/")
    .replace("T", " ");
  const notice = `Price snapshot as of ${timestamp} UTC`;
  return {
    ...rendered,
    text: `${snapshotPriceLanguage(rendered.text)}\n\n${notice}`,
    richMessage: {
      blocks: [
        ...rendered.richMessage.blocks.map((block) => {
          if ("text" in block) {
            return { ...block, text: snapshotRichText(block.text) };
          }
          if (block.type === "table") {
            return {
              ...block,
              ...(block.caption
                ? { caption: snapshotRichText(block.caption) }
                : {}),
              cells: block.cells.map((row) =>
                row.map((cell) => ({
                  ...cell,
                  text: snapshotRichText(cell.text),
                })),
              ),
            };
          }
          return block;
        }),
        { text: notice, type: "footer" },
      ],
    },
  };
}
