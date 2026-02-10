import { writeFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
console.log(`[ai:xai:usage] Loading env from ${envPath}`);
config({ path: envPath, override: false });

type Args = {
  start: string | null;
  end: string | null;
  days: number;
  timezone: string;
  timeUnit: string;
  out: string | null;
  includeBillingInfo: boolean;
  baseUrl: string;
  targetApiKeyId: string | null;
  verbose: boolean;
};

type ApiKeyInfo = {
  redacted_api_key?: string;
  user_id?: string;
  name?: string;
  create_time?: string;
  modify_time?: string;
  modified_by?: string;
  team_id?: string;
  acls?: string[];
  api_key_id?: string;
  team_blocked?: boolean;
  api_key_blocked?: boolean;
  api_key_disabled?: boolean;
};

type FlatUsageRow = {
  usd: number;
  group: Record<string, string>;
  time: string | null;
};

type UsageSummary = {
  totalUsd: number;
  rows: FlatUsageRow[];
};

const GROUP_FIELDS = [
  "description",
  "api_key_id",
  "apiKeyId",
  "model",
  "name",
  "team_id",
  "user_id",
];

const TIME_FIELDS = [
  "time",
  "date",
  "day",
  "bucket",
  "timestamp",
  "startTime",
  "endTime",
];

function parseFlag(argv: string[], name: string): string | undefined {
  const idx = argv.findIndex(value => value === name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  pnpm -C hunch-monorepo -F api run ai:xai:usage -- [options]",
      "",
      "Required env:",
      "  XAI_MANAGEMENT_API_KEY=... (preferred)",
      "  or XAI_API_KEY=... (fallback, may not have billing access)",
      "",
      "Options:",
      "  --start <YYYY-MM-DD|YYYY-MM-DD HH:MM:SS>   Start time in UTC (default: days lookback)",
      "  --end <YYYY-MM-DD|YYYY-MM-DD HH:MM:SS>     End time in UTC (default: now date 23:59:59)",
      "  --days <n>                                  Lookback days when --start not set (default: 7)",
      "  --timezone <tz>                             Analytics timezone (default: Etc/GMT)",
      "  --time-unit <enum>                          Analytics time unit (default: TIME_UNIT_DAY)",
      "  --include-billing-info                      Fetch billing profile too",
      "  --base-url <url>                            API base URL (default: https://management-api.x.ai)",
      "  --target-api-key-id <id>                    Report usage for this api_key_id",
      "  --verbose                                   Log endpoint fallback attempts",
      "  --out <path>                                Write full raw+parsed JSON report",
      "",
      "Examples:",
      "  XAI_MANAGEMENT_API_KEY=... pnpm -C hunch-monorepo -F api run ai:xai:usage -- --days 7",
      "  XAI_MANAGEMENT_API_KEY=... pnpm -C hunch-monorepo -F api run ai:xai:usage -- --start 2026-02-01 --end 2026-02-10 --target-api-key-id <uuid> --out /tmp/xai-usage.json",
    ].join("\n"),
  );
  process.exit(1);
}

