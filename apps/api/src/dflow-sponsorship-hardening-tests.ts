#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  hasPositiveSponsorFeeLike,
  parseSolanaPublicKeyList,
} from "./services/solana-sponsorship-primitives.js";

function readApiSourceFile(...parts: string[]): string {
  return readFileSync(path.join(import.meta.dirname, ...parts), "utf8");
}

const dflowPrivate = readApiSourceFile("routes", "dflow-private.ts");
const dflowSchemas = readApiSourceFile("schemas", "dflow.ts");
const bridgeRoute = readApiSourceFile("routes", "bridge.ts");
const embeddedWalletsRoute = readApiSourceFile("routes", "embedded-wallets.ts");
const sponsorshipReconcile = readApiSourceFile(
  "services",
  "solana-sponsorship-reconcile.ts",
);
const kalshiExecutionReconcile = readApiSourceFile(
  "services",
  "kalshi-execution-reconcile.ts",
);
const apiEnv = readApiSourceFile("env.ts");
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
  /\/admin\/prediction-market-init[\s\S]*?allowLegacyFallback:\s*false/,
  "admin DFlow market init must reject legacy admin fallback",
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

assert.equal(
  hasPositiveSponsorFeeLike({
    tx: { kind: "solana", data: "tx" },
    estimation: { fees: { protocolFee: "1" } },
  }),
  true,
  "deBridge fee detection must reject nested positive provider fees",
);
assert.equal(
  hasPositiveSponsorFeeLike({
    tx: { kind: "solana", data: "tx" },
    affiliateFeeRecipient: "11111111111111111111111111111111",
  }),
  false,
  "deBridge fee detection must not reject fee recipient addresses",
);
assert.deepEqual(
  parseSolanaPublicKeyList([
    "11111111111111111111111111111111",
    "11111111111111111111111111111111",
  ]),
  ["11111111111111111111111111111111"],
  "deBridge allowlist parsing must validate and dedupe program IDs",
);
assert.throws(
  () => parseSolanaPublicKeyList(["not-a-program-id"]),
  /valid Solana address/,
  "deBridge allowlist parsing must reject invalid program IDs",
);
assert.match(
  bridgeRoute,
  /async function createDebridgeSolanaSponsorshipIntent[\s\S]*?hasPositiveSponsorFeeLike\(inputs\.payload\)/,
  "deBridge sponsorship intent creation must reject positive native/provider fees",
);
assert.match(
  bridgeRoute,
  /embeddedSolanaSponsorshipFlows\.debridge !== true/,
  "deBridge sponsorship intent creation must require the Access policy flow flag",
);
assert.match(
  bridgeRoute,
  /parseSolanaPublicKeyList\([\s\S]*?env\.debridgeSolanaAllowedProgramIds[\s\S]*?if \(!allowedProgramIds\.length\) return null;/,
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
  sponsorshipReconcile,
  /status = 'failed'[\s\S]*?actual_sponsor_lamports is null[\s\S]*?genericSponsorshipReconciliation/,
  "already-accounted generic failed sponsorship rows must not be reselected",
);
assert.match(
  sponsorshipReconcile,
  /status = 'intent_created'[\s\S]*?metadata[\s\S]*?txSignature[\s\S]*?submission,signature/,
  "generic intent_created sponsorship rows must reconcile only with durable signature metadata",
);
assert.match(
  apiEnv,
  /HUNCH_SOLANA_SPONSOR_RENT_RECLAIM_ENABLED[\s\S]*\?\?\s*false/,
  "Solana sponsorship rent reclaim must default off",
);
assert.match(
  kalshiExecutionReconcile,
  /env\.solanaSponsorRentReclaimEnabled[\s\S]*?reclaimSolanaSponsorshipRentAccounts/,
  "Kalshi reconcile must gate rent reclaim behind the explicit sponsorship reclaim flag",
);
assert.match(
  embeddedWalletsRoute,
  /sponsorship_ledger_not_durable/,
  "embedded Solana sponsored submit must return a distinct ledger durability error",
);
assert.match(
  embeddedWalletsRoute,
  /EmbeddedSolanaSponsorshipLedgerDurabilityError[\s\S]*?requestId[\s\S]*?signature/,
  "embedded Solana ledger durability errors must include request id and signature",
);
assert.match(
  embeddedWalletsRoute,
  /assertCachedEmbeddedSolanaSponsorPolicy\(requests\)/,
  "embedded Solana execute must re-check sponsorship policy for cached sponsor requests",
);
assert.match(
  embeddedWalletsRoute,
  /createEmbeddedSolanaSponsorshipIntent\(\{[\s\S]*?requireDurable:\s*requireDurableSponsorship/,
  "direct-transfer sponsorship intent creation must require durable Redis when policy requires it",
);
assert.match(
  dflowPrivate,
  /resolveDflowPredictionMarketInitCandidate[\s\S]*?Outcome mint maps to multiple Hunch Kalshi markets/,
  "admin DFlow market init must pre-validate unique Hunch Kalshi market mapping",
);
assert.match(
  dflowPrivate,
  /sponsorship_ledger_not_durable[\s\S]*?signature:\s*error\.signature/,
  "DFlow sponsored submit must surface post-broadcast ledger durability failures",
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
  adminRoute,
  /\/admin\/intel\/policies\/:key[\s\S]*?requiredAdminPermissions:\s*\[\][\s\S]*?sponsorshipPolicyChanged[\s\S]*?adminHasPermission\(adminRole, "sponsorship:write"\)[\s\S]*?adminHasPermission\(adminRole, "intel:write"\)/,
  "auth_access sponsorship policy writes must allow sponsorship:write without broadening normal intel policy writes",
);
assert.match(
  adminRoute,
  /authAccessSponsorshipPolicyChanged[\s\S]*?request\.adminActor\?\.kind === "legacy_user"/,
  "auth_access sponsorship policy writes must reject legacy admin fallback",
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
