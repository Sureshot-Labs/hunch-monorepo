import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { artifacts, ethers, network } from "hardhat";

const EXPECTED = {
  pUsd: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  factory: "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",
  beacon: "0x7A18EDfe055488A3128f01F563e5B479D92ffc3a",
  legacyImplementation: "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB",
  goldenOwner: "0x09c88f1d3cdd98c356a21434cd4af40cce795314",
  goldenDeposit: "0x496f46AA7500563E7f577D12CB8193421F2963C7",
} as const;

async function dependency(address: string, name: string) {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`${name} is not deployed at ${address}`);
  return {
    address: ethers.getAddress(address),
    codeHash: ethers.keccak256(code),
  };
}

async function waitForFunding(wallet: { address: string }, data: string) {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const [gas, fee, balance] = await Promise.all([
        ethers.provider
          .estimateGas({ from: wallet.address, data })
          .catch(() => 1_100_000n),
        ethers.provider.getFeeData(),
        ethers.provider.getBalance(wallet.address),
      ]);
      const feePerGas = fee.maxFeePerGas ?? fee.gasPrice;
      if (!feePerGas) throw new Error("Polygon RPC returned no gas price");
      const required = (gas * 125n * feePerGas * 120n + 9_999n) / 10_000n;
      console.log(`Ephemeral deployer: ${wallet.address}`);
      console.log(`Recommended balance: ${ethers.formatEther(required)} POL`);
      console.log(`Current balance: ${ethers.formatEther(balance)} POL`);
      if (balance >= required) return;
      await terminal.question(
        "Fund this address, then press Enter to re-check: ",
      );
    }
  } finally {
    terminal.close();
  }
}

async function main() {
  if (network.name !== "polygon") {
    throw new Error("PolymarketDepositWalletPuller is Polygon-only");
  }
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== 137n)
    throw new Error(`Expected Polygon 137, received ${chainId}`);

  const deploymentDir = resolve(__dirname, "../deployments");
  const manifestPath = resolve(
    deploymentDir,
    "polymarket-deposit-wallet-puller.polygon.json",
  );
  await access(manifestPath)
    .then(() => {
      throw new Error(`Puller manifest already exists at ${manifestPath}`);
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });

  const dependencies = {
    pUsd: await dependency(EXPECTED.pUsd, "pUSD"),
    factory: await dependency(EXPECTED.factory, "Deposit Wallet Factory"),
    beacon: await dependency(EXPECTED.beacon, "Deposit Wallet Beacon"),
    legacyImplementation: await dependency(
      EXPECTED.legacyImplementation,
      "legacy Deposit Wallet implementation",
    ),
  };
  const factory = new ethers.Contract(
    EXPECTED.factory,
    [
      "function BEACON() view returns (address)",
      "function LEGACY_IMPL() view returns (address)",
      "function predictLegacyWalletAddress(bytes32 id) view returns (address)",
    ],
    ethers.provider,
  );
  const [beacon, legacyImplementation, goldenDeposit] = await Promise.all([
    factory.BEACON() as Promise<string>,
    factory.LEGACY_IMPL() as Promise<string>,
    factory.predictLegacyWalletAddress(
      ethers.zeroPadValue(EXPECTED.goldenOwner, 32),
    ) as Promise<string>,
  ]);
  if (
    ethers.getAddress(beacon) !== ethers.getAddress(EXPECTED.beacon) ||
    ethers.getAddress(legacyImplementation) !==
      ethers.getAddress(EXPECTED.legacyImplementation) ||
    ethers.getAddress(goldenDeposit) !==
      ethers.getAddress(EXPECTED.goldenDeposit)
  )
    throw new Error(
      "Polymarket factory state failed the audited golden vector",
    );

  const configuredKey = process.env.POLYGON_DEPLOYER_KEY?.trim();
  const ephemeral = configuredKey
    ? null
    : ethers.Wallet.createRandom().connect(ethers.provider);
  const deployer = ephemeral ?? (await ethers.getSigners())[0];
  if (!deployer) throw new Error("Polygon deployer is unavailable");
  const factoryContract = await ethers.getContractFactory(
    "PolymarketDepositWalletPuller",
    deployer,
  );
  const request = await factoryContract.getDeployTransaction();
  if (!request.data) throw new Error("Puller deployment bytecode is missing");
  if (ephemeral) await waitForFunding(ephemeral, request.data);

  const puller = await factoryContract.deploy();
  const address = await puller.getAddress();
  const transaction = puller.deploymentTransaction();
  console.log(`Puller broadcast: ${transaction?.hash ?? "unknown"}`);
  console.log(`Puller address: ${address}`);
  await puller.waitForDeployment();
  const receipt = await transaction?.wait(5);
  if (!receipt) throw new Error("Puller deployment receipt is missing");
  if (
    ethers.getAddress(await puller.depositWalletOf(EXPECTED.goldenOwner)) !==
    ethers.getAddress(EXPECTED.goldenDeposit)
  )
    throw new Error("Deployed Puller failed the production golden vector");

  const runtimeCode = await ethers.provider.getCode(address);
  const artifact = await artifacts.readArtifact(
    "PolymarketDepositWalletPuller",
  );
  const runtimeCodeHash = ethers.keccak256(runtimeCode);
  const artifactCodeHash = ethers.keccak256(artifact.deployedBytecode);
  if (runtimeCodeHash !== artifactCodeHash) {
    throw new Error("Deployed Puller bytecode does not match local artifact");
  }
  const manifest = {
    contract: "PolymarketDepositWalletPuller",
    version: 1,
    network: "polygon",
    chainId: 137,
    address,
    deployer: await deployer.getAddress(),
    deployerMode: ephemeral ? "ephemeral-memory" : "configured-key",
    transactionHash: transaction?.hash ?? null,
    blockNumber: receipt.blockNumber,
    runtimeCodeHash,
    runtimeBytecodeVerification: {
      artifactCodeHash,
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
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
