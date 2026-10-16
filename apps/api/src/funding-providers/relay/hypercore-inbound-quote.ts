import { Interface } from "ethers";
import { z } from "zod";
import { canonicalJsonHash } from "../../funding/persistence/canonical.js";
import { HYPERCORE_MAINNET_USDC } from "../../funding/domain/hypercore-identity.js";
import { normalizeRelayFees } from "./fees.js";
import { relayHexV2ProtocolSchema } from "./order-contract.js";
import { relayHexOrderId } from "./order-hash.js";
import {
  BASE_USDC,
  POLYGON_PUSD,
  POLYGON_USDC,
  RELAY_DEPOSITORY_V2,
  assertEvmActionGasWithinHardPolicy,
  parseRelayEvmTransactionAction,
  validateRelayDepositoryV2Action,
} from "./rehearsal.js";
import {
  relayQuoteResponseSchema,
  rejectDisabledRelayCapabilities,
} from "./schemas.js";
import type { RelayHypercoreQuoteInput } from "./hypercore-quote.js";

const address = z.string().regex(/^0x[\da-fA-F]{40}$/u);
const raw = z.string().regex(/^(0|[1-9]\d*)$/u);
const perpsCurrency = `0x${"0".repeat(32)}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const approveInterface = new Interface([
  "function approve(address spender,uint256 amount)",
]);
const protocolSchema = relayHexV2ProtocolSchema({
  sourceChain: z.enum(["base", "polygon"]),
  sourceCurrency: address,
  outputCurrency: z
    .string()
    .regex(/^0x[\da-fA-F]{32}$/u)
    .refine((value) => same(value, HYPERCORE_MAINNET_USDC.assetId)),
});

export type RelayHypercoreInboundQuoteInput = Omit<
  RelayHypercoreQuoteInput,
  "sourceDex" | "destinationCurrency" | "destinationRefundRecipient"
> &
  Readonly<{ sourceCurrency: string }>;

/** Validate a native destination using the ordinary EVM source executor. This
 * function creates no operation/authority. The caller must independently prove
 * ownership of both source owner and native recipient and freeze BOTH refund
 * locations before admitting the common funding plan. */
export function validateRelayHypercoreInboundQuote(
  input: RelayHypercoreInboundQuoteInput,
) {
  const owner = address.parse(input.owner),
    recipient = address.parse(input.recipient);
  const sourceChainId = input.contracts.destinationChainId;
  const sourceChain = sourceChainId === 8453 ? "base" : "polygon";
  // Pinned by the selected source route, never inferred from the returned
  // quote. pUSD and USDC on Polygon are distinct economic instruments.
  const sourceCurrency = address.parse(input.sourceCurrency).toLowerCase();
  const allowedCurrencies =
    sourceChainId === 8453 ? [BASE_USDC] : [POLYGON_USDC, POLYGON_PUSD];
  if (
    ![137, 8453].includes(sourceChainId) ||
    input.contracts.destinationChain !== sourceChain ||
    !same(input.contracts.evmDepository, RELAY_DEPOSITORY_V2) ||
    input.contracts.evmSolvers.length === 0
  )
    throw new Error("native_inbound_source_contract_unsupported");
  if (!allowedCurrencies.some((currency) => same(currency, sourceCurrency)))
    throw new Error("native_inbound_source_currency_unsupported");
  const now = input.now.getTime(),
    deadline = input.deadline.getTime();
  const observedAt = input.contractsObservedAt.getTime();
  for (const value of [
    now,
    deadline,
    observedAt,
    input.maximumContractAgeMs,
    input.maximumQuoteTtlMs,
  ])
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("native_inbound_timing_invalid");
  if (
    deadline <= now ||
    observedAt > now ||
    now - observedAt >= input.maximumContractAgeMs
  )
    throw new Error("native_inbound_quote_or_contract_expired");
  const cap = BigInt(raw.parse(input.authorizedSourceRaw));
  const floor = BigInt(raw.parse(input.minimumOutputRaw));
  const outputTarget = BigInt(raw.parse(input.expectedOutputTargetRaw));
  const feeCap = BigInt(raw.parse(input.maximumFeeRaw));
  if (cap <= 0n || floor <= 0n || outputTarget < floor)
    throw new Error("native_inbound_limits_invalid");
  rejectDisabledRelayCapabilities(input.quote);
  const quote = relayQuoteResponseSchema.parse(input.quote);
  if (quote.depositAddress || quote.steps.some((step) => step.depositAddress))
    throw new Error("native_inbound_deposit_address_unsupported");
  if (
    !quote.details.sender ||
    !quote.details.recipient ||
    !same(quote.details.sender, owner) ||
    !same(quote.details.recipient, recipient)
  )
    throw new Error("native_inbound_owner_mismatch");
  const source = quote.details.currencyIn,
    destination = quote.details.currencyOut;
  if (
    source.currency.chainId !== sourceChainId ||
    source.currency.decimals !== 6 ||
    !same(source.currency.address, sourceCurrency) ||
    destination.currency.chainId !== 1337 ||
    destination.currency.decimals !== 8 ||
    !same(destination.currency.address, HYPERCORE_MAINNET_USDC.assetId)
  )
    throw new Error("native_inbound_currency_mismatch");
  const sourceRaw = BigInt(source.amount),
    expectedOutputRaw = BigInt(destination.amount);
  const minimumOutputRaw = BigInt(destination.minimumAmount);
  if (
    sourceRaw <= 0n ||
    sourceRaw > cap ||
    source.minimumAmount !== source.amount ||
    (input.amountMode === "exact_input" && sourceRaw !== cap)
  )
    throw new Error("native_inbound_source_cap_mismatch");
  if (
    minimumOutputRaw < floor ||
    expectedOutputRaw < minimumOutputRaw ||
    (input.amountMode === "expected_output" && expectedOutputRaw < outputTarget)
  )
    throw new Error("native_inbound_output_floor_mismatch");
  const protocol = protocolSchema.parse(quote.protocol).v2;
  const order = protocol.orderData,
    payment = protocol.paymentDetails;
  const origin = order.inputs[0].payment,
    output = order.output;
  const destinationPayment = output.payments[0];
  if (!same(relayHexOrderId(order), protocol.orderId))
    throw new Error("native_inbound_order_hash_mismatch");
  if (
    !input.contracts.evmSolvers.some((solver) => same(solver, order.solver)) ||
    origin.chainId !== sourceChain ||
    payment.chainId !== sourceChain ||
    !same(origin.currency, sourceCurrency) ||
    !same(payment.currency, sourceCurrency) ||
    !same(payment.depository, input.contracts.evmDepository) ||
    origin.amount !== source.amount ||
    payment.amount !== source.amount ||
    output.chainId !== "hyperliquid" ||
    output.extraData !== "0x" ||
    !same(destinationPayment.recipient, recipient) ||
    destinationPayment.expectedAmount !== destination.amount ||
    destinationPayment.minimumAmount !== destination.minimumAmount
  )
    throw new Error("native_inbound_protocol_binding_mismatch");
  const sourceRefund = order.inputs[0].refunds.find(
    (r) => r.chainId === sourceChain,
  );
  const nativeRefund = order.inputs[0].refunds.find(
    (r) => r.chainId === "hyperliquid",
  );
  if (
    !sourceRefund ||
    !nativeRefund ||
    !same(sourceRefund.recipient, owner) ||
    !same(sourceRefund.currency, sourceCurrency) ||
    !same(sourceRefund.extraData, input.contracts.destinationExtraData) ||
    !same(nativeRefund.recipient, recipient) ||
    nativeRefund.currency !== perpsCurrency ||
    nativeRefund.extraData !== "0x" ||
    sourceRefund.minimumAmount !== "0" ||
    nativeRefund.minimumAmount !== "0" ||
    sourceRefund.deadline !== output.deadline ||
    nativeRefund.deadline !== output.deadline
  )
    throw new Error("native_inbound_refund_binding_mismatch");
  if (quote.details.refundCurrency !== undefined) {
    const refund = z
      .object({
        currency: z.object({
          chainId: z.number(),
          address: z.string(),
          decimals: z.number(),
        }),
        amount: raw,
        minimumAmount: raw,
      })
      .parse(quote.details.refundCurrency);
    if (
      refund.currency.chainId !== sourceChainId ||
      refund.currency.decimals !== 6 ||
      !same(refund.currency.address, sourceCurrency) ||
      refund.amount !== source.amount ||
      refund.minimumAmount !== source.amount
    )
      throw new Error("native_inbound_refund_summary_mismatch");
  }
  const protocolDeadline = output.deadline * 1000;
  const expiry = Math.min(
    deadline,
    now + input.maximumQuoteTtlMs,
    observedAt + input.maximumContractAgeMs,
    protocolDeadline,
  );
  if (
    !Number.isSafeInteger(protocolDeadline) ||
    !Number.isSafeInteger(expiry) ||
    expiry <= now
  )
    throw new Error("native_inbound_quote_or_contract_expired");
  if (!quote.fees?.gas || !quote.fees?.relayer || !quote.fees?.app)
    throw new Error("native_inbound_fee_coverage_missing");
  // Gas stays ETH/POL18; it is NOT USDC6 and cannot be added to raw USDC fees.
  // Keep it in the result for the common planner's gas capacity/USD fee policy.
  // Validate denomination even for zero summary fees (normalizer omits zeros).
  for (const [kind, fee] of Object.entries(quote.fees))
    if (
      fee.currency.chainId !== sourceChainId ||
      fee.currency.decimals !== (kind === "gas" ? 18 : 6) ||
      !same(
        fee.currency.address,
        kind === "gas" ? `0x${"0".repeat(40)}` : sourceCurrency,
      )
    )
      throw new Error("native_inbound_fee_currency_mismatch");
  const fees = normalizeRelayFees(quote);
  const feeRaw = fees
    .filter((fee) => fee.kind !== "gas")
    .reduce((sum, fee) => sum + BigInt(fee.amount.raw), 0n);
  if (feeRaw > feeCap || feeRaw >= sourceRaw)
    throw new Error("native_inbound_fee_cap_exceeded");
  // Registered USD stablecoins, different raw precision. Expected output also
  // bounds the route cost: a forged/omitted fee summary cannot hide a loss.
  // Do not use the slippage floor or add ETH/POL gas to this nominal-USDC cost.
  const expectedLossRaw8 = sourceRaw * 100n - expectedOutputRaw;
  if (expectedLossRaw8 > feeCap * 100n)
    throw new Error("native_inbound_effective_fee_cap_exceeded");
  // USDC6 fee reporting can round by < one raw6 unit, never by whole dollars.
  if (expectedLossRaw8 > feeRaw * 100n + 99n)
    throw new Error("native_inbound_fee_summary_understates_cost");

  const ids = quote.steps.map((step) => step.id).join(",");
  if (ids !== "approve,deposit" && ids !== "deposit")
    throw new Error("native_inbound_step_sequence_invalid");
  const parsed = quote.steps.map((step) =>
    parseRelayEvmTransactionAction({
      expectedStepId: step.id as "approve" | "deposit",
      quoteStep: step,
      originChainId: sourceChainId,
      user: owner,
    }),
  );
  const first = parsed[0];
  if (!first) throw new Error("native_inbound_step_sequence_invalid");
  const requestId = first.requestId;
  if (parsed.some((step) => step.requestId !== requestId))
    throw new Error("native_inbound_request_correlation_mismatch");
  const actions = parsed.map(({ action }) => action);
  for (const action of actions) {
    assertEvmActionGasWithinHardPolicy(action);
    if (action.stepId === "approve") {
      const approval = approveInterface.decodeFunctionData(
        "approve",
        action.data,
      );
      if (
        !same(action.to, sourceCurrency) ||
        action.value !== 0n ||
        !same(approval.spender, input.contracts.evmDepository) ||
        approval.amount !== sourceRaw ||
        !same(
          action.data,
          approveInterface.encodeFunctionData("approve", [
            approval.spender,
            approval.amount,
          ]),
        )
      )
        throw new Error("native_inbound_approval_binding_mismatch");
    } else {
      const orderId = validateRelayDepositoryV2Action({
        action,
        amount: sourceRaw,
        token: sourceCurrency,
        user: owner,
      });
      // requestId is Relay's correlation ID, NOT the protocol commitment.
      if (!same(orderId, protocol.orderId) || action.data.length !== 266)
        throw new Error("native_inbound_deposit_order_mismatch");
    }
  }
  return {
    actions,
    requestId,
    orderId: protocol.orderId,
    sourceAmountRaw: sourceRaw,
    expectedOutputRaw,
    minimumOutputRaw,
    fees,
    expiresAt: new Date(expiry),
    contractsRevision: input.contracts.revision,
    refundTargets: {
      source: { owner, chainId: sourceChainId, currency: sourceCurrency },
      native: {
        owner: recipient,
        asset: HYPERCORE_MAINNET_USDC,
        dex: "" as const,
      },
    },
    fingerprint: canonicalJsonHash({
      actions: actions.map((action) =>
        Object.fromEntries(
          Object.entries(action).map(([key, value]) => [
            key,
            typeof value === "bigint" ? value.toString() : value,
          ]),
        ),
      ),
      protocol,
      fees,
      expiresAt: expiry,
      contracts: input.contracts.revision,
    }),
  };
}
