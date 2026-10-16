import { tx, type Pool } from "@hunch/infra";
import type { DbQuery } from "../db.js";
import {
  onboardingStateSchema,
  onboardingStepNames,
  onboardingStepsSchema,
  type OnboardingCatalog,
  type OnboardingInterestsInput,
  type OnboardingProgressInput,
  type OnboardingState,
} from "../schemas/onboarding.js";
import {
  hasExplicitInterestChoice,
  initialOnboardingState,
  mergedOnboardingState,
  nextOnboardingState,
  normalizeOnboardingStep,
  OnboardingError,
  requireOnboardingRevision,
} from "./onboarding-state.js";
import { normalizeSocialHandle, SocialError } from "./social-primitives.js";
import { resolveSocialPolicy } from "./social-policy.js";

type SnapshotRow = {
  is_active: boolean;
  onboarding_version: number;
  social_suspended_at: Date | null;
  handle: string | null;
  photo_ready: boolean;
  revision: string | null;
  status: OnboardingState["status"] | null;
  completion_reason: OnboardingState["completionReason"];
  completed_at: Date | null;
  steps: unknown;
  interest_ids: string[];
};

async function lockUser(db: DbQuery, userId: string): Promise<void> {
  const { rows } = await db.query<{ social_suspended_at: Date | null }>(
    `select social_suspended_at from users where id=$1 and is_active for update`,
    [userId],
  );
  if (!rows[0]) throw new SocialError("user_unavailable", 403);
  if (rows[0].social_suspended_at)
    throw new SocialError("social_suspended", 403);
}

