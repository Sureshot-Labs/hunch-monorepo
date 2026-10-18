import { SocialError } from "./social-primitives.js";

type RankingCursor = {
  version: 1;
  scope: string;
  snapshot: string;
  after: number;
};

export function decodeTraderRankingCursor(
  raw: string | undefined,
  scope: string,
): RankingCursor | null {
  if (!raw) return null;
  try {
    if (raw.length > 1_024) throw new Error("invalid");
    const cursor = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as RankingCursor;
    if (
      cursor.version !== 1 ||
      cursor.scope !== scope ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        cursor.snapshot,
      ) ||
      !Number.isSafeInteger(cursor.after) ||
      cursor.after < 0 ||
      cursor.after > 1000
    )
      throw new Error("invalid");
    return cursor;
  } catch {
    throw new SocialError("invalid_cursor", 400);
  }
}

export function encodeTraderRankingCursor(
  value: Omit<RankingCursor, "version">,
) {
  return Buffer.from(JSON.stringify({ version: 1, ...value })).toString(
    "base64url",
  );
}
