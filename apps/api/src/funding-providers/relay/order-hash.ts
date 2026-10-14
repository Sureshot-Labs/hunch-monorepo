import { TypedDataEncoder } from "ethers";

// Protocol wire definition: Relay settlement SDK, commit
// 98ad1a0af009c247fb85205c2119f7371e684520, packages/sdk/src/order/index.ts.
// https://github.com/relayprotocol/relay-settlement
// This is hashStruct(Order), NOT an EIP-712 domain-signed digest. Keep private
// so callers cannot mutate field definitions used by subsequent validations.
const TYPES = {
  Order: [
    { name: "version", type: "string" },
    { name: "solverChainId", type: "string" },
    { name: "solver", type: "address" },
    { name: "salt", type: "uint256" },
    { name: "inputs", type: "Input[]" },
    { name: "output", type: "Output" },
    { name: "fees", type: "Fee[]" },
  ],
  Input: [
    { name: "payment", type: "InputPayment" },
    { name: "refunds", type: "InputRefund[]" },
  ],
  InputPayment: [
    { name: "chainId", type: "string" },
    { name: "currency", type: "bytes" },
    { name: "amount", type: "uint256" },
    { name: "weight", type: "uint256" },
  ],
  InputRefund: [
    { name: "chainId", type: "string" },
    { name: "recipient", type: "bytes" },
    { name: "currency", type: "bytes" },
    { name: "minimumAmount", type: "uint256" },
    { name: "deadline", type: "uint32" },
    { name: "extraData", type: "bytes" },
  ],
  Output: [
    { name: "chainId", type: "string" },
    { name: "payments", type: "OutputPayment[]" },
    { name: "deadline", type: "uint32" },
    { name: "calls", type: "bytes[]" },
    { name: "extraData", type: "bytes" },
  ],
  OutputPayment: [
    { name: "recipient", type: "bytes" },
    { name: "currency", type: "bytes" },
    { name: "minimumAmount", type: "uint256" },
    { name: "expectedAmount", type: "uint256" },
  ],
  Fee: [
    { name: "recipientChainId", type: "string" },
    { name: "recipient", type: "bytes" },
    { name: "currencyChainId", type: "string" },
    { name: "currency", type: "bytes" },
    { name: "amount", type: "uint256" },
  ],
};

/** Input MUST have passed the native -> EVM strict protocol parser. For those
 * VMs all addresses/currencies already are exact hex bytes (native token 16
 * bytes, owner/ERC20 20 bytes); never pad them to a common address width.
 * Do not reuse this helper for Solana/base58 or another unnormalized VM. */
export function relayHexOrderId(
  order: Record<string, unknown> & { solver: string },
) {
  return TypedDataEncoder.hashStruct("Order", TYPES, {
    ...order,
    solver: order.solver.toLowerCase(),
  });
}
