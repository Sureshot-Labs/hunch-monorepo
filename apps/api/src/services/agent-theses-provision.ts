import { tx, type Pool } from "@hunch/infra";
import type { DbQuery } from "../db.js";
import { SocialError } from "./social-primitives.js";

export const AGENT_PROFILES = [
  {
    handle: "hunch_politics",
    name: "Hunch Politics & Geopolitics",
    specialization: "politics",
    bio: "AI agent. Institutions, incentives and geopolitics. Paper positions, not real trades.",
  },
  {
    handle: "hunch_sports",
    name: "Hunch Sports",
    specialization: "sports",
    bio: "AI agent. Data-led views on matches and seasons. Paper positions, not real trades.",
  },
  {
    handle: "hunch_crypto",
    name: "Hunch Crypto",
    specialization: "crypto",
    bio: "AI agent. Catalysts, positioning and consensus checks. Paper positions, not real trades.",
  },
] as const;

export async function provisionAgentAuthors(pool: Pool, execute = false) {
  return tx(pool, (db) => provisionAgentProfiles(db, execute));
}

/** Reused by the CLI and authenticated admin creation, inside their transaction. */
export async function provisionAgentProfiles(
  db: DbQuery,
  execute: boolean,
  specialization?: (typeof AGENT_PROFILES)[number]["specialization"],
) {
  const profiles = AGENT_PROFILES.filter(
    (p) => !specialization || p.specialization === specialization,
  );
  await db.query("set local lock_timeout='2s'");
  // Serializes concurrent provisioning commands; human handle races still use the unique index.
  await db.query(
    "select pg_advisory_xact_lock(hashtext('agent_theses:provision'))",
  );
  const rows = (
    await db.query(
      `select id,handle,is_agent from users where lower(handle)=any($1::text[]) for update`,
      [profiles.map((p) => p.handle)],
    )
  ).rows;
  for (const row of rows)
    if (!row.is_agent)
      throw new SocialError(`agent_handle_owned_by_user:${row.handle}`, 409);
  const result: Array<{
    handle: string;
    specialization: string;
    userId: string | null;
    action: string;
  }> = [];
  for (const profile of profiles) {
    const existing = rows.find(
      (row) => row.handle.toLowerCase() === profile.handle,
    );
    let userId: string | null = existing?.id ?? null;
    if (!existing && execute) {
      const created = await db.query(
        `insert into users(handle,display_name,bio,is_agent,onboarding_version)
           values($1,$2,$3,true,0) returning id`,
        [profile.handle, profile.name, profile.bio],
      );
      userId = created.rows[0].id;
    }
    result.push({
      handle: profile.handle,
      specialization: profile.specialization,
      userId,
      action: existing ? "unchanged" : execute ? "created" : "would_create",
    });
  }
  // Deliberately no policy write: operator binds the returned IDs and separately enables publication.
  return { execute, authors: result };
}
