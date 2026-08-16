import fs from "node:fs";
import path from "node:path";

type AbiExport = {
  artifact: string;
  outFile: string;
};

const exportsList: AbiExport[] = [
  {
    artifact: "PolymarketFundingRouter.sol/PolymarketFundingRouter.json",
    outFile: "PolymarketFundingRouter.json",
  },
  {
    artifact: "PolymarketFeeCollector.sol/PolymarketFeeCollector.json",
    outFile: "PolymarketFeeCollector.json",
  },
  {
    artifact:
      "PolymarketFeeCollectorClobV2.sol/PolymarketFeeCollectorClobV2.json",
    outFile: "PolymarketFeeCollectorClobV2.json",
  },
  {
    artifact: "PolymarketInterfaces.sol/IPolymarketExchange.json",
    outFile: "IPolymarketExchange.json",
  },
  {
    artifact: "PolymarketInterfacesV2.sol/IPolymarketExchangeV2.json",
    outFile: "IPolymarketExchangeV2.json",
  },
];

function main() {
  const root = path.resolve(__dirname, "..");
  const artifactsDir = path.join(root, "artifacts", "src");
  const outDir = path.join(root, "src", "abis");

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  for (const entry of exportsList) {
    const artifactPath = path.join(artifactsDir, entry.artifact);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Missing artifact: ${artifactPath}`);
    }
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const outPath = path.join(outDir, entry.outFile);
    fs.writeFileSync(outPath, `${JSON.stringify(artifact.abi, null, 2)}\n`);
  }

  console.log(`Exported ${exportsList.length} ABI files to ${outDir}`);
}

main();
