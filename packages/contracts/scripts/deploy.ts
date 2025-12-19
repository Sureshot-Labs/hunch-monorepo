import { ethers } from "hardhat";
import minimist from "minimist";

/**
 * Deploys PolymarketFeeCollector (v2) with configurable params.
 *
 * Usage:
 *  pnpm deploy -- --network polygon \
 *    --treasury 0xYourTreasury \
 *    --collateral 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 \
 *    --exchange 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E \
 *    --negRiskExchange 0xC5d563A36AE78145C45a50134d48A1215220f80a
 *
 * Or:
 *  pnpm deploy -- --network polygon \
 *    --treasury 0xYourTreasury \
 *    --collateral 0x2791... \
 *    --exchanges 0x4bFb...,0xC5d5...
 */

async function main() {
  const argv = minimist(process.argv.slice(2));

  const treasury = argv.treasury as string | undefined;
  const collateral =
    (argv.collateral as string | undefined) ||
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
  const exchange =
    (argv.exchange as string | undefined) ||
    "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
  const negRiskExchange =
    (argv.negRiskExchange as string | undefined) ||
    "0xC5d563A36AE78145C45a50134d48A1215220f80a";
  const exchangesArg = argv.exchanges as string | undefined;

  if (!treasury) {
    throw new Error("Missing --treasury address");
  }

  const exchanges =
    exchangesArg && exchangesArg.trim().length > 0
      ? exchangesArg.split(",").map((value) => value.trim())
      : [exchange, negRiskExchange];

  console.log("Deploying PolymarketFeeCollector v2 with params:");
  console.log({ treasury, collateral, exchanges });

  const FeeCollector = await ethers.getContractFactory("PolymarketFeeCollector");
  const feeCollector = await FeeCollector.deploy(treasury, collateral, exchanges);
  await feeCollector.waitForDeployment();

  console.log("PolymarketFeeCollector deployed to:", await feeCollector.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
