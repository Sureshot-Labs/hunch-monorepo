#!/usr/bin/env tsx

import { PrivyClient, type Policy } from "@privy-io/node";
import { POLYMARKET_FUNDING_ROUTER, POLYMARKET_USDCE } from "@hunch/contracts";
import { config } from "dotenv";
import { readFileSync } from "node:fs";

import { knownPrivyPolicyFingerprint } from "./funding/execution/known-privy-wallet-signers.js";

const CONFIRMATION = "ADD POLYMARKET ROUTER USDC.E APPROVAL";
const MAX_UINT256 =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

const APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : null;
  return value && !value.startsWith("--") ? value : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function required(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function authorizationKey(): string {
  const fromStdin = hasFlag("authorization-key-stdin")
    ? readFileSync(0, "utf8").trim()
    : "";
  return fromStdin || required("PRIVY_WALLET_AUTHORIZATION_KEY");
}

function readback(policy: Policy) {
  return {
    chainType: policy.chain_type,
    id: policy.id,
    rules: policy.rules.map((rule) => ({
      action: rule.action,
      conditions: rule.conditions as unknown as readonly Record<
        string,
        unknown
      >[],
      id: rule.id,
      method: rule.method,
      name: rule.name,
    })),
  };
}

function isExactUsdceRouterApproval(
  rule: Readonly<{
    action: string;
    method: string;
    conditions: readonly unknown[];
  }>,
): boolean {
  const expected = [
    ["ethereum_transaction", "chain_id", "eq", "137"],
    [
      "ethereum_transaction",
      "to",
      "eq",
      POLYMARKET_USDCE.polygon.toLowerCase(),
    ],
    ["ethereum_transaction", "value", "eq", "0x0"],
    ["ethereum_calldata", "function_name", "eq", "approve"],
    [
      "ethereum_calldata",
      "approve.spender",
      "eq",
      POLYMARKET_FUNDING_ROUTER.polygon.toLowerCase(),
    ],
    ["ethereum_calldata", "approve.amount", "eq", MAX_UINT256],
  ] as const;
  return (
    rule.action === "ALLOW" &&
    rule.method === "eth_sendTransaction" &&
    rule.conditions.length === expected.length &&
    expected.every(([fieldSource, field, operator, value]) =>
      rule.conditions.some(
        (condition) =>
          (condition as unknown as Record<string, unknown>).field_source ===
            fieldSource &&
          (condition as unknown as Record<string, unknown>).field === field &&
          (condition as unknown as Record<string, unknown>).operator ===
            operator &&
          String(
            (condition as unknown as Record<string, unknown>).value,
          ).toLowerCase() === value,
      ),
    )
  );
}

async function main(): Promise<void> {
  const envFile = argument("env-file");
  if (envFile) config({ path: envFile, override: true });
  else config({ override: false });

  const policyId =
    argument("policy-id") ??
    required("PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_ID");
  const client = new PrivyClient({
    appId: required("PRIVY_APP_ID"),
    appSecret: required("PRIVY_APP_SECRET"),
  });
  const initial = await client.policies().get(policyId);
  if (initial.chain_type !== "ethereum") {
    throw new Error("configured policy is not an Ethereum policy");
  }
  const present = initial.rules.filter(isExactUsdceRouterApproval);
  if (present.length > 1) {
    throw new Error("policy contains duplicate USDC.e Router approval rules");
  }
  const execute = hasFlag("execute");
  if (execute && argument("confirm") !== CONFIRMATION) {
    throw new Error(
      `--confirm must exactly equal ${JSON.stringify(CONFIRMATION)}`,
    );
  }

  if (execute && present.length === 0) {
    await client.policies().createRule(policyId, {
      name: "Funding Router controller USDC.e approval",
      method: "eth_sendTransaction",
      action: "ALLOW",
      conditions: [
        {
          field_source: "ethereum_transaction",
          field: "chain_id",
          operator: "eq",
          value: "137",
        },
        {
          field_source: "ethereum_transaction",
          field: "to",
          operator: "eq",
          value: POLYMARKET_USDCE.polygon,
        },
        {
          field_source: "ethereum_transaction",
          field: "value",
          operator: "eq",
          value: "0x0",
        },
        {
          field_source: "ethereum_calldata",
          field: "function_name",
          operator: "eq",
          value: "approve",
          abi: APPROVE_ABI,
        },
        {
          field_source: "ethereum_calldata",
          field: "approve.spender",
          operator: "eq",
          value: POLYMARKET_FUNDING_ROUTER.polygon,
          abi: APPROVE_ABI,
        },
        {
          field_source: "ethereum_calldata",
          field: "approve.amount",
          operator: "eq",
          value: MAX_UINT256,
          abi: APPROVE_ABI,
        },
      ],
      authorization_context: {
        authorization_private_keys: [authorizationKey()],
      },
    });
  }

  const policy = await client.policies().get(policyId);
  const exactRules = policy.rules.filter(isExactUsdceRouterApproval);
  if (execute && exactRules.length !== 1) {
    throw new Error(
      "read-back did not contain exactly one USDC.e Router approval rule",
    );
  }
  const normalized = readback(policy);
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: !execute,
        changed: execute && present.length === 0,
        policyId: normalized.id,
        policyFingerprint: knownPrivyPolicyFingerprint(normalized),
        usdceRouterApprovalRuleId: exactRules[0]?.id ?? null,
      },
      null,
      2,
    ),
  );
}

await main();
