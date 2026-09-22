import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { NormalizedAction } from "../../domain/types.js";
import { deriveSafeProxyAddress } from "../../../services/polymarket-safe-address.js";
import {
  SAFE_FUNDING_SUBMISSION_METADATA,
  SAFE_FUNDING_TX_TYPES,
  parseSafeFundingSubmission,
  validateSafeFundingSubmission,
} from "../../execution/safe-funding-submission-contract.js";
import { validatePolymarketRelayerSignRequestForWallet } from "../../../services/polymarket-relayer-signing.js";

const signer = ethers.Wallet.createRandom();
const safe = deriveSafeProxyAddress(signer.address);
assert.ok(safe);
const token = "0x0000000000000000000000000000000000000001";
const data = new ethers.Interface([
  "function transfer(address,uint256)",
]).encodeFunctionData("transfer", [signer.address, 12]);
const action = {
  kind: "external_handoff",
  networkId: "evm:137",
  handoffKind: "polymarket_safe_transfer",
  payload: {
    topology: "safe",
    token,
    funder: safe,
    recipient: signer.address,
    amountRaw: "12",
    calls: [{ target: token, data, value: "0" }],
  },
} as unknown as NormalizedAction;
const validation = {
  tokenAddress: token,
  funderAddress: safe,
  recipientAddress: signer.address,
  signerAddress: signer.address,
  amountRaw: "12",
  transferData: data,
  executionEnvelope: "polymarket_safe_to_controller_v1",
};
const safeTransactionHash = ethers.TypedDataEncoder.hash(
  { chainId: 137, verifyingContract: safe },
  SAFE_FUNDING_TX_TYPES,
  {
    to: token,
    value: 0,
    data,
    operation: 0,
    safeTxGas: 0,
    baseGas: 0,
    gasPrice: 0,
    gasToken: ethers.ZeroAddress,
    refundReceiver: ethers.ZeroAddress,
    nonce: "5",
  },
);
const ordinarySignature = await signer.signMessage(
  ethers.getBytes(safeTransactionHash),
);
const signature =
  ordinarySignature.slice(0, -2) +
  (Number.parseInt(ordinarySignature.slice(-2), 16) + 4).toString(16);
const request = {
  from: signer.address,
  to: token,
  proxyWallet: safe,
  data,
  nonce: "5",
  signature,
  signatureParams: {
    gasPrice: "0",
    operation: "0",
    safeTxnGas: "0",
    baseGas: "0",
    gasToken: ethers.ZeroAddress,
    refundReceiver: ethers.ZeroAddress,
  },
  type: "SAFE",
  metadata: SAFE_FUNDING_SUBMISSION_METADATA,
};
const validated = validateSafeFundingSubmission({
  action,
  validation,
  request,
});
assert.equal(validated.safeTransactionHash, safeTransactionHash);
assert.equal(validated.safeNonce, "5");
for (const patch of [
  { nonce: "6" },
  { from: ethers.Wallet.createRandom().address },
  { proxyWallet: token },
  { to: signer.address },
  { data: "0x" },
  { signature: ordinarySignature },
  { metadata: "another action" },
  { value: "0" },
  { nonce: "05" },
  { signatureParams: { ...request.signatureParams, operation: "1" } },
  { signatureParams: { ...request.signatureParams, gasPrice: "1" } },
  {
    signatureParams: {
      ...request.signatureParams,
      refundReceiver: signer.address,
    },
  },
])
  assert.throws(
    () =>
      validateSafeFundingSubmission({
        action,
        validation,
        request: { ...request, ...patch },
      }),
    /exact committed/,
  );
assert.throws(
  () =>
    validatePolymarketRelayerSignRequestForWallet({
      method: "POST",
      path: "/submit",
      body: request,
      walletAddress: signer.address,
    }),
  /operation-scoped/,
);
assert.doesNotThrow(() =>
  validatePolymarketRelayerSignRequestForWallet({
    method: "POST",
    path: "/submit",
    body: { ...request, metadata: "unrelated redemption" },
    walletAddress: signer.address,
  }),
);
assert.equal(parseSafeFundingSubmission(undefined), null);
assert.equal(
  parseSafeFundingSubmission({
    version: 1,
    expiresAt: "invalid",
    phase: "prepared",
  }),
  null,
);
assert.equal(
  parseSafeFundingSubmission({
    version: 2,
    expiresAt: new Date().toISOString(),
    phase: "prepared",
  }),
  null,
);
assert.equal(
  parseSafeFundingSubmission({
    version: 1,
    expiresAt: new Date().toISOString(),
    phase: "prepared",
  })?.phase,
  "prepared",
);
console.log(
  "[safe-funding-submission-tests] passed: exact Safe signature/envelope, legacy signer fence, versioned lease parser",
);
