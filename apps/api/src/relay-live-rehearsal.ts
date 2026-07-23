#!/usr/bin/env tsx

import { config } from "dotenv";
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  getAddress,
  keccak256,
} from "ethers";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  RELAY_APPROVAL_PROXY_V3,
  RELAY_DEPOSITORY_V2,
  RELAY_ROUTER_V3,
  SOLANA_NATIVE,
  SOLANA_USDC,
  type RelayRehearsalScenario,
  type RelayRehearsalScenarioId,
  type ValidatedRelayAction,
  relayRehearsalScenarios,
  validateRelayRehearsalQuote,
} from "./funding-providers/relay/rehearsal.js";

process.umask(0o077);
config({ path: resolve(import.meta.dirname, "../../../.env"), override: true });

const walletPath = resolve(
  import.meta.dirname,
  "../../../untracked/relay-rehearsal-evm-wallet.json",
);
const solanaWalletPath = resolve(
  import.meta.dirname,
  "../../../untracked/relay-rehearsal-solana-wallet.json",
);

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is required`);
  return value;
}
const runsDir = resolve(
  import.meta.dirname,
  "../../../untracked/relay-rehearsal-runs",
);
const relayBaseUrl = "https://api.relay.link";
const maxFeePerGasHardCap = 800_000_000_000n;
const erc20Interface = new Interface([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

type CliOptions = {
  amountRaw: bigint;
  confirm?: string;
  live: boolean;
  maxGasRaw: bigint;
  minimumOutputRaw: bigint;
  scenario: RelayRehearsalScenario;
};

type WalletFile = {
  address: string;
  privateKey: string;
};

type SolanaWalletFile = {
  address: string;
};

type TxEvidence = {
  blockNumber: number;
  blockTimestamp: string;
  broadcastAt: string;
  gasCostRaw: string;
  gasUsed: string;
  receiptLatencyMs: number;
  receiptObservedAt: string;
  status: number | null;
  stepId: "approve" | "deposit";
  txFingerprint: string;
};

type QuoteResult = {
  body: unknown;
  completedAt: string;
  latencyMs: number;
  startedAt: string;
};

type RunReport = {
  schemaVersion: 1;
  scenarioId: RelayRehearsalScenarioId;
  mode: "preflight" | "live";
  startedAt: string;
  completedAt?: string;
  sourceAsset: string;
  destinationAsset: string;
  amountRaw: string;
  minimumOutputFloorRaw: string;
  maxGasRaw: string;
  signerMode: "dedicated-burner";
  burnerFingerprint: string;
  recipientFingerprint?: string;
  sourceBalanceBeforeRaw?: string;
  sourceBalanceAfterRaw?: string;
  destinationBalanceBeforeRaw?: string;
  destinationBalanceAfterRaw?: string;
  destinationDeltaRaw?: string;
  quoteExpectedOutputRaw?: string;
  quoteMinimumOutputRaw?: string;
  quoteFingerprint?: string;
  requestFingerprint?: string;
  routeShape?: string;
  actionChecks?: {
    actionCount: number;
    contractCodeHashes: Record<string, string>;
    gasWorstCaseRaw: string;
    simulations: Array<{
      estimatedGas?: string;
      result: "passed" | "deferred-until-approval";
      stepId: string;
    }>;
  };
  confirmation?: string;
  broadcastAttempted: boolean;
  broadcastFingerprints: string[];
  transactions: TxEvidence[];
  relayStatus?: string;
  relayStatusHistory?: string[];
  timings: {
    destinationObservedAt?: string;
    depositBroadcastToDestinationObservedMs?: number;
    depositReceiptToDestinationObservedMs?: number;
    quoteLatenciesMs: number[];
    relayTerminalObservedAt?: string;
    runDurationMs?: number;
  };
  terminalResult:
    | "preflight_only"
    | "broadcasting"
    | "destination_observed"
    | "relay_terminal_without_destination"
    | "reconcile_required"
    | "failed_before_broadcast";
  error?: string;
};

function parseUnsigned(value: string | undefined, flag: string): bigint {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${flag} requires an unsigned integer`);
  }
  return BigInt(value);
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function parseArgs(args: string[]): CliOptions {
  const scenarioId = getArg(args, "--scenario");
  if (!scenarioId || !(scenarioId in relayRehearsalScenarios)) {
    throw new Error(
      `--scenario must be one of ${Object.keys(relayRehearsalScenarios).join(", ")}`,
    );
  }
  return {
    scenario: relayRehearsalScenarios[scenarioId as RelayRehearsalScenarioId],
    amountRaw: parseUnsigned(getArg(args, "--amount-raw"), "--amount-raw"),
    minimumOutputRaw: parseUnsigned(
      getArg(args, "--minimum-output-raw"),
      "--minimum-output-raw",
    ),
    maxGasRaw: parseUnsigned(getArg(args, "--max-gas-raw"), "--max-gas-raw"),
    live: args.includes("--live"),
    confirm: getArg(args, "--confirm"),
  };
}

