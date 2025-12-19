// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPolymarketExchange} from "../PolymarketInterfaces.sol";

/// @dev Lightweight mock for Polymarket Exchange; intended only for local HH tests.
contract MockExchange is IPolymarketExchange {
    mapping(bytes32 => OrderStatus) public orderStatuses;

    function setOrderStatus(bytes32 orderHash, bool isFilledOrCancelled, uint256 remaining) external {
        orderStatuses[orderHash] = OrderStatus(isFilledOrCancelled, remaining);
    }

    function hashOrder(Order memory order) public pure override returns (bytes32) {
        // Simple ABI-encoded hash; for tests we just need consistency with FeeCollector
        return keccak256(
            abi.encode(
                order.salt,
                order.maker,
                order.signer,
                order.taker,
                order.tokenId,
                order.makerAmount,
                order.takerAmount,
                order.expiration,
                order.nonce,
                order.feeRateBps,
                order.side,
                order.signatureType,
                keccak256(order.signature)
            )
        );
    }

    function getOrderStatus(bytes32 orderHash) external view override returns (OrderStatus memory) {
        return orderStatuses[orderHash];
    }
}
