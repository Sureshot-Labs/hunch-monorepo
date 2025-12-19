import { expect } from "chai";
import { ethers, artifacts, network } from "hardhat";
import type { PolymarketFeeCollector } from "../typechain-types";

// Canonical Polymarket addresses on Polygon (used for deterministic mock injection)
const EXCHANGE_ADDR = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const USDC_ADDR = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

async function setCodeAt(address: string, contractName: string) {
  const artifact = await artifacts.readArtifact(contractName);
  await network.provider.send("hardhat_setCode", [
    address,
    artifact.deployedBytecode,
  ]);
  return ethers.getContractAt(contractName, address);
}

function buildOrder(
  overrides: Partial<{
    salt: bigint;
    maker: string;
    signer: string;
    taker: string;
    tokenId: bigint;
    makerAmount: bigint;
    takerAmount: bigint;
    expiration: bigint;
    nonce: bigint;
    feeRateBps: bigint;
    side: number;
    signatureType: number;
    signature: string;
  }> = {}
) {
  return {
    salt: overrides.salt ?? 1n,
    maker: overrides.maker!,
    signer: overrides.signer!,
    taker: overrides.taker ?? ethers.ZeroAddress,
    tokenId: overrides.tokenId ?? 123n,
    makerAmount: overrides.makerAmount ?? ethers.parseUnits("100", 6),
    takerAmount: overrides.takerAmount ?? ethers.parseUnits("50", 6),
    expiration: overrides.expiration ?? BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: overrides.nonce ?? 0n,
    feeRateBps: overrides.feeRateBps ?? 0n,
    side: overrides.side ?? 0,
    signatureType: overrides.signatureType ?? 0,
    signature: overrides.signature ?? "0x",
  };
}

function buildDomain(chainId: number, collector: string) {
  return {
    name: "Polymarket Aggregator FeeCollector",
    version: "2",
    chainId,
    verifyingContract: collector,
  };
}

