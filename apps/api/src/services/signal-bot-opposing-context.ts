import type { DbQuery } from "../db.js";
import {
  normalizeHolderPublicNote,
  type HolderPublicNote,
} from "./holder-research-publication-history.js";
import { escapeTelegramMarkdownV2 } from "./signal-delivery.js";
import { formatTelegramItalic } from "./signal-bot-markdown-format.js";
import {
  telegramRichBold,
  telegramRichItalic,
  telegramRichParagraph,
  telegramRichText,
  type TelegramInputRichBlock,
} from "./telegram-rich-message.js";

export function buildSignalBotOpposingView(
  side: "NO" | "YES",
  labels?: { current: string; previous: string },
  reason?: string,
): {
  markdown: string;
  richBlock: TelegramInputRichBlock;
} {
  const label = `Opposing view · ${labels?.current ?? side} vs earlier ${labels?.previous ?? (side === "YES" ? "NO" : "YES")}`;
  const caveat =
    "Separate holder thesis; not proof the earlier trader changed sides.";
  return {
    markdown: `*${escapeTelegramMarkdownV2(label)}*${reason ? `\n${escapeTelegramMarkdownV2(`What changed: ${reason}`)}` : ""}\n${formatTelegramItalic(caveat)}`,
    richBlock: telegramRichParagraph(
      telegramRichText(
        telegramRichBold(label),
        ...(reason ? [`\nWhat changed: ${reason}`] : []),
        "\n",
        telegramRichItalic(caveat),
      ),
    ),
  };
}

/** Compare with the LAST direction actually delivered here, not any old opposite. */
export const SIGNAL_BOT_LATEST_PUBLIC_THESIS_SQL = `
      select prior.telegram_message_id::text as "messageId",
        prior_note.id::text as "noteId", prior_note.source_id as "marketId",
        case prior_note.direction when 'up' then 'YES' else 'NO' end as side,
        prior.sent_at::text as "publishedAt", prior_note.title, prior_note.description as summary,
        prior_note.metrics #>> '{sideCopy,label}' as "sideLabel",
        prior.metrics->'publicationSnapshotV1' as "priceSnapshot",
        prior_note.lineage->'decision_snapshot' as "decisionSnapshot",
        prior_note.model_meta->'external_research' as "externalResearch"
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
        and prior_note.source_id = $2
        and prior_note.note_type = 'signal'
        and prior_note.producer_type = 'holder_research'
        and prior_note.status <> 'retracted'
        and prior_note.direction in ('up', 'down')
        and prior.telegram_message_id is not null
        and coalesce(prior.metrics->>'status', 'sent') = 'sent'
        and coalesce(prior.metrics->>'contentProfile', '') <> 'x_editorial_draft_v1'
      order by prior.sent_at desc, prior.id desc
      limit 1
`;

export async function loadSignalBotLatestPublicThesis(input: {
  chatId: string;
  db: DbQuery;
  marketId: string;
  noteId: string;
}): Promise<(HolderPublicNote & { messageId: number }) | null> {
  const { rows } = await input.db.query<
    HolderPublicNote & { messageId: string }
  >(SIGNAL_BOT_LATEST_PUBLIC_THESIS_SQL, [
    input.chatId,
    input.marketId,
    input.noteId,
  ]);
  const row = rows[0];
  const messageId = Number(row?.messageId);
  return row && Number.isSafeInteger(messageId) && messageId > 0
    ? normalizeHolderPublicNote({ ...row, messageId })
    : null;
}
