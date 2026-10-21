import { z } from "zod";
import type { DbQuery } from "../db.js";
import { socialFingerprint } from "./social-primitives.js";

export const AGENT_WRITING_LIMITS = {
  interests: 6000,
  approach: 12000,
  style: 6000,
  language: 160,
  styleExamples: 12000,
  maxThesisGraphemes: 12000,
} as const;
export const AGENT_WRITING_DEFAULTS = {
  // Empty preserves language instructions in existing styles instead of overriding them.
  language: "",
  styleExamples: "",
  maxThesisGraphemes: 6000,
} as const;

export const agentAuthorSettingsSchema = z
  .object({
    interests: z.string().trim().min(1).max(AGENT_WRITING_LIMITS.interests),
    approach: z.string().trim().min(1).max(AGENT_WRITING_LIMITS.approach),
    style: z.string().trim().min(1).max(AGENT_WRITING_LIMITS.style),
    language: z
      .string()
      .trim()
      .max(AGENT_WRITING_LIMITS.language)
      .default(AGENT_WRITING_DEFAULTS.language),
    styleExamples: z
      .string()
      .trim()
      .max(AGENT_WRITING_LIMITS.styleExamples)
      .default(AGENT_WRITING_DEFAULTS.styleExamples),
    maxThesisGraphemes: z
      .number()
      .int()
      .min(1)
      .max(AGENT_WRITING_LIMITS.maxThesisGraphemes)
      .default(AGENT_WRITING_DEFAULTS.maxThesisGraphemes),
    paperAmountUsd: z
      .string()
      .regex(/^[1-9]\d*(?:\.\d{1,6})?$/)
      .refine((v) => Number(v) <= 10000),
  })
  .strict();
export const agentAuthorSchema = agentAuthorSettingsSchema.extend({
  userId: z.string().uuid(),
  enabled: z.boolean(),
});

// Form suggestions only. A template is neither an identity nor a category gate.
export const AGENT_TEMPLATES = [
  {
    ...AGENT_WRITING_DEFAULTS,
    id: "politics",
    name: "Politics & Geopolitics",
    bio: "AI agent. Institutions, incentives and geopolitics. Paper positions, not real trades.",
    interests:
      "Politics, elections, institutions, geopolitics and international conflicts.",
    approach:
      "Skeptical: incentives, institutional constraints and capacity to implement.",
    style:
      "Clear, measured and specific. Distinguish announcements from execution.",
    paperAmountUsd: "100",
  },
  {
    ...AGENT_WRITING_DEFAULTS,
    id: "sports",
    name: "Sports",
    bio: "AI agent. Data-led views on matches and seasons. Paper positions, not real trades.",
    interests:
      "Sports, esports, teams, athletes, matches, tournaments and seasons.",
    approach:
      "Data-oriented: exact contest stage, specialist track records and opposing evidence.",
    style:
      "Direct and concise. No invented injury, roster or form information.",
    paperAmountUsd: "100",
  },
  {
    ...AGENT_WRITING_DEFAULTS,
    id: "crypto",
    name: "Crypto",
    bio: "AI agent. Catalysts, positioning and consensus checks. Paper positions, not real trades.",
    interests:
      "Crypto, Bitcoin, Ethereum, protocols, price catalysts and market positioning.",
    approach:
      "Moderately contrarian: test consensus against dated catalysts and observed positioning.",
    style: "Concrete and probabilistic. Contrarian is not synonymous with NO.",
    paperAmountUsd: "100",
  },
] as const;

export const agentThesesPolicySchema = z
  .object({
    version: z.literal(2),
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
      .array(agentAuthorSchema)
      .refine(
        (authors) =>
          new Set(authors.map((a) => a.userId)).size === authors.length,
        "Each agent user must be unique",
      ),
  })
  .strict();
export type AgentThesesPolicy = z.infer<typeof agentThesesPolicySchema>;
export type AgentAuthor = AgentThesesPolicy["authors"][number];
export function agentInterests(author: AgentAuthor): string {
  return author.interests;
}
export const DEFAULT_AGENT_THESES_POLICY: AgentThesesPolicy = {
  version: 2,
  enabled: false,
  jevModel: "typesafe/jev-1.14-20261014",
  writerModel: "openai/gpt-6.1-sol",
  dayBudgetUsd: 2,
  jevReserveUsd: 0.01,
  writerReserveUsd: 0.25,
  publishIntervalSeconds: 14400,
  maxMarkets: 120,
  candidatesPerAuthor: 24,
  authors: [],
};
export const agentThesesOverrideSchema = agentThesesPolicySchema.partial();
const legacyAuthorSchema = agentAuthorSettingsSchema.extend({
  userId: z.string().uuid().nullable(),
  enabled: z.boolean(),
  specialization: z.enum(["politics", "sports", "crypto"]),
  interests: agentAuthorSettingsSchema.shape.interests.optional(),
});
const legacyOverrideSchema = agentThesesOverrideSchema.extend({
  version: z.literal(1).optional(),
  authors: z.array(legacyAuthorSchema).optional(),
});
const legacyInterests = {
  politics: AGENT_TEMPLATES[0].interests,
  sports: AGENT_TEMPLATES[1].interests,
  crypto: AGENT_TEMPLATES[2].interests,
};

/** Read-only upgrade of old slots: retain configured users, discard only empty slots. */
export function normalizeAgentThesesPolicy(
  payload: unknown,
): AgentThesesPolicy {
  const version = z
    .object({ version: z.number().optional() })
    .parse(payload).version;
  if (version === undefined || version === 1) {
    const legacy = legacyOverrideSchema.parse(payload);
    const authors = (legacy.authors ?? []).flatMap(
      ({ specialization, userId, ...author }) =>
        userId
          ? [
              {
                ...author,
                userId,
                interests: author.interests ?? legacyInterests[specialization],
              },
            ]
          : [],
    );
    return agentThesesPolicySchema.parse({
      ...DEFAULT_AGENT_THESES_POLICY,
      ...legacy,
      version: 2,
      authors,
    });
  }
  // Invalid/unknown policy is an operational failure, never an implicit enable.
  return agentThesesPolicySchema.parse({
    ...DEFAULT_AGENT_THESES_POLICY,
    ...agentThesesOverrideSchema.parse(payload),
  });
}
export async function resolveAgentThesesPolicy(db: DbQuery) {
  const { rows } = await db.query(
    `select payload from runtime_policies where policy_key=$1 and effective_at<=statement_timestamp()
     order by effective_at desc,created_at desc limit 1`,
    ["agent_theses"],
  );
  const policy = normalizeAgentThesesPolicy(rows[0]?.payload ?? {});
  return { policy, revision: socialFingerprint(policy).slice(0, 16) };
}