function resolveArgs(argv: string[]): Args {
  if (hasFlag(argv, "--help")) usage();
  return {
    start: parseFlag(argv, "--start") ?? null,
    end: parseFlag(argv, "--end") ?? null,
    days: parsePositiveInt(parseFlag(argv, "--days"), 7),
    timezone: parseFlag(argv, "--timezone")?.trim() || "Etc/GMT",
    timeUnit: parseFlag(argv, "--time-unit")?.trim() || "TIME_UNIT_DAY",
    out: parseFlag(argv, "--out") ?? null,
    includeBillingInfo: hasFlag(argv, "--include-billing-info"),
    baseUrl:
      parseFlag(argv, "--base-url")?.trim() ||
      process.env.XAI_MANAGEMENT_BASE_URL?.trim() ||
      process.env.XAI_BASE_URL?.trim() ||
      "https://management-api.x.ai",
    targetApiKeyId:
      parseFlag(argv, "--target-api-key-id")?.trim() ||
      process.env.XAI_TARGET_API_KEY_ID?.trim() ||
      null,
    verbose: hasFlag(argv, "--verbose"),
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatUtcDateTime(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

function normalizeInputDateTime(value: string, endOfDay: boolean): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed} ${endOfDay ? "23:59:59" : "00:00:00"}`;
  }
  return trimmed;
}

function resolveTimeRange(args: Args): { startTime: string; endTime: string } {
  const now = new Date();
  const endTime = args.end
    ? normalizeInputDateTime(args.end, true)
    : `${now.toISOString().slice(0, 10)} 23:59:59`;

  if (args.start) {
    return {
      startTime: normalizeInputDateTime(args.start, false),
      endTime,
    };
  }

  const start = new Date(now.getTime());
  start.setUTCDate(start.getUTCDate() - (args.days - 1));
  start.setUTCHours(0, 0, 0, 0);
  return {
    startTime: formatUtcDateTime(start),
    endTime,
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function hasV1Path(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return /\/v1\/?$/.test(url.pathname);
  } catch {
    return /\/v1\/?$/.test(baseUrl);
  }
}

function candidateUrls(baseUrlRaw: string, resourcePathNoVersion: string): string[] {
  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  const resource = resourcePathNoVersion.replace(/^\/+/, "");

  const withV1 = `${baseUrl}/v1/${resource}`;
  const withoutV1 = `${baseUrl}/${resource}`;

  // If base already ends with /v1, the first candidate should not add /v1 again.
  const ordered = hasV1Path(baseUrl) ? [withoutV1, withV1] : [withV1, withoutV1];
  return Array.from(new Set(ordered));
}

async function requestJson(
  apiKey: string,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // leave as raw text
  }

  if (!response.ok) {
    const compact =
      typeof payload === "string"
        ? payload.slice(0, 600)
        : JSON.stringify(payload).slice(0, 600);
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${compact}`);
  }
  return payload;
}

async function requestJsonWithFallback(
  apiKey: string,
  method: "GET" | "POST",
  urls: string[],
  body: unknown | undefined,
  verbose: boolean,
): Promise<{ payload: unknown; url: string }> {
  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      if (verbose) console.log(`[ai:xai:usage] request ${method} ${url}`);
      const payload = await requestJson(apiKey, method, url, body);
      return { payload, url };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = error instanceof Error ? error : new Error(message);
      // Retry only for route-shape errors.
      if (!/HTTP 404\b/.test(message) && !/HTTP 405\b/.test(message)) {
        throw lastError;
      }
      if (verbose) console.log(`[ai:xai:usage] fallback after ${message}`);
    }
  }

  throw lastError ?? new Error("All endpoint candidates failed.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pickGroup(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};

  const compositeKeys = [
    "groupByValues",
    "group_by_values",
    "groupBy",
    "dimensions",
    "labels",
    "keys",
  ];
  for (const key of compositeKeys) {
    const value = record[key];
    if (!isRecord(value)) continue;
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out[k] = String(v);
      }
    }
  }

  for (const key of GROUP_FIELDS) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
    }
  }

  return out;
}

function pickTime(record: Record<string, unknown>): string | null {
  for (const key of TIME_FIELDS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  const timeRange = record.timeRange;
  if (isRecord(timeRange)) {
    const start = typeof timeRange.startTime === "string" ? timeRange.startTime : null;
    const end = typeof timeRange.endTime === "string" ? timeRange.endTime : null;
    if (start || end) return `${start ?? ""}|${end ?? ""}`;
  }
  return null;
}

function maybeExtractUsdRow(record: Record<string, unknown>): FlatUsageRow | null {
  const valueCandidates: unknown[] = [];
  valueCandidates.push(record.usd);

  const values = record.values;
  if (isRecord(values)) valueCandidates.push(values.usd);

  const value = record.value;
  if (isRecord(value)) valueCandidates.push(value.usd);

  const metrics = record.metrics;
  if (isRecord(metrics)) valueCandidates.push(metrics.usd);

  const usd = valueCandidates
    .map(candidate => asNumber(candidate))
    .find((candidate): candidate is number => candidate !== null);

  if (usd === undefined) return null;

  return {
    usd,
    group: pickGroup(record),
    time: pickTime(record),
  };
}

function extractUsageRows(payload: unknown): FlatUsageRow[] {
  const rows: FlatUsageRow[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isRecord(node)) return;

    const maybeRow = maybeExtractUsdRow(node);
    if (maybeRow) rows.push(maybeRow);

    for (const value of Object.values(node)) {
      if (typeof value === "object" && value !== null) {
        walk(value);
      }
    }
  };

  walk(payload);
  const dedupe = new Map<string, FlatUsageRow>();
  for (const row of rows) {
    const key = JSON.stringify({
      usd: row.usd,
      group: row.group,
      time: row.time,
    });
    dedupe.set(key, row);
  }
  const unique = Array.from(dedupe.values());

  const hasTimedRows = unique.some(row => row.time !== null);
  if (!hasTimedRows) return unique;
  return unique.filter(row => row.time !== null);
}

