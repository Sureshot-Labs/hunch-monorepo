import { z } from "zod";
import { socialSourceRefSchema } from "./social-trade.js";

const uuid = z.string().uuid();
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const timestamp = z.string();
export const socialErrorSchema = z.object({ error: z.string() });
export const socialOkSchema = z.object({ ok: z.literal(true) });
export const socialIdParams = z.object({ id: uuid });
export const socialHandleParams = z.object({ handle: z.string() });
export const socialPageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});
export const socialFeedQuery = socialPageQuery.extend({
  mode: z.enum(["all", "following"]).default("all"),
  source: z.enum(["all", "thesis", "hunch"]).default("all"),
  authorId: uuid.optional(),
  marketId: z.string().optional(),
  eventId: z.string().optional(),
});
export const socialProfilePatch = z
  .object({
    handle: z.string().optional(),
    displayName: z.string().optional(),
    bio: z.string().optional(),
    avatarAssetId: uuid.nullable().optional(),
  })
  .strict();
export const socialProfileSchema = z.object({
  id: uuid,
  handle: z.string().nullable(),
  displayName: z.string(),
  bio: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  joinedAt: timestamp,
  isFollowing: z.boolean(),
  isBlocked: z.boolean(),
  followerCount: z.number().int().nonnegative(),
  followingCount: z.number().int().nonnegative(),
});
export const socialProfileStatsSchema = z.object({
  wins: z.number().int(),
  losses: z.number().int(),
  fractional: z.number().int(),
  void: z.number().int(),
  pending: z.number().int(),
  totalGroups: z.number().int(),
  invalidated: z.number().int(),
  eventCount: z.number().int(),
  winRate: decimal.nullable(),
  primaryCategory: z.string().nullable(),
  badges: z.null(),
  basis: z.literal("published_theses"),
});
export const socialProfileResponse = z.object({
  profile: socialProfileSchema,
  statistics: socialProfileStatsSchema.nullable(),
});
export const socialProfilesResponse = z.object({
  items: z.array(socialProfileSchema),
  nextCursor: z.string().nullable(),
});
export const socialHandleResponse = z.object({
  handle: z.string(),
  available: z.boolean(),
});
export const socialPurchaseRef = z.object({
  kind: z.enum(["order", "execution"]),
  id: uuid,
});
export const socialCopyStatusParams = z.object({
  idempotencyKey: z.string().min(1),
});
export const socialCopyStatusResponse = z.object({
  id: uuid,
  state: z.enum(["pending", "confirmed", "revoked", "failed"]),
  sourceRef: socialSourceRefSchema,
  purchaseRef: socialPurchaseRef.nullable(),
  createdAt: timestamp,
  confirmedAt: timestamp.nullable(),
  updatedAt: timestamp,
});
export const socialEligibilityQuery = z.object({
  kind: z.enum(["order", "execution"]),
  id: uuid,
});
export const socialPublishBody = z
  .object({
    purchaseRef: socialPurchaseRef,
    body: z.string(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export const socialEligibilitySchema = z.object({
  eligible: z.boolean(),
  reason: z.string().nullable(),
  state: z.enum(["missing", "pending", "verified", "revoked"]),
  minimumNotionalUsd: decimal,
  grossNotionalUsd: decimal.nullable(),
  existingThesisId: uuid.nullable(),
  policyRevision: z.string(),
});
export const socialInstrumentSchema = z.object({
  marketId: z.string(),
  eventId: z.string().nullable(),
  tokenId: z.string().nullable(),
  outcome: z.enum(["YES", "NO"]),
  generation: z.string(),
  expiry: timestamp.nullable(),
  venue: z.string(),
  title: z.string().nullable(),
  outcomeLabel: z.string().nullable(),
  image: z.string().nullable(),
});
export const socialPositionSchema = z.object({
  state: z.enum(["open", "pending", "win", "loss", "fractional", "void"]),
  entryPrice: decimal.nullable(),
  markPrice: decimal.nullable(),
  markedValueUsd: decimal.nullable(),
  pnlUsd: decimal.nullable(),
  returnFraction: decimal.nullable(),
  potentialPayoutUsd: decimal,
  feeTreatment: z.literal("excluded"),
});
export const socialThesisSchema = z.object({
  kind: z.literal("thesis"),
  id: uuid,
  author: socialProfileSchema,
  body: z.string(),
  publishedAt: timestamp,
  purchasedAt: timestamp,
  instrument: socialInstrumentSchema,
  grossNotionalUsd: decimal,
  netShares: decimal,
  position: socialPositionSchema,
  commentCount: z.number().int(),
  copyCount: z.number().int(),
  canCopy: z.boolean(),
  visibility: z.enum([
    "public",
    "author_hidden",
    "moderation_hidden",
    "invalidated",
  ]),
});
export const socialHunchSchema = z.object({
  kind: z.literal("hunch"),
  id: uuid,
  noteType: z.enum(["signal", "context"]),
  title: z.string(),
  summary: z.string(),
  publishedAt: timestamp,
  marketId: z.string(),
  eventId: z.string().nullable(),
  side: z.enum(["YES", "NO"]).nullable(),
  strength: z.enum(["good", "strong", "neutral"]),
  commentCount: z.number().int(),
  copyCount: z.number().int(),
  canCopy: z.boolean(),
});
export const socialFeedResponse = z.object({
  items: z.array(
    z.discriminatedUnion("kind", [socialThesisSchema, socialHunchSchema]),
  ),
  nextCursor: z.string().nullable(),
});
export const socialCommentTarget = z.object({
  kind: z.enum(["thesis", "hunch"]),
  id: uuid,
});
export const socialCommentsQuery = socialPageQuery.extend({
  targetKind: z.enum(["thesis", "hunch"]),
  targetId: uuid,
});
export const socialCommentBody = z
  .object({
    target: socialCommentTarget,
    body: z.string(),
    idempotencyKey: uuid,
  })
  .strict();
export const socialCommentSchema = z.object({
  id: uuid,
  author: socialProfileSchema,
  body: z.string(),
  createdAt: timestamp,
  observedRevisionId: uuid.nullable(),
  revisionAvailable: z.boolean(),
});
export const socialCommentsResponse = z.object({
  items: z.array(socialCommentSchema),
  nextCursor: z.string().nullable(),
});
export const socialReportBody = z
  .object({
    targetKind: z.enum(["profile", "thesis", "comment"]),
    targetId: uuid,
    reason: z.string(),
  })
  .strict();
export const socialReportSchema = z.object({
  id: uuid,
  targetKind: z.enum(["profile", "thesis", "comment"]),
  targetId: uuid,
  reason: z.string(),
  status: z.enum(["open", "resolved"]),
  createdAt: timestamp,
});
export const socialReportsQuery = socialPageQuery.extend({
  status: z.enum(["open", "resolved"]).default("open"),
});
export const socialReportsResponse = z.object({
  items: z.array(socialReportSchema),
  nextCursor: z.string().nullable(),
});
export const socialModerationBody = z
  .object({
    targetKind: z.enum(["profile", "thesis", "comment"]),
    targetId: uuid,
    action: z.enum(["hide", "unhide", "suspend", "unsuspend"]),
    reason: z.string(),
    reportId: uuid.optional(),
  })
  .strict();
