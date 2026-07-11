import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { artifacts, ethers, network } from "hardhat";

const EPHEMERAL_GAS_FALLBACK = 1_200_000n;
const GAS_LIMIT_BUFFER_PERCENT = 125n;
const FUNDING_BUFFER_PERCENT = 120n;

const EXPECTED = {
  pUsd: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  usdce: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  onramp: "0x93070a847efEf7F70739046A929D47a521F5B8ee",
  factory: "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",
  beacon: "0x7A18EDfe055488A3128f01F563e5B479D92ffc3a",
  legacyImplementation: "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB",
  goldenOwner: "0x09c88f1d3cdd98c356a21434cd4af40cce795314",
  goldenDeposit: "0x496f46AA7500563E7f577D12CB8193421F2963C7",
} as const;

async function assertDependency(address: string, name: string) {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`${name} is not deployed at ${address}`);
  return {
    address: ethers.getAddress(address),
    codeHash: ethers.keccak256(code),
  };
}

async function estimateDeploymentFunding(input: {
  deployer: string;
  deploymentData: string;
}): Promise<{
  estimatedGas: bigint;
  feePerGas: bigint;
  recommendedBalance: bigint;
}> {
  let estimatedGas: bigint;
  try {
    estimatedGas = await ethers.provider.estimateGas({
      data: input.deploymentData,
      from: input.deployer,
    });
  } catch {
    estimatedGas = EPHEMERAL_GAS_FALLBACK;
  }
  const feeData = await ethers.provider.getFeeData();
  const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!feePerGas || feePerGas <= 0n) {
    throw new Error("Polygon RPC did not return a usable gas price");
  }
  const bufferedGas = (estimatedGas * GAS_LIMIT_BUFFER_PERCENT + 99n) / 100n;
  const recommendedBalance =
    (bufferedGas * feePerGas * FUNDING_BUFFER_PERCENT + 99n) / 100n;
  return { estimatedGas, feePerGas, recommendedBalance };
}

async function waitForEphemeralFunding(input: {
  deployer: { address: string };
  deploymentData: string;
}): Promise<void> {
  const terminal = createInterface({ input: stdin, output: stdout });
  console.log("\nNo POLYGON_DEPLOYER_KEY was provided.");
  console.log("Created an ephemeral Polygon deployer only in this process.");
  console.log(
    "WARNING: do not close this terminal after funding it. The private key is not printed or written anywhere, so sent POL would be unrecoverable.",
  );
  console.log(`Ephemeral deployer: ${input.deployer.address}`);

  try {
    for (;;) {
      const estimate = await estimateDeploymentFunding({
        deployer: input.deployer.address,
        deploymentData: input.deploymentData,
      });
      const balance = await ethers.provider.getBalance(input.deployer.address);
      console.log(`Estimated deployment gas: ${estimate.estimatedGas}`);
      console.log(
        `Current max fee: ${ethers.formatUnits(estimate.feePerGas, "gwei")} gwei`,
      );
      console.log(
        `Recommended deployer balance: ${ethers.formatEther(estimate.recommendedBalance)} POL`,
      );
      console.log(`Current balance: ${ethers.formatEther(balance)} POL`);
      await terminal.question(
        "Fund the address above, then press Enter to re-check and deploy: ",
      );
      const refreshed = await estimateDeploymentFunding({
        deployer: input.deployer.address,
        deploymentData: input.deploymentData,
      });
      const refreshedBalance = await ethers.provider.getBalance(
        input.deployer.address,
      );
      if (refreshedBalance >= refreshed.recommendedBalance) return;
      console.log(
        `Balance is still below the current recommendation by ${ethers.formatEther(refreshed.recommendedBalance - refreshedBalance)} POL.`,
      );
    }
  } finally {
    terminal.close();
  }
}

