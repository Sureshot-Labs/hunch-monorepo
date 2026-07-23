import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { getAddress } from "ethers";
import {
  POLYGON_PUSD,
  RELAY_SOLANA_CHAIN_ID,
  RELAY_SOLVER,
  SOLANA_USDC,
} from "./rehearsal.js";

export const RELAY_SOLANA_DEPOSITORY =
  "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2";
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SPL_ASSOCIATED_TOKEN_PROGRAM =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SOLANA_SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const POLYGON_USDCE = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

type UnknownRecord = Record<string, unknown>;

export type ValidatedSolanaInstruction = {
  addressLookupTableAddresses: string[];
  data: Uint8Array;
  keys: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  programId: string;
};

export type ValidatedSolanaRelayQuote = {
  expectedOutputRaw: bigint;
  instruction: ValidatedSolanaInstruction;
  minimumOutputRaw: bigint;
  requestId: string;
};

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

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is required`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function unsigned(value: unknown, label: string): bigint {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^\d+$/.test(String(value))
  ) {
    throw new Error(`${label} must be an unsigned integer`);
  }
  return BigInt(String(value));
}

function publicKey(value: unknown, label: string): string {
  try {
    return new PublicKey(string(value, label)).toBase58();
  } catch {
    throw new Error(`${label} must be a Solana public key`);
  }
}

function evmAddress(value: unknown, label: string): string {
  try {
    return getAddress(string(value, label));
  } catch {
    throw new Error(`${label} must be an EVM address`);
  }
}

function sameEvmAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function assertExact(
  actual: unknown,
  expected: string | number | boolean,
  label: string,
): void {
  if (actual !== expected) throw new Error(`${label} mismatch`);
}

function currencyAmount(
  details: UnknownRecord,
  field: "currencyIn" | "currencyOut",
  expected: {
    address: string;
    amount?: bigint;
    chainId: number;
    decimals: number;
    vm: "evm" | "svm";
  },
): { amount: bigint; minimumAmount: bigint } {
  const value = record(details[field], `details.${field}`);
  const currency = record(value.currency, `details.${field}.currency`);
  if (Number(currency.chainId) !== expected.chainId) {
    throw new Error(`details.${field}.currency.chainId mismatch`);
  }
  if (expected.vm === "svm") {
    assertExact(
      publicKey(currency.address, `details.${field}.currency.address`),
      expected.address,
      `details.${field}.currency.address`,
    );
  } else if (
    !sameEvmAddress(
      evmAddress(currency.address, `details.${field}.currency.address`),
      expected.address,
    )
  ) {
    throw new Error(`details.${field}.currency.address mismatch`);
  }
  if (
    currency.decimals !== undefined &&
    Number(currency.decimals) !== expected.decimals
  ) {
    throw new Error(`details.${field}.currency.decimals mismatch`);
  }
  const amount = unsigned(value.amount, `details.${field}.amount`);
  const minimumAmount = unsigned(
    value.minimumAmount,
    `details.${field}.minimumAmount`,
  );
  if (expected.amount !== undefined && amount !== expected.amount) {
    throw new Error(`details.${field}.amount mismatch`);
  }
  if (minimumAmount > amount) {
    throw new Error(`details.${field}.minimumAmount exceeds amount`);
  }
  return { amount, minimumAmount };
}

function validateProtocol(input: {
  amount: bigint;
  expectedOutputRaw: bigint;
  minimumOutputRaw: bigint;
  protocolValue: unknown;
  recipient: string;
  user: string;
}): void {
  const protocol = record(input.protocolValue, "protocol");
  const v2 = record(protocol.v2, "protocol.v2");
  assertExact(v2.hubType, "onchain", "protocol.v2.hubType");
  const payment = record(v2.paymentDetails, "protocol.v2.paymentDetails");
  assertExact(payment.chainId, "solana", "paymentDetails.chainId");
  assertExact(
    publicKey(payment.depository, "paymentDetails.depository"),
    RELAY_SOLANA_DEPOSITORY,
    "paymentDetails.depository",
  );
  assertExact(
    publicKey(payment.currency, "paymentDetails.currency"),
    SOLANA_USDC,
    "paymentDetails.currency",
  );
  if (unsigned(payment.amount, "paymentDetails.amount") !== input.amount) {
    throw new Error("paymentDetails.amount mismatch");
  }

  const orderData = record(v2.orderData, "protocol.v2.orderData");
  assertExact(orderData.version, "v1", "orderData.version");
  if (
    !sameEvmAddress(
      evmAddress(orderData.solver, "orderData.solver"),
      RELAY_SOLVER,
    )
  ) {
    throw new Error("orderData.solver mismatch");
  }
  assertExact(orderData.solverChainId, "base", "orderData.solverChainId");
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
  assertExact(orderPayment.chainId, "solana", "input.payment.chainId");
  assertExact(
    publicKey(orderPayment.currency, "input.payment.currency"),
    SOLANA_USDC,
    "input.payment.currency",
  );
  if (unsigned(orderPayment.amount, "input.payment.amount") !== input.amount) {
    throw new Error("input.payment.amount mismatch");
  }
  assertExact(orderPayment.weight, "1", "input.payment.weight");
  const refunds = array(orderInput.refunds, "orderData.inputs[0].refunds");
  if (refunds.length !== 2) throw new Error("refund policy count mismatch");
  const solanaRefund = refunds
    .map((value, index) => record(value, `refunds[${index}]`))
    .find((refund) => refund.chainId === "solana");
  const polygonRefund = refunds
    .map((value, index) => record(value, `refunds[${index}]`))
    .find((refund) => refund.chainId === "polygon");
  if (!solanaRefund || !polygonRefund) {
    throw new Error("required controlled refund paths missing");
  }
  assertExact(
    publicKey(solanaRefund.recipient, "solana refund recipient"),
    input.user,
    "solana refund recipient",
  );
  assertExact(
    publicKey(solanaRefund.currency, "solana refund currency"),
    SOLANA_USDC,
    "solana refund currency",
  );
  if (
    !sameEvmAddress(
      evmAddress(polygonRefund.recipient, "polygon refund recipient"),
      input.recipient,
    )
  ) {
    throw new Error("polygon refund recipient mismatch");
  }
  if (
    !sameEvmAddress(
      evmAddress(polygonRefund.currency, "polygon refund currency"),
      POLYGON_USDCE,
    )
  ) {
    throw new Error("polygon refund currency mismatch");
  }

  const output = record(orderData.output, "orderData.output");
  assertExact(output.chainId, "polygon", "output.chainId");
  if (array(output.calls, "output.calls").length !== 0) {
    throw new Error("output.calls must be empty");
  }
  const payments = array(output.payments, "output.payments");
  if (payments.length !== 1) throw new Error("output payment count mismatch");
  const outputPayment = record(payments[0], "output.payments[0]");
  if (
    !sameEvmAddress(
      evmAddress(outputPayment.recipient, "output recipient"),
      input.recipient,
    )
  ) {
    throw new Error("output recipient mismatch");
  }
  if (
    !sameEvmAddress(
      evmAddress(outputPayment.currency, "output currency"),
      POLYGON_PUSD,
    )
  ) {
    throw new Error("output currency mismatch");
  }
  if (
    unsigned(outputPayment.minimumAmount, "output minimumAmount") !==
      input.minimumOutputRaw ||
    unsigned(outputPayment.expectedAmount, "output expectedAmount") !==
      input.expectedOutputRaw
  ) {
    throw new Error("output amount correlation mismatch");
  }
}

export function validateRelaySolanaRehearsalQuote(input: {
  amount: bigint;
  minimumOutputFloor: bigint;
  quote: unknown;
  recipient: string;
  user: string;
}): ValidatedSolanaRelayQuote {
  if (input.amount <= 0n) throw new Error("amount must be positive");
  const user = publicKey(input.user, "user");
  const recipient = evmAddress(input.recipient, "recipient");
  const quote = record(input.quote, "quote");
  if (
    quote.depositAddress !== undefined &&
    quote.depositAddress !== "" &&
    quote.depositAddress !== null
  ) {
    throw new Error("Deposit Address mode is forbidden");
  }
  const details = record(quote.details, "details");
  assertExact(
    publicKey(details.sender, "details.sender"),
    user,
    "details.sender",
  );
  if (
    !sameEvmAddress(
      evmAddress(details.recipient, "details.recipient"),
      recipient,
    )
  ) {
    throw new Error("details.recipient mismatch");
  }
  currencyAmount(details, "currencyIn", {
    address: SOLANA_USDC,
    amount: input.amount,
    chainId: RELAY_SOLANA_CHAIN_ID,
    decimals: 6,
    vm: "svm",
  });
  const output = currencyAmount(details, "currencyOut", {
    address: POLYGON_PUSD,
    chainId: 137,
    decimals: 6,
    vm: "evm",
  });
  if (output.minimumAmount < input.minimumOutputFloor) {
    throw new Error("quote minimum output below authorized floor");
  }
  validateProtocol({
    amount: input.amount,
    expectedOutputRaw: output.amount,
    minimumOutputRaw: output.minimumAmount,
    protocolValue: quote.protocol,
    recipient,
    user,
  });

  const steps = array(quote.steps, "steps");
  if (steps.length !== 1) throw new Error("unexpected Relay step count");
  const step = record(steps[0], "steps[0]");
  assertExact(step.id, "deposit", "step.id");
  assertExact(step.kind, "transaction", "step.kind");
  const requestId = string(step.requestId, "step.requestId");
  const items = array(step.items, "step.items");
  if (items.length !== 1) throw new Error("deposit item count mismatch");
  const item = record(items[0], "step.items[0]");
  assertExact(item.status, "incomplete", "deposit item status");
  const check = record(item.check, "deposit.check");
  assertExact(check.method, "GET", "deposit.check.method");
  const correlatedRequestId = new URL(
    string(check.endpoint, "deposit.check.endpoint"),
    "https://api.relay.link",
  ).searchParams.get("requestId");
  if (correlatedRequestId !== requestId) {
    throw new Error("deposit request correlation mismatch");
  }
  const data = record(item.data, "deposit.data");
  const dataKeys = Object.keys(data).sort();
  if (dataKeys.join(",") !== "addressLookupTableAddresses,instructions") {
    throw new Error("unexpected Solana action capability");
  }
  const lookupTables = array(
    data.addressLookupTableAddresses,
    "addressLookupTableAddresses",
  ).map((value, index) => publicKey(value, `lookupTables[${index}]`));
  if (lookupTables.length !== 1) {
    throw new Error("exactly one address lookup table is required");
  }
  const instructions = array(data.instructions, "instructions");
  if (instructions.length !== 1) {
    throw new Error("exactly one Relay instruction is required");
  }
  const instruction = record(instructions[0], "instructions[0]");
  const programId = publicKey(instruction.programId, "instruction.programId");
  assertExact(programId, RELAY_SOLANA_DEPOSITORY, "instruction.programId");
  const encodedData = string(instruction.data, "instruction.data");
  if (!/^[0-9a-f]+$/iu.test(encodedData) || encodedData.length % 2 !== 0) {
    throw new Error("instruction.data must be hex without a prefix");
  }
  const decodedData = Buffer.from(encodedData, "hex");
  if (
    decodedData.byteLength !== 48 ||
    decodedData.toString("hex").toLowerCase() !== encodedData.toLowerCase()
  ) {
    throw new Error("instruction.data encoding or length mismatch");
  }
  const keys = array(instruction.keys, "instruction.keys").map(
    (value, index) => {
      const key = record(value, `instruction.keys[${index}]`);
      if (
        typeof key.isSigner !== "boolean" ||
        typeof key.isWritable !== "boolean"
      ) {
        throw new Error(`instruction.keys[${index}] flags invalid`);
      }
      return {
        pubkey: publicKey(key.pubkey, `instruction.keys[${index}].pubkey`),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      };
    },
  );
  if (keys.length !== 10) throw new Error("instruction key count mismatch");
  const signerIndexes = keys.flatMap((key, index) =>
    key.isSigner ? [index] : [],
  );
  if (signerIndexes.length !== 1 || signerIndexes[0] !== 1) {
    throw new Error("only the controlled burner may sign");
  }
  assertExact(
    required(keys[1], "signer account").pubkey,
    user,
    "signer account",
  );
  assertExact(
    required(keys[1], "signer account").isWritable,
    true,
    "signer writable flag",
  );
  assertExact(
    required(keys[2], "depositor account").pubkey,
    user,
    "depositor account",
  );
  assertExact(
    required(keys[2], "depositor account").isWritable,
    false,
    "depositor writable flag",
  );
  assertExact(
    required(keys[4], "mint account").pubkey,
    SOLANA_USDC,
    "mint account",
  );
  const expectedSourceAta = getAssociatedTokenAddressSync(
    new PublicKey(SOLANA_USDC),
    new PublicKey(user),
  ).toBase58();
  assertExact(
    required(keys[5], "source token account").pubkey,
    expectedSourceAta,
    "source token account",
  );
  assertExact(
    required(keys[7], "token program").pubkey,
    SPL_TOKEN_PROGRAM,
    "token program",
  );
  assertExact(
    required(keys[8], "associated token program").pubkey,
    SPL_ASSOCIATED_TOKEN_PROGRAM,
    "associated token program",
  );
  assertExact(
    required(keys[9], "system program").pubkey,
    SOLANA_SYSTEM_PROGRAM,
    "system program",
  );
  const writableIndexes = keys.flatMap((key, index) =>
    key.isWritable ? [index] : [],
  );
  if (writableIndexes.join(",") !== "1,5,6") {
    throw new Error("unexpected writable account set");
  }

  return {
    expectedOutputRaw: output.amount,
    minimumOutputRaw: output.minimumAmount,
    requestId,
    instruction: {
      addressLookupTableAddresses: lookupTables,
      data: decodedData,
      keys,
      programId,
    },
  };
}
