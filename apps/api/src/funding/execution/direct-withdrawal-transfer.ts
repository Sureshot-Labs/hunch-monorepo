import { ethers } from "ethers";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import type {
  AssetRef,
  EvmTransactionAction,
  JsonValue,
  Money,
  ResolvedExternalRecipient,
  SvmTransactionAction,
  WalletExecutionProfile,
} from "../domain/types.js";
import { sameAccountAddress, sameAsset } from "../domain/asset-identity.js";
import { isPositiveRawAmount } from "../domain/raw-amount.js";
import { stableOpaqueId } from "../../account-value/canonical.js";
import { RELAY_PINNED_ASSETS } from "../../funding-providers/relay/mappings.js";
import { POLYMARKET_COLLATERAL_OFFRAMP } from "../../funding-providers/relay/rehearsal.js";
import { canonicalJsonHash } from "../persistence/canonical.js";

const ERC20_TRANSFER_INTERFACE = new ethers.Interface([
  "function transfer(address recipient,uint256 amount) returns (bool)",
]);
const ERC20_APPROVE_INTERFACE = new ethers.Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const POLYMARKET_COLLATERAL_INTERFACE = new ethers.Interface([
  "function unwrap(address asset,address recipient,uint256 amount)",
]);

export const DIRECT_WITHDRAWAL_PROVIDER_ID = "direct_wallet";
export const DIRECT_WITHDRAWAL_ADAPTER_ID = "exact_direct_withdrawal_v1";
export const DIRECT_WITHDRAWAL_ROUTE_ID = "exact-direct-withdrawal-v1";

export type ExactErc20WithdrawalActionValidation = Readonly<{
  kind: "exact_erc20_withdrawal";
  signerAddress: string;
  recipientAddress: string;
  recipientAddressFingerprint: string;
  postconditionEvidenceKind: "exact_erc20_source_debit_v1";
  expectedSourceAssetId: string;
  expectedSourceAssetDecimals: number;
  expectedSourceAddress: string;
  expectedSourceRecipient: string;
  expectedSourceRaw: string;
  observationKind: "destination_credit";
}>;

export type ExactSolWithdrawalActionValidation = Readonly<{
  kind: "exact_sol_withdrawal";
  signerAddress: string;
  signerWalletId: string;
  recipientAddress: string;
  recipientAddressFingerprint: string;
  postconditionEvidenceKind: "exact_sol_source_debit_v1";
  expectedSourceAssetId: string;
  expectedSourceAssetDecimals: number;
  expectedSourceAddress: string;
  expectedSourceRecipient: string;
  expectedSourceRaw: string;
  observationKind: "destination_credit";
}>;

export type PolymarketUsdceWithdrawalApprovalValidation = Readonly<{
  kind: "polymarket_usdce_withdrawal_pusd_approval";
  signerAddress: string;
  signerWalletId: string;
  recipientAddress: string;
  recipientAddressFingerprint: string;
  sourceUsdceTokenAddress: string;
  pusdTokenAddress: string;
  collateralOfframpAddress: string;
  amountRaw: string;
  observationKind: "none";
}>;

export type PolymarketUsdceWithdrawalUnwrapValidation = Readonly<{
  kind: "polymarket_usdce_withdrawal_unwrap";
  signerAddress: string;
  signerWalletId: string;
  recipientAddress: string;
  recipientAddressFingerprint: string;
  sourcePusdTokenAddress: string;
  destinationUsdceTokenAddress: string;
  collateralOfframpAddress: string;
  amountRaw: string;
  postconditionEvidenceKind: "exact_erc20_destination_credit_v1";
  expectedDestinationAssetId: string;
  expectedDestinationAssetDecimals: number;
  expectedDestinationAddress: string;
  expectedDestinationRaw: string;
  requiresDestinationEventIdentity: true;
  observationKind: "destination_credit";
}>;

export type DirectWithdrawalActionValidation =
  | ExactErc20WithdrawalActionValidation
  | ExactSolWithdrawalActionValidation
  | PolymarketUsdceWithdrawalApprovalValidation
  | PolymarketUsdceWithdrawalUnwrapValidation;

