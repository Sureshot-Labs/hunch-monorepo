// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockDepositWalletFactoryBeacon {
    address public immutable BEACON;

    constructor(address beacon_) {
        BEACON = beacon_;
    }
}
