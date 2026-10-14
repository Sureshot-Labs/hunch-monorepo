import { z } from "zod";
import { canonicalJsonHash } from "../../funding/persistence/canonical.js";
import { HYPERCORE_MAINNET_USDC } from "../../funding/domain/hypercore-identity.js";
import { validateRelayHypercoreActions } from "./hypercore-actions.js";
import { normalizeRelayHypercoreFees } from "./fees.js";
import { relayHexOrderId } from "./order-hash.js";
import { relayHexV2ProtocolSchema } from "./order-contract.js";
import { BASE_USDC, POLYGON_PUSD } from "./rehearsal.js";
import {
  relayQuoteResponseSchema,
  rejectDisabledRelayCapabilities,
} from "./schemas.js";

const address = z.string().regex(/^0x[\da-fA-F]{40}$/u);
const raw = z.string().regex(/^(0|[1-9]\d*)$/u);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const perpsCurrency = `0x${"0".repeat(32)}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Selected independent /chains facts, not a depository supplied by a quote.
 * No RPC URL or generic provider executable payload escapes this boundary. */
const chainSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  disabled: z.boolean(),
  depositEnabled: z.boolean(),
  vmType: z.string(),
  protocol: z.object({
    v2: z.object({ chainId: z.string(), depository: address }),
  }),
  solverAddresses: z.array(address),
  contracts: z.object({ erc20Router: z.union([address, z.literal("")]) }),
});
export function resolveRelayHypercoreContracts(
  value: unknown,
  destinationChainId: 137 | 8453,
) {
  const entries = z
    .object({ chains: z.array(z.object({ id: z.number() }).passthrough()) })
    .parse(value).chains;
  const exact = (id: number) => {
    const selected = entries.filter((row) => row.id === id);
    if (selected.length !== 1)
      throw new Error("native_chain_contract_identity_mismatch");
    const chain = chainSchema.parse(selected[0]);
    if (chain.disabled || !chain.depositEnabled)
      throw new Error("native_chain_unavailable");
    return chain;
  };
  const native = exact(1337),
    destination = exact(destinationChainId);
  const destinationChain = destinationChainId === 8453 ? "base" : "polygon";
  if (
    native.name !== "hyperliquid" ||
    native.vmType !== "hypevm" ||
    native.protocol.v2.chainId !== "hyperliquid" ||
    destination.vmType !== "evm" ||
    destination.protocol.v2.chainId !== destinationChain ||
    destination.name !== destinationChain
  )
    throw new Error("native_chain_contract_identity_mismatch");
  const router = address.parse(destination.contracts.erc20Router);
  const facts = {
    depository: native.protocol.v2.depository.toLowerCase(),
    solvers: native.solverAddresses.map((v) => v.toLowerCase()),
    destinationChainId,
    destinationChain,
    evmDepository: destination.protocol.v2.depository.toLowerCase(),
    evmSolvers: destination.solverAddresses.map((v) => v.toLowerCase()),
    destinationExtraData: `0x${router.slice(2).toLowerCase().padStart(64, "0")}`,
  };
  if (facts.solvers.length === 0)
    throw new Error("native_chain_solver_missing");
  return { ...facts, revision: canonicalJsonHash(facts) };
}

const protocolSchema = relayHexV2ProtocolSchema({
  sourceChain: z.literal("hyperliquid"),
  sourceCurrency: z.literal(perpsCurrency),
  outputCurrency: address,
});

export type RelayHypercoreQuoteInput = Readonly<{
  quote: unknown;
  contracts: ReturnType<typeof resolveRelayHypercoreContracts>;
  contractsObservedAt: Date;
  maximumContractAgeMs: number;
  owner: string;
  recipient: string;
  /** Owned refund recipient, resolved independently even for an external withdrawal. */
  destinationRefundRecipient: string;
  destinationCurrency: string;
  sourceDex: "spot" | "";
  amountMode: "exact_input" | "expected_output";
  authorizedSourceRaw: string;
  minimumOutputRaw: string;
  expectedOutputTargetRaw: string;
  maximumFeeRaw: string;
  now: Date;
  deadline: Date;
  maximumQuoteTtlMs: number;
}>;

/** Pure validation for a single native USDC -> EVM stable route. It does not
 * claim source capacity, reserve funds or authorize execution. All limits come
 * from the existing funding policy/intent. Solana needs its own exact protocol
 * destination envelope before it can be admitted here. */
export function validateRelayHypercoreQuote(input: RelayHypercoreQuoteInput) {
  const owner = address.parse(input.owner),
    recipient = address.parse(input.recipient);
  const refundRecipient = address.parse(input.destinationRefundRecipient);
  const target = address.parse(input.destinationCurrency).toLowerCase();
  const allowedCurrencies =
    input.contracts.destinationChainId === 8453
      ? [BASE_USDC.toLowerCase()]
      : [
          POLYGON_PUSD.toLowerCase(),
          "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
        ];
  if (!allowedCurrencies.includes(target))
    throw new Error("native_destination_currency_unsupported");
  const cap = BigInt(raw.parse(input.authorizedSourceRaw));
  const floor = BigInt(raw.parse(input.minimumOutputRaw));
  const outputTarget = BigInt(raw.parse(input.expectedOutputTargetRaw));
  const feeCap = BigInt(raw.parse(input.maximumFeeRaw));
  if (cap <= 0n || floor <= 0n || outputTarget < floor)
    throw new Error("native_quote_limits_invalid");
  const now = timestamp.parse(input.now.getTime());
  const deadline = timestamp.parse(input.deadline.getTime());
  const observedAt = timestamp.parse(input.contractsObservedAt.getTime());
  for (const interval of [input.maximumContractAgeMs, input.maximumQuoteTtlMs])
    if (!Number.isSafeInteger(interval) || interval <= 0)
      throw new Error("native_quote_timing_invalid");
  if (
    deadline <= now ||
    observedAt > now ||
    now - observedAt > input.maximumContractAgeMs
  )
    throw new Error("native_quote_or_contract_expired");
  rejectDisabledRelayCapabilities(input.quote);
  const quote = relayQuoteResponseSchema.parse(input.quote);
  if (quote.depositAddress)
    throw new Error("native_deposit_address_unsupported");
  if (
    !quote.details.sender ||
    !quote.details.recipient ||
    !same(quote.details.sender, owner) ||
    !same(quote.details.recipient, recipient)
  )
    throw new Error("native_quote_owner_mismatch");
  const source = quote.details.currencyIn,
    destination = quote.details.currencyOut;
  if (
    source.currency.chainId !== 1337 ||
    source.currency.decimals !== 8 ||
    !same(
      source.currency.address,
      input.sourceDex === "spot"
        ? HYPERCORE_MAINNET_USDC.assetId
        : perpsCurrency,
    ) ||
    destination.currency.chainId !== input.contracts.destinationChainId ||
    destination.currency.decimals !== 6 ||
    !same(destination.currency.address, target)
  )
    throw new Error("native_quote_currency_mismatch");
  const sourceRaw = BigInt(source.amount),
    expectedOutputRaw = BigInt(destination.amount),
    minimumOutputRaw = BigInt(destination.minimumAmount);
  if (
    sourceRaw <= 0n ||
    source.minimumAmount !== source.amount ||
    sourceRaw > cap ||
    (input.amountMode === "exact_input" && sourceRaw !== cap)
  )
    throw new Error("native_quote_source_cap_mismatch");
  if (
    minimumOutputRaw < floor ||
    expectedOutputRaw < minimumOutputRaw ||
    (input.amountMode === "expected_output" && expectedOutputRaw < outputTarget)
  )
    throw new Error("native_quote_output_floor_mismatch");
  const protocol = protocolSchema.parse(quote.protocol).v2;
  // Optional presentation summary is not refund authority, but a conflicting
  // summary must not reach the UI beside a different signed protocol path.
  if (quote.details.refundCurrency !== undefined) {
    const refund = z
      .object({
        currency: z.object({
          chainId: z.literal(1337),
          address: z.literal(perpsCurrency),
          decimals: z.literal(8),
        }),
        amount: raw,
        minimumAmount: raw,
      })
      .parse(quote.details.refundCurrency);
    if (
      refund.amount !== source.amount ||
      refund.minimumAmount !== source.amount
    )
      throw new Error("native_quote_refund_summary_mismatch");
  }
  const data = protocol.orderData,
    payment = protocol.paymentDetails,
    output = data.output;
  if (relayHexOrderId(data).toLowerCase() !== protocol.orderId.toLowerCase())
    throw new Error("native_quote_order_hash_mismatch");
  const routePayment = data.inputs[0].payment,
    outputPayment = output.payments[0];
  if (
    !same(payment.depository, input.contracts.depository) ||
    !input.contracts.solvers.some((s) => same(s, data.solver)) ||
    payment.amount !== source.amount ||
    routePayment.amount !== source.amount ||
    output.chainId !== input.contracts.destinationChain ||
    !same(outputPayment.recipient, recipient) ||
    !same(outputPayment.currency, target) ||
    outputPayment.minimumAmount !== destination.minimumAmount ||
    outputPayment.expectedAmount !== destination.amount ||
    output.extraData.toLowerCase() !== input.contracts.destinationExtraData
  )
    throw new Error("native_quote_protocol_binding_mismatch");
  const nativeRefund = data.inputs[0].refunds.find(
    (v) => v.chainId === "hyperliquid",
  );
  const destinationRefund = data.inputs[0].refunds.find(
    (v) => v.chainId === input.contracts.destinationChain,
  );
  if (
    !nativeRefund ||
    !destinationRefund ||
    !same(nativeRefund.recipient, owner) ||
    nativeRefund.currency !== perpsCurrency ||
    nativeRefund.extraData !== "0x" ||
    !same(destinationRefund.recipient, refundRecipient) ||
    !same(destinationRefund.currency, target) ||
    destinationRefund.extraData.toLowerCase() !==
      input.contracts.destinationExtraData ||
    nativeRefund.minimumAmount !== "0" ||
    destinationRefund.minimumAmount !== "0" ||
    nativeRefund.deadline !== output.deadline ||
    destinationRefund.deadline !== output.deadline
  )
    throw new Error("native_quote_refund_binding_mismatch");
  // Protocol refund deadlines are not our permission to sign for seven days.
  const protocolDeadlineMs = output.deadline * 1000;
  const expiry = Math.min(
    deadline,
    now + input.maximumQuoteTtlMs,
    observedAt + input.maximumContractAgeMs,
    protocolDeadlineMs,
  );
  if (
    !Number.isSafeInteger(protocolDeadlineMs) ||
    !Number.isSafeInteger(expiry) ||
    expiry <= now
  )
    throw new Error("native_quote_or_contract_expired");
  if (!quote.fees?.gas || !quote.fees.relayer || !quote.fees.app)
    throw new Error("native_quote_fee_coverage_missing");
  const normalizedFees = normalizeRelayHypercoreFees(quote);
  const feeRaw = normalizedFees.fees.reduce(
    (sum, fee) => sum + BigInt(fee.amount.raw),
    0n,
  );
  if (feeRaw > feeCap || feeRaw >= sourceRaw)
    throw new Error("native_quote_fee_cap_exceeded");
  if (!same(target, POLYGON_PUSD)) {
    // Exact USDC bridge only: output raw6 and input raw8 share the same units.
    // An unsigned fee summary cannot conceal cost in the committed output.
    // Downscaling can truncate at most 99 raw8; minimum-output slippage is not
    // an additional route fee. pUSD is a different asset, not a 1:1 assumption.
    const expectedLossRaw8 = sourceRaw - expectedOutputRaw * 100n;
    if (expectedLossRaw8 > feeCap + 99n)
      throw new Error("native_quote_effective_fee_cap_exceeded");
    if (expectedLossRaw8 > feeRaw + 99n)
      throw new Error("native_quote_fee_summary_understates_cost");
  }
  // Native authorization fields carry only the nonce/order link. The exact
  // monetary identities were checked above against frozen intent + contracts.
  const [first] = quote.steps;
  if (!first) throw new Error("native_steps_missing");
  const authNonce = z
    .object({ sign: z.object({ value: z.object({ nonce: timestamp }) }) })
    .parse(first.items[0]?.data).sign.value.nonce;
  if (
    authNonce < now - input.maximumQuoteTtlMs ||
    authNonce > now + input.maximumQuoteTtlMs
  )
    throw new Error("native_quote_nonce_expired");
  const actions = validateRelayHypercoreActions(quote.steps, {
    requestId: first.requestId,
    protocolOrderId: protocol.orderId,
    owner,
    authorizationDepositor: owner,
    depository: input.contracts.depository,
    sourceDex: input.sourceDex,
    destinationDex: "",
    nonce: authNonce,
    sourceRaw: source.amount,
  });
  return {
    actions,
    sourceAmountRaw: sourceRaw,
    expectedOutputRaw,
    minimumOutputRaw,
    fees: normalizedFees.fees,
    feeBreakdownVarianceRaw: normalizedFees.breakdownVarianceRaw,
    expiresAt: new Date(expiry),
    contractsRevision: input.contracts.revision,
    // A spot withdrawal can refund into owned perps cash; never label it spot.
    refundSourceDex: "" as const,
    fingerprint: canonicalJsonHash({
      actions: actions.fingerprint,
      protocol,
      fees: normalizedFees,
      expiresAt: expiry,
      contracts: input.contracts.revision,
    }),
  };
}