export const POLYMARKET_USDCE_WITHDRAWAL_EXECUTION_KIND =
  "polymarket_usdce_via_controller_pusd";

export function isDirectWithdrawalExecutionKind(value: unknown): boolean {
  return (
    value === "exact_same_asset_transfer" ||
    value === POLYMARKET_USDCE_WITHDRAWAL_EXECUTION_KIND
  );
}

export function buildExactErc20WithdrawalAction(
  input: Readonly<{
    amount: Money;
    profile: WalletExecutionProfile;
    recipient: Readonly<{ address: string; addressFingerprint: string }>;
  }>,
): Readonly<{
  action: EvmTransactionAction;
  validation: ExactErc20WithdrawalActionValidation;
}> {
  if (
    !input.amount.asset.networkId.startsWith("evm:") ||
    input.profile.networkId !== input.amount.asset.networkId ||
    BigInt(input.amount.raw) <= 0n
  ) {
    throw new Error("direct withdrawal requires a positive EVM token amount");
  }
  const token = ethers.getAddress(input.amount.asset.assetId);
  const recipient = ethers.getAddress(input.recipient.address);
  const signer = ethers.getAddress(input.profile.address);
  const data = ERC20_TRANSFER_INTERFACE.encodeFunctionData("transfer", [
    recipient,
    BigInt(input.amount.raw),
  ]);
  const action: EvmTransactionAction = {
    kind: "evm_transaction",
    actionId: stableOpaqueId(
      "funding_action",
      canonicalJsonHash({
        kind: "exact_erc20_withdrawal",
        networkId: input.amount.asset.networkId,
        senderWalletId: input.profile.walletId,
        token,
        recipient,
        amountRaw: input.amount.raw,
      }),
    ),
    networkId: input.amount.asset.networkId,
    senderWalletId: input.profile.walletId,
    to: token,
    data,
    valueRaw: "0",
    gasLimitRaw: null,
  };
  return {
    action,
    validation: {
      kind: "exact_erc20_withdrawal",
      signerAddress: signer,
      recipientAddress: recipient,
      recipientAddressFingerprint: input.recipient.addressFingerprint,
      postconditionEvidenceKind: "exact_erc20_source_debit_v1",
      expectedSourceAssetId: token,
      expectedSourceAssetDecimals: input.amount.asset.decimals,
      expectedSourceAddress: signer,
      expectedSourceRecipient: recipient,
      expectedSourceRaw: input.amount.raw,
      observationKind: "destination_credit",
    },
  };
}

export function buildExactSolWithdrawalAction(
  input: Readonly<{
    amount: Money;
    profile: WalletExecutionProfile;
    recipient: Readonly<{ address: string; addressFingerprint: string }>;
  }>,
): Readonly<{
  action: SvmTransactionAction;
  validation: ExactSolWithdrawalActionValidation;
}> {
  if (
    input.amount.asset.networkId !== "solana:mainnet" ||
    input.amount.asset.assetId !== SystemProgram.programId.toBase58() ||
    input.amount.asset.decimals !== 9 ||
    input.profile.networkId !== input.amount.asset.networkId ||
    BigInt(input.amount.raw) <= 0n
  ) {
    throw new Error("direct withdrawal requires a positive native SOL amount");
  }
  const signer = new PublicKey(input.profile.address).toBase58();
  const recipient = new PublicKey(input.recipient.address).toBase58();
  const instruction = SystemProgram.transfer({
    fromPubkey: new PublicKey(signer),
    toPubkey: new PublicKey(recipient),
    lamports: BigInt(input.amount.raw),
  });
  const action: SvmTransactionAction = {
    kind: "svm_transaction",
    actionId: stableOpaqueId(
      "funding_action",
      canonicalJsonHash({
        kind: "exact_sol_withdrawal",
        networkId: input.amount.asset.networkId,
        signerWalletId: input.profile.walletId,
        signer,
        recipient,
        amountRaw: input.amount.raw,
      }),
    ),
    networkId: input.amount.asset.networkId,
    signerWalletId: input.profile.walletId,
    instructions: [
      {
        programId: instruction.programId.toBase58(),
        accounts: instruction.keys.map((account) => ({
          address: account.pubkey.toBase58(),
          signer: account.isSigner,
          writable: account.isWritable,
        })),
        data: Buffer.from(instruction.data).toString("hex"),
        dataEncoding: "hex",
      },
    ],
    addressLookupTables: [],
  };
  return {
    action,
    validation: {
      kind: "exact_sol_withdrawal",
      signerAddress: signer,
      signerWalletId: input.profile.walletId,
      recipientAddress: recipient,
      recipientAddressFingerprint: input.recipient.addressFingerprint,
      postconditionEvidenceKind: "exact_sol_source_debit_v1",
      expectedSourceAssetId: SystemProgram.programId.toBase58(),
      expectedSourceAssetDecimals: 9,
      expectedSourceAddress: signer,
      expectedSourceRecipient: recipient,
      expectedSourceRaw: input.amount.raw,
      observationKind: "destination_credit",
    },
  };
}

