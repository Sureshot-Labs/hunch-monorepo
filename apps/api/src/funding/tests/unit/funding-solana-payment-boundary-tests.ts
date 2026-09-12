import assert from "node:assert/strict";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  applyEmbeddedSolanaBackendSponsorshipPolicy,
  validateEmbeddedSolanaSponsorshipAtExecute,
} from "../../../routes/embedded-wallets.js";
import { prepareEmbeddedSolanaTransactionRequests } from "../../../services/embedded-solana.js";
import {
  assertSolanaFundingPaymentBinding,
  type VerifiedSolanaFundingPayment,
} from "../../execution/solana-funding-payment.js";

const signer = Keypair.generate().publicKey;
const recipient = Keypair.generate().publicKey;
const serialized = Buffer.from(
  new VersionedTransaction(
    new TransactionMessage({
      payerKey: signer,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [
        SystemProgram.transfer({
          fromPubkey: signer,
          toPubkey: recipient,
          lamports: 2995000n,
        }),
      ],
    }).compileToV0Message(),
  ).serialize(),
).toString("base64");
let proofs = 0;
const previous = process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED;
process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = "true";
try {
  for (const id of [
    "relay:real-provider-intent:deposit",
    "funding_action_direct_withdrawal",
    "opaque-provider-action",
  ]) {
    for (const payer of ["privy_sponsor", "user"] as const) {
      const required = payer === "privy_sponsor" ? 2995000n : 3000000n;
      const payment: VerifiedSolanaFundingPayment = {
        signer: signer.toBase58(),
        transaction: serialized,
        requiredSignerLamports: required,
        binding: {
          operationId: "operation",
          stepId: "step",
          attemptNumber: 1,
          actionFingerprint: "fingerprint",
          payer,
        },
      };
      const prepareFunding: NonNullable<
        Parameters<
          typeof applyEmbeddedSolanaBackendSponsorshipPolicy
        >[0]["dependencies"]
      >["prepareFunding"] = async (input) => {
        proofs++;
        assert.equal(input.requestId, id);
        assert.equal(input.requestedSponsor, payer === "privy_sponsor");
        if (input.execute) {
          assert.ok(input.expectedBinding);
          assertSolanaFundingPaymentBinding(
            payment.binding,
            input.expectedBinding,
          );
        }
        return {
          transaction: serialized,
          idempotencyKey: "bound-step",
          payment,
        };
      };
      const policy = await applyEmbeddedSolanaBackendSponsorshipPolicy({
        user: { id: "user-test" } as Parameters<
          typeof applyEmbeddedSolanaBackendSponsorshipPolicy
        >[0]["user"],
        signer: signer.toBase58(),
        transactions: [
          {
            id,
            label: "Funding",
            transaction: serialized,
            sponsor: payer === "privy_sponsor",
          },
        ],
        dependencies: {
          getRedis: async () => null,
          lossCloseEnabled: async () => false,
          prepareFunding,
        },
      });
      assert.equal(
        proofs > 0,
        true,
        "Opaque Relay IDs must reach the owned funding proof",
      );
      const context = {
        signer: signer.toBase58(),
        walletId: "test",
        walletProfile: {
          walletId: "test",
          address: signer.toBase58(),
          walletType: "solana" as const,
          source: "embedded" as const,
          isInternalWallet: true,
        },
      };
      const requestInput = {
        context,
        transactions: policy.transactions,
        embeddedSolanaSponsorshipEnabled:
          policy.embeddedSolanaSponsorshipEnabled,
        fundingPayment: policy.fundingPayment,
        fetchSponsorBalanceLamports: async () => required,
      };
      for (const balance of [required, 10000000n]) {
        const requests = await prepareEmbeddedSolanaTransactionRequests({
          ...requestInput,
          fetchSponsorBalanceLamports: async () => balance,
        });
        assert.equal(
          requests[0]?.input.body.sponsor,
          payer === "privy_sponsor",
          "The final request must retain the verified fee payer even with extra SOL",
        );
        assert.equal(
          (requests[0]?.input.body.params as { transaction: string })
            .transaction,
          serialized,
        );
        const prepared = requests[0];
        const idempotencyKey = policy.relayIdempotencyKeys[id];
        assert.ok(prepared);
        assert.ok(idempotencyKey);
        prepared.input.headers["privy-idempotency-key"] = idempotencyKey;
        await validateEmbeddedSolanaSponsorshipAtExecute({
          user: { id: "user-test" } as Parameters<
            typeof validateEmbeddedSolanaSponsorshipAtExecute
          >[0]["user"],
          signer: signer.toBase58(),
          requests,
          prepareFunding,
          fundingRedis: null,
        });
      }
      await assert.rejects(
        prepareEmbeddedSolanaTransactionRequests({
          ...requestInput,
          fetchSponsorBalanceLamports: async () => required - 1n,
        }),
        /Needs at least/,
      );
      await assert.rejects(
        prepareEmbeddedSolanaTransactionRequests({
          ...requestInput,
          transactions: [...policy.transactions, ...policy.transactions],
        }),
        /cannot be mixed/,
      );
      await assert.rejects(
        prepareEmbeddedSolanaTransactionRequests({
          ...requestInput,
          fundingPayment: { ...payment, signer: recipient.toBase58() },
        }),
        /does not match/,
      );
      await assert.rejects(
        prepareEmbeddedSolanaTransactionRequests({
          ...requestInput,
          fundingPayment: { ...payment, transaction: "changed" },
        }),
        /does not match/,
      );
    }
  }
  for (const id of [
    "relay:native:deposit",
    "legacy",
    "opaque-provider-action",
  ]) {
    const input = {
      user: { id: "user-test" } as Parameters<
        typeof applyEmbeddedSolanaBackendSponsorshipPolicy
      >[0]["user"],
      signer: signer.toBase58(),
      transactions: [
        { id, label: "Transfer", transaction: serialized, sponsor: false },
      ],
      dependencies: {
        getRedis: async () => null,
        lossCloseEnabled: async () => false,
        prepareFunding: async () => null,
      },
    };
    const policy = await applyEmbeddedSolanaBackendSponsorshipPolicy(input);
    assert.equal(policy.fundingPayment, undefined);
    assert.equal(policy.transactions[0]?.sponsor, false);
    await assert.rejects(
      applyEmbeddedSolanaBackendSponsorshipPolicy({
        ...input,
        transactions: [{ ...input.transactions[0], sponsor: true }],
      }),
      /could not be verified/,
    );
  }
  // Unverified native SOL must retain the legacy guard even if a client asks
  // for sponsorship. The scoped server proof is the only exception.
  await assert.rejects(
    prepareEmbeddedSolanaTransactionRequests({
      context: {
        signer: signer.toBase58(),
        walletId: "test",
        walletProfile: {
          walletId: "test",
          address: signer.toBase58(),
          walletType: "solana",
          source: "embedded",
          isInternalWallet: true,
        },
      },
      transactions: [
        {
          id: "legacy",
          label: "Transfer",
          transaction: serialized,
          sponsor: true,
        },
      ],
      embeddedSolanaSponsorshipEnabled: true,
      fetchSponsorBalanceLamports: async () => 2995000n,
    }),
    /0.005995 SOL/,
  );
  console.log(
    "[funding-solana-payment-boundary-tests] opaque IDs, frozen payer, exact native fee, replay binding and legacy guard passed",
  );
} finally {
  if (previous === undefined)
    delete process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED;
  else process.env.FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED = previous;
}
