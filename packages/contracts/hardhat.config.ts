import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "node:path";

// Load env from both package-local and monorepo-root locations.
dotenvConfig({ path: resolve(__dirname, ".env"), override: false });
dotenvConfig({ path: resolve(__dirname, "../../.env"), override: false });

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function normalizeHexPrivateKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("0x") ? value : `0x${value}`;
}

const polygonRpcUrl = firstNonEmpty(
  process.env.POLYGON_RPC_URL,
  process.env.HUNCH_POLYGON_RPC_URL,
);

const polygonDeployerKey = normalizeHexPrivateKey(
  firstNonEmpty(
    process.env.POLYGON_DEPLOYER_KEY,
    process.env.HUNCH_FEE_COLLECTOR_PRIVATE_KEY,
    process.env.HUNCH_REWARDS_PAYOUT_PRIVATE_KEY_POLYGON,
    process.env.HUNCH_REWARDS_PAYOUT_PRIVATE_KEY,
  ),
);

const networks: HardhatUserConfig["networks"] = {};
if (polygonRpcUrl && process.env.POLYGON_FORK === "1") {
  const configuredBlock = Number(process.env.POLYGON_FORK_BLOCK_NUMBER);
  networks.hardhat = {
    forking: {
      url: polygonRpcUrl,
      ...(Number.isSafeInteger(configuredBlock) && configuredBlock > 0
        ? { blockNumber: configuredBlock }
        : {}),
    },
  };
}
if (polygonRpcUrl) {
  networks.polygon = {
    url: polygonRpcUrl,
    accounts: polygonDeployerKey ? [polygonDeployerKey] : [],
  };
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./hh-cache",
    artifacts: "./artifacts",
  },
  networks,
};

export default config;
