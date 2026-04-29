// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal Polymarket CLOB V2 Exchange interface on Polygon.
interface IPolymarketExchangeV2 {
    enum SignatureType {
        EOA,
        POLY_PROXY,
        POLY_GNOSIS_SAFE,
        POLY_1271
    }

    enum Side {
        BUY,
        SELL
    }

    struct Order {
        uint256 salt;
        address maker;
        address signer;
        uint256 tokenId;
        uint256 makerAmount;
        uint256 takerAmount;
        Side side;
        SignatureType signatureType;
        uint256 timestamp;
        bytes32 metadata;
        bytes32 builder;
        bytes signature;
    }

    struct OrderStatus {
        bool filled;
        uint248 remaining;
    }

    function hashOrder(Order memory order) external view returns (bytes32);

    function getOrderStatus(bytes32 orderHash) external view returns (OrderStatus memory);
}
