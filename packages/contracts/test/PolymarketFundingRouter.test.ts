import { expect } from "chai";
import { artifacts, ethers, network } from "hardhat";

const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ONRAMP = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
const FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
const IMPLEMENTATION = "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";
const POLYGON_BEACON = "0x7A18EDfe055488A3128f01F563e5B479D92ffc3a";
const GOLDEN_OWNER = "0x09c88f1d3cdd98c356a21434cd4af40cce795314";
const GOLDEN_DEPOSIT = "0x496f46AA7500563E7f577D12CB8193421F2963C7";
const BEACON_GOLDEN_DEPOSIT = "0xAd031402De8c9beb499F836934C1876a6eb4e4D0";

const ERC1967_CONST1 =
  "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const ERC1967_CONST2 =
  "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076";
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;

async function setRuntimeCode(address: string, contractName: string) {
  const artifact = await artifacts.readArtifact(contractName);
  await network.provider.send("hardhat_setCode", [
    address,
    artifact.deployedBytecode,
  ]);
}

async function copyRuntimeCode(from: string, to: string) {
  const code = await ethers.provider.getCode(from);
  await network.provider.send("hardhat_setCode", [to, code]);
}

async function approveFromAddress(
  tokenAddress: string,
  ownerAddress: string,
  spender: string,
  amount: bigint,
) {
  await network.provider.send("hardhat_setBalance", [
    ownerAddress,
    ethers.toBeHex(ethers.parseEther("1")),
  ]);
  await network.provider.send("hardhat_impersonateAccount", [ownerAddress]);
  try {
    const owner = await ethers.getSigner(ownerAddress);
    const token = await ethers.getContractAt("MockUSDC", tokenAddress);
    await token.connect(owner).approve(spender, amount);
  } finally {
    await network.provider.send("hardhat_stopImpersonatingAccount", [
      ownerAddress,
    ]);
  }
}

function deriveUups(owner: string): string {
  const walletId = ethers.zeroPadValue(owner, 32);
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes32"],
    [FACTORY, walletId],
  );
  const length = BigInt(ethers.getBytes(args).length);
  const prefix = ERC1967_PREFIX + (length << 56n);
  const initCodeHash = ethers.keccak256(
    ethers.concat([
      ethers.toBeHex(prefix, 10),
      IMPLEMENTATION,
      "0x6009",
      ERC1967_CONST2,
      ERC1967_CONST1,
      args,
    ]),
  );
  return ethers.getCreate2Address(
    FACTORY,
    ethers.keccak256(args),
    initCodeHash,
  );
}

