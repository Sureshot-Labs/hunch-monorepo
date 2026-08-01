import type { DbQuery } from "../db.js";

export async function promoteContentRoute(
  db: DbQuery,
  articleId: string,
  nextSlug: string,
  conflictError: () => Error,
): Promise<string | null> {
  const { rows: currentRows } = await db.query<{ slug: string }>(
    `select slug from content_routes where article_id = $1 and kind = 'current' for update`,
    [articleId],
  );
  const currentSlug = currentRows[0]?.slug ?? null;
  const { rows: historicalRows } = currentSlug
    ? { rows: [] as Array<{ slug: string }> }
    : await db.query<{ slug: string }>(
        `
          select slug
          from content_routes
          where article_id = $1 and has_been_published and slug <> $2
          order by updated_at desc, slug
          for update
          limit 1
        `,
        [articleId, nextSlug],
      );
  const previousSlug = currentSlug ?? historicalRows[0]?.slug ?? null;
  const { rows: nextRows } = await db.query<{ article_id: string }>(
    "select article_id from content_routes where slug = $1 for update",
    [nextSlug],
  );
  if (nextRows[0] && nextRows[0].article_id !== articleId) {
    throw conflictError();
  }

  await db.query(
    `
      update content_routes
      set kind = 'redirect'
      where article_id = $1 and slug <> $2 and has_been_published
    `,
    [articleId, nextSlug],
  );
  if (nextRows[0]) {
    await db.query(
      `
        update content_routes
        set kind = 'current', has_been_published = true
        where slug = $1 and article_id = $2
      `,
      [nextSlug, articleId],
    );
  } else {
    await db.query(
      `
        insert into content_routes (
          slug, article_id, kind, has_been_published
        ) values ($1, $2, 'current', true)
      `,
      [nextSlug, articleId],
    );
  }

  return previousSlug === nextSlug ? null : previousSlug;
}
