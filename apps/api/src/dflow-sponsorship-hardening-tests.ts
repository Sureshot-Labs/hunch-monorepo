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

assert.match(
  dflowPrivate,
  /async function signAndBroadcastSponsoredDflowTransaction[\s\S]*?const sponsorConfig = await resolveDflowSponsorConfig\(\)/,
  "sponsored DFlow submit must re-check sponsor policy/config before signing",
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
  /const feeParams = dflowSponsoredOrder[\s\S]*?getDflowSponsoredFeeParams/,
  "sponsored DFlow orders must use backend-owned fee params",
);
assert.match(
  dflowPrivate,
  /maxSystemCreateLamports === "0"[\s\S]*?validation\?\.valid === true/,
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
  /async function createDebridgeSolanaSponsorshipIntent[\s\S]*?void inputs;\s*return null;/,
  "deBridge sponsorship intent creation must stay disabled",
);

console.log("[dflow-sponsorship-hardening-tests] ok");
