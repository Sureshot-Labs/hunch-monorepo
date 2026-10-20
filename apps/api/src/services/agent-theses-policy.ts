import { z } from "zod";
import type { DbQuery } from "../db.js";
import { socialFingerprint } from "./social-primitives.js";

export const AGENT_SPECIALIZATIONS = ["politics", "sports", "crypto"] as const;
const DEFAULT_INTERESTS = {
  politics:
    "Politics, elections, institutions, geopolitics and international conflicts.",
  sports: "Sports, esports, teams, athletes, matches, tournaments and seasons.",
  crypto:
    "Crypto, Bitcoin, Ethereum, protocols, price catalysts and market positioning.",
} as const;
const authorSchema = z
  .object({
    userId: z.string().uuid().nullable(),
    enabled: z.boolean(),
    specialization: z.enum(AGENT_SPECIALIZATIONS),
    // The specialization is a stable profile slot, not a category restriction.
    // Optional on input for existing policies; resolve once to its old topic.
    interests: z.string().trim().min(1).max(1200).optional(),
    approach: z.string().min(1).max(1200),
    style: z.string().min(1).max(600),
    paperAmountUsd: z
      .string()
      .regex(/^[1-9]\d*(?:\.\d{1,6})?$/)
      .refine((v) => Number(v) <= 10000),
  })
  .strict();
export const agentThesesPolicySchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    jevModel: z.string().min(1).max(160),
    writerModel: z.string().min(1).max(160),
    dayBudgetUsd: z.number().positive().max(100),
    jevReserveUsd: z.number().positive().max(1),
    writerReserveUsd: z.number().positive().max(10),
    publishIntervalSeconds: z.number().int().min(60).max(604800),
    maxMarkets: z.number().int().min(1).max(120),
    candidatesPerAuthor: z.number().int().min(1).max(24),
    authors: z
      .array(authorSchema)
      .length(3)
      .refine(
        (authors) =>
          new Set(authors.map((a) => a.specialization)).size === 3 &&
          new Set(authors.flatMap((a) => (a.userId ? [a.userId] : []))).size ===
            authors.filter((a) => a.userId).length,
        "Each specialization and configured user must be unique",
      ),
  })
  .strict();
export type AgentThesesPolicy = z.infer<typeof agentThesesPolicySchema>;
export type AgentAuthor = AgentThesesPolicy["authors"][number];
export function agentInterests(author: AgentAuthor): string {
  return author.interests ?? DEFAULT_INTERESTS[author.specialization];
}
export const DEFAULT_AGENT_THESES_POLICY: AgentThesesPolicy = {
  version: 1,
  enabled: false,
  jevModel: "typesafe/jev-1.14-20261014",
  writerModel: "openai/gpt-6.1-sol",
  dayBudgetUsd: 2,
  jevReserveUsd: 0.01,
  writerReserveUsd: 0.25,
  publishIntervalSeconds: 14400,
  maxMarkets: 120,
  candidatesPerAuthor: 24,
  authors: [
    {
      userId: null,
      enabled: true,
      specialization: "politics",
      interests: DEFAULT_INTERESTS.politics,
      paperAmountUsd: "100",
      approach:
        "Skeptical: incentives, institutional constraints and capacity to implement.",
      style:
        "Clear, measured and specific. Distinguish announcements from execution.",
    },
    {
      userId: null,
      enabled: true,
      specialization: "sports",
      interests: DEFAULT_INTERESTS.sports,
      paperAmountUsd: "100",
      approach:
        "Data-oriented: exact contest stage, specialist track records and opposing evidence.",
      style:
        "Direct and concise. No invented injury, roster or form information.",
    },
    {
      userId: null,
      enabled: true,
      specialization: "crypto",
      interests: DEFAULT_INTERESTS.crypto,
      paperAmountUsd: "100",
      approach:
        "Moderately contrarian: test consensus against dated catalysts and observed positioning.",
      style:
        "Concrete and probabilistic. Contrarian is not synonymous with NO.",
    },
  ],
};
export const agentThesesOverrideSchema = agentThesesPolicySchema.partial();
export async function resolveAgentThesesPolicy(db: DbQuery) {
  const { rows } = await db.query(
    `select payload from runtime_policies where policy_key=$1 and effective_at<=statement_timestamp()
     order by effective_at desc,created_at desc limit 1`,
    ["agent_theses"],
  );
  // Invalid policy is an operational failure, never an implicit enable.
  const policy = agentThesesPolicySchema.parse({
    ...DEFAULT_AGENT_THESES_POLICY,
    ...agentThesesOverrideSchema.parse(rows[0]?.payload ?? {}),
  });
  policy.authors = policy.authors.map((author) => ({
    ...author,
    interests: agentInterests(author),
  }));
  return { policy, revision: socialFingerprint(policy).slice(0, 16) };
}
