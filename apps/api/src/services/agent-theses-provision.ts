import { tx, type Pool } from "@hunch/infra";
import type { DbQuery } from "../db.js";
import { resolveSocialPolicy } from "./social-policy.js";
import {
  normalizeSocialHandle,
  socialText,
  SocialError,
} from "./social-primitives.js";

export type AgentProfileInput = { handle: string; name: string; bio: string };

export async function provisionAgentAuthors(
  pool: Pool,
  profiles: AgentProfileInput[],
  execute = false,
) {
  return tx(pool, (db) => provisionAgentProfiles(db, profiles, execute));
}

/** Explicit profiles only; no default identities. Reused by CLI and admin transactions. */
export async function provisionAgentProfiles(
  db: DbQuery,
  input: AgentProfileInput[],
  execute: boolean,
) {
  const { policy } = await resolveSocialPolicy(db);
  const profiles = input.map((p) => ({
    handle: normalizeSocialHandle(
      p.handle,
      policy.handleMinLength,
      policy.handleMaxLength,
    ),
    name: socialText(p.name, policy.displayNameMaxGraphemes),
    bio: socialText(p.bio, policy.bioMaxGraphemes, true),
  }));
  if (new Set(profiles.map((p) => p.handle)).size !== profiles.length)
    throw new SocialError("agent_handle_conflict", 409);
  await db.query("set local lock_timeout='2s'");
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
      userId,
      action: existing ? "unchanged" : execute ? "created" : "would_create",
    });
  }
  return { execute, authors: result };
}
