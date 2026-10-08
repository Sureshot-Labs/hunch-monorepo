import type { DbQuery } from "../db.js";
import type {
  AdminSocialAction,
  AdminSocialTarget,
} from "../schemas/admin-social.js";
import {
  DEFAULT_SOCIAL_POLICY,
  resolveSocialPolicy,
  SocialPolicyUnavailableError,
} from "./social-policy.js";
import {
  decodeSocialCursor,
  encodeSocialCursor,
  SocialError,
  socialText,
} from "./social-primitives.js";

export type AdminSocialLimits = Pick<
  typeof DEFAULT_SOCIAL_POLICY,
  "pageSize" | "maxPageSize" | "moderationReasonMaxGraphemes"
>;
export async function resolveAdminSocialLimits(
  db: DbQuery,
  onRecovery: () => void,
): Promise<AdminSocialLimits> {
  try {
    return (await resolveSocialPolicy(db)).policy;
  } catch (error) {
    if (!(error instanceof SocialPolicyUnavailableError)) throw error;
    // Recovery of social restrictions must remain available even when publication policy is invalid.
    // This does not make defaults authoritative for publication or Copy eligibility.
    onRecovery();
    return {
      pageSize: DEFAULT_SOCIAL_POLICY.pageSize,
      maxPageSize: DEFAULT_SOCIAL_POLICY.maxPageSize,
      moderationReasonMaxGraphemes:
        DEFAULT_SOCIAL_POLICY.moderationReasonMaxGraphemes,
    };
  }
}

type PageInput = { cursor?: string; limit?: number };
type Query = { text: string; values: unknown[] };
type ReportRow = {
  id: string;
  target_kind: AdminSocialTarget["kind"];
  target_id: string;
  reporter_id: string | null;
  reason: string;
  status: "open" | "resolved";
  created_at: string;
  resolved_at: string | null;
  target_preview: {
    text: string | null;
    authorUserId: string | null;
    moderationHidden: boolean;
    authorHidden: boolean;
    proofInvalidated: boolean;
    socialSuspended: boolean;
  } | null;
};
type EventRow = {
  id: string;
  target_kind: AdminSocialTarget["kind"];
  target_id: string;
  action: AdminSocialAction | "resolve_report";
  reason: string;
  admin_id: string | null;
  report_id: string | null;
  created_at: string;
};

function pageLimit(input: PageInput, limits: AdminSocialLimits) {
  return Math.min(input.limit ?? limits.pageSize, limits.maxPageSize);
}
function cursorAt(input: PageInput, scope: string) {
  const cursor = decodeSocialCursor(input.cursor, scope);
  if (cursor && cursor.kind !== "report")
    throw new SocialError("invalid_cursor");
  return cursor;
}
function page<T extends { id: string; created_at: string }>(
  rows: T[],
  limit: number,
  scope: string,
) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeSocialCursor({
            scope,
            kind: "report",
            timestamp: last.created_at,
            id: last.id,
          })
        : null,
  };
}
export function adminSocialReportsScope(status: string) {
  return `admin-social-reports:${status}`;
}
export function adminSocialEventsScope(target?: AdminSocialTarget) {
  return `admin-social-events:${target?.kind ?? "all"}:${target?.id ?? "all"}`;
}

