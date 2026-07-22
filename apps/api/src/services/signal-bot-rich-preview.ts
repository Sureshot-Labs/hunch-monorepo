import type { SignalBotRichPreviewKind } from "./signal-bot-command-parsers.js";
import {
  telegramRichAnchor,
  telegramRichAnchorLink,
  telegramRichBold,
  telegramRichDivider,
  telegramRichFooter,
  telegramRichHeading,
  telegramRichMarked,
  telegramRichMetricsTable,
  telegramRichParagraph,
  telegramRichReference,
  telegramRichReferenceLink,
  telegramRichText,
  type TelegramInputRichMessage,
  type TelegramRichText,
} from "./telegram-rich-message.js";

type SignalBotRichPreviewTelegramClient = {
  sendRichMessage?(input: {
    chat_id: string;
    rich_message: TelegramInputRichMessage;
  }): Promise<{ ok: boolean; retryAfterSec?: number }>;
};

function emphasizeNarrative(value: string): TelegramRichText {
  const metricPattern =
    /([+−-]?\$\d[\d,.]*(?:\.\d+)?[KMB]?|\d+(?:\.\d+)?%|\d+(?:\.\d+)?¢)/g;
  const parts = value.split(metricPattern);
  return telegramRichText(
    ...parts.map((part, index) =>
      index % 2 === 1 ? telegramRichBold(part) : part,
    ),
  );
}

function richPreviewHeadline(input: {
  continuation: string;
  emoji: string;
  hook: string;
}): TelegramRichText {
  return telegramRichText(
    `${input.emoji} `,
    telegramRichMarked(input.hook),
    ` ${input.continuation}`,
  );
}

function richPreviewTable(
  rows: Array<{ label: TelegramRichText; value: TelegramRichText }>,
): TelegramInputRichMessage["blocks"][number] {
  return telegramRichMetricsTable({ rows });
}

function richPreviewPositionTable(
  rows: Array<{ label: string; value: string }>,
): TelegramInputRichMessage["blocks"][number] {
  return richPreviewTable(
    rows.map((row) => ({
      label: row.label,
      value: telegramRichBold(row.value),
    })),
  );
}

function richPreviewStory(input: {
  continuation: string;
  emoji: string;
  hook: string;
  paragraphs: string[];
  rows: Array<{ label: string; value: string }>;
}): TelegramInputRichMessage {
  return {
    blocks: [
      telegramRichParagraph(
        telegramRichText(
          richPreviewHeadline(input),
          ...input.paragraphs.flatMap((paragraph) => [
            "\n\n",
            emphasizeNarrative(paragraph),
          ]),
        ),
      ),
      richPreviewPositionTable(input.rows),
    ],
  };
}

