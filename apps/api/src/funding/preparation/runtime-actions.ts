import { Interface } from "ethers";

import type { UserWallet } from "../../auth.js";
import { env } from "../../env.js";
import { buildEmbeddedPersonalSignRequest } from "../../services/embedded-privy.js";
import { fetchLimitlessSigningMessageRoute } from "../../services/limitless-trading-execution-service.js";
import {
  buildEmbeddedPolymarketConnectPayload,
  buildEmbeddedPolymarketConnectRequest,
} from "../../services/polymarket-embedded.js";
import type { JsonObject } from "../domain/types.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import type {
  PreparationActionMaterializer,
  PreparationActionTemplate,
} from "./core-adapter.js";

const ERC20 = new Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const ERC1155 = new Interface([
  "function setApprovalForAll(address operator,bool approved)",
]);
const MAX_APPROVAL_RAW = (1n << 256n) - 1n;

function jsonObject(value: unknown): JsonObject {
  const encoded = JSON.stringify(value);
  if (!encoded)
    throw new Error("preparation action payload is not serializable");
  const decoded = JSON.parse(encoded) as unknown;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("preparation action payload must be an object");
  }
  return decoded as JsonObject;
}

function requirement(
  source: PreparationActionTemplate,
  action: NonNullable<PreparationActionTemplate["action"]>,
): PreparationActionTemplate {
  if (source.summary.kind !== action.kind) {
    throw new Error(`preparation action kind mismatch for ${source.actionKey}`);
  }
  return {
    actionKey: source.actionKey,
    action,
    summary: source.summary,
  } as PreparationActionTemplate;
}

function operationTimestamp(observedAt: string): string {
  const timestamp = Math.floor(Date.parse(observedAt) / 1_000);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error("preparation evidence timestamp is invalid");
  }
  return String(timestamp);
}

function deterministicNonce(input: {
  operationId: string;
  inspectionRevision: string;
}): number {
  const digest = canonicalJsonHash(input);
  return Number.parseInt(digest.slice(0, 8), 16) % 1_000_000_000;
}

function spenderForPolymarketCheck(
  checkId: string,
  redemptionOperator: string | null,
): { token: string; spender: string; kind: "erc20" | "erc1155" } | null {
  if (checkId === "erc20_exchange_allowance") {
    return {
      token: env.polymarketUsdcAddress,
      spender: env.polymarketExchangeAddress,
      kind: "erc20",
    };
  }
  if (checkId === "erc20_neg_risk_exchange_allowance") {
    return {
      token: env.polymarketUsdcAddress,
      spender: env.polymarketNegRiskExchangeAddress,
      kind: "erc20",
    };
  }
  if (checkId === "erc20_neg_risk_adapter_allowance") {
    return env.polymarketNegRiskAdapterAddress
      ? {
          token: env.polymarketUsdcAddress,
          spender: env.polymarketNegRiskAdapterAddress,
          kind: "erc20",
        }
      : null;
  }
  if (checkId === "ctf_exchange_approval") {
    return {
      token: env.polymarketConditionalTokensAddress,
      spender: env.polymarketExchangeAddress,
      kind: "erc1155",
    };
  }
  if (checkId === "ctf_neg_risk_exchange_approval") {
    return {
      token: env.polymarketConditionalTokensAddress,
      spender: env.polymarketNegRiskExchangeAddress,
      kind: "erc1155",
    };
  }
  if (checkId === "ctf_neg_risk_adapter_approval") {
    return env.polymarketNegRiskAdapterAddress
      ? {
          token: env.polymarketConditionalTokensAddress,
          spender: env.polymarketNegRiskAdapterAddress,
          kind: "erc1155",
        }
      : null;
  }
  if (checkId === "redemption_operator_approval" && redemptionOperator) {
    return {
      token: env.polymarketConditionalTokensAddress,
      spender: redemptionOperator,
      kind: "erc1155",
    };
  }
  return null;
}

function approvalCalldata(input: {
  kind: "erc20" | "erc1155";
  spender: string;
}): string {
  return input.kind === "erc20"
    ? ERC20.encodeFunctionData("approve", [input.spender, MAX_APPROVAL_RAW])
    : ERC1155.encodeFunctionData("setApprovalForAll", [input.spender, true]);
}

function polymarketFundingRouterApproval(actionKey: string): {
  owner: "deposit_wallet" | "signer";
  token: string;
  spender: string;
} | null {
  const spender = env.polymarketFundingRouterAddress?.trim() ?? "";
  if (!spender) return null;
  if (actionKey === "approve-funding-router-deposit-usdce") {
    return {
      owner: "deposit_wallet",
      token: env.polymarketUsdceAddress,
      spender,
    };
  }
  if (actionKey === "approve-funding-router-signer-pusd") {
    return {
      owner: "signer",
      token: env.polymarketUsdcAddress,
      spender,
    };
  }
  if (actionKey === "approve-funding-router-signer-usdce") {
    return {
      owner: "signer",
      token: env.polymarketUsdceAddress,
      spender,
    };
  }
  return null;
}

