#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

function readApiSourceFile(...parts: string[]): string {
  return readFileSync(path.join(import.meta.dirname, ...parts), "utf8");
}

const dflowPrivate = readApiSourceFile("routes", "dflow-private.ts");
const dflowSchemas = readApiSourceFile("schemas", "dflow.ts");
const bridgeRoute = readApiSourceFile("routes", "bridge.ts");
const sponsorshipReconcile = readApiSourceFile(
  "services",
  "solana-sponsorship-reconcile.ts",
);
const adminRoute = readApiSourceFile("routes", "admin.ts");
const adminAuth = readApiSourceFile("services", "admin-auth.ts");
const secretsConfig = readFileSync(
  path.join(import.meta.dirname, "../../../packages/config/src/secrets.ts"),
  "utf8",
);
const rewardsSecretBundle =
  /rewards:\s*\[([\s\S]*?)\],/.exec(secretsConfig)?.[1] ?? "";
const prodCompose = readFileSync(
  path.join(import.meta.dirname, "../../../ops/docker-compose.prod.yml"),
  "utf8",
);

assert.match(
  dflowPrivate,
  /async function signAndBroadcastSponsoredDflowTransaction[\s\S]*?const sponsorConfig = await resolveDflowSponsorConfig\(\)/,
  "sponsored DFlow submit must re-check sponsor policy/config before signing",
);
assert.match(
  dflowPrivate,
  /\/order[\s\S]*?resolveEmbeddedSolanaWalletContext\(\{[\s\S]*?user,[\s\S]*?signer: walletAddress/,
  "DFlow order sponsorship must require an embedded Solana wallet",
);
assert.match(
  dflowPrivate,
  /\/sponsored-submit[\s\S]*?resolveEmbeddedSolanaWalletContext\(\{[\s\S]*?user,[\s\S]*?signer: walletAddress/,
  "sponsored DFlow submit must re-check the embedded Solana wallet",
);
assert.match(
  dflowPrivate,
  /\/admin\/prediction-market-init[\s\S]*?requiredAdminPermissions:\s*\["finance:write",\s*"sponsorship:write"\]/,
  "admin DFlow market init must require sponsorship write permission",
);
assert.match(
  dflowPrivate,
  /\/admin\/prediction-market-init[\s\S]*?resolveDflowActualSponsorshipDecision[\s\S]*?!decision\.actualSponsorAllowed/,
  "admin DFlow market init must respect actual sponsorship policy",
);
assert.match(
  dflowPrivate,
  /array\['created', 'intent_created', 'user_signed', 'submitted', 'failed', 'confirmed'\]/,
  "DFlow ledger upsert must allow submitted rows to become failed after finalized tx errors",
);

assert.match(
  dflowPrivate,
  /skipPreflight:\s*false/,
  "sponsored DFlow broadcasts must force preflight on",
);
assert.doesNotMatch(
  dflowPrivate,
  /signAndBroadcastSponsoredDflowTransaction\(\{[\s\S]*?skipPreflight:\s*request\.body\.skipPreflight/,
  "sponsored DFlow submit must not forward client skipPreflight",
);

assert.match(
  dflowPrivate,
  /analysis\.feePayer !== inputs\.sponsorAddress/,
  "sponsored DFlow validation must require sponsor fee payer",
);
assert.match(
  dflowPrivate,
  /missing_dflow_instruction/,
  "sponsored DFlow validation must require a DFlow instruction",
);
assert.match(
  dflowPrivate,
  /analysis\.signerAddresses\.length !== expectedSigners\.size/,
  "sponsored DFlow validation must reject extra signers",
);
assert.match(
  dflowPrivate,
  /sponsor_cost_exceeds_cap/,
  "sponsored DFlow validation must enforce a sponsor lamport cap",
);

assert.match(
  dflowPrivate,
  /export function buildDflowOrderRequestQuery[\s\S]*?inputs\.sponsored[\s\S]*?getDflowSponsoredFeeParams/,
  "sponsored DFlow orders must use backend-owned fee params",
);
assert.match(
  dflowPrivate,
  /maxSystemCreateLamports !== "0"[\s\S]*?validation\?\.valid !== true/,
  "sponsored DFlow intent creation must reject market-init rent and failed validation",
);

const sponsoredSubmitSchema =
  /export const dflowSponsoredSubmitBodySchema = z\.object\(\{([\s\S]*?)\}\);/.exec(
    dflowSchemas,
  )?.[1] ?? "";
assert.doesNotMatch(
  sponsoredSubmitSchema,
  /skipPreflight/,
  "sponsored submit schema must not expose skipPreflight",
);

const preinitSchema =
  /export const dflowPredictionMarketInitBodySchema = z\.object\(\{([\s\S]*?)\}\);/.exec(
    dflowSchemas,
  )?.[1] ?? "";
assert.doesNotMatch(
  preinitSchema,
  /skipPreflight/,
  "prediction-market init schema must not expose skipPreflight",
);

assert.match(
  bridgeRoute,
  /async function createDebridgeSolanaSponsorshipIntent[\s\S]*?isPositiveIntegerLike\(inputs\.payload\.fixFee\)[\s\S]*?isPositiveIntegerLike\(inputs\.payload\.protocolFee\)/,
  "deBridge sponsorship intent creation must reject positive native/provider fees",
);
assert.match(
  bridgeRoute,
  /embeddedSolanaSponsorshipFlows\.debridge !== true/,
  "deBridge sponsorship intent creation must require the Access policy flow flag",
);
assert.match(
  bridgeRoute,
  /const allowedProgramIds = env\.debridgeSolanaAllowedProgramIds;[\s\S]*?if \(!allowedProgramIds\.length\) return null;/,
  "deBridge sponsorship intent creation must require an explicit program allowlist",
);
assert.match(
  bridgeRoute,
  /validateEmbeddedSolanaSponsorshipIntentCandidate\(\{[\s\S]*?flow: "debridge"/,
  "deBridge sponsorship intent creation must use the Solana sponsorship analyzer",
);
assert.match(
  bridgeRoute,
  /reserveEmbeddedSolanaSponsorshipBudget\(\{[\s\S]*?flow: "debridge"/,
  "deBridge sponsorship intent creation must reserve budget before creating an intent",
);
assert.match(
  bridgeRoute,
  /upsertSolanaSponsorshipLedger\(\{[\s\S]*?flow: "across"[\s\S]*?\}\);\s*hunchSponsorshipIntentId = intent\.id;/,
  "Across sponsorship intent id must be returned only after ledger durability",
);
assert.match(
  sponsorshipReconcile,
  /getBooleanMetadata\(row\.metadata, "adminPredictionMarketInit"\)[\s\S]*?isTerminalDflowSettlementStatus/,
  "admin DFlow market-init rows must reconcile as single-transaction sponsor rows",
);
assert.match(
  sponsorshipReconcile,
  /status:\s*failed \? "failed" : "confirmed"[\s\S]*?actualSponsorLamports:\s*sponsorCost\.toString\(\)[\s\S]*?error:\s*failed \? JSON\.stringify\(tx\.err\) : null/,
  "generic sponsorship reconciliation must account failed finalized transactions",
);

assert.match(
  adminAuth,
  /"sponsorship:write"/,
  "admin roles must include an explicit sponsorship write permission",
);
assert.match(
  adminRoute,
  /authAccessSponsorshipPolicyChanged[\s\S]*?adminHasPermission\(adminRole, "sponsorship:write"\)/,
  "auth_access sponsorship policy writes must require sponsorship permission",
);
assert.match(
  secretsConfig,
  /sponsorship:\s*\[[\s\S]*?"HUNCH_SOLANA_SPONSOR_SECRET_KEY"/,
  "sponsor secret key must live in the sponsorship secret bundle",
);
assert.doesNotMatch(
  rewardsSecretBundle,
  /HUNCH_SOLANA_SPONSOR_SECRET_KEY/,
  "rewards secret bundle must not include the sponsor secret key",
);
assert.match(
  prodCompose,
  /HUNCH_SECRET_BUNDLES_API:-[^}\n]*\/hunch\/prod\/sponsorship/,
  "API production secret bundles must include sponsorship secrets",
);
assert.doesNotMatch(
  prodCompose,
  /HUNCH_SECRET_BUNDLES_FINANCE_WORKER:-[^}\n]*\/hunch\/prod\/sponsorship/,
  "finance-worker production secret bundles must not include sponsorship secrets",
);

console.log("[dflow-sponsorship-hardening-tests] ok");
