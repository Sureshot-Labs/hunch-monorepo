import type { SignalBotPolicy } from "./signal-bot-trading-policy.js";
import type { XEditorialComposerConfig } from "./x-editorial-draft.js";

// Null overrides preserve environment/default settings; safe for sidecar imports.
export function resolveSignalBotEditorialConfig(
  base: XEditorialComposerConfig,
  policy: SignalBotPolicy,
): XEditorialComposerConfig {
  return {
    ...base,
    model: policy.xEditorialModel ?? base.model,
    reasoningEffort: policy.xEditorialReasoningEffort ?? base.reasoningEffort,
    maxOutputTokens: policy.xEditorialMaxOutputTokens ?? base.maxOutputTokens,
  };
}
