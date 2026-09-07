import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  fundingEvmRpcUrl,
  loadFundingSidecarRuntimeConfig,
} from "../../runtime/sidecar-runtime-config.js";
import { readPreparationReceipt } from "../../preparation/approval-receipt.js";

async function check(label: string, body: () => void | Promise<void>) {
  await body();
  console.log(`[preparation-receipt-rpc] ok ${label}`);
}

await check(
  "receipt RPC selection uses named RPCs without override map",
  () => {
    const named = {
      BASE_RPC_URL: "http://base.test",
      POLYGON_RPC_URL: "http://polygon.test",
      ETHEREUM_RPC_URL: "http://ethereum.test",
      OPTIMISM_RPC_URL: "http://optimism.test",
      BSC_RPC_URL: "http://bsc.test",
      ARBITRUM_RPC_URL: "http://arbitrum.test",
      AVALANCHE_RPC_URL: "http://avalanche.test",
      LINEA_RPC_URL: "http://linea.test",
    };
    const config = loadFundingSidecarRuntimeConfig(named);
    assert.deepEqual(config.evmRpcUrlsByChain, {});
    for (const [chain, url] of [
      [8453, named.BASE_RPC_URL],
      [137, named.POLYGON_RPC_URL],
      [1, named.ETHEREUM_RPC_URL],
      [10, named.OPTIMISM_RPC_URL],
      [56, named.BSC_RPC_URL],
      [42161, named.ARBITRUM_RPC_URL],
      [43114, named.AVALANCHE_RPC_URL],
      [59144, named.LINEA_RPC_URL],
    ] as const)
      assert.equal(fundingEvmRpcUrl(chain, config), url);
    assert.equal(
      fundingEvmRpcUrl(8453, {
        ...config,
        evmRpcUrlsByChain: { "8453": " http://override.test " },
      }),
      "http://override.test",
    );
    assert.equal(
      fundingEvmRpcUrl(8453, { ...config, evmRpcUrlsByChain: { "8453": " " } }),
      named.BASE_RPC_URL,
    );
    for (const chain of [NaN, 0, -1, 1.5, 999999])
      assert.equal(fundingEvmRpcUrl(chain, config), null);
  },
);

await check(
  "real preparation receipt loader reaches named Base RPC and reads canonical block",
  async () => {
    const calls: string[] = [];
    const hash = `0x${"ab".repeat(32)}`;
    const address = `0x${"11".repeat(20)}`;
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const input = JSON.parse(body) as { id: number; method: string };
      calls.push(input.method);
      const results: Record<string, unknown> = {
        eth_getTransactionByHash: {
          chainId: "0x2105",
          from: address,
          to: address,
          input: "0x",
          value: "0x0",
        },
        eth_getTransactionReceipt: {
          status: "0x1",
          blockNumber: "0x10",
          blockHash: hash,
          logs: [],
        },
        eth_getBlockByNumber: { hash },
        eth_blockNumber: "0x20",
      };
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: input.id,
          result: results[input.method],
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const bound = server.address();
      assert.ok(bound && typeof bound !== "string");
      const config = loadFundingSidecarRuntimeConfig({
        BASE_RPC_URL: `http://127.0.0.1:${bound.port}`,
      });
      assert.deepEqual(config.evmRpcUrlsByChain, {});
      const result = await readPreparationReceipt("evm:8453", hash, config);
      assert.equal(result.transaction?.chainId, 8453n);
      assert.equal(result.receipt?.canonicalBlockHash, hash);
      assert.equal(result.receipt?.confirmations, 17);
      assert.deepEqual(
        calls.sort(),
        [
          "eth_blockNumber",
          "eth_getBlockByNumber",
          "eth_getTransactionByHash",
          "eth_getTransactionReceipt",
        ].sort(),
      );
      await assert.rejects(
        readPreparationReceipt("evm:999999", hash, config),
        /preparation_receipt_rpc_unavailable/u,
      );
      await assert.rejects(
        readPreparationReceipt("solana:mainnet", hash, config),
        /preparation_receipt_rpc_unavailable/u,
      );
      assert.equal(
        calls.length,
        4,
        "unsupported network does not query a different chain",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
