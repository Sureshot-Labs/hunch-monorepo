import { ethers } from "hardhat";
import minimist from "minimist";

/**
 * Deploys PolymarketFeeCollector (v2) with configurable params.
 *
 * Usage:
 *  HARDHAT_NETWORK=polygon \
 *  FEE_COLLECTOR_TREASURY=0xYourTreasury \
 *  FEE_COLLECTOR_COLLATERAL=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 \
 *  FEE_COLLECTOR_EXCHANGES=0x4bFb...,0xC5d5... \
 *  pnpm run deploy
 *
 * Or:
 *  HARDHAT_NETWORK=polygon pnpm run deploy -- \
 *    --treasury 0xYourTreasury \
 *    --collateral 0x2791... \
 *    --exchanges 0x4bFb...,0xC5d5...
 */

async function main() {
  const argv = minimist(process.argv.slice(2));

  const firstNonEmpty = (...values: Array<string | undefined>) => {
    for (const value of values) {
      const trimmed = value?.trim();
      if (trimmed) return trimmed;
    }
    return undefined;
  };

  const treasury = firstNonEmpty(
    argv.treasury as string | undefined,
    process.env.FEE_COLLECTOR_TREASURY,
    process.env.HUNCH_FEE_COLLECTOR_TREASURY,
  );
  const collateral =
    firstNonEmpty(
      argv.collateral as string | undefined,
      process.env.FEE_COLLECTOR_COLLATERAL,
      process.env.HUNCH_FEE_COLLECTOR_COLLATERAL,
    ) || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
  const exchange =
    firstNonEmpty(
      argv.exchange as string | undefined,
      process.env.FEE_COLLECTOR_EXCHANGE,
      process.env.HUNCH_FEE_COLLECTOR_EXCHANGE,
    ) || "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
  const negRiskExchange =
    (argv.negriskexchange as string | undefined) ||
    (argv["neg-risk-exchange"] as string | undefined) ||
    (argv.negRiskExchange as string | undefined) ||
    process.env.FEE_COLLECTOR_NEG_RISK_EXCHANGE ||
    process.env.HUNCH_FEE_COLLECTOR_NEG_RISK_EXCHANGE ||
    "0xC5d563A36AE78145C45a50134d48A1215220f80a";
  const exchangesArg = firstNonEmpty(
    argv.exchanges as string | undefined,
    process.env.FEE_COLLECTOR_EXCHANGES,
    process.env.HUNCH_FEE_COLLECTOR_EXCHANGES,
  );

  if (!treasury) {
    throw new Error(
      "Missing treasury address (set --treasury or FEE_COLLECTOR_TREASURY)",
    );
  }

  const exchanges =
    exchangesArg && exchangesArg.trim().length > 0
      ? exchangesArg.split(",").map((value) => value.trim())
      : [exchange, negRiskExchange];

  console.log("Deploying PolymarketFeeCollector v2 with params:");
  console.log({ treasury, collateral, exchanges });

  const FeeCollector = await ethers.getContractFactory(
    "PolymarketFeeCollector",
  );
  const feeCollector = await FeeCollector.deploy(
    treasury,
    collateral,
    exchanges,
  );
  await feeCollector.waitForDeployment();

  console.log(
    "PolymarketFeeCollector deployed to:",
    await feeCollector.getAddress(),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