const feeAuthTypes = {
  FeeAuth: [
    { name: "signer", type: "address" },
    { name: "vault", type: "address" },
    { name: "exchange", type: "address" },
    { name: "orderHash", type: "bytes32" },
    { name: "feeBps", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

describe("PolymarketFeeCollector (v2)", () => {
  let treasury: any;
  let signer: any;
  let vault: any;
  let deployer: any;
  let feeCollector: PolymarketFeeCollector;

  beforeEach(async () => {
    await network.provider.send("hardhat_reset");

    [deployer, treasury, signer, vault] = await ethers.getSigners();

    await setCodeAt(USDC_ADDR, "MockUSDC");
    await setCodeAt(EXCHANGE_ADDR, "MockExchange");

    const FeeCollector = await ethers.getContractFactory(
      "PolymarketFeeCollector"
    );
    feeCollector = (await FeeCollector.deploy(
      treasury.address,
      USDC_ADDR,
      [EXCHANGE_ADDR]
    )) as PolymarketFeeCollector;
    await feeCollector.waitForDeployment();
  });

  async function signFeeAuth(params: {
    orderHash: string;
    feeBps: number;
    nonce: bigint;
    deadline: bigint;
    exchange?: string;
    authSignerAddress?: string;
    signingWallet?: any;
  }) {
    const networkData = await ethers.provider.getNetwork();
    const domain = buildDomain(
      Number(networkData.chainId),
      await feeCollector.getAddress()
    );
    const authSignerAddress = params.authSignerAddress ?? signer.address;
    const signingWallet = params.signingWallet ?? signer;
    const feeAuth = {
      signer: authSignerAddress,
      vault: vault.address,
      exchange: params.exchange ?? EXCHANGE_ADDR,
      orderHash: params.orderHash,
      feeBps: params.feeBps,
      nonce: params.nonce,
      deadline: params.deadline,
    };
    const sig = await signingWallet.signTypedData(
      domain,
      feeAuthTypes as any,
      feeAuth
    );
    return { feeAuth, sig };
  }

  it("charges fee for BUY order delta fill and updates state", async () => {
    const order = buildOrder({ maker: vault.address, signer: signer.address, side: 0 });
    const mockExchange = await ethers.getContractAt("MockExchange", EXCHANGE_ADDR);
    const orderHash = await mockExchange.hashOrder(order);

    const remaining = order.makerAmount - ethers.parseUnits("60", 6);
    await mockExchange.setOrderStatus(orderHash, false, remaining);

    const mockUSDC = await ethers.getContractAt("MockUSDC", USDC_ADDR);
    await mockUSDC.mint(vault.address, ethers.parseUnits("1000", 6));
    await mockUSDC.connect(vault).approve(await feeCollector.getAddress(), ethers.MaxUint256);

    const { feeAuth, sig } = await signFeeAuth({
      orderHash,
      feeBps: 50,
      nonce: await feeCollector.nonces(signer.address),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });

    await expect(feeCollector.collectFee(order, feeAuth, sig))
      .to.emit(feeCollector, "FeeCollected")
      .withArgs(
        orderHash,
        vault.address,
        signer.address,
        ethers.parseUnits("0.30", 6),
        ethers.parseUnits("60", 6)
      );

    const treasuryBal = await mockUSDC.balanceOf(treasury.address);
    expect(treasuryBal).to.equal(ethers.parseUnits("0.30", 6));

    const { feeAuth: feeAuth2, sig: sig2 } = await signFeeAuth({
      orderHash,
      feeBps: 50,
      nonce: await feeCollector.nonces(signer.address),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });

    await expect(feeCollector.collectFee(order, feeAuth2, sig2)).to.be.revertedWithCustomError(
      feeCollector,
      "NothingToCharge"
    );
  });

  it("handles SELL order delta", async () => {
    const order = buildOrder({
      maker: vault.address,
      signer: signer.address,
      side: 1,
      makerAmount: ethers.parseUnits("200", 6),
      takerAmount: ethers.parseUnits("150", 6),
    });

    const mockExchange = await ethers.getContractAt("MockExchange", EXCHANGE_ADDR);
    const orderHash = await mockExchange.hashOrder(order);

    const remaining = order.makerAmount - ethers.parseUnits("100", 6);
    await mockExchange.setOrderStatus(orderHash, false, remaining);

    const mockUSDC = await ethers.getContractAt("MockUSDC", USDC_ADDR);
    await mockUSDC.mint(vault.address, ethers.parseUnits("1000", 6));
    await mockUSDC.connect(vault).approve(await feeCollector.getAddress(), ethers.MaxUint256);

    const { feeAuth, sig } = await signFeeAuth({
      orderHash,
      feeBps: 50,
      nonce: await feeCollector.nonces(signer.address),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });

    await feeCollector.collectFee(order, feeAuth, sig);
    const charged = await feeCollector.makerFilledCharged(orderHash);
    const treasuryBal = await mockUSDC.balanceOf(treasury.address);
    expect(charged).to.equal(ethers.parseUnits("100", 6));
    expect(treasuryBal).to.equal(ethers.parseUnits("0.375", 6));
  });

  it("reverts if feeBps is above 100%", async () => {
    const order = buildOrder({ maker: vault.address, signer: signer.address, side: 0 });
    const mockExchange = await ethers.getContractAt("MockExchange", EXCHANGE_ADDR);
    const orderHash = await mockExchange.hashOrder(order);

    const remaining = order.makerAmount - ethers.parseUnits("10", 6);
    await mockExchange.setOrderStatus(orderHash, false, remaining);

    const mockUSDC = await ethers.getContractAt("MockUSDC", USDC_ADDR);
    await mockUSDC.mint(vault.address, ethers.parseUnits("1000", 6));
    await mockUSDC.connect(vault).approve(await feeCollector.getAddress(), ethers.MaxUint256);

    const { feeAuth, sig } = await signFeeAuth({
      orderHash,
      feeBps: 10_001,
      nonce: await feeCollector.nonces(signer.address),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });

    await expect(feeCollector.collectFee(order, feeAuth, sig)).to.be.revertedWithCustomError(
      feeCollector,
      "InvalidFeeBps"
    );
  });

  it("reverts on expired deadline", async () => {
    const order = buildOrder({ maker: vault.address, signer: signer.address, side: 0 });
    const mockExchange = await ethers.getContractAt("MockExchange", EXCHANGE_ADDR);
    const orderHash = await mockExchange.hashOrder(order);
    const remaining = order.makerAmount - ethers.parseUnits("10", 6);
    await mockExchange.setOrderStatus(orderHash, false, remaining);

    const mockUSDC = await ethers.getContractAt("MockUSDC", USDC_ADDR);
    await mockUSDC.mint(vault.address, ethers.parseUnits("1000", 6));
    await mockUSDC.connect(vault).approve(await feeCollector.getAddress(), ethers.MaxUint256);

    const { feeAuth, sig } = await signFeeAuth({
      orderHash,
      feeBps: 50,
      nonce: await feeCollector.nonces(signer.address),
      deadline: BigInt(Math.floor(Date.now() / 1000) - 1),
    });

    await expect(feeCollector.collectFee(order, feeAuth, sig)).to.be.revertedWithCustomError(
      feeCollector,
      "Expired"
    );
  });

  it("reverts on BadNonce reuse", async () => {
    const order = buildOrder({ maker: vault.address, signer: signer.address, side: 0 });
    const mockExchange = await ethers.getContractAt("MockExchange", EXCHANGE_ADDR);
    const orderHash = await mockExchange.hashOrder(order);
    const remaining = order.makerAmount - ethers.parseUnits("10", 6);
    await mockExchange.setOrderStatus(orderHash, false, remaining);

    const mockUSDC = await ethers.getContractAt("MockUSDC", USDC_ADDR);
    await mockUSDC.mint(vault.address, ethers.parseUnits("1000", 6));
    await mockUSDC.connect(vault).approve(await feeCollector.getAddress(), ethers.MaxUint256);

    const nonce = await feeCollector.nonces(signer.address);
    const { feeAuth, sig } = await signFeeAuth({
      orderHash,
      feeBps: 50,
      nonce,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });

    await feeCollector.collectFee(order, feeAuth, sig);

    await expect(feeCollector.collectFee(order, feeAuth, sig)).to.be.revertedWithCustomError(
      feeCollector,
      "BadNonce"
    );
  });

  it("pauses and unpauses", async () => {
    const order = buildOrder({ maker: vault.address, signer: signer.address, side: 0 });
    const mockExchange = await ethers.getContractAt("MockExchange", EXCHANGE_ADDR);
    const orderHash = await mockExchange.hashOrder(order);
    const remaining = order.makerAmount - ethers.parseUnits("10", 6);
    await mockExchange.setOrderStatus(orderHash, false, remaining);

    const mockUSDC = await ethers.getContractAt("MockUSDC", USDC_ADDR);
    await mockUSDC.mint(vault.address, ethers.parseUnits("1000", 6));
    await mockUSDC.connect(vault).approve(await feeCollector.getAddress(), ethers.MaxUint256);

    const { feeAuth, sig } = await signFeeAuth({
      orderHash,
      feeBps: 50,
      nonce: await feeCollector.nonces(signer.address),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });

    await expect(feeCollector.connect(deployer).pause())
      .to.emit(feeCollector, "Paused")
      .withArgs(deployer.address);

    await expect(feeCollector.collectFee(order, feeAuth, sig)).to.be.revertedWithCustomError(
      feeCollector,
      "PausedError"
    );

    await expect(feeCollector.connect(deployer).unpause())
      .to.emit(feeCollector, "Unpaused")
      .withArgs(deployer.address);

    await feeCollector.collectFee(order, feeAuth, sig);
  });

  it("reverts on ParamMismatch (wrong signer/vault/orderHash)", async () => {
    const order = buildOrder({ maker: vault.address, signer: signer.address, side: 0 });
    const mockExchange = await ethers.getContractAt("MockExchange", EXCHANGE_ADDR);
    const orderHash = await mockExchange.hashOrder(order);
    const remaining = order.makerAmount - ethers.parseUnits("10", 6);
    await mockExchange.setOrderStatus(orderHash, false, remaining);

    const mockUSDC = await ethers.getContractAt("MockUSDC", USDC_ADDR);
    await mockUSDC.mint(vault.address, ethers.parseUnits("1000", 6));
    await mockUSDC.connect(vault).approve(await feeCollector.getAddress(), ethers.MaxUint256);

    const { feeAuth, sig } = await signFeeAuth({
      orderHash,
      feeBps: 50,
      nonce: await feeCollector.nonces(signer.address),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });
    feeAuth.vault = deployer.address;

    await expect(feeCollector.collectFee(order, feeAuth, sig)).to.be.revertedWithCustomError(
      feeCollector,
      "ParamMismatch"
    );
  });

  it("reverts on BadSignature", async () => {
    const order = buildOrder({ maker: vault.address, signer: signer.address, side: 0 });
    const mockExchange = await ethers.getContractAt("MockExchange", EXCHANGE_ADDR);
    const orderHash = await mockExchange.hashOrder(order);
    const remaining = order.makerAmount - ethers.parseUnits("10", 6);
    await mockExchange.setOrderStatus(orderHash, false, remaining);

    const mockUSDC = await ethers.getContractAt("MockUSDC", USDC_ADDR);
    await mockUSDC.mint(vault.address, ethers.parseUnits("1000", 6));
    await mockUSDC.connect(vault).approve(await feeCollector.getAddress(), ethers.MaxUint256);

    const { feeAuth } = await signFeeAuth({
      orderHash,
      feeBps: 50,
      nonce: await feeCollector.nonces(signer.address),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });

    const badSig = "0x";
    await expect(feeCollector.collectFee(order, feeAuth, badSig)).to.be.revertedWithCustomError(
      feeCollector,
      "BadSignature"
    );
  });

  it("reverts when exchange is not allowlisted", async () => {
    const order = buildOrder({ maker: vault.address, signer: signer.address, side: 0 });
    const mockExchange = await ethers.getContractAt("MockExchange", EXCHANGE_ADDR);
    const orderHash = await mockExchange.hashOrder(order);
    const remaining = order.makerAmount - ethers.parseUnits("10", 6);
    await mockExchange.setOrderStatus(orderHash, false, remaining);

    const mockUSDC = await ethers.getContractAt("MockUSDC", USDC_ADDR);
    await mockUSDC.mint(vault.address, ethers.parseUnits("1000", 6));
    await mockUSDC.connect(vault).approve(await feeCollector.getAddress(), ethers.MaxUint256);

    const { feeAuth, sig } = await signFeeAuth({
      orderHash,
      feeBps: 50,
      nonce: await feeCollector.nonces(signer.address),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      exchange: deployer.address,
    });

    await expect(feeCollector.collectFee(order, feeAuth, sig)).to.be.revertedWithCustomError(
      feeCollector,
      "ExchangeNotAllowed"
    );
  });

  it("supports EIP-1271 contract signer", async () => {
    const walletFactory = await ethers.getContractFactory("Mock1271Wallet");
    const contractSigner = await walletFactory.deploy(signer.address);
    await contractSigner.waitForDeployment();

    const contractSignerAddress = await contractSigner.getAddress();
    const order = buildOrder({
      maker: vault.address,
      signer: contractSignerAddress,
      side: 0,
      signatureType: 3,
    });

    const mockExchange = await ethers.getContractAt("MockExchange", EXCHANGE_ADDR);
    const orderHash = await mockExchange.hashOrder(order);
    const remaining = order.makerAmount - ethers.parseUnits("10", 6);
    await mockExchange.setOrderStatus(orderHash, false, remaining);

    const mockUSDC = await ethers.getContractAt("MockUSDC", USDC_ADDR);
    await mockUSDC.mint(vault.address, ethers.parseUnits("1000", 6));
    await mockUSDC.connect(vault).approve(await feeCollector.getAddress(), ethers.MaxUint256);

    const { feeAuth, sig } = await signFeeAuth({
      orderHash,
      feeBps: 50,
      nonce: await feeCollector.nonces(contractSignerAddress),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      authSignerAddress: contractSignerAddress,
      signingWallet: signer,
    });

    await feeCollector.collectFee(order, feeAuth, sig);
  });

  it("reverts on zero fee delta", async () => {
    const order = buildOrder({ maker: vault.address, signer: signer.address, side: 0 });
    const mockExchange = await ethers.getContractAt("MockExchange", EXCHANGE_ADDR);
    const orderHash = await mockExchange.hashOrder(order);

    await mockExchange.setOrderStatus(orderHash, false, order.makerAmount);

    const mockUSDC = await ethers.getContractAt("MockUSDC", USDC_ADDR);
    await mockUSDC.mint(vault.address, ethers.parseUnits("1000", 6));
    await mockUSDC.connect(vault).approve(await feeCollector.getAddress(), ethers.MaxUint256);

    const { feeAuth, sig } = await signFeeAuth({
      orderHash,
      feeBps: 50,
      nonce: await feeCollector.nonces(signer.address),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });

    await expect(feeCollector.collectFee(order, feeAuth, sig)).to.be.revertedWithCustomError(
      feeCollector,
      "NothingToCharge"
    );
  });
});
