#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ethers } from "ethers";

import { env } from "./env.js";
import {
  acrossRequest,
  isAcrossFallbackableError,
} from "./services/across-client.js";
import {
  ACROSS_SOLANA_CHAIN_ID,
  HUNCH_SOLANA_CHAIN_ID,
  buildAcrossSuggestedFeesQuery,
  buildAcrossSwapApprovalQuery,
  getAcrossExecutionError,
  normalizeAcrossEvmToSolanaQuoteResponse,
  normalizeAcrossSolanaSourceQuoteResponse,
  resolveAcrossAppFeeForRoute,
  resolveAcrossRoute,
} from "./services/across-bridge.js";
import { buildEmbeddedEthereumSendTransactionRequest } from "./services/embedded-ethereum.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const ACROSS_SOLANA_SPOKE_POOL = "DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const POLYGON_USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const SOLANA_MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

function withAcrossEnv(
  run: () => void,
  overrides: {
    appFee?: number;
    appFeeRecipients?: string;
  } = {},
) {
  const originalEnabled = env.bridgeAcrossEnabled;
  const originalIntegratorId = env.acrossIntegratorId;
  const originalAllowlist = env.acrossRouteAllowlist;
  const originalAppFee = env.acrossAppFee;
  const originalAppFeeRecipients = env.acrossAppFeeRecipients;
  try {
    env.bridgeAcrossEnabled = true;
    env.acrossIntegratorId = "0x00f7";
    env.acrossRouteAllowlist = [];
    env.acrossAppFee = overrides.appFee ?? 0;
    env.acrossAppFeeRecipients = overrides.appFeeRecipients ?? "";
    run();
  } finally {
    env.bridgeAcrossEnabled = originalEnabled;
    env.acrossIntegratorId = originalIntegratorId;
    env.acrossRouteAllowlist = originalAllowlist;
    env.acrossAppFee = originalAppFee;
    env.acrossAppFeeRecipients = originalAppFeeRecipients;
  }
}

function u32Le(value: number): Buffer {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(value, 0);
  return output;
}

function u64Le(value: bigint): Buffer {
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(value, 0);
  return output;
}

function bytes32Amount(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(64, "0"), "hex");
}

function evmAddressToPublicKey(address: string): PublicKey {
  const output = Buffer.alloc(32);
  Buffer.from(address.replace(/^0x/u, ""), "hex").copy(output, 12);
  return new PublicKey(output);
}

function encodeBorshBytes(bytes: Buffer): Buffer {
  return Buffer.concat([u32Le(bytes.length), bytes]);
}

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

function deriveDepositSeedHash(inputs: {
  depositor: PublicKey;
  recipient: PublicKey;
  inputToken: PublicKey;
  outputToken: PublicKey;
  inputAmount: bigint;
  outputAmount: Buffer;
  destinationChainId: bigint;
  exclusiveRelayer: PublicKey;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusivityParameter: number;
  message: Buffer;
}) {
  return Buffer.from(
    ethers
      .keccak256(
        Buffer.concat([
          inputs.depositor.toBuffer(),
          inputs.recipient.toBuffer(),
          inputs.inputToken.toBuffer(),
          inputs.outputToken.toBuffer(),
          u64Le(inputs.inputAmount),
          inputs.outputAmount,
          u64Le(inputs.destinationChainId),
          inputs.exclusiveRelayer.toBuffer(),
          u32Le(inputs.quoteTimestamp),
          u32Le(inputs.fillDeadline),
          u32Le(inputs.exclusivityParameter),
          encodeBorshBytes(inputs.message),
        ]),
      )
      .slice(2),
    "hex",
  );
}

