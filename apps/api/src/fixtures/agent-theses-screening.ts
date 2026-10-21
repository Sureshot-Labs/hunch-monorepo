import { DEFAULT_AGENT_THESES_POLICY } from "../services/agent-theses-policy.js";
import {
  AGENT_SCREEN_DECISIONS,
  type AgentCandidateScreen,
} from "../services/agent-theses-model.js";

/** Mock provider output only; never a live judgement of editorial quality. */
export function agentScreenFixture(
  body: unknown,
  decide: (label: string) => AgentCandidateScreen["decision"] = () => "usable",
) {
  const questions =
    (body as { questions?: Record<string, unknown> }).questions ?? {};
  const keys = Object.keys(questions);
  if (!keys.length || keys.some((key) => !key.startsWith("screen_c")))
    return null;
  return {
    model: DEFAULT_AGENT_THESES_POLICY.jevModel,
    usage: { cost: 0.001 },
    answers: Object.fromEntries(
      keys.map((key) => {
        const selected = decide(key.slice("screen_".length));
        return [
          key,
          {
            type: "choice",
            choice: selected,
            confidence: 1,
            probabilities: Object.fromEntries(
              AGENT_SCREEN_DECISIONS.map((option) => [
                option,
                Number(option === selected),
              ]),
            ),
          },
        ];
      }),
    ),
  };
}
