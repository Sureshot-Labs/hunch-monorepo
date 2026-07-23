#!/usr/bin/env tsx

import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "dotenv";
import { Contract, Interface, JsonRpcProvider, getAddress } from "ethers";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  POLYGON_PUSD,
  SOLANA_USDC,
} from "./funding-providers/relay/rehearsal.js";
import {
  RELAY_SOLANA_DEPOSITORY,
  SPL_TOKEN_PROGRAM,
  type ValidatedSolanaRelayQuote,
  validateRelaySolanaRehearsalQuote,
} from "./funding-providers/relay/solana-rehearsal.js";

process.umask(0o077);
config({ path: resolve(import.meta.dirname, "../../../.env"), override: true });

const root = resolve(import.meta.dirname, "../../..");
const solanaWalletPath = resolve(
  root,
  "untracked/relay-rehearsal-solana-wallet.json",
);
const evmWalletPath = resolve(
  root,
  "untracked/relay-rehearsal-evm-wallet.json",
);
const runsDir = resolve(root, "untracked/relay-rehearsal-runs");
const relayBaseUrl = "https://api.relay.link";
const scenarioId = "solana-usdc-to-polygon-pusd";
const erc20 = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
]);

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is required`);
  return value;
}

type CliOptions = {
  amountRaw: bigint;
  confirm?: string;
  live: boolean;
  maxFeeLamports: bigint;
  minimumOutputRaw: bigint;
};

type RunReport = {
  schemaVersion: 1;
  scenarioId: typeof scenarioId;
  mode: "preflight" | "live";
  startedAt: string;
  completedAt?: string;
  amountRaw: string;
  minimumOutputFloorRaw: string;
  maxFeeLamports: string;
  signerMode: "dedicated-burner";
  burnerFingerprint: string;
  recipientFingerprint: string;
  solBalanceBeforeLamports?: string;
  solBalanceAfterLamports?: string;
  sourceBalanceBeforeRaw?: string;
  sourceBalanceAfterRaw?: string;
  destinationBalanceBeforeRaw?: string;
  destinationBalanceAfterRaw?: string;
  destinationDeltaRaw?: string;
  quoteExpectedOutputRaw?: string;
  quoteMinimumOutputRaw?: string;
  quoteFingerprint?: string;
  requestFingerprint?: string;
  instructionChecks?: {
    programFingerprint: string;
    programExecutable: boolean;
    programOwnerFingerprint: string;
    instructionDataFingerprint: string;
    sourceAtaFingerprint: string;
    lookupTableFingerprints: string[];
    estimatedNetworkFeeLamports: string;
    rentReserveLamports: string;
    unsignedSimulation: {
      passed: boolean;
      unitsConsumed?: number;
    };
    signedSimulation?: {
      passed: boolean;
      unitsConsumed?: number;
    };
  };
  confirmation?: string;
  signatureCreated: boolean;
  broadcastAttempted: boolean;
  transaction?: {
    signatureFingerprint: string;
    broadcastAt: string;
    confirmedAt: string;
    confirmationLatencyMs: number;
    slot: number;
    blockTimestamp?: string;
    feeLamports: string;
    status: "success";
  };
  relayStatus?: string;
  relayStatusHistory?: string[];
  timings: {
    quoteLatencyMs?: number;
    destinationObservedAt?: string;
    broadcastToDestinationObservedMs?: number;
    confirmationToDestinationObservedMs?: number;
    relayTerminalObservedAt?: string;
    runDurationMs?: number;
  };
  terminalResult:
    | "failed_before_broadcast"
    | "preflight_only"
    | "broadcasting"
    | "destination_observed"
    | "relay_terminal_without_destination"
    | "reconcile_required";
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
  return {
    amountRaw: parseUnsigned(getArg(args, "--amount-raw"), "--amount-raw"),
    minimumOutputRaw: parseUnsigned(
      getArg(args, "--minimum-output-raw"),
      "--minimum-output-raw",
    ),
    maxFeeLamports: parseUnsigned(
      getArg(args, "--max-fee-lamports"),
      "--max-fee-lamports",
    ),
    live: args.includes("--live"),
    confirm: getArg(args, "--confirm"),
  };
}

function assertHardBudgets(options: CliOptions): void {
  if (options.amountRaw <= 0n || options.amountRaw > 500_000n) {
    throw new Error("Solana USDC amount exceeds 0.5 USDC hard cap");
  }
  if (options.maxFeeLamports <= 0n || options.maxFeeLamports > 250_000n) {
    throw new Error("Solana fee cap exceeds 0.00025 SOL");
  }
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
    scenarioId,
    `spend=${options.amountRaw}`,
    `minOut=${options.minimumOutputRaw}`,
    `fee=${options.maxFeeLamports}`,
    "signer=dedicated-burner",
  ].join(":");
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

function polygonProvider(): JsonRpcProvider {
  const rpcUrl = process.env.POLYGON_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("POLYGON_RPC_URL is missing");
  if (!new URL(rpcUrl).hostname.endsWith("alchemy.com")) {
    throw new Error("POLYGON_RPC_URL must point to an Alchemy RPC");
  }
  return new JsonRpcProvider(rpcUrl, 137, {
    batchMaxCount: 1,
    staticNetwork: true,
  });
}

async function quoteRelay(input: {
  amount: bigint;
  apiKey: string;
  recipient: string;
  user: string;
}): Promise<{ body: unknown; latencyMs: number }> {
  const startedAt = Date.now();
  const response = await fetch(`${relayBaseUrl}/quote/v2`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": input.apiKey,
    },
    body: JSON.stringify({
      user: input.user,
      recipient: input.recipient,
      originChainId: 792703809,
      destinationChainId: 137,
      originCurrency: SOLANA_USDC,
      destinationCurrency: POLYGON_PUSD,
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
    throw new Error(`Relay quote failed HTTP ${response.status}`);
  }
  return { body, latencyMs: Date.now() - startedAt };
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

async function solanaUsdcBalance(
  connection: Connection,
  owner: PublicKey,
): Promise<bigint> {
  const sourceAta = getAssociatedTokenAddressSync(
    new PublicKey(SOLANA_USDC),
    owner,
  );
  const accountInfo = await connection.getAccountInfo(sourceAta, "confirmed");
  if (!accountInfo) return 0n;
  const balance = await connection.getTokenAccountBalance(
    sourceAta,
    "confirmed",
  );
  return BigInt(balance.value.amount);
}

async function polygonPusdBalance(
  provider: JsonRpcProvider,
  owner: string,
): Promise<bigint> {
  const token = new Contract(POLYGON_PUSD, erc20, provider);
  return token.balanceOf(owner) as Promise<bigint>;
}

async function loadLookupTables(
  connection: Connection,
  addresses: string[],
): Promise<AddressLookupTableAccount[]> {
  const tables = await Promise.all(
    addresses.map(async (address) => {
      const response = await connection.getAddressLookupTable(
        new PublicKey(address),
        { commitment: "confirmed" },
      );
      if (!response.value) {
        throw new Error("Relay address lookup table does not exist");
      }
      return response.value;
    }),
  );
  return tables;
}

function transactionInstruction(
  validated: ValidatedSolanaRelayQuote,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(validated.instruction.programId),
    data: Buffer.from(validated.instruction.data),
    keys: validated.instruction.keys.map((key) => ({
      pubkey: new PublicKey(key.pubkey),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
  });
}

async function validateAccounts(input: {
  connection: Connection;
  user: PublicKey;
  validated: ValidatedSolanaRelayQuote;
}): Promise<{
  lookupTables: AddressLookupTableAccount[];
  programOwnerFingerprint: string;
  sourceAta: PublicKey;
}> {
  const sourceAta = getAssociatedTokenAddressSync(
    new PublicKey(SOLANA_USDC),
    input.user,
  );
  const instructionKeys = input.validated.instruction.keys;
  const inspectedKeys = [
    new PublicKey(RELAY_SOLANA_DEPOSITORY),
    new PublicKey(SOLANA_USDC),
    sourceAta,
    new PublicKey(required(instructionKeys[0], "instruction key 0").pubkey),
    new PublicKey(required(instructionKeys[3], "instruction key 3").pubkey),
    new PublicKey(required(instructionKeys[6], "instruction key 6").pubkey),
  ];
  const infos = await input.connection.getMultipleAccountsInfo(
    inspectedKeys,
    "confirmed",
  );
  const [programInfo, mintInfo, sourceInfo, ...protocolInfos] = infos;
  if (!programInfo?.executable) {
    throw new Error("Relay Solana program is missing or not executable");
  }
  if (mintInfo?.owner.toBase58() !== SPL_TOKEN_PROGRAM) {
    throw new Error("Solana USDC mint owner mismatch");
  }
  if (sourceInfo?.owner.toBase58() !== SPL_TOKEN_PROGRAM) {
    throw new Error("source ATA is missing or has wrong owner");
  }
  if (protocolInfos.some((info) => !info)) {
    throw new Error("Relay protocol account is missing");
  }
  return {
    sourceAta,
    programOwnerFingerprint: fingerprint(programInfo.owner.toBase58()),
    lookupTables: await loadLookupTables(
      input.connection,
      input.validated.instruction.addressLookupTableAddresses,
    ),
  };
}

async function writeReport(path: string, report: RunReport): Promise<void> {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

async function waitForSignatureStatus(input: {
  connection: Connection;
  signature: string;
}): Promise<{ observedAtMs: number; slot: number }> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await input.connection.getSignatureStatuses(
      [input.signature],
      { searchTransactionHistory: true },
    );
    const status = response.value[0];
    if (status?.err) throw new Error("Solana transaction failed");
    if (
      status &&
      (status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized")
    ) {
      return { observedAtMs: Date.now(), slot: status.slot };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("Solana HTTP confirmation polling timed out");
}

async function loadConfirmedTransaction(input: {
  connection: Connection;
  signature: string;
}) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const transaction = await input.connection.getTransaction(input.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (transaction) return transaction;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("confirmed Solana transaction details unavailable");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  assertHardBudgets(options);
  const apiKey = process.env.RELAY_API_KEY?.trim();
  if (!apiKey) throw new Error("RELAY_API_KEY is missing");
  const solanaWallet = JSON.parse(await readFile(solanaWalletPath, "utf8")) as {
    address: string;
    secretKeyBase58: string;
  };
  const evmWallet = JSON.parse(await readFile(evmWalletPath, "utf8")) as {
    address: string;
  };
  const user = new PublicKey(solanaWallet.address);
  const signer = Keypair.fromSecretKey(
    bs58.decode(solanaWallet.secretKeyBase58),
  );
  if (!signer.publicKey.equals(user)) {
    throw new Error("Solana wallet key/address mismatch");
  }
  const recipient = getAddress(evmWallet.address);
  const connection = solanaConnection();
  const polygon = polygonProvider();

  await mkdir(runsDir, { recursive: true, mode: 0o700 });
  await chmod(runsDir, 0o700);
  const startedAt = new Date().toISOString();
  const reportPath = resolve(
    runsDir,
    `${startedAt.replaceAll(":", "-")}-${scenarioId}-${options.live ? "live" : "preflight"}.json`,
  );
  const report: RunReport = {
    schemaVersion: 1,
    scenarioId,
    mode: options.live ? "live" : "preflight",
    startedAt,
    amountRaw: options.amountRaw.toString(),
    minimumOutputFloorRaw: options.minimumOutputRaw.toString(),
    maxFeeLamports: options.maxFeeLamports.toString(),
    signerMode: "dedicated-burner",
    burnerFingerprint: fingerprint(user.toBase58()),
    recipientFingerprint: fingerprint(recipient),
    signatureCreated: false,
    broadcastAttempted: false,
    timings: {},
    terminalResult: "failed_before_broadcast",
  };
  await writeReport(reportPath, report);

  const [genesisHash, polygonNetwork] = await Promise.all([
    connection.getGenesisHash(),
    polygon.getNetwork(),
  ]);
  if (
    genesisHash !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" ||
    Number(polygonNetwork.chainId) !== 137
  ) {
    throw new Error("RPC chain identity mismatch");
  }

  const [sourceBefore, solBefore, destinationBefore, quoteResult] =
    await Promise.all([
      solanaUsdcBalance(connection, user),
      connection.getBalance(user, "confirmed").then(BigInt),
      polygonPusdBalance(polygon, recipient),
      quoteRelay({
        amount: options.amountRaw,
        apiKey,
        recipient,
        user: user.toBase58(),
      }),
    ]);
  report.timings.quoteLatencyMs = quoteResult.latencyMs;
  if (sourceBefore < options.amountRaw) {
    throw new Error("insufficient Solana USDC balance");
  }
  const validated = validateRelaySolanaRehearsalQuote({
    amount: options.amountRaw,
    minimumOutputFloor: options.minimumOutputRaw,
    quote: quoteResult.body,
    recipient,
    user: user.toBase58(),
  });
  const accountChecks = await validateAccounts({
    connection,
    user,
    validated,
  });
  const [latestBlockhash, rentReserveLamports] = await Promise.all([
    connection.getLatestBlockhash("confirmed"),
    connection.getMinimumBalanceForRentExemption(0, "confirmed"),
  ]);
  const instruction = transactionInstruction(validated);
  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [instruction],
  }).compileToV0Message(accountChecks.lookupTables);
  const feeResponse = await connection.getFeeForMessage(message, "confirmed");
  if (feeResponse.value === null) {
    throw new Error("Solana fee estimate unavailable");
  }
  const estimatedFeeLamports = BigInt(feeResponse.value);
  if (estimatedFeeLamports > options.maxFeeLamports) {
    throw new Error("estimated Solana fee exceeds authorized cap");
  }
  if (solBefore < BigInt(rentReserveLamports) + options.maxFeeLamports) {
    throw new Error("SOL balance cannot preserve rent reserve plus fee cap");
  }
  const unsignedTransaction = new VersionedTransaction(message);
  const unsignedSimulation = await connection.simulateTransaction(
    unsignedTransaction,
    {
      commitment: "confirmed",
      replaceRecentBlockhash: true,
      sigVerify: false,
    },
  );
  if (unsignedSimulation.value.err) {
    const safeLogs = (unsignedSimulation.value.logs ?? [])
      .slice(-8)
      .join(" | ");
    throw new Error(
      `unsigned Solana simulation failed: ${JSON.stringify(unsignedSimulation.value.err)}; ${safeLogs}`,
    );
  }
  report.solBalanceBeforeLamports = solBefore.toString();
  report.sourceBalanceBeforeRaw = sourceBefore.toString();
  report.destinationBalanceBeforeRaw = destinationBefore.toString();
  report.quoteExpectedOutputRaw = validated.expectedOutputRaw.toString();
  report.quoteMinimumOutputRaw = validated.minimumOutputRaw.toString();
  report.quoteFingerprint = stableFingerprint(quoteResult.body);
  report.requestFingerprint = fingerprint(validated.requestId);
  report.confirmation = confirmation(options);
  report.instructionChecks = {
    programFingerprint: fingerprint(RELAY_SOLANA_DEPOSITORY),
    programExecutable: true,
    programOwnerFingerprint: accountChecks.programOwnerFingerprint,
    instructionDataFingerprint: fingerprint(validated.instruction.data),
    sourceAtaFingerprint: fingerprint(accountChecks.sourceAta.toBase58()),
    lookupTableFingerprints:
      validated.instruction.addressLookupTableAddresses.map(fingerprint),
    estimatedNetworkFeeLamports: estimatedFeeLamports.toString(),
    rentReserveLamports: rentReserveLamports.toString(),
    unsignedSimulation: {
      passed: true,
      unitsConsumed: unsignedSimulation.value.unitsConsumed,
    },
  };

  if (!options.live) {
    report.completedAt = new Date().toISOString();
    report.timings.runDurationMs =
      Date.parse(report.completedAt) - Date.parse(report.startedAt);
    report.terminalResult = "preflight_only";
    await writeReport(reportPath, report);
    console.log(
      JSON.stringify(
        {
          result: report.terminalResult,
          reportPath,
          amountRaw: report.amountRaw,
          expectedOutputRaw: report.quoteExpectedOutputRaw,
          minimumOutputRaw: report.quoteMinimumOutputRaw,
          solBalanceLamports: report.solBalanceBeforeLamports,
          estimatedNetworkFeeLamports:
            report.instructionChecks.estimatedNetworkFeeLamports,
          rentReserveLamports: report.instructionChecks.rentReserveLamports,
          unsignedSimulation: report.instructionChecks.unsignedSimulation,
          confirmation: report.confirmation,
          timings: report.timings,
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

  const pending = await connection.getSignaturesForAddress(user, { limit: 5 });
  if (pending.some((entry) => entry.confirmationStatus === "processed")) {
    throw new Error(
      "burner has a processed-only transaction; refusing broadcast",
    );
  }
  const signedTransaction = new VersionedTransaction(message);
  signedTransaction.sign([signer]);
  report.signatureCreated = true;
  const signedSimulation = await connection.simulateTransaction(
    signedTransaction,
    {
      commitment: "confirmed",
      sigVerify: true,
    },
  );
  if (signedSimulation.value.err) {
    const safeLogs = (signedSimulation.value.logs ?? []).slice(-8).join(" | ");
    throw new Error(
      `signed Solana simulation failed: ${JSON.stringify(signedSimulation.value.err)}; ${safeLogs}`,
    );
  }
  report.instructionChecks.signedSimulation = {
    passed: true,
    unitsConsumed: signedSimulation.value.unitsConsumed,
  };
  report.broadcastAttempted = true;
  report.terminalResult = "broadcasting";
  await writeReport(reportPath, report);

  const signature = await connection.sendRawTransaction(
    signedTransaction.serialize(),
    {
      maxRetries: 3,
      preflightCommitment: "confirmed",
      skipPreflight: false,
    },
  );
  const broadcastAtMs = Date.now();
  const broadcastAt = new Date(broadcastAtMs).toISOString();
  const signatureFingerprint = fingerprint(signature);
  report.transaction = {
    signatureFingerprint,
    broadcastAt,
    confirmedAt: "",
    confirmationLatencyMs: 0,
    slot: 0,
    feeLamports: "0",
    status: "success",
  };
  await writeReport(reportPath, report);

  const confirmationResult = await waitForSignatureStatus({
    connection,
    signature,
  });
  const confirmedAtMs = confirmationResult.observedAtMs;
  const transactionDetails = await loadConfirmedTransaction({
    connection,
    signature,
  });
  if (!transactionDetails || transactionDetails.meta?.err) {
    throw new Error("confirmed Solana transaction details unavailable");
  }
  report.transaction = {
    signatureFingerprint,
    broadcastAt,
    confirmedAt: new Date(confirmedAtMs).toISOString(),
    confirmationLatencyMs: confirmedAtMs - broadcastAtMs,
    slot: confirmationResult.slot,
    blockTimestamp:
      transactionDetails.blockTime == null
        ? undefined
        : new Date(transactionDetails.blockTime * 1_000).toISOString(),
    feeLamports: String(transactionDetails.meta?.fee ?? 0),
    status: "success",
  };
  await writeReport(reportPath, report);

  const relayStatusHistory: string[] = [];
  let destinationAfter = destinationBefore;
  let relayStatus = "waiting";
  let destinationObservedAt: string | undefined;
  let relayTerminalObservedAt: string | undefined;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const [status, balance] = await Promise.all([
      fetchRelayStatus({ apiKey, requestId: validated.requestId }),
      polygonPusdBalance(polygon, recipient),
    ]);
    relayStatus = status;
    if (relayStatusHistory.at(-1) !== status) {
      relayStatusHistory.push(status);
    }
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

  const [sourceAfter, solAfter, finalDestination] = await Promise.all([
    solanaUsdcBalance(connection, user),
    connection.getBalance(user, "confirmed").then(BigInt),
    polygonPusdBalance(polygon, recipient),
  ]);
  destinationAfter = finalDestination;
  const destinationDelta = destinationAfter - destinationBefore;
  report.sourceBalanceAfterRaw = sourceAfter.toString();
  report.solBalanceAfterLamports = solAfter.toString();
  report.destinationBalanceAfterRaw = destinationAfter.toString();
  report.destinationDeltaRaw = destinationDelta.toString();
  report.relayStatus = relayStatus;
  report.relayStatusHistory = relayStatusHistory;
  report.timings.destinationObservedAt = destinationObservedAt;
  report.timings.relayTerminalObservedAt = relayTerminalObservedAt;
  if (destinationObservedAt) {
    report.timings.broadcastToDestinationObservedMs =
      Date.parse(destinationObservedAt) -
      Date.parse(report.transaction.broadcastAt);
    report.timings.confirmationToDestinationObservedMs =
      Date.parse(destinationObservedAt) -
      Date.parse(report.transaction.confirmedAt);
  }
  report.completedAt = new Date().toISOString();
  report.timings.runDurationMs =
    Date.parse(report.completedAt) - Date.parse(report.startedAt);
  report.terminalResult =
    destinationDelta >= options.minimumOutputRaw
      ? "destination_observed"
      : ["failure", "refund", "refunded"].includes(relayStatus)
        ? "relay_terminal_without_destination"
        : "reconcile_required";
  await writeReport(reportPath, report);
  console.log(
    JSON.stringify(
      {
        result: report.terminalResult,
        reportPath,
        sourceBalanceBeforeRaw: report.sourceBalanceBeforeRaw,
        sourceBalanceAfterRaw: report.sourceBalanceAfterRaw,
        solBalanceBeforeLamports: report.solBalanceBeforeLamports,
        solBalanceAfterLamports: report.solBalanceAfterLamports,
        destinationBalanceBeforeRaw: report.destinationBalanceBeforeRaw,
        destinationBalanceAfterRaw: report.destinationBalanceAfterRaw,
        destinationDeltaRaw: report.destinationDeltaRaw,
        relayStatus: report.relayStatus,
        relayStatusHistory: report.relayStatusHistory,
        transaction: report.transaction,
        timings: report.timings,
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof Error &&
    !error.message.includes("transaction=") &&
    !error.message.includes("secret")
      ? error.message
      : "operation failed without a safe error detail";
  console.error(`[relay-solana-rehearsal] ${message}`);
  process.exitCode = 1;
}
