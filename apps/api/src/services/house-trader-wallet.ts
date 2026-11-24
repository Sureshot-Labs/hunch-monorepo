import { ethers } from "ethers";
import { hkdfSync } from "node:crypto";
import {
  encryptCredentialsString,
  decryptCredentialsString,
} from "../lib/credentials-encryption.js";
import { AuthService } from "../auth.js";
import { env } from "../env.js";
import { POLYMARKET_PROTOCOL_CONTRACTS } from "@hunch/shared";
import {
  inspectPolymarketDepositWallet,
  POLYMARKET_DEPOSIT_WALLET_FACTORY,
} from "./polymarket-deposit-wallet-derivation.js";
import { requestPolymarketCredentials } from "./polymarket-credentials.js";
import {
  buildDepositWalletBatchTypedData,
  buildDepositWalletSubmitBody,
  fetchPolymarketRelayerNonce,
  submitPolymarketDepositWalletBatch,
  POLYMARKET_RELAYER_BASE_URL,
  type DepositWalletCall,
  type PolymarketRelayerTransaction,
} from "./polymarket-deposit-wallet-relayer.js";
import { createPolymarketRelayerHeaderPayload } from "./polymarket-relayer-signing.js";
import {
  POLYMARKET_AUTH_MESSAGE,
  POLYMARKET_AUTH_TYPES,
} from "./polymarket-signing-schema.js";
import type { Account } from "./house-trader-store.js";

const erc20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const shares = new ethers.Interface([
  "function balanceOf(address,uint256) view returns (uint256)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function setApprovalForAll(address,bool)",
]);

export function exactTransfer(
  receipt: ethers.TransactionReceipt,
  token: string,
  from: string,
  to: string,
  amount: bigint,
) {
  return (
    receipt.status === 1 &&
    receipt.logs.some((log) => {
      if (log.address.toLowerCase() !== token.toLowerCase()) return false;
      try {
        const event = erc20.parseLog(log);
        return (
          event?.name === "Transfer" &&
          event.args[0].toLowerCase() === from.toLowerCase() &&
          event.args[1].toLowerCase() === to.toLowerCase() &&
          event.args[2] === amount
        );
      } catch {
        return false;
      }
    })
  );
}