export function createPolymarketRuntimeActionMaterializer(input: {
  wallet: UserWallet;
  topology:
    | "signer"
    | "deposit_wallet"
    | "safe_1_1"
    | "safe_unsupported"
    | "magic_proxy"
    | "unknown_contract";
  funder: string;
  redemptionOperator: string | null;
}): PreparationActionMaterializer {
  return async ({ request, facts, inspectionRevision, requiredActions }) => {
    const timestamp = operationTimestamp(facts.observedAt);
    const nonce = deterministicNonce({
      operationId: request.operationId,
      inspectionRevision,
    });
    return requiredActions.map((source): PreparationActionTemplate => {
      if (source.actionKey === "deploy-polymarket-wallet") {
        if (source.summary.kind !== "external_handoff") {
          throw new Error("Polymarket deployment action kind is invalid");
        }
        return requirement(source, {
          kind: "external_handoff",
          networkId: facts.binding.settlementLocation.asset.networkId,
          actorWalletId: facts.binding.executionWalletId,
          handoffKind: "polymarket_deposit_wallet_deploy",
          payload: {
            owner: input.wallet.walletAddress,
            depositWallet: input.funder,
            expectedTopology: "deposit_wallet",
          },
        });
      }
      if (source.actionKey.startsWith("connect-polymarket")) {
        if (source.summary.kind !== "signature") {
          throw new Error("Polymarket connect action kind is invalid");
        }
        const typedData = buildEmbeddedPolymarketConnectPayload({
          signer: input.wallet.walletAddress,
          timestamp,
          nonce,
        });
        const payload =
          input.wallet.isInternalWallet && input.wallet.privyWalletId
            ? {
                typedData,
                timestamp,
                nonce,
                authorizationRequest: buildEmbeddedPolymarketConnectRequest({
                  context: {
                    signer: input.wallet.walletAddress,
                    walletId: input.wallet.privyWalletId,
                  },
                  timestamp,
                  nonce,
                }),
              }
            : { typedData, timestamp, nonce };
        return requirement(source, {
          kind: "signature",
          networkId: facts.binding.settlementLocation.asset.networkId,
          signerWalletId: facts.binding.executionWalletId,
          payloadKind: "eip712",
          payload: jsonObject(payload),
        });
      }
      const fundingRouterApproval = polymarketFundingRouterApproval(
        source.actionKey,
      );
      if (fundingRouterApproval) {
        const data = approvalCalldata({
          kind: "erc20",
          spender: fundingRouterApproval.spender,
        });
        if (fundingRouterApproval.owner === "signer") {
          return requirement(source, {
            kind: "evm_transaction",
            networkId: facts.binding.settlementLocation.asset.networkId,
            senderWalletId: facts.binding.executionWalletId,
            to: fundingRouterApproval.token,
            data,
            valueRaw: "0",
            gasLimitRaw: null,
          });
        }
        if (input.topology !== "deposit_wallet") {
          throw new Error(
            "Deposit Wallet Funding Router approval requires deposit-wallet topology",
          );
        }
        return requirement(source, {
          kind: "external_handoff",
          networkId: facts.binding.settlementLocation.asset.networkId,
          actorWalletId: facts.binding.executionWalletId,
          handoffKind: "polymarket_proxy_execute",
          payload: {
            topology: input.topology,
            funder: input.funder,
            calls: [
              {
                target: fundingRouterApproval.token,
                data,
                value: "0",
              },
            ],
          },
        });
      }
      const checkId = source.actionKey.replace(/^approve-/, "");
      const approval = spenderForPolymarketCheck(
        checkId,
        input.redemptionOperator,
      );
      if (!approval) {
        throw new Error(
          `Polymarket action ${source.actionKey} has no exact allowlisted target`,
        );
      }
      const data = approvalCalldata(approval);
      if (input.topology === "signer") {
        return requirement(source, {
          kind: "evm_transaction",
          networkId: facts.binding.settlementLocation.asset.networkId,
          senderWalletId: facts.binding.executionWalletId,
          to: approval.token,
          data,
          valueRaw: "0",
          gasLimitRaw: null,
        });
      }
      if (
        input.topology !== "deposit_wallet" &&
        input.topology !== "safe_1_1" &&
        input.topology !== "magic_proxy"
      ) {
        throw new Error(
          `Polymarket topology ${input.topology} cannot execute approvals`,
        );
      }
      if (source.summary.kind !== "external_handoff") {
        throw new Error("Polymarket proxy approval action kind is invalid");
      }
      return requirement(source, {
        kind: "external_handoff",
        networkId: facts.binding.settlementLocation.asset.networkId,
        actorWalletId: facts.binding.executionWalletId,
        handoffKind: "polymarket_proxy_execute",
        payload: {
          topology: input.topology,
          funder: input.funder,
          calls: [{ target: approval.token, data, value: "0" }],
        },
      });
    });
  };
}