const tests: TestCase[] = [
  {
    name: "resolveAcrossRoute uses Swap API for EVM-origin Solana routes",
    run: () => {
      withAcrossEnv(() => {
        assert.deepEqual(
          resolveAcrossRoute({
            swapType: "cross_chain",
            srcChainId: HUNCH_SOLANA_CHAIN_ID,
            dstChainId: "137",
            srcToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            dstToken: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
          }),
          { ok: true, mode: "solana_source" },
        );

        assert.deepEqual(
          resolveAcrossRoute({
            swapType: "cross_chain",
            srcChainId: "8453",
            dstChainId: HUNCH_SOLANA_CHAIN_ID,
            srcToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            dstToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          }),
          { ok: true, mode: "swap_api" },
        );

        assert.deepEqual(
          resolveAcrossRoute({
            swapType: "cross_chain",
            srcChainId: "137",
            dstChainId: HUNCH_SOLANA_CHAIN_ID,
            srcToken: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
            dstToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          }),
          { ok: true, mode: "swap_api" },
        );
      });
    },
  },
  {
    name: "Across app fee applies only to Swap API routes",
    run: () => {
      withAcrossEnv(
        () => {
          assert.deepEqual(resolveAcrossAppFeeForRoute("solana_source", "137"), {
            ok: true,
          });
          assert.deepEqual(
            resolveAcrossAppFeeForRoute("evm_to_solana", HUNCH_SOLANA_CHAIN_ID),
            { ok: true },
          );
          assert.deepEqual(
            resolveAcrossAppFeeForRoute("swap_api", HUNCH_SOLANA_CHAIN_ID),
            { ok: true },
          );

          const missingRecipient = resolveAcrossAppFeeForRoute("swap_api", "8453");
          assert.equal(missingRecipient.ok, false);

          env.acrossAppFeeRecipients =
            "8453:0x3B5EdF27853C5E521D2419508AAfcf9A1DB2b493";
          const appFee = resolveAcrossAppFeeForRoute("swap_api", "8453");
          assert.deepEqual(appFee, {
            ok: true,
            appFee: 0.001,
            appFeeRecipient: "0x3B5EdF27853C5E521D2419508AAfcf9A1DB2b493",
          });
        },
        { appFee: 0.001 },
      );
    },
  },
  {
    name: "Across query builders keep Solana fees off suggested-fees",
    run: () => {
      withAcrossEnv(
        () => {
          const suggestedFeesQuery = buildAcrossSuggestedFeesQuery({
            srcChainId: "8453",
            dstChainId: HUNCH_SOLANA_CHAIN_ID,
            srcToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            dstToken: SOLANA_USDC,
            amountIn: "1000000",
            recipientAddress: "7GyRwj3RfmWAFM5mPHcrREEiTVasmHvSWQoCGQ9heAAr",
          });
          assert.equal("appFee" in suggestedFeesQuery, false);
          assert.equal("appFeeRecipient" in suggestedFeesQuery, false);

          const swapApprovalQuery = buildAcrossSwapApprovalQuery({
            srcChainId: "137",
            dstChainId: "8453",
            srcToken: POLYGON_USDC,
            dstToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            amountIn: "1000000",
            senderAddress: "0x1111111111111111111111111111111111111111",
            recipientAddress: "0x2222222222222222222222222222222222222222",
          });
          assert.equal(swapApprovalQuery.appFee, 0.001);
          assert.equal(
            swapApprovalQuery.appFeeRecipient,
            "0x3B5EdF27853C5E521D2419508AAfcf9A1DB2b493",
          );

          const evmToSolanaSwapApprovalQuery = buildAcrossSwapApprovalQuery({
            srcChainId: "137",
            dstChainId: HUNCH_SOLANA_CHAIN_ID,
            srcToken: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
            dstToken: SOLANA_USDC,
            amountIn: "1000000",
            senderAddress: "0x1111111111111111111111111111111111111111",
            recipientAddress: "7GyRwj3RfmWAFM5mPHcrREEiTVasmHvSWQoCGQ9heAAr",
          });
          assert.equal(evmToSolanaSwapApprovalQuery.appFee, undefined);
          assert.equal(evmToSolanaSwapApprovalQuery.appFeeRecipient, undefined);
          assert.equal(
            evmToSolanaSwapApprovalQuery.destinationChainId,
            ACROSS_SOLANA_CHAIN_ID,
          );
        },
        {
          appFee: 0.001,
          appFeeRecipients:
            "8453:0x3B5EdF27853C5E521D2419508AAfcf9A1DB2b493",
        },
      );
    },
  },
  {
    name: "Across status requests can omit integratorId",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const capturedUrls: string[] = [];
      globalThis.fetch = (async (input) => {
        capturedUrls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      try {
        await acrossRequest({
          baseUrl: "https://app.across.to/api",
          timeoutMs: 1000,
          method: "GET",
          requestPath: "/deposit/status",
          integratorId: "0x00f7",
          includeIntegratorId: false,
          query: { depositTxnRef: "0xabc" },
        });
        await acrossRequest({
          baseUrl: "https://app.across.to/api",
          timeoutMs: 1000,
          method: "GET",
          requestPath: "/swap/chains",
          integratorId: "0x00f7",
        });
      } finally {
        globalThis.fetch = originalFetch;
      }

      assert.equal(
        capturedUrls[0],
        "https://app.across.to/api/deposit/status?depositTxnRef=0xabc",
      );
      assert.equal(
        capturedUrls[1],
        "https://app.across.to/api/swap/chains?integratorId=0x00f7",
      );
    },
  },
  {
    name: "normalizeAcrossEvmToSolanaQuoteResponse builds executable tx and approval",
    run: () => {
      const quote = normalizeAcrossEvmToSolanaQuoteResponse({
        payload: {
          id: "quote-1",
          timestamp: "1770000000",
          fillDeadline: "1770003600",
          outputAmount: "990000",
          spokePoolAddress: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5",
          inputToken: { decimals: 6, symbol: "USDC" },
          outputToken: { decimals: 6, symbol: "USDC" },
        },
        swapType: "cross_chain",
        srcChainId: "8453",
        dstChainId: HUNCH_SOLANA_CHAIN_ID,
        srcToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        dstToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amountIn: "1000000",
        senderAddress: "0x1111111111111111111111111111111111111111",
        recipientAddress: "7GyRwj3RfmWAFM5mPHcrREEiTVasmHvSWQoCGQ9heAAr",
      });

      assert.equal(getAcrossExecutionError(quote), null);
      assert.equal((quote.tx as { kind?: string }).kind, "evm");
      assert.equal(
        (quote.tx as { to?: string }).to,
        "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5",
      );
      assert.match((quote.tx as { data?: string }).data ?? "", /^0x/);
      assert.equal(
        ((quote.approvalTxns as Array<{ to: string }>) ?? [])[0]?.to,
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      );
    },
  },
  {
    name: "normalizeAcrossSolanaSourceQuoteResponse builds expected SVM deposit transaction",
    run: async () => {
      const signer = new PublicKey("7GyRwj3RfmWAFM5mPHcrREEiTVasmHvSWQoCGQ9heAAr");
      const recipient = evmAddressToPublicKey(
        "0x1111111111111111111111111111111111111111",
      );
      const inputToken = new PublicKey(SOLANA_USDC);
      const outputToken = evmAddressToPublicKey(POLYGON_USDC);
      const inputAmount = 1_000_000n;
      const outputAmount = bytes32Amount(997_503n);
      const quoteTimestamp = 1_776_975_659;
      const fillDeadline = 1_776_982_859;
      const programId = new PublicKey(ACROSS_SOLANA_SPOKE_POOL);
      const [statePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("state"), u64Le(0n)],
        programId,
      );
      const seedHash = deriveDepositSeedHash({
        depositor: signer,
        recipient,
        inputToken,
        outputToken,
        inputAmount,
        outputAmount,
        destinationChainId: 137n,
        exclusiveRelayer: PublicKey.default,
        quoteTimestamp,
        fillDeadline,
        exclusivityParameter: 0,
        message: Buffer.alloc(0),
      });
      const [delegatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("delegate"), seedHash],
        programId,
      );
      const depositorTokenAccount = getAssociatedTokenAddressSync(inputToken, signer);
      const vault = getAssociatedTokenAddressSync(inputToken, statePda, true);
      const [eventAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        programId,
      );

      const quote = await normalizeAcrossSolanaSourceQuoteResponse({
        payload: {
          id: "solana-quote-1",
          timestamp: String(quoteTimestamp),
          fillDeadline: String(fillDeadline),
          outputAmount: "997503",
          exclusiveRelayer: "0x0000000000000000000000000000000000000000",
          exclusivityDeadline: 0,
          spokePoolAddress: ACROSS_SOLANA_SPOKE_POOL,
          inputToken: { address: SOLANA_USDC, symbol: "USDC", decimals: 6 },
          outputToken: { address: POLYGON_USDC, symbol: "USDC", decimals: 6 },
        },
        swapType: "cross_chain",
        srcChainId: HUNCH_SOLANA_CHAIN_ID,
        dstChainId: "137",
        srcToken: SOLANA_USDC,
        dstToken: POLYGON_USDC,
        amountIn: inputAmount.toString(),
        senderAddress: signer.toBase58(),
        recipientAddress: "0x1111111111111111111111111111111111111111",
        integratorId: "0x00f7",
        latestBlockhash: {
          blockhash: "11111111111111111111111111111111",
          lastValidBlockHeight: 123,
        },
      });

      assert.equal(getAcrossExecutionError(quote), null);
      assert.equal(quote.lastValidBlockHeight, 123);
      const serialized = (quote.tx as { data?: string }).data ?? "";
      const tx = Transaction.from(Buffer.from(serialized, "base64"));
      assert.equal(tx.feePayer?.toBase58(), signer.toBase58());
      assert.equal(tx.instructions.length, 3);

      const [approveIx, depositIx, memoIx] = tx.instructions;
      assert.equal(approveIx.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
      assert.equal(approveIx.keys[0]?.pubkey.toBase58(), depositorTokenAccount.toBase58());
      assert.equal(approveIx.keys[1]?.pubkey.toBase58(), inputToken.toBase58());
      assert.equal(approveIx.keys[2]?.pubkey.toBase58(), delegatePda.toBase58());
      assert.equal(approveIx.keys[3]?.pubkey.toBase58(), signer.toBase58());

      assert.equal(depositIx.programId.toBase58(), programId.toBase58());
      assert.deepEqual(
        depositIx.keys.map((key) => key.pubkey.toBase58()),
        [
          signer.toBase58(),
          statePda.toBase58(),
          delegatePda.toBase58(),
          depositorTokenAccount.toBase58(),
          vault.toBase58(),
          inputToken.toBase58(),
          TOKEN_PROGRAM_ID.toBase58(),
          ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
          SystemProgram.programId.toBase58(),
          eventAuthority.toBase58(),
          programId.toBase58(),
        ],
      );
      assert.equal(
        depositIx.data.subarray(0, 8).toString("hex"),
        anchorDiscriminator("deposit").toString("hex"),
      );

      assert.equal(memoIx.programId.toBase58(), SOLANA_MEMO_PROGRAM_ID);
      assert.equal(memoIx.data.toString("utf8"), "0x00f7");
    },
  },
  {
    name: "embedded EVM transaction requests omit gas and zero value",
    run: () => {
      const request = buildEmbeddedEthereumSendTransactionRequest({
        context: {
          signer: "0x1111111111111111111111111111111111111111",
          walletId: "wallet-id",
          walletProfile: {
            address: "0x1111111111111111111111111111111111111111",
            walletType: "ethereum",
            source: "embedded",
            isInternalWallet: true,
            walletId: "wallet-id",
          },
        },
        chainId: 137,
        transaction: {
          id: "bridge-submit",
          label: "Bridge transaction",
          to: "0x2222222222222222222222222222222222222222",
          data: "0x",
          value: "0",
          gas: "98561",
        },
      });
      const body = request.input.body as {
        params?: { transaction?: Record<string, unknown> };
      };
      assert.equal(body.params?.transaction?.value, undefined);
      assert.equal(body.params?.transaction?.gas, undefined);
    },
  },
  {
    name: "Across fallback excludes config errors",
    run: () => {
      assert.equal(
        isAcrossFallbackableError({
          status: 500,
          payload: { code: "across_app_fee_invalid", error: "bad config" },
        }),
        false,
      );
      assert.equal(
        isAcrossFallbackableError({
          status: 500,
          payload: { code: "INTERNAL_SERVER_ERROR" },
        }),
        true,
      );
    },
  },
];

for (const test of tests) {
  await test.run();
}
