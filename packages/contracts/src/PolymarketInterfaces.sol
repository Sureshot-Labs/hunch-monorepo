// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal Polymarket CTF Exchange interface on Polygon
/// @dev Exchange address: 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
interface IPolymarketExchange {
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

    enum MatchType {
        COMPLEMENTARY,
        MINT,
        MERGE
    }

    struct Order {
        uint256 salt;
        address maker;
        address signer;
        address taker;
        uint256 tokenId;
        uint256 makerAmount;
        uint256 takerAmount;
        uint256 expiration;
        uint256 nonce;
        uint256 feeRateBps;
        Side side;
        SignatureType signatureType;
        bytes signature;
    }

    struct OrderStatus {
        bool isFilledOrCancelled;
        uint256 remaining;
    }

    function hashOrder(Order memory order) external view returns (bytes32);

    function getOrderStatus(bytes32 orderHash) external view returns (OrderStatus memory);
}
