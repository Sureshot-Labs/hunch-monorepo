import type { DbQuery } from "../db.js";
import { escapeTelegramMarkdownV2 } from "./signal-delivery.js";
import { formatTelegramItalic } from "./signal-bot-markdown-format.js";
import {
  telegramRichBold,
  telegramRichItalic,
  telegramRichParagraph,
  telegramRichText,
  type TelegramInputRichBlock,
} from "./telegram-rich-message.js";

export function buildSignalBotOpposingView(side: "NO" | "YES"): {
  markdown: string;
  richBlock: TelegramInputRichBlock;
} {
  const label = `Opposing view · ${side} vs earlier ${side === "YES" ? "NO" : "YES"}`;
  const caveat =
    "Separate holder thesis; not proof the earlier trader changed sides.";
  return {
    markdown: `*${escapeTelegramMarkdownV2(label)}*\n${formatTelegramItalic(caveat)}`,
    richBlock: telegramRichParagraph(
      telegramRichText(
        telegramRichBold(label),
        "\n",
        telegramRichItalic(caveat),
      ),
    ),
  };
}

/** Link opposing initial theses only to messages actually delivered in this chat. */
export async function loadSignalBotOpposingMessageId(input: {
  chatId: string;
  db: DbQuery;
  marketId: string;
  noteId: string;
  selectedSide: "NO" | "YES";
}): Promise<number | null> {
  const { rows } = await input.db.query<{
    reply_to_message_id: string | number | null;
  }>(
    `
      select prior.telegram_message_id::text as reply_to_message_id
      from ai_note_targets market_target
      join ai_notes prior_note on prior_note.id = market_target.note_id
      join signal_bot_messages prior
        on prior.note_id = prior_note.id
       and prior.chat_id = $1
       and prior.message_kind in ('initial', 'research_update')
      where market_target.target_kind = 'market'
        and market_target.target_id = $2
        and market_target.is_primary = true
        and prior.note_id <> $3::uuid
        and prior_note.note_type = 'signal'
        and prior_note.producer_type = 'holder_research'
        and prior_note.status <> 'retracted'
        and prior_note.direction = $4
        and prior.telegram_message_id is not null
        and coalesce(prior.metrics->>'status', 'sent') = 'sent'
      order by prior.sent_at desc, prior.telegram_message_id desc
      limit 1
    `,
    [
      input.chatId,
      input.marketId,
      input.noteId,
      input.selectedSide === "YES" ? "down" : "up",
    ],
  );
  const value = rows[0]?.reply_to_message_id;
  const messageId = value == null ? null : Number(value);
  return messageId != null && Number.isSafeInteger(messageId) && messageId > 0
    ? messageId
    : null;
}