/**
 * Rebuilds the immutable action shape of already-persisted USDC.e-via-pUSD
 * withdrawals. New plans use a direct exact USDC.e handoff and transfer; this
 * remains only so in-flight operations can still be validated and reconciled.
 */
export function buildPolymarketUsdceWithdrawalActions(
  input: Readonly<{
    amount: Money;
    profile: WalletExecutionProfile;
    recipient: Readonly<{ address: string; addressFingerprint: string }>;
  }>,
): readonly [
  Readonly<{
    action: EvmTransactionAction;
    validation: PolymarketUsdceWithdrawalApprovalValidation;
  }>,
  Readonly<{
    action: EvmTransactionAction;
    validation: PolymarketUsdceWithdrawalUnwrapValidation;
  }>,
] {
  if (
    input.amount.asset.networkId !== "evm:137" ||
    input.amount.asset.decimals !== 6 ||
    !sameAsset(input.amount.asset, {
      networkId: "evm:137",
      assetId: RELAY_PINNED_ASSETS.polygonUsdce,
      decimals: 6,
    }) ||
    input.profile.networkId !== input.amount.asset.networkId ||
    BigInt(input.amount.raw) <= 0n
  ) {
    throw new Error(
      "Polymarket USDC.e withdrawal requires a positive canonical Polygon amount",
    );
  }
  const signer = ethers.getAddress(input.profile.address);
  const recipient = ethers.getAddress(input.recipient.address);
  const pusd = ethers.getAddress(RELAY_PINNED_ASSETS.polygonPusd);
  const usdce = ethers.getAddress(RELAY_PINNED_ASSETS.polygonUsdce);
  const offramp = ethers.getAddress(POLYMARKET_COLLATERAL_OFFRAMP);
  const amountRaw = input.amount.raw;
  const approvalAction: EvmTransactionAction = {
    kind: "evm_transaction",
    actionId: stableOpaqueId(
      "funding_action",
      canonicalJsonHash({
        kind: "polymarket_usdce_withdrawal_pusd_approval",
        networkId: input.amount.asset.networkId,
        senderWalletId: input.profile.walletId,
        pusd,
        offramp,
        amountRaw,
        recipient,
      }),
    ),
    networkId: input.amount.asset.networkId,
    senderWalletId: input.profile.walletId,
    to: pusd,
    data: ERC20_APPROVE_INTERFACE.encodeFunctionData("approve", [
      offramp,
      BigInt(amountRaw),
    ]),
    valueRaw: "0",
    gasLimitRaw: null,
  };
  const unwrapAction: EvmTransactionAction = {
    kind: "evm_transaction",
    actionId: stableOpaqueId(
      "funding_action",
      canonicalJsonHash({
        kind: "polymarket_usdce_withdrawal_unwrap",
        networkId: input.amount.asset.networkId,
        senderWalletId: input.profile.walletId,
        usdce,
        offramp,
        amountRaw,
        recipient,
      }),
    ),
    networkId: input.amount.asset.networkId,
    senderWalletId: input.profile.walletId,
    to: offramp,
    data: POLYMARKET_COLLATERAL_INTERFACE.encodeFunctionData("unwrap", [
      usdce,
      recipient,
      BigInt(amountRaw),
    ]),
    valueRaw: "0",
    gasLimitRaw: null,
  };
  const common = {
    signerAddress: signer,
    signerWalletId: input.profile.walletId,
    recipientAddress: recipient,
    recipientAddressFingerprint: input.recipient.addressFingerprint,
    collateralOfframpAddress: offramp,
    amountRaw,
  } as const;
  return [
    {
      action: approvalAction,
      validation: {
        kind: "polymarket_usdce_withdrawal_pusd_approval",
        ...common,
        sourceUsdceTokenAddress: usdce,
        pusdTokenAddress: pusd,
        observationKind: "none",
      },
    },
    {
      action: unwrapAction,
      validation: {
        kind: "polymarket_usdce_withdrawal_unwrap",
        ...common,
        sourcePusdTokenAddress: pusd,
        destinationUsdceTokenAddress: usdce,
        postconditionEvidenceKind: "exact_erc20_destination_credit_v1",
        expectedDestinationAssetId: usdce,
        expectedDestinationAssetDecimals: 6,
        expectedDestinationAddress: recipient,
        expectedDestinationRaw: amountRaw,
        requiresDestinationEventIdentity: true,
        observationKind: "destination_credit",
      },
    },
  ];
}