/** Page the report index before hydrating the selected targets; no scan of content bodies. */
export function buildAdminSocialReportsQuery(
  input: PageInput & { status: "open" | "resolved" },
  limits: AdminSocialLimits,
): Query {
  const cursor = cursorAt(input, adminSocialReportsScope(input.status));
  const values: unknown[] = [input.status];
  const after = cursor
    ? (values.push(cursor.timestamp, cursor.id),
      `and (r.created_at,r.id)<($2::timestamptz,$3::uuid)`)
    : "";
  values.push(pageLimit(input, limits) + 1);
  return {
    values,
    text: `with report_page as materialized (
    select r.* from social_reports r where r.status=$1 ${after}
    order by r.created_at desc,r.id desc limit $${values.length}
  ) select r.id,r.target_kind,r.target_id,r.reporter_id,r.reason,r.status,
    r.created_at::text,r.resolved_at::text,
    case when r.target_kind='user' and profile_row.id is not null then jsonb_build_object(
      'text',concat_ws(E'\\n',coalesce(nullif(profile_row.handle,''),profile_row.display_name),profile_row.bio),
      'authorUserId',profile_row.id,'moderationHidden',false,'authorHidden',false,'proofInvalidated',false,'socialSuspended',profile_row.social_suspended_at is not null)
    when r.target_kind='thesis' and thesis_row.id is not null then jsonb_build_object(
      'text',thesis_row.body,'authorUserId',thesis_row.author_id,'moderationHidden',thesis_row.moderation_hidden_at is not null,
      'authorHidden',thesis_row.author_hidden_at is not null,'proofInvalidated',thesis_row.proof_invalidated_at is not null,'socialSuspended',thesis_author.social_suspended_at is not null)
    when r.target_kind='comment' and comment_row.id is not null then jsonb_build_object(
      'text',comment_row.body,'authorUserId',comment_row.author_id,'moderationHidden',comment_row.moderation_hidden_at is not null,
      'authorHidden',comment_row.author_hidden_at is not null,'proofInvalidated',comment_thesis.proof_invalidated_at is not null,'socialSuspended',comment_author.social_suspended_at is not null)
    else null end as target_preview
    from report_page r
    left join lateral (select u.id,u.handle,u.display_name,u.bio,u.social_suspended_at from users u
      where r.target_kind='user' and u.id=r.target_profile_id limit 1) profile_row on true
    left join lateral (select t.id,t.author_id,t.body,t.moderation_hidden_at,t.author_hidden_at,t.proof_invalidated_at from user_theses t
      where r.target_kind='thesis' and t.id=r.thesis_id limit 1) thesis_row on true
    left join lateral (select u.social_suspended_at from users u where u.id=thesis_row.author_id limit 1) thesis_author on true
    left join lateral (select c.id,c.author_id,c.thesis_id,c.body,c.moderation_hidden_at,c.author_hidden_at from social_comments c
      where r.target_kind='comment' and c.id=r.comment_id limit 1) comment_row on true
    left join lateral (select u.social_suspended_at from users u where u.id=comment_row.author_id limit 1) comment_author on true
    left join lateral (select t.proof_invalidated_at from user_theses t where t.id=comment_row.thesis_id limit 1) comment_thesis on true
    order by r.created_at desc,r.id desc`,
  };
}

export async function listAdminSocialReports(
  db: DbQuery,
  input: PageInput & { status: "open" | "resolved" },
  limits: AdminSocialLimits,
) {
  const query = buildAdminSocialReportsQuery(input, limits);
  const result = await db.query<ReportRow>(query.text, query.values);
  const resultPage = page(
    result.rows,
    pageLimit(input, limits),
    adminSocialReportsScope(input.status),
  );
  return {
    nextCursor: resultPage.nextCursor,
    items: resultPage.items.map((row) => ({
      id: row.id,
      target: { kind: row.target_kind, id: row.target_id },
      reporterUserId: row.reporter_id,
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      targetPreview: row.target_preview,
    })),
  };
}

