import type { DbQuery } from "../db.js";

export async function resolveWalletTagId(
  db: DbQuery,
  slug: string,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `select id from wallet_tags where slug = $1 limit 1`,
    [slug],
  );
  const tagId = result.rows[0]?.id ?? null;
  if (!tagId) {
    throw new Error(`Missing wallet_tags.slug='${slug}' record`);
  }
  return tagId;
}
