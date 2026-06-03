#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import { analyzeAuthAccessPolicyChange } from "./routes/admin.js";
import { validateEmbeddedSolanaSponsorshipIntentCandidate } from "./services/embedded-solana-sponsorship.js";
import {
  SOLANA_DFLOW_SPONSORSHIP_ALLOWED_PROGRAMS,
  SOLANA_SYSTEM_PROGRAM_ID,
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
const sponsorshipService = readApiSourceFile(
  "services",
  "embedded-solana-sponsorship.ts",
);
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
    estimation: { fees: { protocolFee: "0.1", serviceFee: "1e-9" } },
  }),
  true,
  "deBridge fee detection must reject decimal positive provider fees",
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

const baseAuthAccessPolicy = {
  state: "prompt",
  embeddedSolanaSponsorship: true,
  embeddedSolanaSponsorshipMode: "enforce",
  embeddedSolanaSponsorshipObserveCanSponsor: false,
  embeddedSolanaSponsorshipFlows: {
    dflow: true,
    across: false,
    directTransfer: true,
    debridge: false,
  },
  embeddedSolanaSponsorshipLimits: {
    dflow: {
      maxPerHour: 10,
      maxPerDay: 50,
      maxLamportsPerWalletPerDay: 10_000_000,
    },
    across: {
      maxPerHour: 5,
      maxPerDay: 20,
      maxLamportsPerWalletPerDay: 200_000,
    },
    directTransfer: {
      maxPerHour: 5,
      maxPerDay: 20,
      maxLamportsPerWalletPerDay: 150_000,
      minAmountRaw: "500000",
    },
    debridge: {
      maxPerHour: 3,
      maxPerDay: 10,
      maxLamportsPerWalletPerDay: 100_000,
    },
  },
};

const authAccessStateOnlyChange = analyzeAuthAccessPolicyChange(
  baseAuthAccessPolicy,
  { state: "required" },
);
assert.equal(
  authAccessStateOnlyChange.sponsorshipChanged,
  false,
  "auth_access state-only updates must not require sponsorship permission",
);
assert.equal(
  authAccessStateOnlyChange.nonSponsorshipChanged,
  true,
  "auth_access state-only updates must require intel permission",
);
assert.equal(
  authAccessStateOnlyChange.nextPolicy.embeddedSolanaSponsorship,
  true,
  "auth_access partial updates must preserve current sponsorship fields",
);

const authAccessSponsorshipOnlyChange = analyzeAuthAccessPolicyChange(
  baseAuthAccessPolicy,
  { embeddedSolanaSponsorshipFlows: { debridge: true } },
);
assert.equal(
  authAccessSponsorshipOnlyChange.sponsorshipChanged,
  true,
  "auth_access sponsorship flow updates must require sponsorship permission",
);
assert.equal(
  authAccessSponsorshipOnlyChange.nonSponsorshipChanged,
  false,
  "auth_access sponsorship-only updates must not require intel permission",
);

const authAccessObserveCanSponsorChange = analyzeAuthAccessPolicyChange(
  baseAuthAccessPolicy,
  { embeddedSolanaSponsorshipObserveCanSponsor: true },
);
assert.equal(
  authAccessObserveCanSponsorChange.sponsorshipChanged,
  true,
  "auth_access observe-can-sponsor updates must require sponsorship permission",
);
assert.equal(
  authAccessObserveCanSponsorChange.nonSponsorshipChanged,
  false,
  "auth_access observe-can-sponsor updates must not require intel permission",
);

const authAccessUnchangedSponsorshipPayload = analyzeAuthAccessPolicyChange(
  baseAuthAccessPolicy,
  { embeddedSolanaSponsorship: true },
);
assert.equal(
  authAccessUnchangedSponsorshipPayload.sponsorshipChanged,
  false,
  "auth_access unchanged explicit sponsorship fields must not require sponsorship permission",
);
assert.equal(
  authAccessUnchangedSponsorshipPayload.nonSponsorshipChanged,
  false,
  "auth_access unchanged explicit sponsorship fields must not require intel as a field change",
);

const authAccessMixedChange = analyzeAuthAccessPolicyChange(
  baseAuthAccessPolicy,
  {
    state: "required",
    embeddedSolanaSponsorshipMode: "observe",
  },
);
assert.equal(
  authAccessMixedChange.sponsorshipChanged,
  true,
  "auth_access mixed updates must require sponsorship permission",
);
assert.equal(
  authAccessMixedChange.nonSponsorshipChanged,
  true,
  "auth_access mixed updates must require intel permission",
);

