import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { getAddress } from "ethers";

import type { RelayQuoteResponse } from "./schemas.js";
import {
  POLYGON_PUSD,
  RELAY_SOLANA_CHAIN_ID,
  RELAY_SOLVER,
  SOLANA_NATIVE,
  SOLANA_USDC,
} from "./rehearsal.js";
import {
  POLYGON_USDCE,
  RELAY_SOLANA_DEPOSITORY,
  SOLANA_SYSTEM_PROGRAM,
  SPL_ASSOCIATED_TOKEN_PROGRAM,
  SPL_TOKEN_PROGRAM,
  type ValidatedSolanaInstruction,
} from "./solana-rehearsal.js";

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const JUPITER_SHARED_ACCOUNTS_ROUTE_DISCRIMINATOR = "e517cb977ae3ad2a";
const RELAY_SOLANA_SWAP_PROGRAM =
  "DPArtTLbEqa6EuXHfL5UFLBZhFjiEXWRudhvXDrjwXUr";
const RELAY_SOLANA_SWAP_DEPOSIT_DISCRIMINATOR = "9d537021bf32ab25";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

type UnknownRecord = Record<string, unknown>;

export type ValidatedSolanaNativeRelayQuote = Readonly<{
  sourceAmountRaw: bigint;
  sourceEstimatedUsd: string | null;
  expectedOutputRaw: bigint;
  minimumOutputRaw: bigint;
  instructions: readonly ValidatedSolanaInstruction[];
  requestId: string;
}>;

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function unsigned(value: unknown, label: string): bigint {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^(0|[1-9]\d*)$/u.test(String(value))
  ) {
    throw new Error(`${label} must be an unsigned integer`);
  }
  return BigInt(String(value));
}

function publicKey(value: unknown, label: string): string {
  try {
    return new PublicKey(text(value, label)).toBase58();
  } catch {
    throw new Error(`${label} must be a Solana public key`);
  }
}

function evmAddress(value: unknown, label: string): string {
  try {
    return getAddress(text(value, label)).toLowerCase();
  } catch {
    throw new Error(`${label} must be an EVM address`);
  }
}