function summarizeUsage(payload: unknown): UsageSummary {
  const rows = extractUsageRows(payload);
  const totalUsd = rows.reduce((acc, row) => acc + row.usd, 0);
  return { totalUsd, rows };
}

function resolveApiKeyId(row: FlatUsageRow): string | null {
  const keys = ["api_key_id", "apiKeyId"];
  for (const key of keys) {
    if (row.group[key]) return row.group[key];
  }
  return null;
}

function buildUsageRequest(
  startTime: string,
  endTime: string,
  timezone: string,
  timeUnit: string,
  groupBy: string[],
): Record<string, unknown> {
  return {
    analyticsRequest: {
      timeRange: {
        startTime,
        endTime,
        timezone,
      },
      timeUnit,
      values: [
        {
          name: "usd",
          aggregation: "AGGREGATION_SUM",
        },
      ],
      groupBy,
      filters: [],
    },
  };
}

async function main(): Promise<void> {
  const args = resolveArgs(process.argv.slice(2));
  const apiKey =
    process.env.XAI_MANAGEMENT_API_KEY?.trim() ||
    process.env.XAI_API_KEY?.trim();
  if (!apiKey) {
    console.error(
      "[ai:xai:usage] Missing auth key. Set XAI_MANAGEMENT_API_KEY (preferred) or XAI_API_KEY.",
    );
    usage();
  }

  const { startTime, endTime } = resolveTimeRange(args);

  const apiKeyCandidates = candidateUrls(args.baseUrl, "/api-key");
  const apiKeyResult = await requestJsonWithFallback(
    apiKey,
    "GET",
    apiKeyCandidates,
    undefined,
    args.verbose,
  );
  const apiKeyPayload = apiKeyResult.payload;
  if (!isRecord(apiKeyPayload)) {
    throw new Error("Unexpected /v1/api-key response.");
  }

  const apiKeyInfo = apiKeyPayload as ApiKeyInfo;
  const teamId = apiKeyInfo.team_id;
  const derivedApiKeyId = apiKeyInfo.api_key_id;
  const targetApiKeyId = args.targetApiKeyId ?? derivedApiKeyId ?? null;
  if (!teamId) {
    throw new Error("Missing team_id in /v1/api-key response.");
  }

  const usageCandidates = candidateUrls(
    args.baseUrl,
    `/billing/teams/${encodeURIComponent(teamId)}/usage`,
  );

  const reqTotal = buildUsageRequest(startTime, endTime, args.timezone, args.timeUnit, []);
  const reqByDescription = buildUsageRequest(startTime, endTime, args.timezone, args.timeUnit, [
    "description",
  ]);
  const reqByApiKey = buildUsageRequest(startTime, endTime, args.timezone, args.timeUnit, [
    "api_key_id",
  ]);

  let resTotalResult: { payload: unknown; url: string };
  try {
    resTotalResult = await requestJsonWithFallback(
      apiKey,
      "POST",
      usageCandidates,
      reqTotal,
      args.verbose,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${msg} | Billing usage endpoint was not reachable. Use management base URL and key: base=https://management-api.x.ai, env=XAI_MANAGEMENT_API_KEY`,
    );
  }
  const resTotal = resTotalResult.payload;

  const usageByDescriptionCandidates =
    resTotalResult.url === usageCandidates[0]
      ? usageCandidates
      : [resTotalResult.url, ...usageCandidates.filter(url => url !== resTotalResult.url)];

  const resByDescriptionResult = await requestJsonWithFallback(
    apiKey,
    "POST",
    usageByDescriptionCandidates,
    reqByDescription,
    args.verbose,
  );
  const resByDescription = resByDescriptionResult.payload;

  let resByApiKey: unknown = null;
  let byApiKeyError: string | null = null;
  try {
    const resByApiKeyResult = await requestJsonWithFallback(
      apiKey,
      "POST",
      usageByDescriptionCandidates,
      reqByApiKey,
      args.verbose,
    );
    resByApiKey = resByApiKeyResult.payload;
  } catch (error) {
    byApiKeyError = error instanceof Error ? error.message : String(error);
  }

  let billingInfoPayload: unknown = null;
  if (args.includeBillingInfo) {
    const billingInfoCandidates = candidateUrls(
      args.baseUrl,
      `/billing/teams/${encodeURIComponent(teamId)}/billing-info`,
    );
    const billingInfoResult = await requestJsonWithFallback(
      apiKey,
      "GET",
      billingInfoCandidates,
      undefined,
      args.verbose,
    );
    billingInfoPayload = billingInfoResult.payload;
  }

  const totalSummary = summarizeUsage(resTotal);
  const descriptionSummary = summarizeUsage(resByDescription);
  const byApiKeySummary = resByApiKey ? summarizeUsage(resByApiKey) : null;

  let thisKeyUsd: number | null = null;
  if (targetApiKeyId && byApiKeySummary) {
    const rowsForKey = byApiKeySummary.rows.filter(
      row => resolveApiKeyId(row) === targetApiKeyId,
    );
    if (rowsForKey.length > 0) {
      thisKeyUsd = rowsForKey.reduce((acc, row) => acc + row.usd, 0);
    }
  }

  const topDescriptions = descriptionSummary.rows
    .map(row => ({
      description: row.group.description ?? "(unknown)",
      usd: row.usd,
      time: row.time ?? "",
    }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 20);

  console.log(
    `[ai:xai:usage] team_id=${teamId} derived_key_id=${derivedApiKeyId ?? "unknown"} target_key_id=${targetApiKeyId ?? "unknown"}`,
  );
  console.log(
    `[ai:xai:usage] range=${startTime} -> ${endTime} tz=${args.timezone} time_unit=${args.timeUnit}`,
  );
  console.log(
    `[ai:xai:usage] team_total_usd=${totalSummary.totalUsd.toFixed(6)}`,
  );

  if (thisKeyUsd !== null) {
    console.log(
      `[ai:xai:usage] api_key_total_usd=${thisKeyUsd.toFixed(6)}`,
    );
  } else if (byApiKeyError) {
    console.log(
      `[ai:xai:usage] api_key_total_usd=unavailable (api_key_id grouping failed: ${byApiKeyError})`,
    );
  } else {
    console.log(
      "[ai:xai:usage] api_key_total_usd=unavailable (no api_key_id rows matched this key)",
    );
  }

  console.log("[ai:xai:usage] top_descriptions");
  console.table(topDescriptions);

  if (args.out) {
    const report = {
      generatedAt: new Date().toISOString(),
      baseUrl: args.baseUrl,
      range: {
        startTime,
        endTime,
        timezone: args.timezone,
        timeUnit: args.timeUnit,
      },
      apiKey: apiKeyInfo,
      targetApiKeyId,
      totals: {
        teamTotalUsd: totalSummary.totalUsd,
        apiKeyTotalUsd: thisKeyUsd,
      },
      summaries: {
        total: totalSummary,
        byDescription: descriptionSummary,
        byApiKey: byApiKeySummary,
      },
      topDescriptions,
      requests: {
        total: reqTotal,
        byDescription: reqByDescription,
        byApiKey: reqByApiKey,
      },
      raw: {
        total: resTotal,
        byDescription: resByDescription,
        byApiKey: resByApiKey,
        billingInfo: billingInfoPayload,
      },
      byApiKeyError,
    };
    await writeFile(args.out, JSON.stringify(report, null, 2), "utf8");
    console.log(`[ai:xai:usage] wrote ${args.out}`);
  }
}

main().catch(error => {
  console.error("[ai:xai:usage] failed", error);
  process.exit(1);
});
