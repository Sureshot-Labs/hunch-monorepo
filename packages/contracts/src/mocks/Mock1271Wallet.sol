// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Minimal EIP-1271 wallet mock that validates signatures from a single owner.
contract Mock1271Wallet {
    bytes4 private constant EIP1271_MAGICVALUE = 0x1626ba7e;

    address public immutable owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (_recover(hash, signature) == owner) {
            return EIP1271_MAGICVALUE;
        }
        return 0xffffffff;
    }

    function _recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