function fingerprint(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function stableFingerprint(value: unknown): string {
  return fingerprint(JSON.stringify(value));
}

function confirmation(options: CliOptions): string {
  return [
    "LIVE",
    options.scenario.id,
    `spend=${options.amountRaw}`,
    `minOut=${options.minimumOutputRaw}`,
    `gas=${options.maxGasRaw}`,
    "signer=dedicated-burner",
  ].join(":");
}

function assertHardBudgets(options: CliOptions): void {
  const limits: Record<RelayRehearsalScenarioId, bigint> = {
    "polygon-pol-to-base-eth": 10_000_000_000_000_000_000n,
    "polygon-pusd-to-base-usdc": 3_000_000n,
    "base-usdc-to-polygon-pusd": 1_000_000n,
    "polygon-pol-to-solana-sol": 3_000_000_000_000_000_000n,
    "polygon-pusd-to-solana-usdc": 1_000_000n,
  };
  if (
    options.amountRaw <= 0n ||
    options.amountRaw > limits[options.scenario.id]
  ) {
    throw new Error("requested amount exceeds the scenario hard budget");
  }
  if (
    options.maxGasRaw <= 0n ||
    options.maxGasRaw > 3_000_000_000_000_000_000n
  ) {
    throw new Error("max gas exceeds the 3-native-unit rehearsal hard cap");
  }
}

function providerFor(chainId: number): JsonRpcProvider {
  const envName =
    chainId === 137
      ? "POLYGON_RPC_URL"
      : chainId === 8453
        ? "BASE_RPC_URL"
        : undefined;
  if (!envName) throw new Error(`unsupported chain ${chainId}`);
  const rpcUrl = process.env[envName]?.trim();
  if (!rpcUrl) throw new Error(`${envName} is missing`);
  if (!new URL(rpcUrl).hostname.endsWith("alchemy.com")) {
    throw new Error(`${envName} must point to an Alchemy RPC`);
  }
  return new JsonRpcProvider(rpcUrl, chainId, {
    batchMaxCount: 1,
    staticNetwork: true,
  });
}

function solanaConnection(): Connection {
  const rpcUrl = (
    process.env.SOLANA_RPC_URLS ??
    process.env.SOLANA_RPC_URL ??
    ""
  )
    .split(",")[0]
    ?.trim();
  if (!rpcUrl) throw new Error("SOLANA_RPC_URL is missing");
  if (!new URL(rpcUrl).hostname.endsWith("alchemy.com")) {
    throw new Error("SOLANA_RPC_URL must point to an Alchemy RPC");
  }
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 120_000,
  });
}