export class HouseWallet {
  readonly key: ethers.Wallet;
  readonly provider: ethers.JsonRpcProvider;
  readonly collateral = env.polymarketPusdAddress;
  private readonly relayer = {
    key: env.polymarketBuilderApiKey,
    secret: env.polymarketBuilderApiSecret,
    passphrase: env.polymarketBuilderApiPassphrase,
  };
  constructor(privateKey: string) {
    this.key = new ethers.Wallet(privateKey);
    if (
      !env.polygonRpcUrl ||
      Object.values(this.relayer).some((value) => !value)
    )
      throw new Error("house_wallet_configuration_invalid");
    const request = new ethers.FetchRequest(env.polygonRpcUrl);
    request.timeout = 12_000;
    this.provider = new ethers.JsonRpcProvider(request);
  }
  async inspect() {
    if ((await this.provider.getNetwork()).chainId !== 137n)
      throw new Error("wrong_chain");
    return inspectPolymarketDepositWallet({
      owner: this.key.address,
      rpcUrl: env.polygonRpcUrl,
      timeoutMs: env.polygonRpcTimeoutMs,
      bypassCodeCache: true,
    });
  }
  async verifyDepositOwner(funder: string, blockTag: number) {
    const iface = new ethers.Interface([
      "function owner() view returns (address)",
    ]);
    const result = await this.provider.call({
      to: funder,
      data: iface.encodeFunctionData("owner"),
      blockTag,
    });
    if (
      ethers.getAddress(iface.decodeFunctionResult("owner", result)[0]) !==
      this.key.address
    )
      throw new Error("deposit_wallet_owner_mismatch");
  }
  async expiredUnspentBatch(funder: string, reference: string | null) {
    const match = /^batch:(\d+):(\d+)$/.exec(reference ?? "");
    if (!match) return false;
    const block = await this.provider.getBlock("finalized");
    if (!block || BigInt(block.timestamp) <= BigInt(match[2])) return false;
    return (await this.batchNonceAt(funder, block.number)) === BigInt(match[1]);
  }
  async batchNonceAt(funder: string, blockTag: number) {
    const iface = new ethers.Interface([
      "function nonce() view returns (uint256)",
    ]);
    const returned = await this.provider.call({
      to: funder,
      data: iface.encodeFunctionData("nonce"),
      blockTag,
    });
    return BigInt(iface.decodeFunctionResult("nonce", returned)[0]);
  }
  async deploy() {
    const body = {
      type: "WALLET-CREATE",
      from: this.key.address,
      to: POLYMARKET_DEPOSIT_WALLET_FACTORY,
    };
    const headers = createPolymarketRelayerHeaderPayload({
      ...this.relayer,
      method: "POST",
      path: "/submit",
      body,
    });
    const response = await fetch(`${POLYMARKET_RELAYER_BASE_URL}/submit`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error("relayer_create_uncertain");
    return (await response.json()) as PolymarketRelayerTransaction;
  }
  async connect(account: Account, funder: string) {
    const existing = await AuthService.getVenueCredentials(
      account.user_id,
      "polymarket",
      this.key.address,
    );
    if (
      existing?.apiKey &&
      existing.apiSecret &&
      existing.apiPassphrase &&
      existing.funderAddress?.toLowerCase() === funder.toLowerCase()
    )
      return;
    const nonce = 0;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await this.key.signTypedData(
      { name: "ClobAuthDomain", version: "1", chainId: 137 },
      { ClobAuth: [...POLYMARKET_AUTH_TYPES.ClobAuth] },
      {
        address: this.key.address,
        nonce,
        timestamp,
        message: POLYMARKET_AUTH_MESSAGE,
      },
    );
    const creds = await requestPolymarketCredentials({
      walletAddress: this.key.address,
      signature,
      timestamp,
      nonce,
      deriveOnConflict: true,
    });
    await AuthService.createOrUpdateVenueCredentials(
      account.user_id,
      this.key.address,
      "polymarket",
      creds.apiKey,
      creds.apiSecret,
      { passphrase: creds.passphrase, funderAddress: funder },
    );
  }
  async balance(owner: string): Promise<bigint> {
    const result = await this.provider.call({
      to: this.collateral,
      data: erc20.encodeFunctionData("balanceOf", [owner]),
    });
    return erc20.decodeFunctionResult("balanceOf", result)[0];
  }
  async position(
    owner: string,
    contract: string,
    token: string,
  ): Promise<bigint> {
    const result = await this.provider.call({
      to: contract,
      data: shares.encodeFunctionData("balanceOf", [owner, token]),
    });
    return shares.decodeFunctionResult("balanceOf", result)[0];
  }
  async approvals(
    funder: string,
    blockTag?: number,
  ): Promise<DepositWalletCall[]> {
    const c = POLYMARKET_PROTOCOL_CONTRACTS;
    const exchanges = [c.exchangeV2, c.negRiskExchangeV2, c.exchangeV3];
    const calls: DepositWalletCall[] = [];
    for (const exchange of exchanges) {
      const raw = await this.provider.call({
        to: this.collateral,
        data: erc20.encodeFunctionData("allowance", [funder, exchange]),
        blockTag,
      });
      if (erc20.decodeFunctionResult("allowance", raw)[0] < 1_000_000_000_000n)
        calls.push({
          target: this.collateral,
          value: "0",
          data: erc20.encodeFunctionData("approve", [
            exchange,
            ethers.MaxUint256,
          ]),
        });
    }
    for (const [ledger, operator] of [
      [c.conditionalTokens, c.exchangeV2],
      [c.conditionalTokens, c.negRiskExchangeV2],
      [c.positionManager, c.exchangeV3],
      [c.positionManager, c.router],
      [c.conditionalTokens, env.polymarketCtfCollateralAdapterAddress],
      [c.conditionalTokens, env.polymarketNegRiskCollateralAdapterAddress],
    ]) {
      if (!operator) continue;
      const raw = await this.provider.call({
        to: ledger,
        data: shares.encodeFunctionData("isApprovedForAll", [funder, operator]),
        blockTag,
      });
      if (!shares.decodeFunctionResult("isApprovedForAll", raw)[0])
        calls.push({
          target: ledger,
          value: "0",
          data: shares.encodeFunctionData("setApprovalForAll", [
            operator,
            true,
          ]),
        });
    }
    return calls;
  }
  async submitBatch(
    funder: string,
    calls: DepositWalletCall[],
    before: (nonce: string, deadline: string) => Promise<void>,
  ) {
    const nonce = await fetchPolymarketRelayerNonce(this.key.address);
    const deadline = (Math.floor(Date.now() / 1000) + 180).toString();
    const typed = buildDepositWalletBatchTypedData({
      depositWalletAddress: funder,
      nonce,
      deadline,
      calls,
    });
    const signature = await this.key.signTypedData(
      typed.domain,
      typed.types,
      typed.message,
    );
    await before(nonce, deadline);
    return submitPolymarketDepositWalletBatch({
      credentials: this.relayer,
      body: buildDepositWalletSubmitBody({
        ownerAddress: this.key.address,
        depositWalletAddress: funder,
        nonce,
        deadline,
        signature,
        calls,
      }),
    });
  }
  transfer(to: string, amount: bigint): DepositWalletCall {
    return {
      target: this.collateral,
      value: "0",
      data: erc20.encodeFunctionData("transfer", [to, amount]),
    };
  }
  async signSweep(recipient: string, amount: bigint) {
    const wallet = this.key.connect(this.provider);
    const transfer = this.transfer(recipient, amount);
    return wallet.signTransaction(
      await wallet.populateTransaction({
        chainId: 137,
        to: transfer.target,
        data: transfer.data,
        value: 0n,
      }),
    );
  }
  private sweepEnvelopeKey() {
    return Buffer.from(
      hkdfSync(
        "sha256",
        ethers.getBytes(this.key.privateKey),
        Buffer.alloc(0),
        "hunch-house-trader-sweep-envelope-v1",
        32,
      ),
    );
  }
  sealSweep(signed: string) {
    return encryptCredentialsString(signed, this.sweepEnvelopeKey());
  }
  openSweep(sealed: string, hash: string, recipient: string, amount: bigint) {
    const raw = decryptCredentialsString(sealed, this.sweepEnvelopeKey());
    const tx = ethers.Transaction.from(raw);
    const expected = this.transfer(recipient, amount);
    if (
      tx.hash !== hash ||
      tx.chainId !== 137n ||
      tx.from !== this.key.address ||
      tx.to?.toLowerCase() !== expected.target.toLowerCase() ||
      tx.value !== 0n ||
      tx.data !== expected.data
    )
      throw new Error("sweep_envelope_mismatch");
    return { tx, raw };
  }
}
