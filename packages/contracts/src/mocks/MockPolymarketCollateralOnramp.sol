// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMockMintableToken {
    function mint(address to, uint256 amount) external;

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
}

contract MockPolymarketCollateralOnramp {
    address public immutable usdce;
    address public immutable pUsd;
    bool public shouldRevert;
    bool public mintShort;

    constructor(address usdce_, address pUsd_) {
        usdce = usdce_;
        pUsd = pUsd_;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function setMintShort(bool value) external {
        mintShort = value;
    }

    function wrap(address asset, address to, uint256 amount) external {
        require(!shouldRevert, "wrap reverted");
        require(asset == usdce, "asset");
        require(
            IMockMintableToken(usdce).transferFrom(
                msg.sender,
                address(this),
                amount
            ),
            "transfer"
        );
        IMockMintableToken(pUsd).mint(to, mintShort ? amount - 1 : amount);
    }
}
