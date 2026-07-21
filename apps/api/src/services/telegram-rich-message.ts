export type TelegramRichText =
  | string
  | TelegramRichText[]
  | {
      text: TelegramRichText;
      type:
        | "bold"
        | "code"
        | "italic"
        | "marked"
        | "spoiler"
        | "strikethrough"
        | "underline";
    }
  | {
      alternative_text: string;
      custom_emoji_id: string;
      type: "custom_emoji";
    }
  | {
      text: TelegramRichText;
      type: "url";
      url: string;
    }
  | {
      name: string;
      text: TelegramRichText;
      type: "reference";
    }
  | {
      reference_name: string;
      text: TelegramRichText;
      type: "reference_link";
    }
  | {
      anchor_name: string;
      text: TelegramRichText;
      type: "anchor_link";
    };

export type TelegramRichTableCell = {
  align: "center" | "left" | "right";
  is_header?: true;
  text: TelegramRichText;
  valign: "bottom" | "middle" | "top";
};

export type TelegramInputRichBlockListItem = {
  blocks: TelegramInputRichBlock[];
  has_checkbox?: true;
  is_checked?: true;
  type?: "1" | "A" | "I" | "a" | "i";
  value?: number;
};

export type TelegramInputRichBlock =
  | {
      text: TelegramRichText;
      type: "paragraph";
    }
  | {
      size: 1 | 2 | 3 | 4 | 5 | 6;
      text: TelegramRichText;
      type: "heading";
    }
  | {
      type: "divider";
    }
  | {
      blocks: TelegramInputRichBlock[];
      credit?: TelegramRichText;
      type: "blockquote";
    }
  | {
      blocks: TelegramInputRichBlock[];
      is_open?: true;
      summary: TelegramRichText;
      type: "details";
    }
  | {
      items: TelegramInputRichBlockListItem[];
      type: "list";
    }
  | {
      language?: string;
      text: TelegramRichText;
      type: "pre";
    }
  | {
      name: string;
      type: "anchor";
    }
  | {
      caption?: TelegramRichText;
      cells: TelegramRichTableCell[][];
      is_bordered?: true;
      is_striped?: true;
      type: "table";
    }
  | {
      text: TelegramRichText;
      type: "footer";
    };

export type TelegramInputRichMessage = {
  blocks: TelegramInputRichBlock[];
};

export function telegramRichMessageHasCustomEmoji(
  message: TelegramInputRichMessage,
): boolean {
  return JSON.stringify(message).includes('"type":"custom_emoji"');
}

export function stripTelegramCustomEmojiRichText(
  text: TelegramRichText,
): TelegramRichText {
  if (typeof text === "string") return text;
  if (Array.isArray(text)) return text.map(stripTelegramCustomEmojiRichText);
  if (text.type === "custom_emoji") return text.alternative_text;
  return {
    ...text,
    text: stripTelegramCustomEmojiRichText(text.text),
  };
}

export function stripTelegramCustomEmojiRichMessage(
  message: TelegramInputRichMessage,
): TelegramInputRichMessage {
  const stripBlock = (
    block: TelegramInputRichBlock,
  ): TelegramInputRichBlock => {
    if (
      block.type === "paragraph" ||
      block.type === "heading" ||
      block.type === "footer" ||
      block.type === "pre"
    ) {
      return {
        ...block,
        text: stripTelegramCustomEmojiRichText(block.text),
      };
    }
    if (block.type === "table") {
      return {
        ...block,
        ...(block.caption
          ? { caption: stripTelegramCustomEmojiRichText(block.caption) }
          : {}),
        cells: block.cells.map((row) =>
          row.map((cell) => ({
            ...cell,
            text: stripTelegramCustomEmojiRichText(cell.text),
          })),
        ),
      };
    }
    if (block.type === "blockquote") {
      return {
        ...block,
        blocks: block.blocks.map(stripBlock),
        ...(block.credit
          ? { credit: stripTelegramCustomEmojiRichText(block.credit) }
          : {}),
      };
    }
    if (block.type === "details") {
      return {
        ...block,
        blocks: block.blocks.map(stripBlock),
        summary: stripTelegramCustomEmojiRichText(block.summary),
      };
    }
    if (block.type === "list") {
      return {
        ...block,
        items: block.items.map((item) => ({
          ...item,
          blocks: item.blocks.map(stripBlock),
        })),
      };
    }
    return block;
  };
  return { blocks: message.blocks.map(stripBlock) };
}

export function telegramRichBold(text: TelegramRichText): TelegramRichText {
  return { text, type: "bold" };
}

export function telegramRichItalic(text: TelegramRichText): TelegramRichText {
  return { text, type: "italic" };
}