// One statement gives GET a consistent snapshot of state and selection. Writers
// acquire users first, then call this in a fresh statement after any lock wait.
async function snapshot(db: DbQuery, userId: string) {
  const { rows } = await db.query<SnapshotRow>(
    `select u.onboarding_version,u.is_active,u.social_suspended_at,u.handle,
      coalesce((select a.owner_user_id=u.id and a.kind='image' and a.status='ready'
        from content_assets a where a.id=u.avatar_asset_id),false) as photo_ready,
      s.revision,s.status,s.completion_reason,s.completed_at,s.steps,
      array(select i.interest_id from user_interests i
        join onboarding_interests c on c.id=i.interest_id
        where i.user_id=u.id order by c.sort_order,c.id) as interest_ids
    from users u left join user_onboarding_state s on s.user_id=u.id
    where u.id=$1`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new SocialError("user_unavailable", 403);
  const state =
    row.status === null
      ? initialOnboardingState(row.onboarding_version === 0)
      : onboardingStateSchema.parse({
          flowVersion: 1,
          revision: Number(row.revision),
          status: row.status,
          completionReason: row.completion_reason,
          completedAt: row.completed_at?.toISOString() ?? null,
          nextStep: null,
          interestIds: row.interest_ids,
          steps: onboardingStepsSchema.parse(row.steps),
        });
  if (state.status !== "completed")
    state.nextStep =
      onboardingStepNames.find(
        (step) => state.steps[step].status === "pending",
      ) ?? null;
  return { state, row };
}

async function saveState(
  db: DbQuery,
  userId: string,
  state: OnboardingState,
): Promise<void> {
  await db.query(
    `insert into user_onboarding_state(user_id,flow_version,revision,status,completion_reason,completed_at,steps)
      values($1,1,$2,$3,$4,$5,$6::jsonb)
      on conflict(user_id) do update set revision=excluded.revision,status=excluded.status,
        completion_reason=excluded.completion_reason,completed_at=excluded.completed_at,
        steps=excluded.steps,updated_at=now()`,
    [
      userId,
      state.revision,
      state.status,
      state.completionReason,
      state.completedAt,
      JSON.stringify(state.steps),
    ],
  );
}

async function replaceInterests(
  db: DbQuery,
  userId: string,
  ids: string[],
): Promise<void> {
  await db.query(`delete from user_interests where user_id=$1`, [userId]);
  if (ids.length)
    await db.query(
      `insert into user_interests(user_id,interest_id) select $1,id from unnest($2::text[]) as id`,
      [userId, ids],
    );
}

async function profileEvidence(db: DbQuery, row: SnapshotRow) {
  let handle = false;
  if (row.handle) {
    const { policy } = await resolveSocialPolicy(db);
    try {
      handle =
        normalizeSocialHandle(
          row.handle,
          policy.handleMinLength,
          policy.handleMaxLength,
        ) === row.handle;
    } catch (error) {
      if (!(error instanceof SocialError)) throw error;
    }
  }
  return { handle, photo: row.photo_ready };
}

export class OnboardingService {
  constructor(
    private readonly db: Pool,
    private readonly checkWrite: (
      userId: string,
    ) => Promise<void> = async () => {},
  ) {}

  async catalog(): Promise<OnboardingCatalog> {
    const { rows } = await this.db.query<{
      id: string;
      label: string;
      enabled: boolean;
      sort_order: number;
    }>(
      `select id,label,enabled,sort_order from onboarding_interests order by sort_order,id`,
    );
    return {
      catalogVersion: 1,
      minSelections: 3,
      items: rows.map((row) => ({
        id: row.id,
        label: row.label,
        enabled: row.enabled,
        sortOrder: row.sort_order,
      })),
    };
  }

  async get(userId: string): Promise<OnboardingState> {
    const { state, row } = await snapshot(this.db, userId);
    if (!row.is_active) throw new SocialError("user_unavailable", 403);
    return state;
  }

  async setInterests(
    userId: string,
    input: OnboardingInterestsInput,
  ): Promise<OnboardingState> {
    await this.checkWrite(userId);
    return tx(this.db, async (db) => {
      await lockUser(db, userId);
      const { state } = await snapshot(db, userId);
      if (input.outcome === "skipped" && input.interestIds.length)
        throw new OnboardingError("invalid_request", 400);
      const unique = new Set(input.interestIds);
      const catalog = await db.query<{ id: string; enabled: boolean }>(
        `select id,enabled from onboarding_interests order by sort_order,id for share`,
      );
      const ids = catalog.rows
        .filter((row) => unique.has(row.id))
        .map((row) => row.id);
      if (
        ids.length !== unique.size ||
        catalog.rows.some((row) => unique.has(row.id) && !row.enabled)
      )
        throw new OnboardingError("invalid_interest", 400);
      if (input.outcome === "completed" && ids.length < 3)
        throw new OnboardingError("too_few_interests", 400);
      if (
        state.steps.interests.status === input.outcome &&
        JSON.stringify(ids) === JSON.stringify(state.interestIds)
      )
        return state;
      requireOnboardingRevision(state, input.expectedRevision);
      const updated = nextOnboardingState({
        ...state,
        interestIds: ids,
        steps: {
          ...state.steps,
          interests: {
            status: input.outcome,
            reason: input.outcome === "skipped" ? "user_skipped" : null,
          },
        },
      });
      await saveState(db, userId, updated);
      await replaceInterests(db, userId, ids);
      return updated;
    });
  }

  async progress(
    userId: string,
    input: OnboardingProgressInput,
  ): Promise<OnboardingState> {
    const result = normalizeOnboardingStep(input);
    await this.checkWrite(userId);
    return tx(this.db, async (db) => {
      await lockUser(db, userId);
      const { state, row } = await snapshot(db, userId);
      if (JSON.stringify(state.steps[input.step]) === JSON.stringify(result))
        return state;
      if (state.status === "completed")
        throw new OnboardingError("onboarding_completed", 409, state);
      requireOnboardingRevision(state, input.expectedRevision);
      if (!hasExplicitInterestChoice(state))
        throw new OnboardingError("onboarding_incomplete", 409, state);
      if (
        result.status === "completed" &&
        (input.step === "handle" || input.step === "photo")
      ) {
        const evidence = await profileEvidence(db, row);
        if (!evidence[input.step])
          throw new OnboardingError(
            "onboarding_step_evidence_missing",
            409,
            state,
          );
      }
      const updated = nextOnboardingState({
        ...state,
        steps: { ...state.steps, [input.step]: result },
      });
      await saveState(db, userId, updated);
      return updated;
    });
  }

  async complete(
    userId: string,
    expectedRevision: number,
  ): Promise<OnboardingState> {
    await this.checkWrite(userId);
    return tx(this.db, async (db) => {
      await lockUser(db, userId);
      const { state } = await snapshot(db, userId);
      if (state.status === "completed") return state;
      requireOnboardingRevision(state, expectedRevision);
      if (Object.values(state.steps).some((step) => step.status === "pending"))
        throw new OnboardingError("onboarding_incomplete", 409, state);
      const updated = nextOnboardingState({
        ...state,
        status: "completed",
        completionReason: "flow",
        completedAt: new Date().toISOString(),
      });
      await saveState(db, userId, updated);
      return updated;
    });
  }
}

/** Called only after successful profile persistence, inside the user's existing transaction/lock. */
export async function recordOnboardingProfileWrite(
  db: DbQuery,
  userId: string,
  input: { handle?: string; avatarAssetId?: string | null },
): Promise<void> {
  if (input.handle === undefined && !input.avatarAssetId) return;
  const { state, row } = await snapshot(db, userId);
  if (row.onboarding_version !== 1 || state.status !== "in_progress") return;
  const steps = structuredClone(state.steps);
  if (input.handle !== undefined)
    steps.handle = { status: "completed", reason: null };
  if (input.avatarAssetId) steps.photo = { status: "completed", reason: null };
  if (JSON.stringify(steps) !== JSON.stringify(state.steps))
    await saveState(db, userId, nextOnboardingState({ ...state, steps }));
}

/** Caller holds the deletion lifecycle lock, including for financially retained users. */
export async function clearUserOnboardingData(
  db: DbQuery,
  userId: string,
): Promise<void> {
  await db.query(`delete from user_onboarding_state where user_id=$1`, [
    userId,
  ]);
  await db.query(`delete from user_interests where user_id=$1`, [userId]);
}

/** Caller holds both user locks; run after profile/asset ownership transfer, before source deletion. */
export async function mergeUserOnboardingData(
  db: DbQuery,
  sourceId: string,
  targetId: string,
): Promise<void> {
  const source = await snapshot(db, sourceId);
  const target = await snapshot(db, targetId);
  const merged = mergedOnboardingState(
    source.state,
    target.state,
    await profileEvidence(db, target.row),
  );
  if (merged === target.state) return;
  await saveState(db, targetId, merged);
  if (
    JSON.stringify(merged.interestIds) !==
    JSON.stringify(target.state.interestIds)
  )
    await replaceInterests(db, targetId, merged.interestIds);
}
