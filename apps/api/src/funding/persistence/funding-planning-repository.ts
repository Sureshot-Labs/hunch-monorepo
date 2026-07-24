import type { Pool } from "@hunch/infra";

import type {
  FundingDiscoveryRequest,
  IntentLiquidityProjection,
} from "../domain/types.js";
import type {
  FundingPlanningSnapshot,
  FundingPlanningStore,
  PersistedFundingPlanningSnapshot,
} from "../planner/planning-types.js";

type PlanningProjectionDbRow = Readonly<{
  id: string;
  user_id: string;
  request_snapshot: FundingDiscoveryRequest;
  projection_snapshot: IntentLiquidityProjection;
  planner_snapshot: FundingPlanningSnapshot;
  policy_version: string | number;
  policy_revision: string;
  ownership_revision: string;
  expires_at: Date;
  created_at: Date;
}>;

function mapProjection(
  row: PlanningProjectionDbRow,
): PersistedFundingPlanningSnapshot {
  const projection = {
    ...row.projection_snapshot,
    liquidityProjectionId: row.id,
  };
  return {
    id: row.id,
    userId: row.user_id,
    request: row.request_snapshot,
    projection,
    plannerSnapshot: {
      ...row.planner_snapshot,
      projection,
    },
    policyVersion: Number(row.policy_version),
    policyRevision: row.policy_revision,
    ownershipRevision: row.ownership_revision,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

const projectionColumns = `
  id,
  user_id,
  request_snapshot,
  projection_snapshot,
  planner_snapshot,
  policy_version,
  policy_revision,
  ownership_revision,
  expires_at,
  created_at
`;

export class PostgresFundingPlanningStore implements FundingPlanningStore {
  constructor(private readonly db: Pick<Pool, "query">) {}

  async create(
    input: Parameters<FundingPlanningStore["create"]>[0],
  ): Promise<PersistedFundingPlanningSnapshot> {
    const projection = {
      ...input.projection,
      liquidityProjectionId: input.projection.liquidityProjectionId,
    };
    const plannerSnapshot = {
      ...input.plannerSnapshot,
      projection,
    };
    const { rows } = await this.db.query<PlanningProjectionDbRow>(
      `
        insert into funding_liquidity_projections (
          id,
          user_id,
          request_snapshot,
          projection_snapshot,
          planner_snapshot,
          policy_version,
          policy_revision,
          ownership_revision,
          expires_at
        )
        values (
          $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9
        )
        returning ${projectionColumns}
      `,
      [
        projection.liquidityProjectionId,
        input.userId,
        input.request,
        projection,
        plannerSnapshot,
        input.policyVersion,
        input.policyRevision,
        input.ownershipRevision,
        input.expiresAt,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("funding projection insert returned no row");
    return mapProjection(row);
  }

  async fetchOwnedCurrent(
    input: Parameters<FundingPlanningStore["fetchOwnedCurrent"]>[0],
  ): Promise<PersistedFundingPlanningSnapshot | null> {
    const { rows } = await this.db.query<PlanningProjectionDbRow>(
      `
        select ${projectionColumns}
        from funding_liquidity_projections
        where user_id = $1
          and id = $2
          and expires_at > $3
      `,
      [input.userId, input.projectionId, input.now],
    );
    return rows[0] ? mapProjection(rows[0]) : null;
  }
}

export async function deleteExpiredFundingPlanningSnapshots(
  db: Pick<Pool, "query">,
  now = new Date(),
): Promise<number> {
  const result = await db.query(
    `
      delete from funding_liquidity_projections
      where expires_at <= $1
    `,
    [now],
  );
  return result.rowCount ?? 0;
}