export function telegramRichCode(text: TelegramRichText): TelegramRichText {
  return { text, type: "code" };
}

export function telegramRichCustomEmoji(
  customEmojiId: string,
  alternativeText: string,
): TelegramRichText {
  return {
    alternative_text: alternativeText,
    custom_emoji_id: customEmojiId,
    type: "custom_emoji",
  };
}

export function telegramRichMarked(text: TelegramRichText): TelegramRichText {
  return { text, type: "marked" };
}

export function telegramRichUnderline(
  text: TelegramRichText,
): TelegramRichText {
  return { text, type: "underline" };
}

export function telegramRichUrl(
  text: TelegramRichText,
  url: string,
): TelegramRichText {
  return { text: telegramRichUnderline(text), type: "url", url };
}

export function telegramRichReference(
  name: string,
  text: TelegramRichText,
): TelegramRichText {
  return { name, text, type: "reference" };
}

export function telegramRichReferenceLink(
  referenceName: string,
  text: TelegramRichText,
): TelegramRichText {
  return { reference_name: referenceName, text, type: "reference_link" };
}

export function telegramRichAnchorLink(
  anchorName: string,
  text: TelegramRichText,
): TelegramRichText {
  return { anchor_name: anchorName, text, type: "anchor_link" };
}

export function telegramRichText(
  ...parts: Array<TelegramRichText | null | undefined | false>
): TelegramRichText {
  return parts.filter(
    (part): part is TelegramRichText =>
      part !== null && part !== undefined && part !== false,
  );
}

export function telegramRichParagraph(
  text: TelegramRichText,
): TelegramInputRichBlock {
  return { text, type: "paragraph" };
}

export function telegramRichHeading(
  text: TelegramRichText,
  size: 1 | 2 | 3 | 4 | 5 | 6 = 5,
): TelegramInputRichBlock {
  return { size, text, type: "heading" };
}

export function telegramRichDivider(): TelegramInputRichBlock {
  return { type: "divider" };
}

export function telegramRichBlockquote(
  blocks: TelegramInputRichBlock[],
  credit?: TelegramRichText,
): TelegramInputRichBlock {
  return {
    blocks,
    ...(credit ? { credit } : {}),
    type: "blockquote",
  };
}

export function telegramRichDetails(input: {
  blocks: TelegramInputRichBlock[];
  open?: boolean;
  summary: TelegramRichText;
}): TelegramInputRichBlock {
  return {
    blocks: input.blocks,
    ...(input.open ? { is_open: true as const } : {}),
    summary: input.summary,
    type: "details",
  };
}

export function telegramRichList(
  items: Array<TelegramInputRichBlock[] | TelegramInputRichBlockListItem>,
): TelegramInputRichBlock {
  return {
    items: items.map((item) => (Array.isArray(item) ? { blocks: item } : item)),
    type: "list",
  };
}

export function telegramRichPreformatted(
  text: TelegramRichText,
  language?: string,
): TelegramInputRichBlock {
  return {
    ...(language ? { language } : {}),
    text,
    type: "pre",
  };
}

export function telegramRichFooter(
  text: TelegramRichText,
): TelegramInputRichBlock {
  return { text, type: "footer" };
}

export function telegramRichAnchor(name: string): TelegramInputRichBlock {
  return { name, type: "anchor" };
}

export function telegramRichTableCell(
  text: TelegramRichText,
  input: {
    align?: TelegramRichTableCell["align"];
    header?: boolean;
    valign?: TelegramRichTableCell["valign"];
  } = {},
): TelegramRichTableCell {
  return {
    align: input.align ?? "left",
    ...(input.header ? { is_header: true as const } : {}),
    text,
    valign: input.valign ?? "middle",
  };
}

export function telegramRichTable(input: {
  caption?: TelegramRichText;
  cells: TelegramRichTableCell[][];
  bordered?: boolean;
  striped?: boolean;
}): TelegramInputRichBlock {
  return {
    ...(input.caption ? { caption: input.caption } : {}),
    cells: input.cells,
    ...(input.bordered === false ? {} : { is_bordered: true as const }),
    ...(input.striped === false ? {} : { is_striped: true as const }),
    type: "table",
  };
}

export function telegramRichMetricsTable(input: {
  caption?: TelegramRichText;
  valueAlign?: TelegramRichTableCell["align"];
  rows: Array<{
    label: TelegramRichText;
    value: TelegramRichText;
  }>;
}): TelegramInputRichBlock {
  return telegramRichTable({
    caption: input.caption,
    cells: input.rows.map((row) => [
      telegramRichTableCell(row.label),
      telegramRichTableCell(row.value, {
        align: input.valueAlign ?? "left",
      }),
    ]),
  });
}
