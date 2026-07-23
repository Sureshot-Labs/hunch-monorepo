import type { DbQuery } from "../db.js";
import type { ValuedAssetComponent } from "../funding/domain/types.js";

export const FUNDING_SUGGESTION_PREFERENCES = [
  "ask",
  "suggest",
  "never_suggest",
] as const;

export type FundingSuggestionPreference =
  (typeof FUNDING_SUGGESTION_PREFERENCES)[number];

type PreferenceRow = Readonly<{
  component_id: string;
  suggestion_preference: FundingSuggestionPreference;
  revision: string;
}>;

export type StoredAssetFundingPreference = Readonly<{
  componentId: string;
  preference: FundingSuggestionPreference;
  revision: string;
}>;

export async function fetchAssetFundingPreferences(
  db: DbQuery,
  inputs: {
    userId: string;
    componentIds: readonly string[];
  },
): Promise<Readonly<Record<string, StoredAssetFundingPreference>>> {
  if (inputs.componentIds.length === 0) return {};
  try {
    const result = await db.query<PreferenceRow>(
      `
        select component_id, suggestion_preference, revision::text
        from user_asset_funding_preferences
        where user_id = $1
          and component_id = any($2::text[])
      `,
      [inputs.userId, [...inputs.componentIds]],
    );
    return Object.fromEntries(
      result.rows.map((row) => [
        row.component_id,
        {
          componentId: row.component_id,
          preference: row.suggestion_preference,
          revision: row.revision,
        },
      ]),
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "42P01"
    ) {
      return {};
    }
    throw error;
  }
}

export async function upsertAssetFundingPreference(
  db: DbQuery,
  inputs: {
    userId: string;
    component: ValuedAssetComponent;
    preference: FundingSuggestionPreference;
  },
): Promise<StoredAssetFundingPreference> {
  const result = await db.query<PreferenceRow>(
    `
      insert into user_asset_funding_preferences (
        user_id,
        component_id,
        network_id,
        asset_id,
        location_id,
        suggestion_preference
      )
      values ($1, $2, $3, $4, $5, $6)
      on conflict (user_id, component_id)
      do update set
        network_id = excluded.network_id,
        asset_id = excluded.asset_id,
        location_id = excluded.location_id,
        suggestion_preference = excluded.suggestion_preference,
        revision = user_asset_funding_preferences.revision + 1,
        updated_at = now()
      returning component_id, suggestion_preference, revision::text
    `,
    [
      inputs.userId,
      inputs.component.componentId,
      inputs.component.amount.asset.networkId,
      inputs.component.amount.asset.assetId,
      inputs.component.location.locationId,
      inputs.preference,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("asset funding preference upsert returned no row");
  return {
    componentId: row.component_id,
    preference: row.suggestion_preference,
    revision: row.revision,
  };
}

export function rankAssetsForSuggestion(inputs: {
  components: readonly ValuedAssetComponent[];
  preferences: Readonly<
    Record<string, StoredAssetFundingPreference | undefined>
  >;
}): readonly ValuedAssetComponent[] {
  const rank = (component: ValuedAssetComponent): number => {
    const preference =
      inputs.preferences[component.componentId]?.preference ?? "ask";
    if (preference === "never_suggest") return 2;
    if (preference === "suggest") return 0;
    return 1;
  };
  return [...inputs.components]
    .filter(
      (component) =>
        component.category !== "in_transit" &&
        component.executionEligibility !== "ineligible" &&
        (inputs.preferences[component.componentId]?.preference ?? "ask") !==
          "never_suggest",
    )
    .sort(
      (left, right) =>
        rank(left) - rank(right) ||
        left.componentId.localeCompare(right.componentId),
    );
}