function buildSignalBotRichPreviewFixtures(
  kind: SignalBotRichPreviewKind,
): TelegramInputRichMessage[] {
  const production: TelegramInputRichMessage[] = [
    richPreviewStory({
      continuation: "This wallet is backing Spain over Argentina.",
      emoji: "👀",
      hook: "+$542K last month.",
      paragraphs: [
        "Most tracked money is on Argentina, but this wallet is holding $20.5K on Spain.",
        "The market prefers Argentina. This wallet does not.",
      ],
      rows: [
        { label: "Market", value: "Spain to advance against Argentina" },
        { label: "Position", value: "$20.5K on Spain" },
        { label: "Spain price", value: "21¢" },
        { label: "Wallet 30d PnL", value: "+$542K" },
        { label: "Wallet 30d volume", value: "$2.9M" },
      ],
    }),
    richPreviewStory({
      continuation: "A wallet up $67K is still betting on it.",
      emoji: "🪙",
      hook: "Ethereum crashing to $1,000 is priced at 16%.",
      paragraphs: [
        "The market gives Ethereum only a 16% chance of touching $1,000, but LlamaLoco0000 is still holding $53.2K on YES despite being down $8.1K on the trade.",
        "The wallet has traded more than $539K over the last 30 days and has not backed away from one of its most contrarian positions.",
      ],
      rows: [
        { label: "Market", value: "Ethereum to hit $1,000 before 2027" },
        { label: "Position", value: "$53.2K on YES" },
        { label: "YES price", value: "16¢" },
        { label: "Open PnL", value: "−$8.1K" },
        { label: "Wallet 30d PnL", value: "+$67.1K" },
      ],
    }),
    richPreviewStory({
      continuation:
        "Three profitable wallets are holding $277K on the other side.",
      emoji: "🏆",
      hook: "Most tracked money is fading England.",
      paragraphs: [
        "Most tracked money is betting against England, but three of the strongest wallets are still holding the other side.",
        "Together, they made $644K over the last 30 days. Their conviction makes England's 22% chance more interesting than the market price alone suggests.",
      ],
      rows: [
        { label: "Market", value: "England to win the World Cup" },
        { label: "Combined position", value: "$277K on YES" },
        { label: "YES price", value: "22¢" },
        { label: "Profitable wallets aligned", value: "3" },
        { label: "Combined 30d PnL", value: "+$644.1K" },
      ],
    }),
    richPreviewStory({
      continuation: "Four wallets up nearly $1M are still backing Argentina.",
      emoji: "🏆",
      hook: "Argentina is priced at 17%.",
      paragraphs: [
        "Most tracked money is betting against Argentina, but four strong wallets continue to hold $66K on YES.",
        "Together, they made $967.8K over the last 30 days. Argentina is still a minority bet at 17¢, but it has unusually credible money behind it.",
      ],
      rows: [
        { label: "Market", value: "Argentina to win the World Cup" },
        { label: "Combined position", value: "$66K on YES" },
        { label: "YES price", value: "17¢" },
        { label: "Open PnL", value: "+$9.2K" },
        { label: "Profitable wallets aligned", value: "4" },
        { label: "Combined 30d PnL", value: "+$967.8K" },
      ],
    }),
    richPreviewStory({
      continuation: "Two wallets up $251K are taking Spain instead.",
      emoji: "⚽",
      hook: "France is the favorite.",
      paragraphs: [
        "France is priced around 60% to advance, but two strong wallets are holding $20.2K on Spain.",
        "Together, they made $250.8K over the last 30 days. The wider market prefers France, making this a credible contrarian position ahead of kickoff.",
      ],
      rows: [
        { label: "Market", value: "Spain to advance against France" },
        { label: "Combined position", value: "$20.2K on Spain" },
        { label: "Spain price", value: "41¢" },
        { label: "Profitable wallets aligned", value: "2" },
        { label: "Combined 30d PnL", value: "+$250.8K" },
      ],
    }),
    richPreviewStory({
      continuation: "One profitable wallet is holding $32.5K on YES.",
      emoji: "🌐",
      hook: "A U.S. invasion of Iran is priced at 20%.",
      paragraphs: [
        "The market prices the chance at just 20%, while most tracked money is positioned on NO.",
        "Trashpilot is still holding $32.5K on YES after making $43.7K over the last 30 days. It is a high-risk minority bet, but one backed by a wallet with recent momentum.",
      ],
      rows: [
        { label: "Market", value: "U.S. to invade Iran before 2027" },
        { label: "Position", value: "$32.5K on YES" },
        { label: "YES price", value: "20¢" },
        { label: "Open PnL", value: "+$834" },
        { label: "Wallet 30d PnL", value: "+$43.7K" },
      ],
    }),
    richPreviewStory({
      continuation: "Five profitable wallets are quietly backing it.",
      emoji: "🏆",
      hook: "Most tracked money is against Spain.",
      paragraphs: [
        "The wallets are holding a combined $38.5K on Spain, despite most tracked money sitting on the other side.",
        "Together, they made $642.7K over the last 30 days. At 21¢, Spain still offers meaningful upside if their conviction is right.",
      ],
      rows: [
        { label: "Market", value: "Spain to win the World Cup" },
        { label: "Combined position", value: "$38.5K on YES" },
        { label: "YES price", value: "21¢" },
        { label: "Open PnL", value: "+$4.8K" },
        { label: "Profitable wallets aligned", value: "5" },
        { label: "Combined 30d PnL", value: "+$642.7K" },
      ],
    }),
    richPreviewStory({
      continuation: "It is backing France to win the World Cup.",
      emoji: "🐋",
      hook: "A wallet up $168K has built a $305K position.",
      paragraphs: [
        "Mentionmarket has kept the full position despite heavier tracked money betting against France.",
        "The wallet traded $1.2M over the last 30 days and is still holding one of the largest tracked positions in the market.",
      ],
      rows: [
        { label: "Market", value: "France to win the World Cup" },
        { label: "Position", value: "$305K on YES" },
        { label: "YES price", value: "39¢" },
        { label: "Open PnL", value: "+$1.1K" },
        { label: "Wallet 30d PnL", value: "+$168.3K" },
        { label: "Wallet 30d volume", value: "$1.2M" },
      ],
    }),
    richPreviewStory({
      continuation: "Neither has backed away.",
      emoji: "⚽",
      hook: "Two wallets up $1.4M are down on France.",
      paragraphs: [
        "The wallets are holding a combined $56.4K on France, despite currently being down $3.9K on the position.",
        "Their recent performance makes the continued hold worth watching, especially with France priced at only 38¢.",
      ],
      rows: [
        { label: "Market", value: "France to beat Spain" },
        { label: "Combined position", value: "$56.4K on France" },
        { label: "France price", value: "38¢" },
        { label: "Open PnL", value: "−$3.9K" },
        { label: "Profitable wallets aligned", value: "2" },
        { label: "Combined 30d PnL", value: "+$1.4M" },
      ],
    }),
    richPreviewStory({
      continuation: "Two profitable wallets are betting against him.",
      emoji: "🔥",
      hook: "Messi has only an 8% chance of winning the Golden Boot.",
      paragraphs: [
        "The wallets hold a combined $38K on NO and made $122K over the last 30 days.",
        "The market already leans heavily against Messi, so the value here is the scale and quality of the wallets aligned on the same side.",
      ],
      rows: [
        { label: "Market", value: "Lionel Messi to win the Golden Boot" },
        { label: "Combined position", value: "$38K on NO" },
        { label: "NO price", value: "92¢" },
        { label: "Profitable wallets aligned", value: "2" },
        { label: "Combined 30d PnL", value: "+$122K" },
      ],
    }),
    richPreviewStory({
      continuation: "Mbappé reached 99¢ to win the Golden Boot.",
      emoji: "⚠️",
      hook: "22 early wallets are cashing out.",
      paragraphs: [
        "Tracked wallets entered when Mbappé was trading at 49¢ and are now sitting on an estimated $649K in open profit.",
        "Although another $1M flowed into YES, 17 wallets trimmed and five exited. The trade has largely played out, and some early holders are no longer waiting for the final cent.",
      ],
      rows: [
        { label: "Market", value: "Kylian Mbappé to win the Golden Boot" },
        { label: "YES price", value: "49¢ → 99¢" },
        { label: "Net tracked flow", value: "+$1M" },
        { label: "Wallet activity", value: "17 added · 17 trimmed · 5 exited" },
        { label: "Still holding", value: "45" },
        { label: "Est. open PnL", value: "+$649K" },
      ],
    }),
    richPreviewStory({
      continuation: "This wallet still refuses to flip.",
      emoji: "📉",
      hook: "Bitcoin is moving closer to $67.5K.",
      paragraphs: [
        "The price of NO fell by 11¢ to 61¢, meaning the market has become more confident that Bitcoin could reach $67.5K before the end of July.",
        "The tracked wallet still holds $5.8K on NO and remains approximately $1.5K in profit, but the market has moved against its position since the signal.",
      ],
      rows: [
        { label: "Market", value: "Bitcoin to hit $67.5K in July" },
        { label: "Position", value: "$5.8K on NO" },
        { label: "NO price", value: "61¢" },
        { label: "Move since call", value: "−11¢" },
        { label: "Est. open PnL", value: "+$1.5K" },
      ],
    }),
    richPreviewStory({
      continuation:
        "NO on a 25 bps Fed increase in July moved against large-wallet buying.",
      emoji: "📈",
      hook: "+$352K bought. −10¢ anyway.",
      paragraphs: [
        "Large wallets put another $352K behind NO, but the market continued moving the other way.",
        "The buying was not enough to offset the selling pressure. NO is now trading at 83¢, down 10¢ since the original signal, while three large wallets have already exited.",
      ],
      rows: [
        { label: "Market", value: "25 bps Fed increase in July" },
        { label: "Net buying", value: "+$352K" },
        {
          label: "Wallet activity",
          value: "6 added · 7 trimmed · 3 exited",
        },
        { label: "Still holding", value: "13" },
        { label: "NO price", value: "93¢ → 83¢" },
        { label: "Est. open PnL", value: "−$77.7K" },
      ],
    }),
  ];
  const headingCopy = {
    continuation: "This wallet is backing Spain over Argentina.",
    emoji: "👀",
    hook: "+$542K last month.",
  };
  const headingBody = telegramRichText(
    emphasizeNarrative(
      "Most tracked money is on Argentina, but this wallet is holding $20.5K on Spain.",
    ),
    "\n\n",
    "The market prefers Argentina. This wallet does not.",
  );
  const headingTable = () =>
    richPreviewPositionTable([
      { label: "Market", value: "Spain to advance against Argentina" },
      { label: "Position", value: "$20.5K on Spain" },
      { label: "Spain price", value: "21¢" },
      { label: "Wallet 30d PnL", value: "+$542K" },
    ]);
  const headings: TelegramInputRichMessage[] = [
    {
      blocks: [
        telegramRichHeading(richPreviewHeadline(headingCopy), 6),
        telegramRichParagraph(headingBody),
        headingTable(),
      ],
    },
    {
      blocks: [
        telegramRichHeading(richPreviewHeadline(headingCopy), 5),
        telegramRichParagraph(headingBody),
        headingTable(),
      ],
    },
    {
      blocks: [
        telegramRichHeading(
          telegramRichText(
            `${headingCopy.emoji} `,
            telegramRichMarked(headingCopy.hook),
          ),
          5,
        ),
        telegramRichParagraph(
          telegramRichText(headingCopy.continuation, "\n\n", headingBody),
        ),
        headingTable(),
      ],
    },
  ];
  const references: TelegramInputRichMessage[] = [
    {
      blocks: [
        telegramRichAnchor("top"),
        telegramRichParagraph(
          telegramRichText(
            richPreviewHeadline({
              continuation: "One profitable wallet is taking the other side.",
              emoji: "🌐",
              hook: "Argentina is still the favorite.",
            }),
            "\n\nPublic pre-match odds also lean Argentina ",
            telegramRichReferenceLink("outside-odds", "[1]"),
            ", while the tracked wallet continues to hold Spain.",
          ),
        ),
        richPreviewTable([
          { label: "Position", value: telegramRichBold("$20.5K on Spain") },
          {
            label: "Recent PnL",
            value: telegramRichText(telegramRichBold("+$542K"), " · 30d"),
          },
        ]),
        telegramRichDivider(),
        telegramRichFooter(
          telegramRichText(
            telegramRichReference(
              "outside-odds",
              "[1] Consensus pre-match odds, checked 20 Jul 2026.",
            ),
            " · ",
            telegramRichAnchorLink("top", "Back to top"),
          ),
        ),
      ],
    },
  ];
  if (kind === "production") return production;
  if (kind === "headings") return headings;
  if (kind === "references") return references;
  return [...production, ...headings, ...references];
}

export async function sendSignalBotRichLayoutPreview(input: {
  chatId: string;
  kind?: SignalBotRichPreviewKind;
  telegram: SignalBotRichPreviewTelegramClient;
}): Promise<boolean> {
  if (!input.telegram.sendRichMessage) return false;
  for (const richMessage of buildSignalBotRichPreviewFixtures(
    input.kind ?? "all",
  )) {
    let result = await input.telegram.sendRichMessage({
      chat_id: input.chatId,
      rich_message: richMessage,
    });
    if (result.ok === false && result.retryAfterSec != null) {
      const retryAfterSec = result.retryAfterSec;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(5, retryAfterSec) * 1_000),
      );
      result = await input.telegram.sendRichMessage({
        chat_id: input.chatId,
        rich_message: richMessage,
      });
    }
    if (!result.ok) return false;
  }
  return true;
}
