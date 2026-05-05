import { ethers } from "hardhat";
import minimist from "minimist";

/**
 * Deploys PolymarketFeeCollectorClobV2 for Polymarket CLOB V2 pUSD orders.
 *
 * Usage:
 *  HARDHAT_NETWORK=polygon \
 *  FEE_COLLECTOR_TREASURY=0xYourTreasury \
 *  FEE_COLLECTOR_COLLATERAL=0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB \
 *  FEE_COLLECTOR_EXCHANGES=0xE111...,0xe222... \
 *  pnpm run deploy:clob-v2
 */

const DEFAULT_PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const DEFAULT_EXCHANGE = "0xE111180000d2663C0091e4f400237545B87B996B";
const DEFAULT_NEG_RISK_EXCHANGE = "0xe2222d279d744050d28e00520010520000310F59";

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
      process.env.POLYMARKET_PUSD_ADDRESS,
    ) || DEFAULT_PUSD;
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
      : [DEFAULT_EXCHANGE, DEFAULT_NEG_RISK_EXCHANGE];

  console.log("Deploying PolymarketFeeCollectorClobV2 with params:");
  console.log({ treasury, collateral, exchanges });

  const FeeCollector = await ethers.getContractFactory(
    "PolymarketFeeCollectorClobV2",
  );
  const feeCollector = await FeeCollector.deploy(
    treasury,
    collateral,
    exchanges,
  );
  await feeCollector.waitForDeployment();

  console.log(
    "PolymarketFeeCollectorClobV2 deployed to:",
    await feeCollector.getAddress(),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