function exact(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} mismatch`);
}

function hexData(value: unknown, label: string, maximumBytes = 4_096): Buffer {
  const encoded = text(value, label);
  if (
    !/^(?:[0-9a-f]{2})+$/iu.test(encoded) ||
    encoded.length / 2 > maximumBytes
  ) {
    throw new Error(`${label} must be bounded even-length hex`);
  }
  return Buffer.from(encoded, "hex");
}

function instruction(
  value: unknown,
  index: number,
): ValidatedSolanaInstruction {
  const item = record(value, `instructions[${index}]`);
  const keys = array(item.keys, `instructions[${index}].keys`).map(
    (entry, keyIndex) => {
      const key = record(entry, `instructions[${index}].keys[${keyIndex}]`);
      if (
        typeof key.isSigner !== "boolean" ||
        typeof key.isWritable !== "boolean"
      ) {
        throw new Error(`instructions[${index}] account flags invalid`);
      }
      return {
        pubkey: publicKey(
          key.pubkey,
          `instructions[${index}].keys[${keyIndex}].pubkey`,
        ),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      };
    },
  );
  if (keys.length > 64) {
    throw new Error(`instructions[${index}] has too many accounts`);
  }
  return {
    addressLookupTableAddresses: [],
    data: hexData(item.data, `instructions[${index}].data`),
    keys,
    programId: publicKey(item.programId, `instructions[${index}].programId`),
  };
}

function assertSignerSet(
  instructionValue: ValidatedSolanaInstruction,
  user: string,
  label: string,
): void {
  const signers = instructionValue.keys.filter((key) => key.isSigner);
  if (
    signers.length !== 1 ||
    signers[0]?.pubkey !== user ||
    instructionValue.keys.some((key) => key.isSigner && key.pubkey !== user)
  ) {
    throw new Error(`${label} requires exactly the controlled Solana signer`);
  }
}

function assertAccount(
  instructionValue: ValidatedSolanaInstruction,
  index: number,
  expected: Readonly<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>,
  label: string,
): void {
  const actual = instructionValue.keys[index];
  if (
    !actual ||
    actual.pubkey !== expected.pubkey ||
    actual.isSigner !== expected.isSigner ||
    actual.isWritable !== expected.isWritable
  ) {
    throw new Error(`${label} account mismatch`);
  }
}

function bytes32(value: unknown, label: string): Buffer {
  const encoded = text(value, label);
  if (!/^0x[0-9a-f]{64}$/iu.test(encoded)) {
    throw new Error(`${label} must be a bytes32 value`);
  }
  return Buffer.from(encoded.slice(2), "hex");
}

function validateJupiterSwap(input: {
  instruction: ValidatedSolanaInstruction;
  maximumSlippageBps: number;
  minimumPaymentAmountRaw: bigint;
  paymentAmountRaw: bigint;
  sourceAmountRaw: bigint;
  user: string;
  usdcAta: string;
  wrappedSolAta: string;
}): void {
  const value = input.instruction;
  exact(value.programId, JUPITER_V6_PROGRAM, "Jupiter program");
  assertSignerSet(value, input.user, "Jupiter swap");
  if (value.keys.length < 7) {
    throw new Error("Jupiter account layout is too short");
  }
  assertAccount(
    value,
    0,
    { pubkey: SPL_TOKEN_PROGRAM, isSigner: false, isWritable: false },
    "Jupiter token program",
  );
  assertAccount(
    value,
    1,
    { pubkey: input.user, isSigner: true, isWritable: false },
    "Jupiter transfer authority",
  );
  assertAccount(
    value,
    2,
    { pubkey: input.wrappedSolAta, isSigner: false, isWritable: true },
    "Jupiter wrapped SOL input",
  );
  assertAccount(
    value,
    4,
    { pubkey: input.usdcAta, isSigner: false, isWritable: true },
    "Jupiter USDC output",
  );
  assertAccount(
    value,
    5,
    { pubkey: SOLANA_USDC, isSigner: false, isWritable: false },
    "Jupiter output mint",
  );
  assertAccount(
    value,
    6,
    { pubkey: JUPITER_V6_PROGRAM, isSigner: false, isWritable: false },
    "Jupiter program account",
  );

  const data = Buffer.from(value.data);
  const tailLength = 19;
  if (
    data.byteLength < 8 + tailLength ||
    data.subarray(0, 8).toString("hex") !==
      JUPITER_SHARED_ACCOUNTS_ROUTE_DISCRIMINATOR
  ) {
    throw new Error("Jupiter instruction discriminator mismatch");
  }
  const tail = data.subarray(data.byteLength - tailLength);
  const sourceAmountRaw = tail.readBigUInt64LE(0);
  const quotedOutputRaw = tail.readBigUInt64LE(8);
  const slippageBps = tail.readUInt16LE(16);
  const platformFeeBps = tail.readUInt8(18);
  if (
    sourceAmountRaw !== input.sourceAmountRaw ||
    quotedOutputRaw !== input.paymentAmountRaw ||
    slippageBps > input.maximumSlippageBps ||
    platformFeeBps !== 0 ||
    (quotedOutputRaw * BigInt(10_000 - slippageBps) + 9_999n) / 10_000n !==
      input.minimumPaymentAmountRaw
  ) {
    throw new Error("Jupiter swap economics mismatch");
  }
}

function validateRelayDeposit(input: {
  instruction: ValidatedSolanaInstruction;
  orderId: Buffer;
  user: string;
  usdcAta: string;
}): void {
  const value = input.instruction;
  exact(value.programId, RELAY_SOLANA_SWAP_PROGRAM, "Relay deposit program");
  assertSignerSet(value, input.user, "Relay deposit");
  if (value.keys.length !== 12) {
    throw new Error("Relay deposit account layout mismatch");
  }
  [
    [0, input.user, true, true],
    [1, input.user, false, false],
    [2, input.usdcAta, false, true],
    [3, JUPITER_V6_PROGRAM, false, false],
    [4, MEMO_PROGRAM, false, false],
    [5, SOLANA_USDC, false, false],
    [6, input.usdcAta, false, true],
    [7, RELAY_SOLANA_SWAP_PROGRAM, false, true],
    [8, RELAY_SOLANA_DEPOSITORY, false, false],
    [9, SPL_TOKEN_PROGRAM, false, false],
    [10, SPL_ASSOCIATED_TOKEN_PROGRAM, false, false],
    [11, SOLANA_SYSTEM_PROGRAM, false, false],
  ].forEach(([index, pubkey, isSigner, isWritable]) =>
    assertAccount(
      value,
      Number(index),
      {
        pubkey: String(pubkey),
        isSigner: Boolean(isSigner),
        isWritable: Boolean(isWritable),
      },
      `Relay deposit[${index}]`,
    ),
  );
  const data = Buffer.from(value.data);
  if (
    data.byteLength !== 40 ||
    data.subarray(0, 8).toString("hex") !==
      RELAY_SOLANA_SWAP_DEPOSIT_DISCRIMINATOR ||
    !data.subarray(8).equals(input.orderId)
  ) {
    throw new Error("Relay deposit order binding mismatch");
  }
}

function assertAtaCreation(input: {
  instruction: ValidatedSolanaInstruction;
  index: number;
  mint: string;
  owner: string;
  ata: string;
}): void {
  const value = input.instruction;
  exact(
    value.programId,
    SPL_ASSOCIATED_TOKEN_PROGRAM,
    `instructions[${input.index}].programId`,
  );
  if (
    Buffer.from(value.data).toString("hex") !== "01" ||
    value.keys.length !== 6
  ) {
    throw new Error(
      `instructions[${input.index}] must be idempotent ATA creation`,
    );
  }
  const expected = [
    [input.owner, true, true],
    [input.ata, false, true],
    [input.owner, false, false],
    [input.mint, false, false],
    [SOLANA_SYSTEM_PROGRAM, false, false],
    [SPL_TOKEN_PROGRAM, false, false],
  ] as const;
  expected.forEach(([pubkey, isSigner, isWritable], keyIndex) => {
    const key = value.keys[keyIndex];
    if (
      !key ||
      key.pubkey !== pubkey ||
      key.isSigner !== isSigner ||
      key.isWritable !== isWritable
    ) {
      const received = key
        ? `${key.pubkey}/${String(key.isSigner)}/${String(key.isWritable)}`
        : "missing";
      throw new Error(
        `instructions[${input.index}].keys[${keyIndex}] mismatch: expected ${pubkey}/${String(isSigner)}/${String(isWritable)}, received ${received}`,
      );
    }
  });
}

function assertAtaCreationPair(input: {
  instructions: readonly [
    ValidatedSolanaInstruction,
    ValidatedSolanaInstruction,
  ];
  owner: string;
  creations: readonly [
    Readonly<{ mint: string; ata: string }>,
    Readonly<{ mint: string; ata: string }>,
  ];
}): void {
  const firstAta = input.instructions[0].keys[1]?.pubkey;
  const [first, second] =
    firstAta === input.creations[0].ata
      ? input.creations
      : firstAta === input.creations[1].ata
        ? [input.creations[1], input.creations[0]]
        : (() => {
            throw new Error(
              `instructions[0].keys[1] is not an authorized ATA: expected ${input.creations[0].ata} or ${input.creations[1].ata}, received ${firstAta ?? "missing"}`,
            );
          })();
  assertAtaCreation({
    instruction: input.instructions[0],
    index: 0,
    mint: first.mint,
    owner: input.owner,
    ata: first.ata,
  });
  assertAtaCreation({
    instruction: input.instructions[1],
    index: 1,
    mint: second.mint,
    owner: input.owner,
    ata: second.ata,
  });
}

function validateProtocol(input: {
  protocol: unknown;
  recipient: string;
  user: string;
  paymentAmountRaw: bigint;
  expectedOutputRaw: bigint;
  minimumOutputRaw: bigint;
}): Buffer {
  const protocol = record(input.protocol, "protocol");
  const v2 = record(protocol.v2, "protocol.v2");
  exact(v2.hubType, "onchain", "protocol.v2.hubType");
  const payment = record(v2.paymentDetails, "protocol.v2.paymentDetails");
  exact(payment.chainId, "solana", "paymentDetails.chainId");
  exact(
    publicKey(payment.depository, "paymentDetails.depository"),
    RELAY_SOLANA_DEPOSITORY,
    "paymentDetails.depository",
  );
  exact(
    publicKey(payment.currency, "paymentDetails.currency"),
    SOLANA_USDC,
    "paymentDetails.currency",
  );
  if (
    unsigned(payment.amount, "paymentDetails.amount") !== input.paymentAmountRaw
  ) {
    throw new Error("paymentDetails.amount mismatch");
  }

  const orderData = record(v2.orderData, "protocol.v2.orderData");
  const orderId = bytes32(v2.orderId, "protocol.v2.orderId");
  exact(orderData.version, "v1", "orderData.version");
  exact(orderData.solverChainId, "base", "orderData.solverChainId");
  exact(
    evmAddress(orderData.solver, "orderData.solver"),
    RELAY_SOLVER.toLowerCase(),
    "orderData.solver",
  );
  if (array(orderData.fees, "orderData.fees").length !== 0) {
    throw new Error("orderData.fees must be empty");
  }
  const inputs = array(orderData.inputs, "orderData.inputs");
  if (inputs.length !== 1) throw new Error("orderData.inputs count mismatch");
  const orderInput = record(inputs[0], "orderData.inputs[0]");
  const orderPayment = record(
    orderInput.payment,
    "orderData.inputs[0].payment",
  );
  exact(orderPayment.chainId, "solana", "input.payment.chainId");
  exact(
    publicKey(orderPayment.currency, "input.payment.currency"),
    SOLANA_USDC,
    "input.payment.currency",
  );
  if (
    unsigned(orderPayment.amount, "input.payment.amount") !==
    input.paymentAmountRaw
  ) {
    throw new Error("input.payment.amount mismatch");
  }
  exact(orderPayment.weight, "1", "input.payment.weight");

  const refunds = array(orderInput.refunds, "orderData.inputs[0].refunds").map(
    (value, index) => record(value, `refunds[${index}]`),
  );
  if (refunds.length !== 2) throw new Error("refund policy count mismatch");
  const solanaRefund = refunds.find((refund) => refund.chainId === "solana");
  const polygonRefund = refunds.find((refund) => refund.chainId === "polygon");
  if (!solanaRefund || !polygonRefund) {
    throw new Error("required controlled refund paths missing");
  }
  exact(
    publicKey(solanaRefund.recipient, "solana refund recipient"),
    input.user,
    "solana refund recipient",
  );
  exact(
    publicKey(solanaRefund.currency, "solana refund currency"),
    SOLANA_USDC,
    "solana refund currency",
  );
  exact(
    evmAddress(polygonRefund.recipient, "polygon refund recipient"),
    input.recipient,
    "polygon refund recipient",
  );
  exact(
    evmAddress(polygonRefund.currency, "polygon refund currency"),
    POLYGON_USDCE.toLowerCase(),
    "polygon refund currency",
  );

  const output = record(orderData.output, "orderData.output");
  exact(output.chainId, "polygon", "output.chainId");
  if (array(output.calls, "output.calls").length !== 0) {
    throw new Error("output.calls must be empty");
  }
  const payments = array(output.payments, "output.payments");
  if (payments.length !== 1) throw new Error("output payment count mismatch");
  const outputPayment = record(payments[0], "output.payments[0]");
  exact(
    evmAddress(outputPayment.recipient, "output recipient"),
    input.recipient,
    "output recipient",
  );
  exact(
    evmAddress(outputPayment.currency, "output currency"),
    POLYGON_PUSD.toLowerCase(),
    "output currency",
  );
  if (
    unsigned(outputPayment.expectedAmount, "output expectedAmount") !==
      input.expectedOutputRaw ||
    unsigned(outputPayment.minimumAmount, "output minimumAmount") !==
      input.minimumOutputRaw
  ) {
    throw new Error("output amount correlation mismatch");
  }
  return orderId;
}

export function validateRelaySolanaNativeQuote(input: {
  maximumSourceAmountRaw: bigint;
  expectedOutputTargetRaw: bigint;
  minimumOutputFloorRaw: bigint;
  maximumSlippageBps: number;
  quote: RelayQuoteResponse;
  recipient: string;
  user: string;
}): ValidatedSolanaNativeRelayQuote {
  const user = publicKey(input.user, "user");
  const recipient = evmAddress(input.recipient, "recipient");
  if (
    input.maximumSourceAmountRaw <= 0n ||
    input.minimumOutputFloorRaw <= 0n ||
    input.expectedOutputTargetRaw < input.minimumOutputFloorRaw ||
    !Number.isInteger(input.maximumSlippageBps) ||
    input.maximumSlippageBps < 0 ||
    input.maximumSlippageBps > 500
  ) {
    throw new Error("native SOL quote bounds are invalid");
  }
  if (input.quote.depositAddress) {
    throw new Error("Deposit Address mode is forbidden");
  }
  const details = input.quote.details;
  exact(publicKey(details.sender, "details.sender"), user, "details.sender");
  exact(
    evmAddress(details.recipient, "details.recipient"),
    recipient,
    "details.recipient",
  );
  exact(
    details.currencyIn.currency.chainId,
    RELAY_SOLANA_CHAIN_ID,
    "input chain",
  );
  exact(
    publicKey(details.currencyIn.currency.address, "input currency"),
    SOLANA_NATIVE,
    "input currency",
  );
  exact(details.currencyIn.currency.decimals, 9, "input decimals");
  const sourceAmountRaw = BigInt(details.currencyIn.amount);
  if (
    sourceAmountRaw <= 0n ||
    BigInt(details.currencyIn.minimumAmount) !== sourceAmountRaw ||
    sourceAmountRaw > input.maximumSourceAmountRaw
  ) {
    throw new Error("Relay native SOL input exceeds the authorized source cap");
  }
  exact(details.currencyOut.currency.chainId, 137, "output chain");
  exact(
    evmAddress(details.currencyOut.currency.address, "output currency"),
    POLYGON_PUSD.toLowerCase(),
    "output currency",
  );
  exact(details.currencyOut.currency.decimals, 6, "output decimals");
  const expectedOutputRaw = BigInt(details.currencyOut.amount);
  const minimumOutputRaw = BigInt(details.currencyOut.minimumAmount);
  if (
    expectedOutputRaw !== input.expectedOutputTargetRaw ||
    minimumOutputRaw < input.minimumOutputFloorRaw ||
    minimumOutputRaw > expectedOutputRaw
  ) {
    throw new Error("Relay native SOL output is below the authorized floor");
  }

  const route = record(details.route, "details.route");
  const routeOrigin = record(route.origin, "details.route.origin");
  const routeOriginOutput = record(
    routeOrigin.outputCurrency,
    "details.route.origin.outputCurrency",
  );
  const routeOriginOutputCurrency = record(
    routeOriginOutput.currency,
    "details.route.origin.outputCurrency.currency",
  );
  exact(
    routeOriginOutputCurrency.chainId,
    RELAY_SOLANA_CHAIN_ID,
    "origin swap output chain",
  );
  exact(
    publicKey(routeOriginOutputCurrency.address, "origin swap output currency"),
    SOLANA_USDC,
    "origin swap output currency",
  );
  const paymentAmountRaw = unsigned(
    routeOriginOutput.amount,
    "details.route.origin.outputCurrency.amount",
  );
  if (paymentAmountRaw <= 0n) {
    throw new Error("Relay native SOL origin swap output is empty");
  }
  const routeMinimumOutputRaw = unsigned(
    routeOriginOutput.minimumAmount,
    "details.route.origin.outputCurrency.minimumAmount",
  );
  if (routeMinimumOutputRaw <= 0n || routeMinimumOutputRaw > paymentAmountRaw) {
    throw new Error("Relay native SOL origin swap minimum is invalid");
  }
  const orderId = validateProtocol({
    protocol: input.quote.protocol,
    recipient,
    user,
    paymentAmountRaw,
    expectedOutputRaw,
    minimumOutputRaw,
  });

  if (input.quote.steps.length !== 1) {
    throw new Error("unexpected Relay step count");
  }
  const step = input.quote.steps[0];
  if (!step) throw new Error("Relay deposit step missing");
  exact(step.id, "deposit", "step.id");
  exact(step.kind, "transaction", "step.kind");
  if (step.items.length !== 1) throw new Error("deposit item count mismatch");
  const item = step.items[0];
  if (!item) throw new Error("Relay deposit item missing");
  exact(item.status, "incomplete", "deposit item status");
  const requestId = step.requestId;
  bytes32(requestId, "step.requestId");
  const correlatedRequestId = item.check
    ? new URL(item.check.endpoint, "https://api.relay.link").searchParams.get(
        "requestId",
      )
    : null;
  if (item.check?.method !== "GET" || correlatedRequestId !== requestId) {
    throw new Error("deposit request correlation mismatch");
  }
  const dataKeys = Object.keys(item.data).sort();
  if (dataKeys.join(",") !== "addressLookupTableAddresses,instructions") {
    throw new Error("unexpected Solana action capability");
  }
  const lookupTables = array(
    item.data.addressLookupTableAddresses,
    "addressLookupTableAddresses",
  ).map((value, index) => publicKey(value, `lookupTables[${index}]`));
  if (lookupTables.length !== 2 || new Set(lookupTables).size !== 2) {
    throw new Error("native SOL route requires two distinct lookup tables");
  }
  const instructions = array(item.data.instructions, "instructions").map(
    instruction,
  );
  if (instructions.length !== 8) {
    throw new Error("native SOL route instruction count mismatch");
  }
  const usdcAta = getAssociatedTokenAddressSync(
    new PublicKey(SOLANA_USDC),
    new PublicKey(user),
  ).toBase58();
  const wrappedSolAta = getAssociatedTokenAddressSync(
    new PublicKey(WRAPPED_SOL_MINT),
    new PublicKey(user),
  ).toBase58();
  const [
    createAtaFirst,
    createAtaSecond,
    transfer,
    syncNative,
    swap,
    close,
    deposit,
    memo,
  ] = instructions;
  if (
    !createAtaFirst ||
    !createAtaSecond ||
    !transfer ||
    !syncNative ||
    !swap ||
    !close ||
    !deposit ||
    !memo
  ) {
    throw new Error("native SOL route instruction disappeared");
  }
  assertAtaCreationPair({
    instructions: [createAtaFirst, createAtaSecond],
    owner: user,
    creations: [
      { mint: SOLANA_USDC, ata: usdcAta },
      { mint: WRAPPED_SOL_MINT, ata: wrappedSolAta },
    ],
  });
  exact(transfer.programId, SOLANA_SYSTEM_PROGRAM, "transfer program");
  assertSignerSet(transfer, user, "SOL transfer");
  if (
    transfer.keys.length !== 2 ||
    transfer.data.byteLength !== 12 ||
    Buffer.from(transfer.data).readUInt32LE(0) !== 2 ||
    Buffer.from(transfer.data).readBigUInt64LE(4) !== sourceAmountRaw
  ) {
    throw new Error("native SOL transfer instruction mismatch");
  }
  assertAccount(
    transfer,
    0,
    { pubkey: user, isSigner: true, isWritable: true },
    "native SOL transfer source",
  );
  assertAccount(
    transfer,
    1,
    { pubkey: wrappedSolAta, isSigner: false, isWritable: true },
    "native SOL transfer destination",
  );
  exact(syncNative.programId, SPL_TOKEN_PROGRAM, "sync-native program");
  if (
    syncNative.keys.length !== 1 ||
    Buffer.from(syncNative.data).toString("hex") !== "11"
  ) {
    throw new Error("sync-native instruction mismatch");
  }
  assertAccount(
    syncNative,
    0,
    { pubkey: wrappedSolAta, isSigner: false, isWritable: true },
    "sync-native account",
  );
  validateJupiterSwap({
    instruction: swap,
    maximumSlippageBps: input.maximumSlippageBps,
    minimumPaymentAmountRaw: routeMinimumOutputRaw,
    paymentAmountRaw,
    sourceAmountRaw,
    user,
    usdcAta,
    wrappedSolAta,
  });

  exact(close.programId, SPL_TOKEN_PROGRAM, "close-account program");
  assertSignerSet(close, user, "wrapped SOL close");
  if (
    close.keys.length !== 3 ||
    Buffer.from(close.data).toString("hex") !== "09"
  ) {
    throw new Error("wrapped SOL close instruction mismatch");
  }
  assertAccount(
    close,
    0,
    { pubkey: wrappedSolAta, isSigner: false, isWritable: true },
    "wrapped SOL close source",
  );
  assertAccount(
    close,
    1,
    { pubkey: user, isSigner: false, isWritable: true },
    "wrapped SOL close recipient",
  );
  assertAccount(
    close,
    2,
    { pubkey: user, isSigner: true, isWritable: false },
    "wrapped SOL close authority",
  );

  validateRelayDeposit({
    instruction: deposit,
    orderId,
    user,
    usdcAta,
  });
  exact(memo.programId, MEMO_PROGRAM, "memo program");
  if (
    memo.keys.length !== 0 ||
    memo.data.byteLength > 256 ||
    Buffer.from(memo.data).toString("utf8") !== requestId
  ) {
    throw new Error("Relay memo instruction mismatch");
  }

  return {
    sourceAmountRaw,
    sourceEstimatedUsd: details.currencyIn.amountUsd ?? null,
    expectedOutputRaw,
    minimumOutputRaw,
    requestId,
    instructions: instructions.map((item) => ({
      ...item,
      addressLookupTableAddresses: lookupTables,
    })),
  };
}