async function main() {
  if (network.name !== "polygon") {
    throw new Error(
      "PolymarketFundingRouter may only be deployed with HARDHAT_NETWORK=polygon",
    );
  }
  const deploymentDir = resolve(__dirname, "../deployments");
  const manifestPath = resolve(
    deploymentDir,
    "polymarket-funding-router.polygon.json",
  );
  await access(manifestPath)
    .then(() => {
      throw new Error(
        `Funding router manifest already exists at ${manifestPath}; refusing a second deployment`,
      );
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== 137n)
    throw new Error(`Expected Polygon 137, received ${chainId}`);

  const dependencies = Object.fromEntries(
    await Promise.all(
      [
        "pUsd",
        "usdce",
        "onramp",
        "factory",
        "beacon",
        "legacyImplementation",
      ].map(async (name) => [
        name,
        await assertDependency(EXPECTED[name as keyof typeof EXPECTED], name),
      ]),
    ),
  );
  const factory = new ethers.Contract(
    EXPECTED.factory,
    [
      "function BEACON() view returns (address)",
      "function LEGACY_IMPL() view returns (address)",
      "function predictLegacyWalletAddress(bytes32 id) view returns (address)",
    ],
    ethers.provider,
  );
  const walletId = ethers.zeroPadValue(EXPECTED.goldenOwner, 32);
  const [beacon, legacyImplementation, goldenPrediction] = await Promise.all([
    factory.BEACON() as Promise<string>,
    factory.LEGACY_IMPL() as Promise<string>,
    factory.predictLegacyWalletAddress(walletId) as Promise<string>,
  ]);
  if (
    ethers.getAddress(beacon) !== ethers.getAddress(EXPECTED.beacon) ||
    ethers.getAddress(legacyImplementation) !==
      ethers.getAddress(EXPECTED.legacyImplementation) ||
    ethers.getAddress(goldenPrediction) !==
      ethers.getAddress(EXPECTED.goldenDeposit)
  ) {
    throw new Error(
      "Polymarket factory state does not match audited constants",
    );
  }

  const configuredDeployer = process.env.POLYGON_DEPLOYER_KEY?.trim();
  const ephemeralDeployer = configuredDeployer
    ? null
    : ethers.Wallet.createRandom().connect(ethers.provider);
  const deployer = ephemeralDeployer ?? (await ethers.getSigners())[0];
  if (!deployer) {
    throw new Error("Polygon deployer is unavailable");
  }
  const FundingRouter = await ethers.getContractFactory(
    "PolymarketFundingRouter",
    deployer,
  );
  const deploymentRequest = await FundingRouter.getDeployTransaction();
  if (!deploymentRequest.data) {
    throw new Error("Funding router deployment bytecode is missing");
  }
  if (ephemeralDeployer) {
    await waitForEphemeralFunding({
      deployer: ephemeralDeployer,
      deploymentData: deploymentRequest.data,
    });
  }
  const router = await FundingRouter.deploy();
  const address = await router.getAddress();
  const transaction = router.deploymentTransaction();
  console.log(`Funding router broadcast: ${transaction?.hash ?? "unknown"}`);
  console.log(`Funding router address: ${address}`);
  await router.waitForDeployment();
  const receipt = await transaction?.wait(5);
  if (!receipt) throw new Error("Funding router deployment receipt is missing");
  if (
    ethers.getAddress(await router.depositWalletOf(EXPECTED.goldenOwner)) !==
    ethers.getAddress(EXPECTED.goldenDeposit)
  ) {
    throw new Error("Deployed router failed the production golden vector");
  }
  const runtimeCode = await ethers.provider.getCode(address);
  const artifact = await artifacts.readArtifact("PolymarketFundingRouter");
  const runtimeCodeHash = ethers.keccak256(runtimeCode);
  const artifactRuntimeCodeHash = ethers.keccak256(artifact.deployedBytecode);
  if (runtimeCodeHash !== artifactRuntimeCodeHash) {
    throw new Error("Deployed router bytecode does not match local artifact");
  }
  const manifest = {
    contract: "PolymarketFundingRouter",
    version: 2,
    network: "polygon",
    chainId: 137,
    address,
    deployer: await deployer.getAddress(),
    deployerMode: ephemeralDeployer ? "ephemeral-memory" : "configured-key",
    transactionHash: transaction?.hash ?? null,
    blockNumber: receipt.blockNumber,
    runtimeCodeHash,
    runtimeBytecodeVerification: {
      artifactCodeHash: artifactRuntimeCodeHash,
      onchainCodeHash: runtimeCodeHash,
      status: "verified",
    },
    dependencies,
    goldenVector: {
      owner: EXPECTED.goldenOwner,
      depositWallet: EXPECTED.goldenDeposit,
    },
    explorerVerification: "not_published",
    createdAt: new Date().toISOString(),
  };
  await mkdir(deploymentDir, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  if (ephemeralDeployer) {
    const remainingBalance = await ethers.provider.getBalance(
      ephemeralDeployer.address,
    );
    console.log(
      `Ephemeral deployer remaining balance: ${ethers.formatEther(remainingBalance)} POL (unrecoverable after this process exits).`,
    );
  }
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
