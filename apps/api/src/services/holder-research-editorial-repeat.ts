import type { HolderResearchTriageDecisionV2 } from "../schemas/holder-research.js";
import type { EventPublicationHistory } from "./holder-research-event-publications.js";
import type { HolderContractHistory } from "./holder-research-publication-history.js";

/** Only accept the model's cheap repeat decision if it points to an actual
 * delivery. Never turn a tentative comparison into a durable cache veto. */
export function classifyHolderEditorialRepeat(input: {
  decision: HolderResearchTriageDecisionV2;
  history?: HolderContractHistory;
  eventHistory?: EventPublicationHistory;
  side: "YES" | "NO" | null;
  marketId: string;
  verifiedPositionChange: boolean;
  materialAskChange: boolean;
  currentAskKnown: boolean;
  hasMaterialUpdateSince: (publishedAt: string) => boolean;
}): "not_repeat" | "defer" | "investigate" {
  const { decision, history } = input;
  if (
    decision.action !== "skip" ||
    !decision.reason_codes.includes("editorial_repeat")
  )
    return "not_repeat";
  if (
    !input.side ||
    history?.status !== "ok" ||
    !decision.repeat_of_note_id ||
    decision.research_need !== "none" ||
    decision.research_question ||
    !input.currentAskKnown ||
    input.verifiedPositionChange ||
    input.materialAskChange
  )
    return "investigate";

  const latest = history.items[0];
  if (latest && latest.side !== input.side) return "investigate";
  const exact = latest?.noteId === decision.repeat_of_note_id ? latest : null;
  const sibling =
    input.eventHistory?.status === "complete" ||
    input.eventHistory?.status === "partial"
      ? input.eventHistory.items.find(
          (item) =>
            item.delivery === "telegram" &&
            item.noteId === decision.repeat_of_note_id &&
            item.marketId !== input.marketId &&
            item.quotedAsk != null &&
            item.selectedOutcomeCondition,
        )
      : null;
  const anchor = exact || sibling;
  return anchor && !input.hasMaterialUpdateSince(anchor.publishedAt)
    ? "defer"
    : "investigate";
}
