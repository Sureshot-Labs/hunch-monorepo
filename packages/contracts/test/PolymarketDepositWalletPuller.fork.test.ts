import { expect } from "chai";
import { ethers, network } from "hardhat";

const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const OWNER = "0x09c88f1d3cdd98c356a21434cd4af40cce795314";
const DEPOSIT = "0x496f46AA7500563E7f577D12CB8193421F2963C7";

const describeFork =
  process.env.POLYGON_FORK === "1" ? describe : describe.skip;

describeFork("PolymarketDepositWalletPuller Polygon fork", () => {
  it("derives the live wallet and pulls only its exact approved pUSD", async () => {
    const Puller = await ethers.getContractFactory(
      "PolymarketDepositWalletPuller",
    );
    const puller = await Puller.deploy();
    await puller.waitForDeployment();
    expect(await puller.depositWalletOf(OWNER)).to.equal(DEPOSIT);
    expect(await ethers.provider.getCode(DEPOSIT)).not.to.equal("0x");

    const amount = 10_000n;
    await network.provider.send("hardhat_setBalance", [
      PUSD,
      "0x56BC75E2D63100000",
    ]);
    await network.provider.send("hardhat_setBalance", [
      OWNER,
      "0x56BC75E2D63100000",
    ]);
    await network.provider.send("hardhat_setBalance", [
      DEPOSIT,
      "0x56BC75E2D63100000",
    ]);
    await network.provider.send("hardhat_impersonateAccount", [PUSD]);
    await network.provider.send("hardhat_impersonateAccount", [OWNER]);
    await network.provider.send("hardhat_impersonateAccount", [DEPOSIT]);
    try {
      const token = new ethers.Contract(
        PUSD,
        [
          "function balanceOf(address) view returns (uint256)",
          "function transfer(address,uint256) returns (bool)",
          "function approve(address,uint256) returns (bool)",
        ],
        ethers.provider,
      );
      await token
        .connect(await ethers.getSigner(PUSD))
        .transfer(DEPOSIT, amount);
      await token
        .connect(await ethers.getSigner(DEPOSIT))
        .approve(await puller.getAddress(), ethers.MaxUint256);
      const ownerBefore = await token.balanceOf(OWNER);
      const depositBefore = await token.balanceOf(DEPOSIT);
      await puller.connect(await ethers.getSigner(OWNER)).pullPusd(0, amount);
      expect(await token.balanceOf(OWNER)).to.equal(ownerBefore + amount);
      expect(await token.balanceOf(DEPOSIT)).to.equal(depositBefore - amount);
      expect(await token.balanceOf(await puller.getAddress())).to.equal(0);
    } finally {
      for (const address of [PUSD, OWNER, DEPOSIT]) {
        await network.provider.send("hardhat_stopImpersonatingAccount", [
          address,
        ]);
      }
    }
  });
});