function buildSolanaSponsorshipTestTransaction(inputs: {
  signer: Keypair;
  programId: string;
}): string {
  const instruction = new TransactionInstruction({
    programId: new PublicKey(inputs.programId),
    keys: [],
    data: Buffer.alloc(0),
  });
  const message = new TransactionMessage({
    payerKey: inputs.signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [instruction],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([inputs.signer]);
  return Buffer.from(tx.serialize()).toString("base64");
}

const debridgeSigner = Keypair.generate();
const debridgeOutOfAllowlistProgram = Keypair.generate().publicKey.toBase58();
const debridgeOutOfAllowlistTransaction =
  buildSolanaSponsorshipTestTransaction({
    signer: debridgeSigner,
    programId: debridgeOutOfAllowlistProgram,
  });
const debridgeNoAllowlist = validateEmbeddedSolanaSponsorshipIntentCandidate({
  flow: "debridge",
  userId: "user-debridge",
  signer: debridgeSigner.publicKey.toBase58(),
  transaction: debridgeOutOfAllowlistTransaction,
  metadata: {
    debridgeSponsorshipEligible: true,
    maxSystemCreateLamports: "0",
  },
});
assert.equal(
  debridgeNoAllowlist.ok,
  false,
  "deBridge sponsorship candidates must fail closed without metadata allowlist",
);
assert.ok(
  debridgeNoAllowlist.reasons.includes("debridge_program_allowlist_missing"),
  "deBridge sponsorship candidates must report missing allowlist",
);

const debridgeOutOfAllowlist =
  validateEmbeddedSolanaSponsorshipIntentCandidate({
    flow: "debridge",
    userId: "user-debridge",
    signer: debridgeSigner.publicKey.toBase58(),
    transaction: debridgeOutOfAllowlistTransaction,
    metadata: {
      debridgeSponsorshipEligible: true,
      allowedProgramIds: [SOLANA_SYSTEM_PROGRAM_ID],
      maxSystemCreateLamports: "0",
    },
  });
assert.equal(
  debridgeOutOfAllowlist.ok,
  false,
  "deBridge sponsorship candidates must reject programs outside metadata allowlist",
);
assert.ok(
  debridgeOutOfAllowlist.reasons.includes("unknown_program"),
  "deBridge sponsorship candidates must report out-of-allowlist programs",
);
assert.deepEqual(
  debridgeOutOfAllowlist.analysis.unknownProgramIds,
  [debridgeOutOfAllowlistProgram],
  "deBridge sponsorship candidates must surface the out-of-allowlist program id",
);

assert.ok(
  new Set<string>(SOLANA_DFLOW_SPONSORSHIP_ALLOWED_PROGRAMS).has(
    "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH",
  ),
  "DFlow sponsorship allowlist must include the DFlow program",
);
assert.match(
  sponsorshipService,
  /export function resolveEmbeddedSolanaActualSponsorshipDecision[\s\S]*?observe_mode_log_only[\s\S]*?actualSponsorAllowed:[\s\S]*?inputs\.mode === "enforce" \|\| inputs\.observeCanSponsor === true/,
  "shared Solana sponsorship policy must disable actual sponsorship in observe log-only mode",
);
assert.match(
  dflowPrivate,
  /resolveDflowActualSponsorshipDecision[\s\S]*?return resolveEmbeddedSolanaActualSponsorshipDecision\(\{[\s\S]*?flow:\s*"dflow"/,
  "DFlow sponsorship policy must use the shared actual sponsorship decision helper",
);
assert.match(
  embeddedWalletsRoute,
  /direct-transfer\/sponsorship-intent[\s\S]*?resolveEmbeddedSolanaActualSponsorshipDecision\(\{[\s\S]*?flow:\s*"directTransfer"[\s\S]*?const disabledReasons = \[\.\.\.sponsorshipDecision\.reasons\][\s\S]*?if \(disabledReasons\.length\)[\s\S]*?reserveEmbeddedSolanaSponsorshipBudget\(/,
  "direct-transfer sponsorship intent creation must return unavailable before budget reservation when actual sponsorship is disabled",
);
assert.match(
  bridgeRoute,
  /async function createDebridgeSolanaSponsorshipIntent[\s\S]*?hasPositiveSponsorFeeLike\(inputs\.payload\)/,
  "deBridge sponsorship intent creation must reject positive native/provider fees",
);
assert.match(
  bridgeRoute,
  /async function createDebridgeSolanaSponsorshipIntent[\s\S]*?resolveEmbeddedSolanaActualSponsorshipDecision\(\{[\s\S]*?flow:\s*"debridge"[\s\S]*?if \(!sponsorshipDecision\.actualSponsorAllowed\) \{[\s\S]*?return unavailable\(sponsorshipDecision\.reasons\);[\s\S]*?reserveEmbeddedSolanaSponsorshipBudget\(/,
  "deBridge sponsorship intent creation must return unavailable before budget reservation when actual sponsorship is disabled",
);
assert.match(
  bridgeRoute,
  /resolveEmbeddedSolanaActualSponsorshipDecision\(\{[\s\S]*?flow:\s*"across"[\s\S]*?hunchSponsorship\.reasons\.push\([\s\S]*?\.\.\.sponsorshipDecision\.reasons[\s\S]*?if \(sponsorshipDecision\.actualSponsorAllowed\)[\s\S]*?reserveEmbeddedSolanaSponsorshipBudget\(/,
  "Across sponsorship intent creation must keep budget reservation behind the actual sponsorship gate",
);
assert.match(
  bridgeRoute,
  /flowEnabled:[\s\S]*?embeddedSolanaSponsorshipFlows\.debridge ===[\s\S]*?true/,
  "deBridge sponsorship intent creation must require the Access policy flow flag",
);
assert.match(
  bridgeRoute,
  /parseSolanaPublicKeyList\([\s\S]*?env\.debridgeSolanaAllowedProgramIds[\s\S]*?if \(!allowedProgramIds\.length\)[\s\S]*?return unavailable\(\["missing_program_allowlist"\]\);/,
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
  bridgeRoute,
  /hunchSponsorship[\s\S]*?requested:\s*true[\s\S]*?available:\s*false[\s\S]*?reasons/,
  "Solana bridge orders must expose sponsorship availability and reasons",
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
  /markSubmittedSolanaSponsorshipRequestWithRetry[\s\S]*?attempt < 3/,
  "embedded Solana sponsored submits must retry post-submit ledger writes",
);
assert.match(
  embeddedWalletsRoute,
  /\/wallets\/embedded\/solana\/sponsorship-ledger\/repair[\s\S]*?repairSubmittedSolanaSponsorshipLedger/,
  "embedded Solana must expose an authenticated sponsorship ledger repair endpoint",
);
assert.match(
  embeddedWalletsRoute,
  /assertCachedEmbeddedSolanaSponsorPolicy\(\{[\s\S]*?requests,[\s\S]*?userId:\s*user\.id,[\s\S]*?signer:\s*context\.signer/,
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
  /analyzeAuthAccessPolicyChange[\s\S]*?sponsorshipPolicyChanged = change\.sponsorshipChanged[\s\S]*?isLegacyAdminActor[\s\S]*?adminHasPermission\(adminRole, "sponsorship:write"\)/,
  "auth_access sponsorship policy writes must require sponsorship permission for modern admin accounts",
);
assert.match(
  adminRoute,
  /\/admin\/intel\/policies\/:key[\s\S]*?requiredAdminPermissions:\s*\[\][\s\S]*?nonSponsorshipPolicyChanged = change\.nonSponsorshipChanged[\s\S]*?nonSponsorshipPolicyChanged[\s\S]*?adminHasPermission\(adminRole, "intel:write"\)/,
  "auth_access non-sponsorship policy writes must require intel permission",
);
assert.match(
  adminRoute,
  /analyzeAuthAccessPolicyChange[\s\S]*?nextPolicy[\s\S]*?payload:\s*parsed\.data/,
  "auth_access partial policy writes must analyze the merged effective payload but persist the submitted override",
);
assert.match(
  adminRoute,
  /const isLegacyAdminActor[\s\S]*?kind === "legacy_user"[\s\S]*?sponsorshipPolicyChanged[\s\S]*?!isLegacyAdminActor[\s\S]*?sponsorship:write/,
  "legacy isAdmin fallback must bypass role permissions after middleware verifies isAdmin",
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
