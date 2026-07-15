export const TELEGRAM_INLINE_BUTTON_GRAPHEME_LIMIT = 64;
export const TELEGRAM_MESSAGE_PAYLOAD_BUDGET = 3_900;

function segmentGraphemes(value: string): string[] {
  const Segmenter = Intl.Segmenter;
  if (Segmenter) {
    const segmenter = new Segmenter("en", { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), (entry) => entry.segment);
  }
  return Array.from(value);
}

export function compactTelegramText(
  value: string,
  maxGraphemes: number,
): string {
  if (maxGraphemes <= 0) return "";
  const graphemes = segmentGraphemes(value);
  if (graphemes.length <= maxGraphemes) return value;
  if (maxGraphemes === 1) return "…";
  return `${graphemes.slice(0, maxGraphemes - 1).join("")}…`;
}

export function telegramPayloadLength(value: string): number {
  return Array.from(value).length;
}

export function canAppendTelegramBlock(input: {
  block: string;
  currentLines: readonly string[];
  reserve?: number;
}): boolean {
  const candidate = [...input.currentLines, input.block].join("\n");
  return (
    telegramPayloadLength(candidate) + Math.max(0, input.reserve ?? 0) <=
    TELEGRAM_MESSAGE_PAYLOAD_BUDGET
  );
}
