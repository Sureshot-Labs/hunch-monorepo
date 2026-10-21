import { z } from "zod";
import type { DbQuery } from "../db.js";
import { insertRuntimePolicy } from "../repos/runtime-policies.js";
import {
  AGENT_TEMPLATES,
  agentAuthorSettingsSchema,
  agentThesesPolicySchema,
  resolveAgentThesesPolicy,
} from "./agent-theses-policy.js";
import { provisionAgentProfiles } from "./agent-theses-provision.js";
import { resolveSocialPolicy } from "./social-policy.js";
import {
  socialFingerprint,
  socialText,
  SocialError,
} from "./social-primitives.js";

export const agentAdminRevision = z
  .object({ revision: z.string().min(1).max(64) })
  .strict();
export const agentAdminSave = agentAdminRevision
  .extend({
    policy: agentThesesPolicySchema,
    profiles: z.array(
      z
        .object({
          id: z.string().uuid(),
          displayName: z.string().min(1).max(1000),
          bio: z.string().max(2000),
          avatarAssetId: z.string().uuid().nullable().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export const agentAdminCreate = agentAdminRevision
  .extend({
    handle: z.string().min(1).max(100),
    displayName: z.string().min(1).max(1000),
    bio: z.string().max(2000),
    avatarAssetId: z.string().uuid().nullable().optional(),
    settings: agentAuthorSettingsSchema,
  })
  .strict();
const profileSchema = z.object({
  id: z.string().uuid(),
  handle: z.string().nullable(),
  displayName: z.string(),
  bio: z.string(),
  avatarAssetId: z.string().uuid().nullable(),
  avatarUrl: z.string().nullable(),
  isActive: z.boolean(),
  suspended: z.boolean(),
});
export const agentAdminStateSchema = z.object({
  ok: z.literal(true),
  revision: z.string(),
  policy: agentThesesPolicySchema,
  profiles: z.array(profileSchema),
  templates: z.array(
    agentAuthorSettingsSchema.extend({
      id: z.string(),
      name: z.string(),
      bio: z.string(),
    }),
  ),
  profileLimits: z.object({
    displayName: z.number(),
    bio: z.number(),
    avatarMaxBytes: z.number(),
    handleMinLength: z.number(),
    handleMaxLength: z.number(),
  }),
});

export async function readAgentAdminState(db: DbQuery) {
  const { policy } = await resolveAgentThesesPolicy(db);
  const { policy: social } = await resolveSocialPolicy(db);
  const ids = policy.authors.flatMap((a) => (a.userId ? [a.userId] : []));
  const { rows } = await db.query<{
    id: string;
    handle: string | null;
    display_name: string | null;
    bio: string | null;
    avatar_asset_id: string | null;
    avatar_url: string | null;
    is_active: boolean;
    suspended: boolean;
  }>(
    `select u.id,u.handle,u.display_name,u.bio,u.avatar_asset_id,
      coalesce(a.public_url,u.avatar_url) as avatar_url,
      u.is_active,u.social_suspended_at is not null as suspended
      from users u left join content_assets a on a.id=u.avatar_asset_id and a.status='ready'
      where u.id=any($1::uuid[]) and u.is_agent order by u.id`,
    [ids],
  );
  const profiles = rows.map((p) => ({
    id: p.id,
    handle: p.handle,
    displayName: p.display_name ?? p.handle ?? "Hunch agent",
    bio: p.bio ?? "",
    avatarAssetId: p.avatar_asset_id,
    avatarUrl: p.avatar_url,
    isActive: p.is_active,
    suspended: p.suspended,
  }));
  return {
    ok: true as const,
    policy,
    profiles,
    revision: socialFingerprint({ policy, profiles }),
    templates: AGENT_TEMPLATES.map((p) => ({ ...p })),
    profileLimits: {
      displayName: social.displayNameMaxGraphemes,
      bio: social.bioMaxGraphemes,
      avatarMaxBytes: social.avatarMaxBytes,
      handleMinLength: social.handleMinLength,
      handleMaxLength: social.handleMaxLength,
    },
  };
}

/** Call inside a transaction to serialize dedicated agent configuration writes. */
export async function lockAgentConfiguration(db: DbQuery) {
  await db.query("set local lock_timeout='2s'");
  await db.query(
    "select pg_advisory_xact_lock(hashtext('agent_theses:config'))",
  );
}
async function currentForWrite(db: DbQuery, revision: string) {
  await lockAgentConfiguration(db);
  const current = await readAgentAdminState(db);
  if (current.revision !== revision)
    throw new SocialError("agent_configuration_changed", 409);
  return current;
}
async function savePolicy(
  db: DbQuery,
  policy: z.infer<typeof agentThesesPolicySchema>,
  adminId: string | null,
) {
  await insertRuntimePolicy(db, {
    policyKey: "agent_theses",
    // Use the DB clock after the configuration lock, preserving microseconds
    // and making this write immediately visible to the resolver.
    effectiveAt: null,
    payload: policy,
    createdByAdminId: adminId,
    createdByUserId: null,
  });
}

async function saveAgentProfile(
  db: DbQuery,
  profile: z.infer<typeof agentAdminSave>["profiles"][number],
  previous: z.infer<typeof profileSchema>,
  limits: z.infer<typeof agentAdminStateSchema>["profileLimits"],
) {
  const avatarChanged =
    profile.avatarAssetId !== undefined &&
    (profile.avatarAssetId !== previous.avatarAssetId ||
      (profile.avatarAssetId === null && previous.avatarUrl !== null));
  let avatarUrl: string | null = null;
  if (avatarChanged && profile.avatarAssetId) {
    // Admin-selected verified media is reusable, like article author avatars.
    // Lock against deletion until the profile reference is committed.
    const asset = await db.query<{ public_url: string }>(
      `select public_url from content_assets
         where id=$1 and kind='image' and status='ready' and public_url is not null
         and byte_size>0 and byte_size<=$2 for update`,
      [profile.avatarAssetId, limits.avatarMaxBytes],
    );
    if (!asset.rows[0]) throw new SocialError("agent_avatar_unavailable", 409);
    avatarUrl = asset.rows[0].public_url;
  }
  await db.query(
    `update users set display_name=$2,bio=$3,
       avatar_asset_id=case when $4::boolean then $5::uuid else avatar_asset_id end,
       avatar_url=case when $4::boolean then $6 else avatar_url end,
       profile_avatar_edited_at=case when $4::boolean then now() else profile_avatar_edited_at end,
       profile_name_edited_at=case when display_name is distinct from $2 then now() else profile_name_edited_at end,
       updated_at=now()
       where id=$1 and is_agent`,
    [
      profile.id,
      socialText(profile.displayName, limits.displayName),
      socialText(profile.bio, limits.bio, true),
      avatarChanged,
      profile.avatarAssetId ?? null,
      avatarUrl,
    ],
  );
}

export async function saveAgentAdminConfiguration(
  db: DbQuery,
  input: z.infer<typeof agentAdminSave>,
  adminId: string | null,
) {
  const current = await currentForWrite(db, input.revision);
  // Identity is the user, not a topic. Creation has its own atomic endpoint.
  if (
    input.policy.authors.length !== current.policy.authors.length ||
    input.policy.authors.some(
      (author) =>
        !current.policy.authors.some((a) => a.userId === author.userId),
    )
  )
    throw new SocialError("agent_profile_binding_changed", 400);
  if (
    new Set(input.profiles.map((p) => p.id)).size !== input.profiles.length ||
    input.profiles.length !== current.profiles.length ||
    input.profiles.some((p) => !current.profiles.some((c) => c.id === p.id))
  )
    throw new SocialError("agent_profile_binding_changed", 400);
  if (
    input.policy.enabled &&
    !input.policy.authors.some(
      (a) =>
        a.enabled &&
        current.profiles.some(
          (p) => p.id === a.userId && p.isActive && !p.suspended,
        ),
    )
  )
    throw new SocialError("agent_no_enabled_author", 400);
  for (const profile of input.profiles) {
    const previous = current.profiles.find((p) => p.id === profile.id);
    if (!previous) throw new SocialError("agent_profile_binding_changed", 400);
    await saveAgentProfile(db, profile, previous, current.profileLimits);
  }
  await savePolicy(db, input.policy, adminId);
  return readAgentAdminState(db);
}

export async function createAgentAdminProfile(
  db: DbQuery,
  input: z.infer<typeof agentAdminCreate>,
  adminId: string | null,
) {
  const current = await currentForWrite(db, input.revision);
  const provisioned = await provisionAgentProfiles(
    db,
    [
      {
        handle: input.handle,
        name: input.displayName,
        bio: input.bio,
      },
    ],
    true,
  );
  const created = provisioned.authors[0];
  if (created?.action !== "created")
    throw new SocialError("agent_handle_conflict", 409);
  const userId = created?.userId;
  if (!userId) throw new SocialError("agent_profile_unavailable", 503);
  current.policy.authors.push({ ...input.settings, userId, enabled: false });
  await savePolicy(db, current.policy, adminId);
  if (input.avatarAssetId) {
    await saveAgentProfile(
      db,
      {
        id: userId,
        displayName: input.displayName,
        bio: input.bio,
        avatarAssetId: input.avatarAssetId,
      },
      {
        id: userId,
        handle: created.handle,
        displayName: input.displayName,
        bio: input.bio,
        avatarAssetId: null,
        avatarUrl: null,
        isActive: true,
        suspended: false,
      },
      current.profileLimits,
    );
  }
  return readAgentAdminState(db);
}
