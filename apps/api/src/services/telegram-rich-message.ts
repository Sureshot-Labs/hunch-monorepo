export type TelegramRichText =
  | string
  | TelegramRichText[]
  | {
      text: TelegramRichText;
      type: "bold" | "italic" | "marked" | "underline";
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

export function telegramRichBold(text: TelegramRichText): TelegramRichText {
  return { text, type: "bold" };
}

export function telegramRichItalic(text: TelegramRichText): TelegramRichText {
  return { text, type: "italic" };
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

export function telegramRichMetricsTable(input: {
  caption?: TelegramRichText;
  valueAlign?: TelegramRichTableCell["align"];
  rows: Array<{
    label: TelegramRichText;
    value: TelegramRichText;
  }>;
}): TelegramInputRichBlock {
  return {
    ...(input.caption ? { caption: input.caption } : {}),
    cells: input.rows.map((row) => [
      telegramRichTableCell(row.label),
      telegramRichTableCell(row.value, {
        align: input.valueAlign ?? "left",
      }),
    ]),
    is_bordered: true,
    is_striped: true,
    type: "table",
  };
}