async function quoteRelay(input: {
  amount: bigint;
  apiKey: string;
  recipient: string;
  scenario: RelayRehearsalScenario;
  user: string;
}): Promise<QuoteResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const response = await fetch(`${relayBaseUrl}/quote/v2`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": input.apiKey,
    },
    body: JSON.stringify({
      user: input.user,
      recipient: input.recipient,
      originChainId: input.scenario.originChainId,
      destinationChainId: input.scenario.destinationChainId,
      originCurrency: input.scenario.originCurrency,
      destinationCurrency: input.scenario.destinationCurrency,
      amount: input.amount.toString(),
      tradeType: "EXACT_INPUT",
    }),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Relay quote returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(
      `Relay quote failed HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  const completedAtMs = Date.now();
  return {
    body,
    startedAt,
    completedAt: new Date(completedAtMs).toISOString(),
    latencyMs: completedAtMs - startedAtMs,
  };
}

async function solanaAssetBalance(
  connection: Connection,
  currency: string,
  owner: string,
): Promise<bigint> {
  const ownerKey = new PublicKey(owner);
  if (currency === SOLANA_NATIVE) {
    return BigInt(await connection.getBalance(ownerKey, "confirmed"));
  }
  if (currency !== SOLANA_USDC) {
    throw new Error("unsupported Solana rehearsal currency");
  }
  const tokenAccount = getAssociatedTokenAddressSync(
    new PublicKey(currency),
    ownerKey,
  );
  const info = await connection.getAccountInfo(tokenAccount, "confirmed");
  if (!info) return 0n;
  const balance = await connection.getTokenAccountBalance(
    tokenAccount,
    "confirmed",
  );
  return BigInt(balance.value.amount);
}

async function assetBalance(
  provider: JsonRpcProvider,
  currency: string,
  owner: string,
): Promise<bigint> {
  if (currency.toLowerCase() === ZeroAddress.toLowerCase()) {
    return provider.getBalance(owner);
  }
  const token = new Contract(currency, erc20Interface, provider);
  return token.balanceOf(owner) as Promise<bigint>;
}

async function allowance(
  provider: JsonRpcProvider,
  currency: string,
  owner: string,
): Promise<bigint> {
  if (currency.toLowerCase() === ZeroAddress.toLowerCase()) return 0n;
  const token = new Contract(currency, erc20Interface, provider);
  return token.allowance(owner, RELAY_APPROVAL_PROXY_V3) as Promise<bigint>;
}

function txRequest(action: ValidatedRelayAction) {
  return {
    type: 2,
    chainId: action.chainId,
    from: action.from,
    to: action.to,
    data: action.data,
    value: action.value,
    gasLimit: action.gasLimit,
    maxFeePerGas: action.maxFeePerGas,
    maxPriorityFeePerGas: action.maxPriorityFeePerGas,
  } as const;
}

function validateGas(
  actions: ValidatedRelayAction[],
  maxGasRaw: bigint,
): bigint {
  let worstCase = 0n;
  for (const action of actions) {
    if (
      action.maxFeePerGas <= 0n ||
      action.maxFeePerGas > maxFeePerGasHardCap ||
      action.maxPriorityFeePerGas > action.maxFeePerGas
    ) {
      throw new Error(`${action.stepId} fee fields outside policy`);
    }
    if (action.gasLimit <= 0n || action.gasLimit > 3_000_000n) {
      throw new Error(`${action.stepId} gas limit outside policy`);
    }
    worstCase += action.gasLimit * action.maxFeePerGas;
  }
  if (worstCase > maxGasRaw) {
    throw new Error(
      `quote worst-case gas ${worstCase} exceeds authorized ${maxGasRaw}`,
    );
  }
  return worstCase;
}

async function verifyContractCode(
  provider: JsonRpcProvider,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    [RELAY_ROUTER_V3, RELAY_APPROVAL_PROXY_V3, RELAY_DEPOSITORY_V2].map(
      async (target) => {
        const code = await provider.getCode(target);
        if (code === "0x")
          throw new Error(`Relay contract has no code: ${target}`);
        return [fingerprint(target), keccak256(code)] as const;
      },
    ),
  );
  return Object.fromEntries(entries);
}

async function simulateActions(input: {
  actions: ValidatedRelayAction[];
  currentAllowance: bigint;
  provider: JsonRpcProvider;
}): Promise<NonNullable<RunReport["actionChecks"]>["simulations"]> {
  const simulations: NonNullable<RunReport["actionChecks"]>["simulations"] = [];
  for (const action of input.actions) {
    if (
      action.stepId === "deposit" &&
      input.actions.some((candidate) => candidate.stepId === "approve") &&
      input.currentAllowance === 0n
    ) {
      simulations.push({
        stepId: action.stepId,
        result: "deferred-until-approval",
      });
      continue;
    }
    const request = txRequest(action);
    const estimatedGas = await input.provider.estimateGas(request);
    if (estimatedGas > action.gasLimit) {
      throw new Error(
        `${action.stepId} estimate ${estimatedGas} exceeds quote gas ${action.gasLimit}`,
      );
    }
    simulations.push({
      stepId: action.stepId,
      result: "passed",
      estimatedGas: estimatedGas.toString(),
    });
  }
  return simulations;
}

async function writeReport(path: string, report: RunReport): Promise<void> {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

async function fetchRelayStatus(input: {
  apiKey: string;
  requestId: string;
}): Promise<string> {
  const url = new URL("/intents/status/v3", relayBaseUrl);
  url.searchParams.set("requestId", input.requestId);
  const response = await fetch(url, {
    headers: { "x-api-key": input.apiKey },
  });
  const body = (await response.json()) as { status?: unknown };
  if (!response.ok || typeof body.status !== "string") {
    throw new Error(`Relay status failed HTTP ${response.status}`);
  }
  return body.status;
}

async function sendAction(input: {
  action: ValidatedRelayAction;
  onBroadcast: (txFingerprint: string) => Promise<void>;
  provider: JsonRpcProvider;
  signer: Wallet;
}): Promise<TxEvidence> {
  const pendingNonce = await input.provider.getTransactionCount(
    input.signer.address,
    "pending",
  );
  const latestNonce = await input.provider.getTransactionCount(
    input.signer.address,
    "latest",
  );
  if (pendingNonce !== latestNonce) {
    throw new Error("burner has a pending nonce; refusing broadcast");
  }
  const request = txRequest(input.action);
  const estimatedGas = await input.provider.estimateGas(request);
  if (estimatedGas > input.action.gasLimit) {
    throw new Error(`${input.action.stepId} gas estimate exceeds quote limit`);
  }
  const response = await input.signer.sendTransaction(request);
  const broadcastAtMs = Date.now();
  const broadcastAt = new Date(broadcastAtMs).toISOString();
  const txFingerprint = fingerprint(response.hash);
  await input.onBroadcast(txFingerprint);
  const receipt = await response.wait(1, 120_000);
  const receiptObservedAtMs = Date.now();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${input.action.stepId} transaction did not succeed`);
  }
  const block = await input.provider.getBlock(receipt.blockNumber);
  if (!block) throw new Error("receipt block could not be loaded");
  return {
    stepId: input.action.stepId,
    txFingerprint,
    blockNumber: receipt.blockNumber,
    blockTimestamp: new Date(block.timestamp * 1_000).toISOString(),
    broadcastAt,
    receiptObservedAt: new Date(receiptObservedAtMs).toISOString(),
    receiptLatencyMs: receiptObservedAtMs - broadcastAtMs,
    status: receipt.status,
    gasUsed: receipt.gasUsed.toString(),
    gasCostRaw: (receipt.gasUsed * receipt.gasPrice).toString(),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  assertHardBudgets(options);
  const apiKeyFromEnv = process.env.RELAY_API_KEY?.trim();
  if (!apiKeyFromEnv) throw new Error("RELAY_API_KEY is missing");
  const apiKey = apiKeyFromEnv;
  const walletFile = JSON.parse(
    await readFile(walletPath, "utf8"),
  ) as WalletFile;
  const user = getAddress(walletFile.address);
  const derived = new Wallet(walletFile.privateKey);
  if (derived.address !== user) throw new Error("wallet key/address mismatch");
  const recipient =
    options.scenario.destinationVm === "svm"
      ? (
          JSON.parse(
            await readFile(solanaWalletPath, "utf8"),
          ) as SolanaWalletFile
        ).address
      : user;
  if (options.scenario.destinationVm === "svm") {
    new PublicKey(recipient);
  } else {
    getAddress(recipient);
  }

  await mkdir(runsDir, { recursive: true, mode: 0o700 });
  await chmod(runsDir, 0o700);
  const startedAt = new Date().toISOString();
  const reportPath = resolve(
    runsDir,
    `${startedAt.replaceAll(":", "-")}-${options.scenario.id}-${options.live ? "live" : "preflight"}.json`,
  );
  const report: RunReport = {
    schemaVersion: 1,
    scenarioId: options.scenario.id,
    mode: options.live ? "live" : "preflight",
    startedAt,
    sourceAsset: options.scenario.sourceAsset,
    destinationAsset: options.scenario.destinationAsset,
    amountRaw: options.amountRaw.toString(),
    minimumOutputFloorRaw: options.minimumOutputRaw.toString(),
    maxGasRaw: options.maxGasRaw.toString(),
    signerMode: "dedicated-burner",
    burnerFingerprint: fingerprint(user),
    recipientFingerprint: fingerprint(recipient),
    broadcastAttempted: false,
    broadcastFingerprints: [],
    transactions: [],
    timings: {
      quoteLatenciesMs: [],
    },
    terminalResult: "failed_before_broadcast",
  };
  await writeReport(reportPath, report);

  const originProvider = providerFor(options.scenario.originChainId);
  const destinationProvider =
    options.scenario.destinationVm === "evm"
      ? providerFor(options.scenario.destinationChainId)
      : undefined;
  const destinationSolana =
    options.scenario.destinationVm === "svm" ? solanaConnection() : undefined;
  const [originNetwork, destinationNetworkIdentity] = await Promise.all([
    originProvider.getNetwork(),
    destinationProvider
      ? destinationProvider
          .getNetwork()
          .then((network) => Number(network.chainId).toString())
      : required(
          destinationSolana,
          "destination Solana connection",
        ).getGenesisHash(),
  ]);
  const expectedDestinationIdentity = destinationProvider
    ? options.scenario.destinationChainId.toString()
    : "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  if (
    Number(originNetwork.chainId) !== options.scenario.originChainId ||
    destinationNetworkIdentity !== expectedDestinationIdentity
  ) {
    throw new Error("RPC chain identity mismatch");
  }
  const readDestinationBalance = () =>
    destinationProvider
      ? assetBalance(
          destinationProvider,
          options.scenario.destinationCurrency,
          recipient,
        )
      : solanaAssetBalance(
          required(destinationSolana, "destination Solana connection"),
          options.scenario.destinationCurrency,
          recipient,
        );

  const [
    sourceBefore,
    destinationBefore,
    nativeGasBefore,
    currentAllowance,
    codeHashes,
    quoteResult,
  ] = await Promise.all([
    assetBalance(originProvider, options.scenario.originCurrency, user),
    readDestinationBalance(),
    originProvider.getBalance(user),
    allowance(originProvider, options.scenario.originCurrency, user),
    verifyContractCode(originProvider),
    quoteRelay({
      amount: options.amountRaw,
      apiKey,
      recipient,
      scenario: options.scenario,
      user,
    }),
  ]);
  report.timings.quoteLatenciesMs.push(quoteResult.latencyMs);
  if (sourceBefore < options.amountRaw) {
    throw new Error("insufficient source asset balance");
  }
  if (nativeGasBefore < options.maxGasRaw) {
    throw new Error("native gas balance below authorized gas envelope");
  }
  if (
    options.scenario.originCurrency.toLowerCase() ===
      ZeroAddress.toLowerCase() &&
    sourceBefore < options.amountRaw + options.maxGasRaw
  ) {
    throw new Error("native balance cannot cover input plus gas envelope");
  }

  let validated = validateRelayRehearsalQuote({
    amount: options.amountRaw,
    minimumOutputFloor: options.minimumOutputRaw,
    quote: quoteResult.body,
    recipient,
    scenario: options.scenario,
    user,
  });
  const gasWorstCase = validateGas(validated.actions, options.maxGasRaw);
  const simulations = await simulateActions({
    actions: validated.actions,
    currentAllowance,
    provider: originProvider,
  });
  report.sourceBalanceBeforeRaw = sourceBefore.toString();
  report.destinationBalanceBeforeRaw = destinationBefore.toString();
  report.quoteExpectedOutputRaw = validated.expectedOutputRaw.toString();
  report.quoteMinimumOutputRaw = validated.minimumOutputRaw.toString();
  report.quoteFingerprint = stableFingerprint(quoteResult.body);
  report.requestFingerprint = fingerprint(validated.requestId);
  report.routeShape = validated.routeShape;
  report.actionChecks = {
    actionCount: validated.actions.length,
    contractCodeHashes: codeHashes,
    gasWorstCaseRaw: gasWorstCase.toString(),
    simulations,
  };
  report.confirmation = confirmation(options);

  if (!options.live) {
    report.completedAt = new Date().toISOString();
    report.timings.runDurationMs =
      Date.parse(report.completedAt) - Date.parse(report.startedAt);
    report.terminalResult = "preflight_only";
    await writeReport(reportPath, report);
    console.log(
      JSON.stringify(
        {
          result: "preflight_only",
          reportPath,
          scenario: options.scenario.id,
          amountRaw: options.amountRaw.toString(),
          minimumOutputRaw: validated.minimumOutputRaw.toString(),
          expectedOutputRaw: validated.expectedOutputRaw.toString(),
          gasWorstCaseRaw: gasWorstCase.toString(),
          confirmation: report.confirmation,
          timings: report.timings,
          simulations,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (options.confirm !== confirmation(options)) {
    throw new Error("live confirmation mismatch");
  }

  const signer = derived.connect(originProvider);
  report.broadcastAttempted = true;
  report.terminalResult = "broadcasting";
  await writeReport(reportPath, report);

  const approve = validated.actions.find(
    (action) => action.stepId === "approve",
  );
  if (approve) {
    const evidence = await sendAction({
      action: approve,
      onBroadcast: async (txFingerprint) => {
        report.broadcastFingerprints.push(txFingerprint);
        await writeReport(reportPath, report);
      },
      provider: originProvider,
      signer,
    });
    report.transactions.push(evidence);
    await writeReport(reportPath, report);

    const refreshedQuote = await quoteRelay({
      amount: options.amountRaw,
      apiKey,
      recipient,
      scenario: options.scenario,
      user,
    });
    report.timings.quoteLatenciesMs.push(refreshedQuote.latencyMs);
    validated = validateRelayRehearsalQuote({
      amount: options.amountRaw,
      minimumOutputFloor: options.minimumOutputRaw,
      quote: refreshedQuote.body,
      recipient,
      scenario: options.scenario,
      user,
    });
    const refreshedGas = validateGas(
      validated.actions.filter((action) => action.stepId === "deposit"),
      options.maxGasRaw - BigInt(report.transactions[0]?.gasCostRaw ?? "0"),
    );
    report.quoteExpectedOutputRaw = validated.expectedOutputRaw.toString();
    report.quoteMinimumOutputRaw = validated.minimumOutputRaw.toString();
    report.quoteFingerprint = stableFingerprint(refreshedQuote.body);
    report.requestFingerprint = fingerprint(validated.requestId);
    report.actionChecks.gasWorstCaseRaw = refreshedGas.toString();
    await writeReport(reportPath, report);
  }

  const deposit = validated.actions.find(
    (action) => action.stepId === "deposit",
  );
  if (!deposit) throw new Error("fresh quote has no deposit action");
  const depositEvidence = await sendAction({
    action: deposit,
    onBroadcast: async (txFingerprint) => {
      report.broadcastFingerprints.push(txFingerprint);
      await writeReport(reportPath, report);
    },
    provider: originProvider,
    signer,
  });
  report.transactions.push(depositEvidence);
  await writeReport(reportPath, report);

  const statusHistory: string[] = [];
  let destinationAfter = destinationBefore;
  let finalStatus = "waiting";
  let destinationObservedAt: string | undefined;
  let relayTerminalObservedAt: string | undefined;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const [status, balance] = await Promise.all([
      fetchRelayStatus({ apiKey, requestId: validated.requestId }),
      readDestinationBalance(),
    ]);
    finalStatus = status;
    if (statusHistory.at(-1) !== status) statusHistory.push(status);
    if (
      !relayTerminalObservedAt &&
      ["success", "failure", "refund", "refunded"].includes(status)
    ) {
      relayTerminalObservedAt = new Date().toISOString();
    }
    destinationAfter = balance;
    if (destinationAfter - destinationBefore >= options.minimumOutputRaw) {
      destinationObservedAt = new Date().toISOString();
      break;
    }
    if (["failure", "refund", "refunded"].includes(status)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  }

  const [sourceAfter, finalDestination] = await Promise.all([
    assetBalance(originProvider, options.scenario.originCurrency, user),
    readDestinationBalance(),
  ]);
  destinationAfter = finalDestination;
  const destinationDelta = destinationAfter - destinationBefore;
  report.sourceBalanceAfterRaw = sourceAfter.toString();
  report.destinationBalanceAfterRaw = destinationAfter.toString();
  report.destinationDeltaRaw = destinationDelta.toString();
  report.relayStatus = finalStatus;
  report.relayStatusHistory = statusHistory;
  report.timings.destinationObservedAt = destinationObservedAt;
  report.timings.relayTerminalObservedAt = relayTerminalObservedAt;
  if (destinationObservedAt) {
    report.timings.depositBroadcastToDestinationObservedMs =
      Date.parse(destinationObservedAt) -
      Date.parse(depositEvidence.broadcastAt);
    report.timings.depositReceiptToDestinationObservedMs =
      Date.parse(destinationObservedAt) -
      Date.parse(depositEvidence.receiptObservedAt);
  }
  report.completedAt = new Date().toISOString();
  report.timings.runDurationMs =
    Date.parse(report.completedAt) - Date.parse(report.startedAt);
  if (destinationDelta >= options.minimumOutputRaw) {
    report.terminalResult = "destination_observed";
  } else if (["failure", "refund", "refunded"].includes(finalStatus)) {
    report.terminalResult = "relay_terminal_without_destination";
  } else {
    report.terminalResult = "reconcile_required";
  }
  await writeReport(reportPath, report);
  console.log(
    JSON.stringify(
      {
        result: report.terminalResult,
        reportPath,
        scenario: options.scenario.id,
        sourceBalanceBeforeRaw: report.sourceBalanceBeforeRaw,
        sourceBalanceAfterRaw: report.sourceBalanceAfterRaw,
        destinationBalanceBeforeRaw: report.destinationBalanceBeforeRaw,
        destinationBalanceAfterRaw: report.destinationBalanceAfterRaw,
        destinationDeltaRaw: report.destinationDeltaRaw,
        relayStatus: report.relayStatus,
        relayStatusHistory: report.relayStatusHistory,
        timings: report.timings,
        transactions: report.transactions,
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} catch (error) {
  const candidate =
    error && typeof error === "object"
      ? (error as {
          code?: unknown;
          reason?: unknown;
          shortMessage?: unknown;
        })
      : {};
  const code =
    typeof candidate.code === "string" ? candidate.code : "UNKNOWN_ERROR";
  const detail =
    typeof candidate.reason === "string"
      ? candidate.reason
      : typeof candidate.shortMessage === "string"
        ? candidate.shortMessage
        : error instanceof Error && !error.message.includes("transaction=")
          ? error.message
          : "operation failed without a safe error detail";
  const message = `${code}: ${detail}`;
  console.error(`[relay-rehearsal] ${message}`);
  process.exitCode = 1;
}
