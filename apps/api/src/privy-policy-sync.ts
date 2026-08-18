#!/usr/bin/env tsx

import { PrivyClient, type Policy } from "@privy-io/node";
import { config } from "dotenv";
import { readFileSync } from "node:fs";

import { knownPrivyPolicyFingerprint } from "./funding/execution/known-privy-wallet-signers.js";
import { canonicalJsonHash } from "./funding/persistence/canonical.js";

type JsonRecord = Record<string, unknown>;
type PolicyUpdateInput = Parameters<
  ReturnType<PrivyClient["policies"]>["update"]
>[1];

type PolicyManifest = Readonly<{
  /** Existing policy; this tool never creates or deletes policies. */
  policyId: string;
  /** Exact fingerprint read before the requested replacement. */
  expectedFingerprint: string;
  /** Complete desired rule set. A full manifest prevents accidental leftovers. */
  rules: readonly JsonRecord[];
  /** Optional policy-name update. Omit to preserve the current name. */
  name?: string;
}>;

const CONFIRMATION = "SYNC PRIVY POLICY MANIFEST";

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : null;
  return value && !value.startsWith("--") ? value : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function authorizationKey(): string {
  const stdin = hasFlag("authorization-key-stdin")
    ? readFileSync(0, "utf8").trim()
    : "";
  return stdin || requiredEnvironment("PRIVY_WALLET_AUTHORIZATION_KEY");
}

function readManifest(path: string): PolicyManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as JsonRecord).policyId !== "string" ||
    typeof (parsed as JsonRecord).expectedFingerprint !== "string" ||
    !Array.isArray((parsed as JsonRecord).rules)
  ) {
    throw new Error(
      "manifest must contain policyId, expectedFingerprint, and a complete rules array",
    );
  }
  const manifest = parsed as PolicyManifest;
  if (!manifest.policyId.trim() || !manifest.expectedFingerprint.trim()) {
    throw new Error(
      "manifest policyId and expectedFingerprint must be non-empty",
    );
  }
  if (manifest.rules.some((rule) => !rule || typeof rule !== "object")) {
    throw new Error("manifest rules must contain JSON objects only");
  }
  if (manifest.name != null && !manifest.name.trim()) {
    throw new Error("manifest name must be non-empty when provided");
  }
  return manifest;
}

function readback(policy: Policy) {
  return {
    chainType: policy.chain_type,
    id: policy.id,
    rules: policy.rules.map((rule) => ({
      action: rule.action,
      conditions: rule.conditions as unknown as readonly JsonRecord[],
      id: rule.id,
      method: rule.method,
      name: rule.name,
    })),
  };
}

function desiredRule(value: JsonRecord): JsonRecord {
  const { id: _id, ...rule } = value;
  return rule;
}

function canonicalRules(rules: readonly JsonRecord[]): string {
  return rules
    .map(desiredRule)
    .map((rule) => canonicalJsonHash(rule))
    .sort()
    .join(",");
}

async function main(): Promise<void> {
  const envFile = argument("env-file");
  if (envFile) config({ path: envFile, override: true });
  else config({ override: false });

  const manifestPath = argument("manifest");
  if (!manifestPath) throw new Error("--manifest <path> is required");
  const manifest = readManifest(manifestPath);
  const client = new PrivyClient({
    appId: requiredEnvironment("PRIVY_APP_ID"),
    appSecret: requiredEnvironment("PRIVY_APP_SECRET"),
  });
  const initial = await client.policies().get(manifest.policyId);
  const initialReadback = readback(initial);
  const actualFingerprint = knownPrivyPolicyFingerprint(initialReadback);
  const desiredRules = manifest.rules.map(desiredRule);
  const differs =
    canonicalRules(initialReadback.rules) !== canonicalRules(desiredRules);
  const execute = hasFlag("execute");
  if (execute && argument("confirm") !== CONFIRMATION) {
    throw new Error(
      `--confirm must exactly equal ${JSON.stringify(CONFIRMATION)}`,
    );
  }
  if (execute && actualFingerprint !== manifest.expectedFingerprint) {
    throw new Error(
      "policy fingerprint changed since the manifest was reviewed; read back and review a fresh manifest",
    );
  }

  if (execute && differs) {
    const update: PolicyUpdateInput = {
      rules: desiredRules as unknown as PolicyUpdateInput["rules"],
      ...(manifest.name != null ? { name: manifest.name } : {}),
    };
    await client.policies().update(manifest.policyId, {
      ...update,
      authorization_context: {
        authorization_private_keys: [authorizationKey()],
      },
    });
  }

  const policy = await client.policies().get(manifest.policyId);
  const normalized = readback(policy);
  const policyFingerprint = knownPrivyPolicyFingerprint(normalized);
  if (
    execute &&
    canonicalRules(normalized.rules) !== canonicalRules(desiredRules)
  ) {
    throw new Error("read-back rule set does not equal the reviewed manifest");
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: !execute,
        changed: execute && differs,
        policyId: normalized.id,
        policyFingerprint,
        currentFingerprint: actualFingerprint,
        desiredRuleCount: desiredRules.length,
      },
      null,
      2,
    ),
  );
}

await main();