function spenderForLimitlessCheck(
  checkId: string,
  input: { adapterAddress: string | null; ammAddress: string | null },
): { token: string; spender: string; kind: "erc20" | "erc1155" } | null {
  const erc20 = (spender: string | null | undefined) =>
    spender
      ? {
          token: env.limitlessUsdcAddress,
          spender,
          kind: "erc20" as const,
        }
      : null;
  const erc1155 = (spender: string | null | undefined) =>
    spender
      ? {
          token: env.limitlessConditionalTokensAddress,
          spender,
          kind: "erc1155" as const,
        }
      : null;
  if (checkId === "clob_usdc_allowance") {
    return erc20(env.limitlessClobAddress);
  }
  if (checkId === "clob_neg_risk_usdc_allowance") {
    return erc20(env.limitlessNegRiskAddress);
  }
  if (checkId === "amm_usdc_allowance") return erc20(input.ammAddress);
  if (checkId === "clob_operator_approval") {
    return erc1155(env.limitlessClobAddress);
  }
  if (checkId === "clob_neg_risk_operator_approval") {
    return erc1155(env.limitlessNegRiskAddress);
  }
  if (checkId === "amm_operator_approval") {
    return erc1155(input.ammAddress);
  }
  if (
    checkId === "market_adapter_approval" ||
    checkId === "redemption_operator_approval"
  ) {
    return erc1155(input.adapterAddress);
  }
  return null;
}

export function createLimitlessRuntimeActionMaterializer(input: {
  wallet: UserWallet;
  adapterAddress: string | null;
  ammAddress: string | null;
  fetchSigningMessage?: () => Promise<string>;
}): PreparationActionMaterializer {
  return async ({ facts, requiredActions }) => {
    let signingMessage: string | null = null;
    if (
      requiredActions.some((action) =>
        action.actionKey.startsWith("connect-limitless"),
      )
    ) {
      if (input.fetchSigningMessage) {
        signingMessage = await input.fetchSigningMessage();
      } else {
        const result = await fetchLimitlessSigningMessageRoute();
        signingMessage =
          result.ok && typeof result.payload.message === "string"
            ? result.payload.message
            : null;
      }
      if (!signingMessage) {
        throw new Error("Limitless signing message is unavailable");
      }
    }
    return requiredActions.map((source): PreparationActionTemplate => {
      if (source.actionKey.startsWith("connect-limitless")) {
        if (!signingMessage || source.summary.kind !== "signature") {
          throw new Error("Limitless connect action is invalid");
        }
        const authorizationRequest =
          input.wallet.isInternalWallet && input.wallet.privyWalletId
            ? buildEmbeddedPersonalSignRequest({
                context: {
                  signer: input.wallet.walletAddress,
                  walletId: input.wallet.privyWalletId,
                  walletProfile: {
                    address: input.wallet.walletAddress,
                    walletType: "ethereum",
                    source: input.wallet.walletSource,
                    isInternalWallet: true,
                    walletId: input.wallet.privyWalletId,
                  },
                },
                id: "limitless-connect",
                label: "Limitless connect",
                message: signingMessage,
              })
            : null;
        return requirement(source, {
          kind: "signature",
          networkId: facts.binding.settlementLocation.asset.networkId,
          signerWalletId: facts.binding.executionWalletId,
          payloadKind: "personal_message",
          payload: jsonObject({
            message: signingMessage,
            encoding: "utf-8",
            authorizationRequest,
          }),
        });
      }
      const checkId = source.actionKey.replace(/^approve-/, "");
      const approval = spenderForLimitlessCheck(checkId, {
        adapterAddress: input.adapterAddress,
        ammAddress: input.ammAddress,
      });
      if (!approval) {
        throw new Error(
          `Limitless action ${source.actionKey} has no exact allowlisted target`,
        );
      }
      return requirement(source, {
        kind: "evm_transaction",
        networkId: facts.binding.settlementLocation.asset.networkId,
        senderWalletId: facts.binding.executionWalletId,
        to: approval.token,
        data: approvalCalldata(approval),
        valueRaw: "0",
        gasLimitRaw: null,
      });
    });
  };
}
