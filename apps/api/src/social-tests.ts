import assert from "node:assert/strict";
import {
  compareSocialDecimal,
  decodeSocialCursor,
  divideSocialDecimal,
  encodeSocialCursor,
  graphemeLength,
  multiplySocialDecimal,
  normalizeSocialHandle,
  socialPositionMetrics,
  socialText,
  subtractSocialDecimal,
} from "./services/social-primitives.js";
import {
  socialCopyStatusResponse,
  socialFeedResponse,
  socialLikeParams,
  socialHunchSchema,
  socialPublishBody,
} from "./schemas/social.js";
import {
  SOCIAL_PUBLIC_THESIS,
  SOCIAL_VALID_ROOT_JOIN,
  readVisibleSocialSource,
} from "./services/social-visibility.js";
import type { DbQuery } from "./db.js";

const id = "00000000-0000-4000-8000-000000000001";
for (const targetKind of ["thesis", "hunch", "comment"])
  assert.equal(
    socialLikeParams.parse({ targetKind, targetId: id }).targetKind,
    targetKind,
  );
assert.equal(
  socialLikeParams.safeParse({ targetKind: "profile", targetId: id }).success,
  false,
);
const likeFields = socialHunchSchema.pick({ likeCount: true, isLiked: true });
assert.deepEqual(
  likeFields.parse({ likeCount: 0, isLiked: false, likerIds: [id] }),
  { likeCount: 0, isLiked: false },
);
assert.equal(
  likeFields.safeParse({ likeCount: -1, isLiked: true }).success,
  false,
);
assert.equal(
  likeFields.safeParse({ likeCount: 0.5, isLiked: true }).success,
  false,
);
const cursor = {
  scope: "feed-filter",
  timestamp: "2026-10-08 11:12:13.123456+00",
  kind: "thesis" as const,
  id,
};
assert.deepEqual(decodeSocialCursor(encodeSocialCursor(cursor), cursor.scope), {
  version: 1,
  ...cursor,
});
assert.throws(
  () => decodeSocialCursor(encodeSocialCursor(cursor), "different-user"),
  /invalid_cursor/,
);
assert.throws(
  () =>
    decodeSocialCursor(
      Buffer.from(
        JSON.stringify({ ...cursor, version: 1, timestamp: "garbage" }),
      ).toString("base64url"),
      cursor.scope,
    ),
  /invalid_cursor/,
);
assert.equal(graphemeLength("👩🏽‍🚀🇵🇹a\u0301"), 3);
assert.equal(socialText("  a\u0301  ", 1), "á");
assert.throws(() => socialText("ab", 1), /invalid_text_length/);
assert.equal(normalizeSocialHandle(" MiXeD_Name ", 3, 20), "mixed_name");
assert.throws(
  () => normalizeSocialHandle("with-dash", 3, 20),
  /invalid_handle/,
);
assert.equal(compareSocialDecimal("9.999999999999999999", "10"), -1);
assert.equal(compareSocialDecimal("10.0000", "10"), 0);
assert.equal(multiplySocialDecimal("0.3", "0.2"), "0.06");
assert.equal(subtractSocialDecimal("0.1", "0.3"), "-0.2");
assert.equal(divideSocialDecimal("10", "20"), "0.5");
assert.equal(divideSocialDecimal("0", "0"), null);
const base = {
  notional: "10",
  grossShares: "20",
  netShares: "19",
  outcome: "NO",
  resolvedOutcome: null,
  resolvedOutcomePct: null,
  active: true,
  mark: "1",
};
assert.equal(
  socialPositionMetrics(base).state,
  "open",
  "100c is not official resolution",
);
assert.equal(
  socialPositionMetrics({ ...base, active: false }).markPrice,
  null,
  "closed proposed excludes preliminary mark",
);
assert.equal(socialPositionMetrics({ ...base, mark: null }).pnlUsd, null);
assert.equal(
  socialPositionMetrics({ ...base, resolvedOutcome: "NO", mark: "0" }).state,
  "win",
  "official outcome beats conflicting quote",
);
assert.equal(
  socialPositionMetrics({ ...base, resolvedOutcome: "YES" }).pnlUsd,
  "-10",
);
assert.equal(
  socialPositionMetrics({ ...base, resolvedOutcomePct: "5000" }).state,
  "fractional",
);
assert.equal(
  socialPositionMetrics({ ...base, resolvedOutcomePct: "5000" }).pnlUsd,
  "-0.5",
  "net shares determine actual payout",
);
assert.equal(
  socialPositionMetrics({ ...base, resolvedOutcome: "VOID" }).state,
  "void",
);
assert.equal(
  socialPositionMetrics({ ...base, resolvedOutcome: "VOID" }).pnlUsd,
  null,
);
assert.equal(
  socialPositionMetrics({ ...base, netShares: "20", mark: "0.5" }).pnlUsd,
  "0",
  "genuine flat remains a measured zero",
);
assert.equal(
  socialPublishBody.safeParse({
    purchaseRef: { kind: "order", id },
    body: "hello",
    idempotencyKey: id,
    verified_buy_facts: {},
  }).success,
  false,
  "client cannot submit financial proof",
);
assert.deepEqual(socialFeedResponse.parse({ items: [], nextCursor: null }), {
  items: [],
  nextCursor: null,
});
const copyStatus = socialCopyStatusResponse.parse({
  id,
  state: "pending",
  sourceRef: { kind: "hunch", id },
  purchaseRef: null,
  createdAt: "2026-10-08T12:00:00.000Z",
  confirmedAt: null,
  updatedAt: "2026-10-08T12:00:00.000Z",
  provider_reference: "private-exact-reference",
  execution_facts: { owner: "private-owner" },
});
assert.equal("provider_reference" in copyStatus, false);
assert.equal("execution_facts" in copyStatus, false);
assert.match(SOCIAL_PUBLIC_THESIS, /proof_invalidated_at is null/);
assert.match(SOCIAL_PUBLIC_THESIS, /blocked_user_id/);
assert.match(SOCIAL_VALID_ROOT_JOIN, /source_kind=n.source_kind/);
const db = (rows: unknown[]) =>
  ({ query: async () => ({ rows }) }) as unknown as DbQuery;
await assert.rejects(
  () => readVisibleSocialSource(db([]), id, { kind: "hunch", id }),
  /source_unavailable/,
);
await assert.rejects(
  () =>
    readVisibleSocialSource(db([{ id, author_id: id, buy_snapshot: {} }]), id, {
      kind: "thesis",
      id,
    }),
  /self_copy/,
);
await assert.rejects(
  () =>
    readVisibleSocialSource(
      db([{ id, author_id: "another-user", buy_snapshot: {} }]),
      id,
      { kind: "thesis", id },
    ),
  /source_evidence_unavailable/,
);
console.log(
  "ok - social exact cursors, Unicode policy limits, decimals, official outcomes, safe contracts and source visibility",
);
