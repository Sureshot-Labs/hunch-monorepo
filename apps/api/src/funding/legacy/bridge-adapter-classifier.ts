export const LEGACY_BRIDGE_ADAPTER_VERSIONS = [
  "across_swap_api_v1",
  "across_suggested_fees_v1",
  "debridge_dln_create_tx_v1",
  "debridge_same_chain_v1",
  "debridge_same_chain_tx_v0",
  "bungee_legacy_v1",
] as const;

export type LegacyBridgeAdapterVersion =
  (typeof LEGACY_BRIDGE_ADAPTER_VERSIONS)[number];

export type LegacyBridgeReconcilerId =
  | "across_legacy"
  | "debridge_dln_legacy"
  | "debridge_same_chain_legacy"
  | "bungee_legacy";

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nestedRecord(
  value: unknown,
  keys: readonly string[],
): JsonRecord | null {
  let cursor: unknown = value;
  for (const key of keys) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  return isRecord(cursor) ? cursor : null;
}

function nestedKeyExists(
  value: unknown,
  parentKeys: readonly string[],
  key: string,
): boolean {
  const parent = nestedRecord(value, parentKeys);
  return parent ? Object.hasOwn(parent, key) : false;
}

export function classifyLegacyBridgeAdapter(
  input: Readonly<{
    provider: string;
    swapType: string;
    orderId: string | null;
    metadata: unknown;
  }>,
): LegacyBridgeAdapterVersion | null {
  if (
    input.provider === "across" &&
    nestedKeyExists(input.metadata, ["across", "providerPayload"], "swapTx")
  ) {
    return "across_swap_api_v1";
  }
  if (
    input.provider === "across" &&
    nestedKeyExists(
      input.metadata,
      ["across", "providerPayload"],
      "capitalFeePct",
    )
  ) {
    return "across_suggested_fees_v1";
  }
  if (
    input.provider === "debridge" &&
    input.swapType === "cross_chain" &&
    input.orderId != null &&
    isRecord(isRecord(input.metadata) ? input.metadata.estimation : null)
  ) {
    return "debridge_dln_create_tx_v1";
  }
  if (
    input.provider === "debridge" &&
    input.swapType === "same_chain" &&
    isRecord(isRecord(input.metadata) ? input.metadata.tokenIn : null) &&
    isRecord(isRecord(input.metadata) ? input.metadata.tokenOut : null)
  ) {
    return "debridge_same_chain_v1";
  }
  if (
    input.provider === "debridge" &&
    input.swapType === "same_chain" &&
    isRecord(isRecord(input.metadata) ? input.metadata.tx : null)
  ) {
    return "debridge_same_chain_tx_v0";
  }
  if (input.provider === "bungee") return "bungee_legacy_v1";
  return null;
}

export function resolveLegacyCreationAdapterVersion(
  input: Readonly<{
    provider: "across" | "debridge";
    swapType: "cross_chain" | "same_chain";
    providerPayload?: unknown;
  }>,
): LegacyBridgeAdapterVersion {
  if (input.provider === "debridge") {
    return input.swapType === "same_chain"
      ? "debridge_same_chain_v1"
      : "debridge_dln_create_tx_v1";
  }
  const providerPayload = isRecord(input.providerPayload)
    ? input.providerPayload
    : {};
  if (Object.hasOwn(providerPayload, "swapTx")) return "across_swap_api_v1";
  if (Object.hasOwn(providerPayload, "capitalFeePct")) {
    return "across_suggested_fees_v1";
  }
  throw new Error("unclassifiable Across legacy creation payload");
}

const LEGACY_RECONCILER_BY_VERSION: Readonly<
  Record<LegacyBridgeAdapterVersion, LegacyBridgeReconcilerId>
> = {
  across_swap_api_v1: "across_legacy",
  across_suggested_fees_v1: "across_legacy",
  debridge_dln_create_tx_v1: "debridge_dln_legacy",
  debridge_same_chain_v1: "debridge_same_chain_legacy",
  debridge_same_chain_tx_v0: "debridge_same_chain_legacy",
  bungee_legacy_v1: "bungee_legacy",
};

export function resolveLegacyBridgeReconciler(
  adapterVersion: string | null | undefined,
): LegacyBridgeReconcilerId | null {
  if (
    !adapterVersion ||
    !(LEGACY_BRIDGE_ADAPTER_VERSIONS as readonly string[]).includes(
      adapterVersion,
    )
  ) {
    return null;
  }
  return LEGACY_RECONCILER_BY_VERSION[
    adapterVersion as LegacyBridgeAdapterVersion
  ];
}

export function legacyBridgeCreationAllowed(
  _adapterVersion: LegacyBridgeAdapterVersion,
): false {
  return false;
}
