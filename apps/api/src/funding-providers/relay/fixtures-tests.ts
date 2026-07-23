import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

type JsonObject = Record<string, unknown>;

const fixtureDirectory = new URL("./fixtures/", import.meta.url);

function object(value: unknown, label: string): JsonObject {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  assert.ok(typeof value === "string", `${label} must be a string`);
  return value;
}

async function fixture(path: string): Promise<JsonObject> {
  const contents = await readFile(new URL(path, fixtureDirectory), "utf8");
  return object(JSON.parse(contents) as unknown, path);
}

const manifest = await fixture("manifest.json");
const manifestFiles = array(manifest.files, "manifest.files").map((value) =>
  string(value, "manifest file"),
);

{
  assert.equal(manifest.schemaVersion, 4);
  const capturePhases = object(
    manifest.capturePhases,
    "manifest.capturePhases",
  );
  const initialReadOnly = object(
    capturePhases.initialReadOnly,
    "manifest.capturePhases.initialReadOnly",
  );
  assert.equal(initialReadOnly.externalStateChanges, false);
  const authorizedQuoteOnly = object(
    capturePhases.authorizedQuoteOnly,
    "manifest.capturePhases.authorizedQuoteOnly",
  );
  assert.equal(authorizedQuoteOnly.externalStateChanges, true);
  assert.equal(authorizedQuoteOnly.quoteRequestsCreated, 6);
  assert.equal(authorizedQuoteOnly.depositAddressModeRequests, 0);
  const authorizedLiveRehearsal = object(
    capturePhases.authorizedLiveRehearsal,
    "manifest.capturePhases.authorizedLiveRehearsal",
  );
  assert.equal(authorizedLiveRehearsal.executedRelayRequests, 6);
  assert.equal(authorizedLiveRehearsal.transactionsBroadcast, 9);
  assert.equal(authorizedLiveRehearsal.successfulTransactionsObserved, 9);
  assert.equal(authorizedLiveRehearsal.destinationSettlementsObserved, 6);
  assert.equal(authorizedLiveRehearsal.depositAddressModeRequests, 0);
  const sharedSafety = object(
    capturePhases.sharedSafety,
    "manifest.capturePhases.sharedSafety",
  );
  for (const field of [
    "walletSecretPersisted",
    "relayApiCredentialPersisted",
    "rawProviderRequestReferencesPersisted",
    "rawTransactionHashesPersisted",
    "rawCalldataPersisted",
  ]) {
    assert.equal(sharedSafety[field], false, `${field} must remain false`);
  }

  const rootJson = (await readdir(fixtureDirectory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        entry.name !== "manifest.json",
    )
    .map((entry) => entry.name);
  const negativeJson = (
    await readdir(new URL("negative/", fixtureDirectory), {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => `negative/${entry.name}`);
  assert.deepEqual(
    [...rootJson, ...negativeJson].sort(),
    [...manifestFiles].sort(),
    "manifest must enumerate every JSON fixture",
  );

  for (const path of manifestFiles) {
    const contents = await readFile(new URL(path, fixtureDirectory), "utf8");
    assert.doesNotMatch(
      contents,
      /"(?:apiKey|privateKey|secret|mnemonic|seedPhrase)"\s*:/i,
      `${path} contains a secret-shaped field`,
    );
    assert.doesNotMatch(
      contents,
      /"X-Signature-SHA256"\s*:\s*"(?!sha256:)/,
      `${path} contains a non-redacted webhook signature`,
    );
    JSON.parse(contents);
  }

  for (const path of manifestFiles.filter((path) => path.includes("live"))) {
    const contents = await readFile(new URL(path, fixtureDirectory), "utf8");
    assert.doesNotMatch(
      contents,
      /"requestId"\s*:/,
      `${path} must not persist a raw provider request ID`,
    );
  }
}

{
  const rehearsal = await fixture(
    "rehearsal-evm-roundtrip.live-sanitized.json",
  );
  const metadata = object(rehearsal._fixture, "rehearsal._fixture");
  assert.equal(metadata.liveRequestsExecuted, 3);
  assert.equal(metadata.walletTransactionsBroadcast, 5);
  const security = object(rehearsal.security, "rehearsal.security");
  assert.equal(security.useDepositAddressRequested, false);
  assert.equal(security.walletSecretPersistedInFixture, false);
  assert.equal(security.rawTransactionHashesPersisted, false);
  const routes = array(rehearsal.routes, "rehearsal.routes").map(
    (value, index) => object(value, `rehearsal.routes[${index}]`),
  );
  assert.deepEqual(
    routes.map((route) => route.scenarioId),
    [
      "polygon-pol-to-base-eth",
      "polygon-pusd-to-base-usdc",
      "base-usdc-to-polygon-pusd",
    ],
  );
  assert.deepEqual(
    routes.map((route) => route.routeShape),
    [
      "relay-router-v3-native",
      "relay-approval-proxy-v3-erc20",
      "relay-depository-v2-erc20",
    ],
  );
  for (const route of routes) {
    const output = object(route.output, "rehearsal.route.output");
    assert.ok(
      BigInt(string(output.actualRaw, "rehearsal output actual")) >=
        BigInt(
          string(
            output.authorizedMinimumRaw,
            "rehearsal output authorized minimum",
          ),
        ),
    );
    const relay = object(route.relay, "rehearsal.route.relay");
    assert.equal(relay.status, "success");
    assert.equal(relay.refunds, 0);
    assert.equal(relay.fills, 1);
    for (const transaction of array(
      route.sourceTransactions,
      "rehearsal.route.sourceTransactions",
    )) {
      assert.equal(object(transaction, "rehearsal transaction").status, 1);
    }
  }
  const budget = object(
    rehearsal.budgetReconciliation,
    "rehearsal.budgetReconciliation",
  );
  assert.equal(budget.withinAuthorizedBudget, true);
  const allowances = object(
    budget.remainingAllowances,
    "rehearsal.remainingAllowances",
  );
  assert.equal(allowances.polygonPusdToRelayV3Raw, "0");
  assert.equal(allowances.baseUsdcToRelayV2Raw, "0");
}

{
  const rehearsal = await fixture(
    "rehearsal-solana-roundtrip.live-sanitized.json",
  );
  const metadata = object(rehearsal._fixture, "solanaRehearsal._fixture");
  assert.equal(metadata.liveRequestsExecuted, 3);
  assert.equal(metadata.walletTransactionsBroadcast, 4);
  const security = object(rehearsal.security, "solanaRehearsal.security");
  assert.equal(security.useDepositAddressRequested, false);
  assert.equal(security.walletSecretPersistedInFixture, false);
  assert.equal(security.rawTransactionHashesPersisted, false);
  assert.equal(security.rawSolanaInstructionDataPersisted, false);
  const policy = object(rehearsal.solanaPolicy, "solanaRehearsal.policy");
  assert.equal(policy.instructionEncoding, "hex-without-prefix");
  assert.equal(policy.instructionDataBytes, 48);
  assert.equal(policy.instructionKeyCount, 10);
  assert.deepEqual(policy.signerKeyIndexes, [1]);
  assert.deepEqual(policy.writableKeyIndexes, [1, 5, 6]);
  assert.equal(policy.sourceAtaDerivedAndMatched, true);
  const routes = array(rehearsal.routes, "solanaRehearsal.routes").map(
    (value, index) => object(value, `solanaRehearsal.routes[${index}]`),
  );
  assert.deepEqual(
    routes.map((route) => route.scenarioId),
    [
      "polygon-pol-to-solana-sol",
      "polygon-pusd-to-solana-usdc",
      "solana-usdc-to-polygon-pusd",
    ],
  );
  for (const route of routes) {
    const output = object(route.output, "solanaRehearsal.route.output");
    assert.ok(
      BigInt(string(output.actualRaw, "solana rehearsal output actual")) >=
        BigInt(
          string(
            output.authorizedMinimumRaw,
            "solana rehearsal output authorized minimum",
          ),
        ),
    );
    assert.equal(
      object(route.relay, "solanaRehearsal.route.relay").status,
      "success",
    );
  }
  const returnRoute = object(routes[2], "solanaRehearsal.routes[2]");
  const returnPreflight = object(
    returnRoute.preflight,
    "solanaRehearsal.return.preflight",
  );
  assert.equal(returnPreflight.unsignedSimulationPassed, true);
  assert.equal(returnPreflight.signedSimulationPassed, true);
  assert.equal(returnPreflight.estimatedNetworkFeeLamports, "5000");
  const returnSource = object(
    array(
      returnRoute.sourceTransactions,
      "solanaRehearsal.return.sourceTransactions",
    )[0],
    "solanaRehearsal.return.sourceTransaction",
  );
  assert.equal(returnSource.status, "finalized");
  assert.equal(returnSource.onchainError, null);
  const budget = object(
    rehearsal.budgetReconciliation,
    "solanaRehearsal.budgetReconciliation",
  );
  assert.equal(budget.withinAuthorizedBudget, true);
  const finalBalances = object(
    budget.final,
    "solanaRehearsal.budgetReconciliation.final",
  );
  assert.equal(finalBalances.solanaSolLamports, "1509964");
  assert.equal(finalBalances.solanaUsdcRaw, "34047");
  const allowances = object(
    budget.remainingAllowances,
    "solanaRehearsal.remainingAllowances",
  );
  assert.equal(allowances.polygonPusdToRelayV3Raw, "0");
  assert.equal(allowances.baseUsdcToRelayV2Raw, "0");
}

{
  const baseUsdc = await fixture(
    "quote-v2-base-usdc-polygon-usdc.live-sanitized.json",
  );
  const baseSafety = object(baseUsdc.safety, "baseUsdc.safety");
  assert.equal(baseSafety.useDepositAddressRequested, false);
  assert.equal(baseSafety.signatureCreated, false);
  assert.equal(baseSafety.transactionBroadcast, false);
  assert.equal(baseSafety.fundsSpentRaw, "0");
  const baseQuote = object(baseUsdc.quote, "baseUsdc.quote");
  assert.equal(baseQuote.httpStatus, 200);
  const baseSteps = array(baseQuote.steps, "baseUsdc.quote.steps").map(
    (value, index) => object(value, `baseUsdc.quote.steps[${index}]`),
  );
  assert.deepEqual(
    baseSteps.map((step) => step.id),
    ["approve", "deposit"],
  );
  assert.equal(baseSteps[0]?.calldataSelector, "0x095ea7b3");
  assert.equal(baseSteps[1]?.calldataSelector, "0xe8017952");
  const depositAddressField = object(
    baseSteps[1]?.depositAddressField,
    "baseUsdc.depositAddressField",
  );
  assert.equal(depositAddressField.empty, true);
  assert.equal(depositAddressField.addressAllocated, false);
  const baseDetails = object(baseQuote.details, "baseUsdc.quote.details");
  assert.ok(
    BigInt(string(baseDetails.minimumOutputAmount, "base minimum output")) <=
      BigInt(string(baseDetails.expectedOutputAmount, "base expected output")),
  );

  const solanaUsdc = await fixture(
    "quote-v2-solana-usdc-polygon-usdc.live-sanitized.json",
  );
  assert.equal(
    object(solanaUsdc.request, "solanaUsdc.request").originChainId,
    792703809,
  );
  const solanaQuote = object(solanaUsdc.quote, "solanaUsdc.quote");
  assert.equal(solanaQuote.httpStatus, 200);
  const solanaStep = object(
    array(solanaQuote.steps, "solanaUsdc.quote.steps")[0],
    "solanaUsdc.quote.steps[0]",
  );
  const instruction = object(
    array(solanaStep.instructions, "solanaStep.instructions")[0],
    "solanaStep.instructions[0]",
  );
  assert.equal(
    instruction.programId,
    "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2",
  );
  assert.equal(instruction.keyCount, 10);
  assert.equal(instruction.signerKeyCount, 1);
  assert.equal(instruction.writableKeyCount, 3);
  assert.equal(
    object(solanaStep.depositAddressField, "solanaStep.depositAddressField")
      .empty,
    true,
  );

  const directPusd = await fixture(
    "quote-v2-base-usdc-polygon-pusd.live-sanitized.json",
  );
  const pusdQuote = object(directPusd.quote, "directPusd.quote");
  assert.equal(pusdQuote.httpStatus, 200);
  const pusdDetails = object(pusdQuote.details, "directPusd.quote.details");
  const outputCurrency = object(
    pusdDetails.outputCurrency,
    "directPusd.quote.details.outputCurrency",
  );
  assert.equal(
    outputCurrency.address,
    "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
  );
  assert.equal(outputCurrency.symbol, "pUSD");

  for (const liveQuote of [baseUsdc, solanaUsdc, directPusd]) {
    const reads = object(liveQuote.immediateReads, "liveQuote.immediateReads");
    assert.equal(
      object(reads.statusV3, "liveQuote.statusV3").status,
      "waiting",
    );
    const requestsRead = object(
      reads.requestsV3ByExactIdWithChildren,
      "liveQuote.requestsV3",
    );
    assert.deepEqual(
      object(requestsRead.response, "liveQuote.requestsV3.response").requests,
      [],
    );
  }
}

{
  const contract = await fixture("openapi-contract.json");
  const document = object(contract.document, "openapi.document");
  assert.equal(document.openapi, "3.0.3");
  assert.equal(
    document.sha256,
    "50033524cd8165c6b265a7c59222b1d940356ed35b69d135495af70fa465fa74",
  );

  const operations = object(contract.operations, "openapi.operations");
  const quote = object(operations.quoteV2, "openapi.quoteV2");
  assert.equal(quote.path, "/quote/v2");
  assert.deepEqual(quote.requestRequired, [
    "user",
    "originChainId",
    "destinationChainId",
    "originCurrency",
    "destinationCurrency",
    "amount",
    "tradeType",
  ]);
  assert.deepEqual(quote.tradeTypeEnum, [
    "EXACT_INPUT",
    "EXACT_OUTPUT",
    "EXPECTED_OUTPUT",
  ]);

  const status = object(operations.statusV3, "openapi.statusV3");
  assert.equal(status.path, "/intents/status/v3");
  assert.equal(
    status.requestIdRequiredByOpenApi,
    false,
    "pin the surprising optional requestId contract",
  );
  const statusEnum = array(status.statusEnum, "openapi.statusEnum");
  assert.ok(!statusEnum.includes("unknown"));
  assert.ok(!statusEnum.includes("delayed"));

  const requests = object(operations.requestsV3, "openapi.requestsV3");
  assert.equal(requests.captureCalled, false);
  assert.equal(requests.supportsExactIdFilter, true);
  assert.equal(requests.includeChildRequestsRequiresId, true);
}

{
  const chains = await fixture("chains-hunch-assets.live.json");
  const mapping = object(chains.chainIdMapping, "chains.chainIdMapping");
  assert.equal(mapping.hunchSolana, 7565164);
  assert.equal(mapping.relaySolana, 792703809);
  assert.notEqual(mapping.hunchSolana, mapping.relaySolana);

  const assets = array(chains.assets, "chains.assets").map((value, index) =>
    object(value, `chains.assets[${index}]`),
  );
  assert.deepEqual(
    assets.map((asset) => asset.routeKey),
    [
      "polygon-usdce",
      "polygon-usdc-native",
      "polygon-pusd",
      "base-usdc",
      "solana-usdc",
    ],
  );
  for (const asset of assets) {
    assert.equal(asset.depositEnabled, true);
    assert.equal(asset.chainDisabled, false);
  }
  const pusd = assets.find((asset) => asset.routeKey === "polygon-pusd");
  assert.ok(pusd);
  assert.equal(pusd.catalogMatch, null);
  assert.equal(pusd.conclusion, "unproven-not-unsupported");
  const solana = assets.find((asset) => asset.routeKey === "solana-usdc");
  assert.ok(solana);
  assert.equal(solana.chainId, 792703809);
  assert.equal(solana.address, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
}

{
  const walletQuote = await fixture("quote-v2-wallet.docs-sanitized.json");
  const metadata = object(walletQuote._fixture, "walletQuote._fixture");
  assert.equal(metadata.liveRequestCreated, false);
  const request = object(walletQuote.request, "walletQuote.request");
  assert.match(string(request.amount, "walletQuote.request.amount"), /^\d+$/);
  assert.equal(request.tradeType, "EXACT_INPUT");
  const response = object(walletQuote.response, "walletQuote.response");
  const details = object(response.details, "walletQuote.response.details");
  const currencyOut = object(details.currencyOut, "walletQuote.currencyOut");
  assert.ok(
    BigInt(string(currencyOut.minimumAmount, "currencyOut.minimumAmount")) <=
      BigInt(string(currencyOut.amount, "currencyOut.amount")),
  );
  const steps = array(response.steps, "walletQuote.response.steps");
  assert.equal(
    object(steps[0], "walletQuote.response.steps[0]").kind,
    "transaction",
  );
}

{
  const strict = await fixture("deposit-address-strict.docs-sanitized.json");
  const strictRequest = object(strict.request, "strict.request");
  assert.equal(
    object(strict._fixture, "strict._fixture").liveRequestCreated,
    false,
  );
  assert.equal(strictRequest.useDepositAddress, true);
  assert.equal(strictRequest.strict, true);
  assert.equal(strictRequest.tradeType, "EXACT_INPUT");
  assert.match(
    string(strictRequest.refundTo, "strict.request.refundTo"),
    /^0x[0-9a-f]{40}$/i,
  );
  const strictSemantics = object(
    strict.documentedSemantics,
    "strict.documentedSemantics",
  );
  assert.equal(strictSemantics.singleUse, true);
  assert.equal(strictSemantics.underpayment, "fail-and-refund");
  assert.equal(strictSemantics.overpayment, "fill-quoted-and-refund-excess");

  const open = await fixture("deposit-address-open.docs-sanitized.json");
  const openRequest = object(open.request, "open.request");
  assert.equal(
    object(open._fixture, "open._fixture").liveRequestCreated,
    false,
  );
  assert.equal(openRequest.useDepositAddress, true);
  assert.notEqual(openRequest.strict, true);
  assert.equal(openRequest.tradeType, "EXACT_INPUT");
  assert.equal(
    object(open._fixture, "open._fixture").hunchInitialRolloutPolicy,
    "reject",
  );
}

{
  const success = await fixture("status-success.live-sanitized.json");
  const successResponse = object(success.response, "statusSuccess.response");
  assert.equal(successResponse.status, "success");
  assert.equal(successResponse.destinationChainId, 792703809);
  assert.match(
    string(
      array(successResponse.txHashes, "statusSuccess.txHashes")[0],
      "statusSuccess.txHashes[0]",
    ),
    /^sha256:/,
  );

  const unknown = await fixture("status-unknown.live-sanitized.json");
  assert.equal(
    object(unknown.response, "statusUnknown.response").status,
    "unknown",
  );
  assert.equal(
    array(
      object(unknown._fixture, "statusUnknown._fixture").requestFingerprints,
      "statusUnknown.requestFingerprints",
    ).length,
    2,
  );

  const lifecycle = await fixture("status-lifecycle.docs-synthetic.json");
  const cases = array(lifecycle.cases, "statusLifecycle.cases").map(
    (value, index) => object(value, `statusLifecycle.cases[${index}]`),
  );
  for (const rawStatus of ["delayed", "unknown", "refunded"]) {
    const statusCase = cases.find(
      (candidate) => candidate.rawStatus === rawStatus,
    );
    assert.ok(statusCase, `missing drift fixture for ${rawStatus}`);
    assert.equal(statusCase.terminal, false);
    assert.equal(statusCase.action, "preserve-raw-and-reconcile");
  }
}

{
  const webhook = await fixture("webhook-status-updated.docs-sanitized.json");
  const payload = object(webhook.payload, "webhook.payload");
  assert.equal(payload.event, "request.status.updated");
  const data = object(payload.data, "webhook.payload.data");
  assert.equal(data.status, "refund");
  assert.equal(
    object(data.depositAddress, "webhook.depositAddress").depositAddressType,
    "open",
  );
  const verification = object(webhook.verification, "webhook.verification");
  assert.equal(verification.algorithm, "HMAC-SHA256");
  assert.equal(verification.signedMessage, "${timestamp}.${rawBody}");
  assert.equal(verification.comparison, "constant-time");
  assert.equal(
    object(webhook.delivery, "webhook.delivery").directTerminalMutationAllowed,
    false,
  );
}

{
  const strictMissingRefund = await fixture(
    "negative/deposit-address-strict-missing-refund-to.json",
  );
  const strictMissingRequest = object(
    strictMissingRefund.request,
    "strictMissingRefund.request",
  );
  assert.equal(strictMissingRequest.strict, true);
  assert.equal(strictMissingRequest.refundTo, undefined);
  assert.equal(
    object(strictMissingRefund.expected, "strictMissingRefund.expected")
      .providerCallAllowed,
    false,
  );

  const openExactOutput = await fixture(
    "negative/deposit-address-open-exact-output.json",
  );
  const openExactRequest = object(
    openExactOutput.request,
    "openExactOutput.request",
  );
  assert.equal(openExactRequest.tradeType, "EXACT_OUTPUT");
  assert.notEqual(openExactRequest.strict, true);
  assert.equal(
    object(openExactOutput.expected, "openExactOutput.expected")
      .providerCallAllowed,
    false,
  );

  const disabledCapabilities = await fixture(
    "negative/quote-disabled-capabilities.json",
  );
  const rejectedFields = array(
    object(disabledCapabilities.expected, "disabledCapabilities.expected")
      .rejectedFields,
    "disabledCapabilities.rejectedFields",
  );
  assert.deepEqual(rejectedFields, [
    "topupGas",
    "subsidizeFees",
    "depositFeePayer",
    "authorizationList",
    "txs",
  ]);
  assert.equal(
    object(disabledCapabilities.expected, "disabledCapabilities.expected")
      .providerCallAllowed,
    false,
  );

  const unsafeRefund = await fixture(
    "negative/deposit-address-unsafe-refund-location.json",
  );
  assert.equal(
    object(unsafeRefund.ownershipEvidence, "unsafeRefund.ownershipEvidence")
      .refundToUserOwned,
    "unknown",
  );
  assert.equal(
    object(unsafeRefund.expected, "unsafeRefund.expected").providerCallAllowed,
    false,
  );

  for (const path of [
    "negative/status-delayed-docs-drift.json",
    "negative/status-unknown-runtime-drift.json",
  ]) {
    const drift = await fixture(path);
    const expected = object(drift.expected, `${path}.expected`);
    assert.equal(expected.terminal, false);
    assert.equal(expected.rawStatusPreserved, true);
    assert.equal(expected.normalizedAction, "reconcile");
  }
}

console.log(
  "[relay-fixtures] provenance, sanitization, mappings, cross-field rules, and drift fixtures ok",
);
