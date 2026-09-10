import assert from "node:assert/strict";
import {
  sendSolanaRawTransaction,
  solanaSubmissionErrorDiagnostic,
} from "../../../services/solana-rpc.js";
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.method, "sendTransaction");
    assert.equal(body.params[1].preflightCommitment, "confirmed");
    assert.equal(body.params[1].skipPreflight, false);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32002,
          message: "Transaction simulation failed: Blockhash not found",
        },
      }),
    );
  };
  await assert.rejects(
    sendSolanaRawTransaction({
      rpcUrls: ["https://rpc.invalid"],
      timeoutMs: 1000,
      signedTransaction: "test",
      skipPreflight: false,
      maxRetries: 0,
    }),
    (error) => {
      assert.deepEqual(solanaSubmissionErrorDiagnostic(error), {
        rpcCode: -32002,
        httpStatus: null,
        reason: "blockhash_not_found",
      });
      return true;
    },
  );
  globalThis.fetch = async () =>
    new Response("upstream unavailable", { status: 520 });
  await assert.rejects(
    sendSolanaRawTransaction({
      rpcUrls: ["https://rpc.invalid"],
      timeoutMs: 1000,
      signedTransaction: "test",
    }),
    (error) => {
      assert.equal(solanaSubmissionErrorDiagnostic(error).httpStatus, 520);
      return true;
    },
  );
  assert.equal(
    JSON.stringify(
      solanaSubmissionErrorDiagnostic(
        new Error("secret https://rpc.invalid/key"),
      ),
    ).includes("secret"),
    false,
  );
} finally {
  globalThis.fetch = originalFetch;
}