describe("PolymarketFundingRouter", () => {
  async function fixture(ownerAddress?: string) {
    await network.provider.send("hardhat_reset");
    const [owner, other] = await ethers.getSigners();
    const effectiveOwner = ownerAddress ?? owner.address;

    await setRuntimeCode(PUSD, "MockUSDC");
    await setRuntimeCode(USDCE, "MockUSDC");

    const FactoryMock = await ethers.getContractFactory(
      "MockDepositWalletFactoryBeacon",
    );
    const factoryMock = await FactoryMock.deploy(POLYGON_BEACON);
    await factoryMock.waitForDeployment();
    await copyRuntimeCode(await factoryMock.getAddress(), FACTORY);

    const OnrampMock = await ethers.getContractFactory(
      "MockPolymarketCollateralOnramp",
    );
    const onrampMock = await OnrampMock.deploy(USDCE, PUSD);
    await onrampMock.waitForDeployment();
    await copyRuntimeCode(await onrampMock.getAddress(), ONRAMP);

    const Router = await ethers.getContractFactory("PolymarketFundingRouter");
    const router = await Router.deploy();
    await router.waitForDeployment();

    const deposit = await router.depositWalletOf(effectiveOwner);
    const DepositMock = await ethers.getContractFactory(
      "MockDepositWalletOwner",
    );
    const depositMock = await DepositMock.deploy(effectiveOwner);
    await depositMock.waitForDeployment();
    await copyRuntimeCode(await depositMock.getAddress(), deposit);

    return {
      deposit,
      onramp: await ethers.getContractAt(
        "MockPolymarketCollateralOnramp",
        ONRAMP,
      ),
      other,
      owner,
      pUsd: await ethers.getContractAt("MockUSDC", PUSD),
      router,
      usdce: await ethers.getContractAt("MockUSDC", USDCE),
    };
  }

  it("matches the deployed production legacy-wallet golden vector", async () => {
    expect(deriveUups(GOLDEN_OWNER)).to.equal(
      ethers.getAddress(GOLDEN_DEPOSIT),
    );

    await network.provider.send("hardhat_reset");
    const FactoryMock = await ethers.getContractFactory(
      "MockDepositWalletFactoryBeacon",
    );
    const factoryMock = await FactoryMock.deploy(POLYGON_BEACON);
    await factoryMock.waitForDeployment();
    await copyRuntimeCode(await factoryMock.getAddress(), FACTORY);
    const DepositMock = await ethers.getContractFactory(
      "MockDepositWalletOwner",
    );
    const depositMock = await DepositMock.deploy(GOLDEN_OWNER);
    await depositMock.waitForDeployment();
    await copyRuntimeCode(await depositMock.getAddress(), GOLDEN_DEPOSIT);
    const Router = await ethers.getContractFactory("PolymarketFundingRouter");
    const router = await Router.deploy();
    await router.waitForDeployment();

    expect(await router.depositWalletOf(GOLDEN_OWNER)).to.equal(
      ethers.getAddress(GOLDEN_DEPOSIT),
    );
  });

  it("matches the official SDK beacon derivation when legacy is absent", async () => {
    const { deposit } = await fixture(GOLDEN_OWNER);
    expect(deposit).to.equal(ethers.getAddress(BEACON_GOLDEN_DEPOSIT));
  });

  it("prefers a deployed legacy UUPS wallet", async () => {
    await network.provider.send("hardhat_reset");
    const [owner] = await ethers.getSigners();
    const FactoryMock = await ethers.getContractFactory(
      "MockDepositWalletFactoryBeacon",
    );
    const factoryMock = await FactoryMock.deploy(POLYGON_BEACON);
    await factoryMock.waitForDeployment();
    await copyRuntimeCode(await factoryMock.getAddress(), FACTORY);

    const expected = deriveUups(owner.address);
    const DepositMock = await ethers.getContractFactory(
      "MockDepositWalletOwner",
    );
    const depositMock = await DepositMock.deploy(owner.address);
    await depositMock.waitForDeployment();
    await copyRuntimeCode(await depositMock.getAddress(), expected);

    const Router = await ethers.getContractFactory("PolymarketFundingRouter");
    const router = await Router.deploy();
    await router.waitForDeployment();
    expect(await router.depositWalletOf(owner.address)).to.equal(expected);
  });

  it("funds with pUSD only", async () => {
    const { deposit, owner, pUsd, router } = await fixture();
    const amount = 1_060_000n;
    await pUsd.mint(owner.address, amount);
    await pUsd.connect(owner).approve(await router.getAddress(), amount);

    await expect(router.connect(owner).fund(0, amount, amount))
      .to.emit(router, "Funded")
      .withArgs(owner.address, deposit, 0, amount, amount, 0, 0);
    expect(await pUsd.balanceOf(deposit)).to.equal(amount);
    expect(await router.fundingNonce(owner.address)).to.equal(1);
  });

  it("funds with USDC.e only and clears onramp allowance", async () => {
    const { deposit, owner, pUsd, router, usdce } = await fixture();
    const amount = 1_060_000n;
    await usdce.mint(owner.address, amount);
    await usdce.connect(owner).approve(await router.getAddress(), amount);

    await router.connect(owner).fund(0, amount, 0);
    expect(await pUsd.balanceOf(deposit)).to.equal(amount);
    expect(await usdce.balanceOf(await router.getAddress())).to.equal(0);
    expect(await usdce.allowance(await router.getAddress(), ONRAMP)).to.equal(
      0,
    );
  });

  it("funds with mixed pUSD and USDC.e", async () => {
    const { deposit, owner, pUsd, router, usdce } = await fixture();
    const pUsdAmount = 400_000n;
    const usdceAmount = 660_000n;
    await pUsd.mint(owner.address, pUsdAmount);
    await usdce.mint(owner.address, usdceAmount);
    await pUsd.connect(owner).approve(await router.getAddress(), pUsdAmount);
    await usdce.connect(owner).approve(await router.getAddress(), usdceAmount);

    await router.connect(owner).fund(0, pUsdAmount + usdceAmount, pUsdAmount);
    expect(await pUsd.balanceOf(deposit)).to.equal(pUsdAmount + usdceAmount);
  });

  it("uses router-approved deposit USDC.e before signer USDC.e", async () => {
    const { deposit, owner, pUsd, router, usdce } = await fixture();
    const depositUsdceAmount = 700_000n;
    const signerUsdceAmount = 360_000n;
    const routerAddress = await router.getAddress();
    await usdce.mint(deposit, depositUsdceAmount);
    await usdce.mint(owner.address, signerUsdceAmount);
    await approveFromAddress(USDCE, deposit, routerAddress, depositUsdceAmount);
    await usdce.connect(owner).approve(routerAddress, signerUsdceAmount);

    await expect(router.connect(owner).fund(0, 1_060_000n, 0))
      .to.emit(router, "Funded")
      .withArgs(
        owner.address,
        deposit,
        0,
        1_060_000n,
        0,
        depositUsdceAmount,
        signerUsdceAmount,
      );
    expect(await usdce.balanceOf(deposit)).to.equal(0);
    expect(await usdce.balanceOf(owner.address)).to.equal(0);
    expect(await pUsd.balanceOf(deposit)).to.equal(1_060_000n);
  });

  it("funds from deposit USDC.e only", async () => {
    const { deposit, owner, pUsd, router, usdce } = await fixture();
    const amount = 1_060_000n;
    const routerAddress = await router.getAddress();
    await usdce.mint(deposit, amount);
    await approveFromAddress(USDCE, deposit, routerAddress, amount);

    await router.connect(owner).fund(0, amount, 0);
    expect(await usdce.balanceOf(deposit)).to.equal(0);
    expect(await pUsd.balanceOf(deposit)).to.equal(amount);
  });

  it("falls back to signer USDC.e when deposit allowance is absent", async () => {
    const { deposit, owner, pUsd, router, usdce } = await fixture();
    const amount = 1_060_000n;
    await usdce.mint(deposit, amount);
    await usdce.mint(owner.address, amount);
    await usdce.connect(owner).approve(await router.getAddress(), amount);

    await router.connect(owner).fund(0, amount, 0);
    expect(await usdce.balanceOf(deposit)).to.equal(amount);
    expect(await usdce.balanceOf(owner.address)).to.equal(0);
    expect(await pUsd.balanceOf(deposit)).to.equal(amount);
  });

  it("rejects a non-canonical wallet even when owner() matches", async () => {
    const { owner, router } = await fixture();
    const fake = await (
      await ethers.getContractFactory("MockDepositWalletOwner")
    ).deploy(owner.address);
    await fake.waitForDeployment();
    expect(await router.depositWalletOf(owner.address)).not.to.equal(
      await fake.getAddress(),
    );
  });

  it("rejects a canonical address whose owner does not match", async () => {
    const { deposit, other, owner, pUsd, router } = await fixture();
    const wrongOwnerMock = await (
      await ethers.getContractFactory("MockDepositWalletOwner")
    ).deploy(other.address);
    await wrongOwnerMock.waitForDeployment();
    await copyRuntimeCode(await wrongOwnerMock.getAddress(), deposit);
    await pUsd.mint(owner.address, 1n);
    await pUsd.connect(owner).approve(await router.getAddress(), 1n);
    await expect(
      router.connect(owner).fund(0, 1, 1),
    ).to.be.revertedWithCustomError(router, "InvalidDepositWallet");
  });

  it("rejects invalid and duplicate nonces", async () => {
    const { owner, pUsd, router } = await fixture();
    await pUsd.mint(owner.address, 2n);
    await pUsd.connect(owner).approve(await router.getAddress(), 2n);
    await expect(
      router.connect(owner).fund(1, 1, 1),
    ).to.be.revertedWithCustomError(router, "InvalidNonce");
    await router.connect(owner).fund(0, 1, 1);
    await expect(
      router.connect(owner).fund(0, 1, 1),
    ).to.be.revertedWithCustomError(router, "InvalidNonce");
  });

  it("rejects reentrancy from a funding token", async () => {
    const { owner, router } = await fixture();
    const ReentrantToken = await ethers.getContractFactory(
      "MockReentrantFundingToken",
    );
    const reentrantToken = await ReentrantToken.deploy(
      await router.getAddress(),
    );
    await reentrantToken.waitForDeployment();
    await copyRuntimeCode(await reentrantToken.getAddress(), PUSD);
    const pUsd = await ethers.getContractAt("MockReentrantFundingToken", PUSD);
    await pUsd.mint(owner.address, 1n);
    await pUsd.connect(owner).approve(await router.getAddress(), 1n);

    await expect(
      router.connect(owner).fund(0, 1, 1),
    ).to.be.revertedWithCustomError(router, "ReentrancyGuardReentrantCall");
    expect(await router.fundingNonce(owner.address)).to.equal(0);
  });

  it("rolls back pUSD funding when wrap fails", async () => {
    const { deposit, onramp, owner, pUsd, router, usdce } = await fixture();
    await pUsd.mint(owner.address, 1n);
    await usdce.mint(owner.address, 1n);
    await pUsd.connect(owner).approve(await router.getAddress(), 1n);
    await usdce.connect(owner).approve(await router.getAddress(), 1n);
    await onramp.setShouldRevert(true);

    await expect(router.connect(owner).fund(0, 2, 1)).to.be.revertedWith(
      "wrap reverted",
    );
    expect(await pUsd.balanceOf(deposit)).to.equal(0);
    expect(await router.fundingNonce(owner.address)).to.equal(0);
  });

  it("rejects a non-exact pUSD balance delta", async () => {
    const { onramp, owner, router, usdce } = await fixture();
    await usdce.mint(owner.address, 2n);
    await usdce.connect(owner).approve(await router.getAddress(), 2n);
    await onramp.setMintShort(true);
    await expect(
      router.connect(owner).fund(0, 2, 0),
    ).to.be.revertedWithCustomError(router, "BalanceDeltaMismatch");
  });

  it("fails closed on insufficient token allowance", async () => {
    const { owner, pUsd, router } = await fixture();
    await pUsd.mint(owner.address, 1n);
    await expect(router.connect(owner).fund(0, 1, 1)).to.be.reverted;
    expect(await router.fundingNonce(owner.address)).to.equal(0);
  });
});
