import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const polygonRpcUrl = process.env.POLYGON_RPC_URL;
const polygonDeployerKey = process.env.POLYGON_DEPLOYER_KEY;

const networks: HardhatUserConfig["networks"] = {};
if (polygonRpcUrl && polygonDeployerKey) {
  networks.polygon = {
    url: polygonRpcUrl,
    accounts: [polygonDeployerKey],
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