export function directWithdrawalActionValidation(
  value: Readonly<Record<string, JsonValue>>,
): DirectWithdrawalActionValidation | null {
  if (
    value.kind === "polymarket_usdce_withdrawal_pusd_approval" &&
    value.observationKind === "none" &&
    typeof value.signerAddress === "string" &&
    typeof value.signerWalletId === "string" &&
    typeof value.recipientAddress === "string" &&
    typeof value.recipientAddressFingerprint === "string" &&
    typeof value.sourceUsdceTokenAddress === "string" &&
    typeof value.pusdTokenAddress === "string" &&
    typeof value.collateralOfframpAddress === "string" &&
    isPositiveRawAmount(value.amountRaw)
  ) {
    return value as PolymarketUsdceWithdrawalApprovalValidation;
  }
  if (
    value.kind === "polymarket_usdce_withdrawal_unwrap" &&
    value.observationKind === "destination_credit" &&
    value.postconditionEvidenceKind === "exact_erc20_destination_credit_v1" &&
    typeof value.signerAddress === "string" &&
    typeof value.signerWalletId === "string" &&
    typeof value.recipientAddress === "string" &&
    typeof value.recipientAddressFingerprint === "string" &&
    typeof value.sourcePusdTokenAddress === "string" &&
    typeof value.destinationUsdceTokenAddress === "string" &&
    typeof value.collateralOfframpAddress === "string" &&
    isPositiveRawAmount(value.amountRaw) &&
    typeof value.expectedDestinationAssetId === "string" &&
    value.expectedDestinationAssetDecimals === 6 &&
    typeof value.expectedDestinationAddress === "string" &&
    isPositiveRawAmount(value.expectedDestinationRaw) &&
    value.requiresDestinationEventIdentity === true
  ) {
    return value as PolymarketUsdceWithdrawalUnwrapValidation;
  }
  if (
    (value.kind !== "exact_erc20_withdrawal" &&
      value.kind !== "exact_sol_withdrawal") ||
    (value.postconditionEvidenceKind !== "exact_erc20_source_debit_v1" &&
      value.postconditionEvidenceKind !== "exact_sol_source_debit_v1") ||
    value.observationKind !== "destination_credit" ||
    typeof value.signerAddress !== "string" ||
    typeof value.recipientAddress !== "string" ||
    typeof value.recipientAddressFingerprint !== "string" ||
    typeof value.expectedSourceAssetId !== "string" ||
    typeof value.expectedSourceAssetDecimals !== "number" ||
    typeof value.expectedSourceAddress !== "string" ||
    typeof value.expectedSourceRecipient !== "string" ||
    typeof value.expectedSourceRaw !== "string" ||
    !Number.isInteger(value.expectedSourceAssetDecimals) ||
    value.expectedSourceAssetDecimals < 0 ||
    !isPositiveRawAmount(value.expectedSourceRaw) ||
    (value.kind === "exact_sol_withdrawal" &&
      typeof value.signerWalletId !== "string") ||
    (value.kind === "exact_erc20_withdrawal" &&
      value.postconditionEvidenceKind !== "exact_erc20_source_debit_v1") ||
    (value.kind === "exact_sol_withdrawal" &&
      value.postconditionEvidenceKind !== "exact_sol_source_debit_v1")
  ) {
    return null;
  }
  return value as DirectWithdrawalActionValidation;
}

