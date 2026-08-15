import { expect } from "chai";
import { artifacts, ethers, network } from "hardhat";

const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
const BEACON = "0x7A18EDfe055488A3128f01F563e5B479D92ffc3a";

async function setRuntimeCode(address: string, contractName: string) {
  const artifact = await artifacts.readArtifact(contractName);
  await network.provider.send("hardhat_setCode", [
    address,
    artifact.deployedBytecode,
  ]);
}

async function copyRuntimeCode(from: string, to: string) {
  await network.provider.send("hardhat_setCode", [
    to,
    await ethers.provider.getCode(from),
  ]);
}

describe("PolymarketDepositWalletPuller", () => {
  async function fixture() {
    await network.provider.send("hardhat_reset");
    const [owner, other] = await ethers.getSigners();
    await setRuntimeCode(PUSD, "MockUSDC");
    const factoryMock = await (
      await ethers.getContractFactory("MockDepositWalletFactoryBeacon")
    ).deploy(BEACON);
    await factoryMock.waitForDeployment();
    await copyRuntimeCode(await factoryMock.getAddress(), FACTORY);
    const puller = await (
      await ethers.getContractFactory("PolymarketDepositWalletPuller")
    ).deploy();
    await puller.waitForDeployment();
    const depositWallet = await puller.depositWalletOf(owner.address);
    const walletMock = await (
      await ethers.getContractFactory("MockDepositWalletOwner")
    ).deploy(owner.address);
    await walletMock.waitForDeployment();
    await copyRuntimeCode(await walletMock.getAddress(), depositWallet);
    return {
      depositWallet,
      other,
      owner,
      puller,
      token: await ethers.getContractAt("MockUSDC", PUSD),
    };
  }

  it("pulls an exact amount to the canonical owner without retaining funds", async () => {
    const { depositWallet, owner, puller, token } = await fixture();
    const amount = 2_000_000n;
    await token.mint(depositWallet, amount);
    await network.provider.send("hardhat_setBalance", [
      depositWallet,
      ethers.toBeHex(ethers.parseEther("1")),
    ]);
    await network.provider.send("hardhat_impersonateAccount", [depositWallet]);
    try {
      await token
        .connect(await ethers.getSigner(depositWallet))
        .approve(await puller.getAddress(), ethers.MaxUint256);
    } finally {
      await network.provider.send("hardhat_stopImpersonatingAccount", [
        depositWallet,
      ]);
    }
    await expect(puller.connect(owner).pullPusd(0, amount))
      .to.emit(puller, "PusdPulled")
      .withArgs(owner.address, depositWallet, 0, amount);
    expect(await token.balanceOf(owner.address)).to.equal(amount);
    expect(await token.balanceOf(depositWallet)).to.equal(0);
    expect(await token.balanceOf(await puller.getAddress())).to.equal(0);
    expect(await puller.pullNonce(owner.address)).to.equal(1);
    await expect(
      puller.connect(owner).pullPusd(0, amount),
    ).to.be.revertedWithCustomError(puller, "InvalidNonce");
  });

  it("cannot pull another owner's canonical Deposit Wallet", async () => {
    const { other, puller } = await fixture();
    await expect(
      puller.connect(other).pullPusd(0, 1),
    ).to.be.revertedWithCustomError(puller, "InvalidDepositWallet");
  });

  it("rolls the nonce back when the exact transfer cannot complete", async () => {
    const { owner, puller } = await fixture();
    await expect(puller.connect(owner).pullPusd(0, 1)).to.be.reverted;
    expect(await puller.pullNonce(owner.address)).to.equal(0);
  });
});
