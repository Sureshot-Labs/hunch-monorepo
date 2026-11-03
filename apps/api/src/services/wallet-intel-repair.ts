import { createHash } from "node:crypto";
import type { Pool } from "@hunch/infra";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type WalletIntelRepairArgs = { walletIds: string[]; execute: boolean };

export function parseWalletIntelRepairArgs(
  argv: readonly string[],
  readManifest: (path: string) => string,
): WalletIntelRepairArgs | null {
  for (const arg of argv)
    if (
      arg.startsWith("--repair") &&
      arg !== "--repair" &&
      arg !== "--repair-execute" &&
      !arg.startsWith("--repair-wallet-ids=") &&
      !arg.startsWith("--repair-wallet-ids-file=")
    )
      throw new Error("Unknown/incomplete repair option.");
  const inline = argv.filter((arg) => arg.startsWith("--repair-wallet-ids="));
  const files = argv.filter((arg) =>
    arg.startsWith("--repair-wallet-ids-file="),
  );
  const execute = argv.includes("--repair-execute");
  if (!inline.length && !files.length) {
    if (execute || argv.includes("--repair"))
      throw new Error("Repair requires an explicit wallet list.");
    return null;
  }
  if (inline.length + files.length !== 1)
    throw new Error("Provide one explicit repair wallet list.");
  let values: unknown;
  const fileArg = files[0];
  const inlineArg = inline[0];
  if (fileArg) {
    const path = fileArg.slice("--repair-wallet-ids-file=".length).trim();
    if (!path) throw new Error("Repair manifest path is empty.");
    const raw = readManifest(path);
    if (raw.length > 65536) throw new Error("Repair manifest exceeds64KiB.");
    values = JSON.parse(raw);
  } else if (inlineArg)
    values = inlineArg.slice("--repair-wallet-ids=".length).split(",");
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.some((id) => typeof id !== "string" || !uuid.test(id.trim()))
  )
    throw new Error("Repair requires a nonempty UUID array/list.");
  const walletIds = [
    ...new Set((values as string[]).map((id) => id.trim().toLowerCase())),
  ].sort();
  if (walletIds.length > 1000)
    throw new Error(
      "Repair manifest exceeds the existing maximum wallet batch1000.",
    );
  if (
    argv.some(
      (arg) =>
        arg !== "--" &&
        arg !== "--repair" &&
        arg !== "--repair-execute" &&
        arg !== "--print-effective-policy" &&
        !arg.startsWith("--repair-wallet-ids=") &&
        !arg.startsWith("--repair-wallet-ids-file="),
    )
  )
    throw new Error(
      "Targeted repair cannot be mixed with normal refresh options or policy overrides.",
    );
  return { walletIds, execute };
}

export const WALLET_INTEL_REPAIR_TARGETS_SQL = `
 select requested_row.wallet_id::text as wallet_id, wallet_row.address, wallet_row.chain,
   'polymarket'::text as venue, tracking_row.sources, tracking_row.priority,
   case when wallet_row.id is null then 'unknown_wallet'
     when wallet_row.chain is null or wallet_row.chain<>'polygon' then 'unsupported_chain'
     when wallet_row.address is null or wallet_row.address !~ '^0x[0-9a-fA-F]{40}$' then 'invalid_address'
     when lower(wallet_row.address)=any($2::text[]) then 'protocol_contract'
     when tracking_row.priority is null then 'inactive_tracking'
     else null end as excluded_reason
 from unnest($1::uuid[]) requested_row(wallet_id)
 left join wallets wallet_row on wallet_row.id=requested_row.wallet_id
 left join lateral (
   select array_agg(distinct source order by source) as sources,max(priority) as priority
   from wallet_tracking_subjects subject_row where subject_row.wallet_id=requested_row.wallet_id
     and subject_row.venue='polymarket' and subject_row.status='active'
     and subject_row.source in ('whale','recent_top_holder','signal_candidate')
 ) tracking_row on true order by requested_row.wallet_id`;

export type WalletIntelRepairTarget = {
  wallet_id: string;
  address: string | null;
  chain: string | null;
  venue: "polymarket";
  sources: string[] | null;
  priority: number | null;
  excluded_reason:
    | "unknown_wallet"
    | "unsupported_chain"
    | "invalid_address"
    | "protocol_contract"
    | "inactive_tracking"
    | null;
};

export async function loadWalletIntelRepairPlan(
  db: Pick<Pool, "query">,
  walletIds: string[],
  options: {
    protocolAddresses: string[];
    enabledVenues: readonly string[];
    maxWallets: number;
  },
) {
  if (walletIds.length > options.maxWallets)
    throw new Error(
      "Split repair into batches within the current autoTrackedWalletLimit.",
    );
  if (!options.enabledVenues.includes("polymarket"))
    throw new Error("Polymarket Intel is disabled by the live venue policy.");
  const { rows } = await db.query<WalletIntelRepairTarget>(
    WALLET_INTEL_REPAIR_TARGETS_SQL,
    [walletIds, options.protocolAddresses],
  );
  const targets = rows.filter(
    (
      row,
    ): row is WalletIntelRepairTarget & {
      address: string;
      sources: string[];
      priority: number;
    } =>
      row.excluded_reason === null &&
      row.address !== null &&
      row.sources !== null &&
      row.priority !== null,
  );
  return {
    targets,
    report: {
      requested: walletIds.length,
      eligible: targets.length,
      manifestHash: createHash("sha256")
        .update(walletIds.join(","))
        .digest("hex"),
      excluded: rows
        .filter((row) => row.excluded_reason !== null)
        .map((row) => ({
          walletId: row.wallet_id,
          reason: row.excluded_reason,
        })),
      bypasses: [
        "selection_rank",
        "selection_ttl",
        "selection_refresh_age",
        "selection_attempt_backoff",
      ],
      preserves: [
        "shared_refresh_lock",
        "provider_retry_after",
        "request_budget",
        "ledger_provenance",
        "complete_inventory",
        "hidden_positions",
      ],
    },
  };
}
