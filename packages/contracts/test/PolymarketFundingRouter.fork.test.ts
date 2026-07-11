import { expect } from "chai";
import { ethers, network } from "hardhat";

const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const OWNER = "0x09c88f1d3cdd98c356a21434cd4af40cce795314";
const DEPOSIT = "0x496f46AA7500563E7f577D12CB8193421F2963C7";

const describeFork =
  process.env.POLYGON_FORK === "1" ? describe : describe.skip;

describeFork("PolymarketFundingRouter Polygon fork", () => {
  it("funds the real canonical deposit wallet through real pUSD and onramp", async () => {
    const Router = await ethers.getContractFactory("PolymarketFundingRouter");
    const router = await Router.deploy();
    await router.waitForDeployment();
    expect(await router.depositWalletOf(OWNER)).to.equal(DEPOSIT);

    await network.provider.send("hardhat_setBalance", [
      PUSD,
      "0x56BC75E2D63100000",
    ]);
    await network.provider.send("hardhat_setBalance", [
      OWNER,
      "0x56BC75E2D63100000",
    ]);
    await network.provider.send("hardhat_impersonateAccount", [PUSD]);
    await network.provider.send("hardhat_impersonateAccount", [OWNER]);
    const treasury = await ethers.getSigner(PUSD);
    const owner = await ethers.getSigner(OWNER);
    const tokenAbi = [
      "function balanceOf(address) view returns (uint256)",
      "function transfer(address,uint256) returns (bool)",
      "function approve(address,uint256) returns (bool)",
    ];
    const pUsd = new ethers.Contract(PUSD, tokenAbi, ethers.provider);
    const usdce = new ethers.Contract(USDCE, tokenAbi, ethers.provider);
    const pUsdAmount = 100_000n;
    const usdceAmount = 100_000n;
    expect(await pUsd.balanceOf(PUSD)).to.be.gte(pUsdAmount);
    expect(await usdce.balanceOf(PUSD)).to.be.gte(usdceAmount);
    await pUsd.connect(treasury).transfer(OWNER, pUsdAmount);
    await usdce.connect(treasury).transfer(OWNER, usdceAmount);
    await pUsd.connect(owner).approve(await router.getAddress(), pUsdAmount);
    await usdce.connect(owner).approve(await router.getAddress(), usdceAmount);

    const before = await pUsd.balanceOf(DEPOSIT);
    await router.connect(owner).fund(0, pUsdAmount + usdceAmount, pUsdAmount);
    expect(await pUsd.balanceOf(DEPOSIT)).to.equal(
      before + pUsdAmount + usdceAmount,
    );
    expect(await usdce.balanceOf(await router.getAddress())).to.equal(0);
    expect(await router.fundingNonce(OWNER)).to.equal(1);

    await network.provider.send("hardhat_stopImpersonatingAccount", [PUSD]);
    await network.provider.send("hardhat_stopImpersonatingAccount", [OWNER]);
  });
});