export function assertDirectWithdrawalActionMatchesRecipient(
  input: Readonly<{
    action: EvmTransactionAction | SvmTransactionAction;
    actionValidationResult: Readonly<Record<string, JsonValue>>;
    recipient: ResolvedExternalRecipient;
    required?: boolean;
  }>,
): void {
  const validation = directWithdrawalActionValidation(
    input.actionValidationResult,
  );
  if (!validation) {
    if (input.required) {
      throw new Error("direct withdrawal action validation is invalid");
    }
    return;
  }
  if (
    validation.kind === "polymarket_usdce_withdrawal_pusd_approval" ||
    validation.kind === "polymarket_usdce_withdrawal_unwrap"
  ) {
    if (input.action.kind !== "evm_transaction") {
      throw new Error("direct withdrawal action differs from frozen recipient");
    }
    const amount: Money = {
      asset: {
        networkId: input.action.networkId,
        assetId:
          validation.kind === "polymarket_usdce_withdrawal_pusd_approval"
            ? validation.sourceUsdceTokenAddress
            : validation.destinationUsdceTokenAddress,
        decimals: 6,
      },
      raw: validation.amountRaw,
    };
    const expected = buildPolymarketUsdceWithdrawalActions({
      amount,
      profile: {
        walletId: validation.signerWalletId,
        networkId: input.action.networkId,
        address: validation.signerAddress,
        source: "embedded",
        signingModes: ["web_client"],
        serverWalletRef: null,
        sponsorshipPolicyIds: [],
      },
      recipient: {
        address: validation.recipientAddress,
        addressFingerprint: validation.recipientAddressFingerprint,
      },
    })[validation.kind === "polymarket_usdce_withdrawal_pusd_approval" ? 0 : 1]
      .action;
    const expectedAsset: AssetRef = {
      networkId: input.action.networkId,
      assetId:
        validation.kind === "polymarket_usdce_withdrawal_pusd_approval"
          ? validation.sourceUsdceTokenAddress
          : validation.destinationUsdceTokenAddress,
      decimals: 6,
    };
    const canonicalUsdce = ethers.getAddress(RELAY_PINNED_ASSETS.polygonUsdce);
    const canonicalPusd = ethers.getAddress(RELAY_PINNED_ASSETS.polygonPusd);
    const canonicalOfframp = ethers.getAddress(POLYMARKET_COLLATERAL_OFFRAMP);
    const validationContractMatches =
      ethers.getAddress(validation.collateralOfframpAddress) ===
        canonicalOfframp &&
      (validation.kind === "polymarket_usdce_withdrawal_pusd_approval"
        ? ethers.getAddress(validation.sourceUsdceTokenAddress) ===
            canonicalUsdce &&
          ethers.getAddress(validation.pusdTokenAddress) === canonicalPusd
        : ethers.getAddress(validation.sourcePusdTokenAddress) ===
            canonicalPusd &&
          ethers.getAddress(validation.destinationUsdceTokenAddress) ===
            canonicalUsdce &&
          ethers.getAddress(validation.expectedDestinationAssetId) ===
            canonicalUsdce &&
          ethers.getAddress(validation.expectedDestinationAddress) ===
            ethers.getAddress(input.recipient.address) &&
          validation.expectedDestinationRaw === validation.amountRaw);
    if (
      !validationContractMatches ||
      input.recipient.addressFingerprint !==
        validation.recipientAddressFingerprint ||
      !sameAsset(input.recipient.asset, expectedAsset) ||
      input.recipient.networkId !== input.action.networkId ||
      !sameAccountAddress(
        input.action.networkId,
        input.recipient.address,
        validation.recipientAddress,
      ) ||
      canonicalJsonHash(input.action) !== canonicalJsonHash(expected)
    ) {
      throw new Error("direct withdrawal action differs from frozen recipient");
    }
    return;
  }
  if (validation.kind === "exact_sol_withdrawal") {
    if (input.action.kind !== "svm_transaction") {
      throw new Error("direct withdrawal action differs from frozen recipient");
    }
    const expected = buildExactSolWithdrawalAction({
      amount: {
        asset: {
          networkId: input.action.networkId,
          assetId: validation.expectedSourceAssetId,
          decimals: validation.expectedSourceAssetDecimals,
        },
        raw: validation.expectedSourceRaw,
      },
      profile: {
        walletId: validation.signerWalletId,
        networkId: input.action.networkId,
        address: validation.signerAddress,
        source: "external",
        signingModes: ["web_client"],
        serverWalletRef: null,
        sponsorshipPolicyIds: [],
      },
      recipient: {
        address: validation.recipientAddress,
        addressFingerprint: validation.recipientAddressFingerprint,
      },
    }).action;
    const expectedAsset: AssetRef = {
      networkId: input.action.networkId,
      assetId: validation.expectedSourceAssetId,
      decimals: validation.expectedSourceAssetDecimals,
    };
    if (
      input.recipient.addressFingerprint !==
        validation.recipientAddressFingerprint ||
      !sameAsset(input.recipient.asset, expectedAsset) ||
      input.recipient.networkId !== input.action.networkId ||
      !sameAccountAddress(
        input.action.networkId,
        input.recipient.address,
        validation.recipientAddress,
      ) ||
      validation.expectedSourceAddress !== validation.signerAddress ||
      validation.expectedSourceRecipient !== validation.recipientAddress ||
      canonicalJsonHash(input.action) !== canonicalJsonHash(expected)
    ) {
      throw new Error("direct withdrawal action differs from frozen recipient");
    }
    return;
  }
  if (input.action.kind !== "evm_transaction") {
    throw new Error("direct withdrawal action differs from frozen recipient");
  }
  let decoded: ethers.TransactionDescription | null = null;
  try {
    decoded = ERC20_TRANSFER_INTERFACE.parseTransaction({
      data: input.action.data,
      value: 0n,
    });
  } catch {
    decoded = null;
  }
  const decodedRecipient = decoded
    ? ethers.getAddress(String(decoded.args[0]))
    : null;
  const decodedRaw = decoded ? BigInt(decoded.args[1]).toString() : null;
  const expectedAsset: AssetRef = {
    networkId: input.action.networkId,
    assetId: validation.expectedSourceAssetId,
    decimals: validation.expectedSourceAssetDecimals,
  };
  if (
    decoded?.name !== "transfer" ||
    input.recipient.addressFingerprint !==
      validation.recipientAddressFingerprint ||
    !sameAsset(input.recipient.asset, expectedAsset) ||
    input.recipient.networkId !== input.action.networkId ||
    !sameAccountAddress(
      input.action.networkId,
      input.recipient.address,
      validation.recipientAddress,
    ) ||
    !sameAccountAddress(
      input.action.networkId,
      validation.recipientAddress,
      validation.expectedSourceRecipient,
    ) ||
    decodedRecipient !== ethers.getAddress(validation.recipientAddress) ||
    decodedRaw !== validation.expectedSourceRaw ||
    ethers.getAddress(input.action.to) !==
      ethers.getAddress(validation.expectedSourceAssetId) ||
    input.action.valueRaw !== "0"
  ) {
    throw new Error("direct withdrawal action differs from frozen recipient");
  }
}
