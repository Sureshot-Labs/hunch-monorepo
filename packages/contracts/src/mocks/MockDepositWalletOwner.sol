// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockDepositWalletOwner {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }
}