export function buildAdminSocialEventsQuery(
  input: PageInput & { target?: AdminSocialTarget },
  limits: AdminSocialLimits,
): Query {
  const cursor = cursorAt(input, adminSocialEventsScope(input.target));
  const values: unknown[] = [];
  const filters: string[] = [];
  if (input.target) {
    values.push(input.target.kind, input.target.id);
    filters.push(`e.target_kind=$1 and e.target_id=$2::uuid`);
  }
  if (cursor) {
    values.push(cursor.timestamp, cursor.id);
    filters.push(
      `(e.created_at,e.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
    );
  }
  values.push(pageLimit(input, limits) + 1);
  return {
    values,
    text: `select e.id,e.target_kind,e.target_id,e.action,e.reason,e.admin_id,e.report_id,e.created_at::text
    from social_moderation_events e ${filters.length ? `where ${filters.join(" and ")}` : ""}
    order by e.created_at desc,e.id desc limit $${values.length}`,
  };
}
function event(row: EventRow) {
  return {
    id: row.id,
    target: { kind: row.target_kind, id: row.target_id },
    action: row.action,
    reason: row.reason,
    adminId: row.admin_id,
    reportId: row.report_id,
    createdAt: row.created_at,
  };
}
export async function listAdminSocialModerationEvents(
  db: DbQuery,
  input: PageInput & { target?: AdminSocialTarget },
  limits: AdminSocialLimits,
) {
  const query = buildAdminSocialEventsQuery(input, limits);
  const result = await db.query<EventRow>(query.text, query.values);
  const resultPage = page(
    result.rows,
    pageLimit(input, limits),
    adminSocialEventsScope(input.target),
  );
  return {
    nextCursor: resultPage.nextCursor,
    items: resultPage.items.map(event),
  };
}

export function buildSocialModerationMutation(
  target: AdminSocialTarget,
  action: AdminSocialAction,
): Query {
  if (target.kind === "user") {
    if (action !== "suspend" && action !== "unsuspend")
      throw new SocialError("social_action_target_mismatch");
    return {
      text: `update users set social_suspended_at=${action === "suspend" ? "coalesce(social_suspended_at,now())" : "null"},updated_at=now() where id=$1 returning id`,
      values: [target.id],
    };
  }
  if (action !== "hide" && action !== "unhide")
    throw new SocialError("social_action_target_mismatch");
  const table = target.kind === "thesis" ? "user_theses" : "social_comments";
  return {
    text: `update ${table} set moderation_hidden_at=${action === "hide" ? "coalesce(moderation_hidden_at,now())" : "null"} where id=$1 returning id`,
    values: [target.id],
  };
}

async function auditEvent(
  db: DbQuery,
  input: {
    target: AdminSocialTarget;
    action: EventRow["action"];
    reason: string;
    adminId: string;
    reportId?: string;
  },
) {
  const result = await db.query<EventRow>(
    `insert into social_moderation_events(target_kind,target_id,action,reason,admin_id,report_id)
    values($1,$2,$3,$4,$5,$6) returning id,target_kind,target_id,action,reason,admin_id,report_id,created_at::text`,
    [
      input.target.kind,
      input.target.id,
      input.action,
      input.reason,
      input.adminId,
      input.reportId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Social moderation audit insert returned no event");
  return event(row);
}
async function lockReport(
  db: DbQuery,
  reportId: string,
  target?: AdminSocialTarget,
) {
  const result = await db.query<{
    target_kind: AdminSocialTarget["kind"];
    target_id: string;
    status: string;
  }>(
    `select target_kind,target_id,status from social_reports where id=$1 for update`,
    [reportId],
  );
  const row = result.rows[0];
  if (!row) throw new SocialError("social_report_not_found", 404);
  if (
    target &&
    (row.target_kind !== target.kind || row.target_id !== target.id)
  )
    throw new SocialError("social_report_target_mismatch", 409);
  return row;
}

/** Caller must run mutation + report resolution + audit in one transaction. */
export async function moderateAdminSocialTarget(
  db: DbQuery,
  input: {
    target: AdminSocialTarget;
    action: AdminSocialAction;
    reason: string;
    reportId?: string;
  },
  adminId: string,
  limits: AdminSocialLimits,
) {
  const reason = socialText(input.reason, limits.moderationReasonMaxGraphemes);
  const mutation = buildSocialModerationMutation(input.target, input.action);
  if (input.reportId) await lockReport(db, input.reportId, input.target);
  const result = await db.query(mutation.text, mutation.values);
  if (!result.rows[0]) throw new SocialError("social_target_unavailable", 404);
  if (input.reportId)
    await db.query(
      `update social_reports set status='resolved',resolved_at=coalesce(resolved_at,now()) where id=$1`,
      [input.reportId],
    );
  return auditEvent(db, { ...input, reason, adminId });
}

/** Closing a report never changes content visibility, even after its target was deleted. */
export async function resolveAdminSocialReport(
  db: DbQuery,
  reportId: string,
  rawReason: string,
  adminId: string,
  limits: AdminSocialLimits,
) {
  const reason = socialText(rawReason, limits.moderationReasonMaxGraphemes);
  const report = await lockReport(db, reportId);
  await db.query(
    `update social_reports set status='resolved',resolved_at=coalesce(resolved_at,now()) where id=$1`,
    [reportId],
  );
  return auditEvent(db, {
    target: { kind: report.target_kind, id: report.target_id },
    action: "resolve_report",
    reason,
    adminId,
    reportId,
  });
}
