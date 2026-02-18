import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
config({ path: envPath, override: true });

function readEnv(key: string): string | undefined {
  const value = process.env[key];
  if (value == null) return undefined;
  if (value.trim().length === 0) return undefined;
  return value;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const asInt = Math.trunc(parsed);
  return asInt > 0 ? asInt : fallback;
}

function parseOptionalChain(key: string): string | undefined {
  const normalized = readEnv(key)?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function parseOptionalPositiveUsdcString(key: string): string | undefined {
  const raw = readEnv(key);
  if (!raw) return undefined;
  const normalized = raw.trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return normalized;
}

const enabled = parseBool(process.env.HUNCH_FINANCE_WORKER_ENABLED, false);
const executeEnabled = parseBool(process.env.HUNCH_FINANCE_EXECUTE, false);

export const env = {
  enabled,
  executeEnabled,

  feesCollectEnabled: parseBool(readEnv("HUNCH_FINANCE_COLLECT_ENABLED"), true),
  feesCollectIntervalSec: parsePositiveInt(
    readEnv("HUNCH_FINANCE_COLLECT_INTERVAL_SEC"),
    600,
  ),
  feesCollectDryRun: parseBool(readEnv("HUNCH_FINANCE_COLLECT_DRY_RUN"), false),
  feesCollectReadOnly: parseBool(
    readEnv("HUNCH_FINANCE_COLLECT_READ_ONLY"),
    false,
  ),

  feesReconcileEnabled: parseBool(
    readEnv("HUNCH_FINANCE_RECONCILE_ENABLED"),
    true,
  ),
  feesReconcileIntervalSec: parsePositiveInt(
    readEnv("HUNCH_FINANCE_RECONCILE_INTERVAL_SEC"),
    120,
  ),
  feesReconcileDryRun: parseBool(
    readEnv("HUNCH_FINANCE_RECONCILE_DRY_RUN"),
    false,
  ),

  treasurySweepEnabled: parseBool(readEnv("HUNCH_FINANCE_SWEEP_ENABLED"), false),
  treasurySweepIntervalSec: parsePositiveInt(
    readEnv("HUNCH_FINANCE_SWEEP_INTERVAL_SEC"),
    900,
  ),
  treasurySweepExecute: parseBool(
    readEnv("HUNCH_FINANCE_SWEEP_EXECUTE"),
    false,
  ),
  treasurySweepChainId: parseOptionalChain("HUNCH_FINANCE_SWEEP_CHAIN_ID"),
  treasurySweepMaxUsd: parseOptionalPositiveUsdcString(
    "HUNCH_FINANCE_SWEEP_MAX_USD",
  ),

  payoutPrepareEnabled: parseBool(
    readEnv("HUNCH_FINANCE_PAYOUT_PREPARE_ENABLED"),
    false,
  ),
  payoutPrepareIntervalSec: parsePositiveInt(
    readEnv("HUNCH_FINANCE_PAYOUT_PREPARE_INTERVAL_SEC"),
    900,
  ),
  payoutPrepareDryRun: parseBool(
    readEnv("HUNCH_FINANCE_PAYOUT_PREPARE_DRY_RUN"),
    true,
  ),
  payoutPrepareChainId: parseOptionalChain(
    "HUNCH_FINANCE_PAYOUT_PREPARE_CHAIN_ID",
  ),
  payoutPrepareLimit: parsePositiveInt(
    readEnv("HUNCH_FINANCE_PAYOUT_PREPARE_LIMIT"),
    25,
  ),

  payoutSendEnabled: parseBool(
    readEnv("HUNCH_FINANCE_PAYOUT_SEND_ENABLED"),
    false,
  ),
  payoutSendIntervalSec: parsePositiveInt(
    readEnv("HUNCH_FINANCE_PAYOUT_SEND_INTERVAL_SEC"),
    900,
  ),
  payoutSendExecute: parseBool(
    readEnv("HUNCH_FINANCE_PAYOUT_SEND_EXECUTE"),
    false,
  ),
  payoutSendChainId: parseOptionalChain("HUNCH_FINANCE_PAYOUT_SEND_CHAIN_ID"),
  payoutSendLimit: parsePositiveInt(
    readEnv("HUNCH_FINANCE_PAYOUT_SEND_LIMIT"),
    25,
  ),

  jobTimeoutSec: parsePositiveInt(process.env.HUNCH_FINANCE_JOB_TIMEOUT_SEC, 300),
  maxRetries: parsePositiveInt(process.env.HUNCH_FINANCE_MAX_RETRIES, 1),
  retryBackoffSec: parsePositiveInt(process.env.HUNCH_FINANCE_RETRY_BACKOFF_SEC, 5),
  jitterSec: parsePositiveInt(process.env.HUNCH_FINANCE_JITTER_SEC, 30),
};
