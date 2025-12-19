// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPolymarketExchange} from "./PolymarketInterfaces.sol";

interface IEIP1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/// @title PolymarketFeeCollector (v2)
/// @notice Non-custodial fee collector for Polymarket orders on Polygon.
/// @dev Charges exact per-order feeBps signed by the user. Supports EIP-1271 contract signers.
contract PolymarketFeeCollector {
    using SafeERC20 for IERC20;

    bytes32 private constant EIP712DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant FEE_AUTH_TYPEHASH =
        keccak256(
            "FeeAuth(address signer,address vault,address exchange,bytes32 orderHash,uint256 feeBps,uint256 nonce,uint256 deadline)"
        );

    bytes4 private constant EIP1271_MAGICVALUE = 0x1626ba7e;
    uint256 private constant MAX_FEE_BPS = 10_000;

    /// @notice USDC collateral (configurable)
    IERC20 public immutable COLLATERAL;

    /// @notice Allowed exchanges (standard + neg-risk).
    mapping(address => bool) public allowedExchanges;

    /// @notice EIP-712 domain separator for this contract
    bytes32 public immutable DOMAIN_SEPARATOR;

    /// @notice Owner for pause control (typically deployer)
    address public immutable owner;

    /// @notice Address receiving collected fees
    address public immutable treasury;

    /// @notice Per-signer nonce for FeeAuth messages
    mapping(address => uint256) public nonces;

    /// @notice For each orderHash, how much makerAmount has already been charged
    mapping(bytes32 => uint256) public makerFilledCharged;

    /// @notice Pause flag (owner controlled)
    bool public paused;

    struct FeeAuth {
        address signer; // Order signer (EOA or contract)
        address vault; // order.maker (funder/Safe)
        address exchange; // Polymarket exchange for the order
        bytes32 orderHash; // exchange.hashOrder(order)
        uint256 feeBps; // exact fee bps for this order
        uint256 nonce; // must match nonces[signer]
        uint256 deadline; // unix timestamp
    }

    event FeeCollected(
        bytes32 indexed orderHash,
        address indexed vault,
        address indexed signer,
        uint256 feeAmount,
        uint256 newMakerFilled
    );

    event ExchangeAllowed(address indexed exchange, bool allowed);

    event Paused(address indexed by);
    event Unpaused(address indexed by);

    error Expired();
    error BadNonce();
    error InvalidFeeBps();
    error BadSignature();
    error NothingToCharge();
    error ParamMismatch();
    error ExchangeNotAllowed();
    error PausedError();
    error ZeroAddress();
    error NotOwner();
    error InvalidAddress();

    constructor(address _treasury, address _collateral, address[] memory _exchanges) {
        if (_treasury == address(0) || _collateral == address(0)) {
            revert ZeroAddress();
        }
        if (_collateral.code.length == 0) {
            revert InvalidAddress();
        }
        if (_exchanges.length == 0) {
            revert InvalidAddress();
        }

        owner = msg.sender;
        treasury = _treasury;
        COLLATERAL = IERC20(_collateral);

        for (uint256 i = 0; i < _exchanges.length; i++) {
            address exchange = _exchanges[i];
            if (exchange == address(0) || exchange.code.length == 0) {
                revert InvalidAddress();
            }
            if (!allowedExchanges[exchange]) {
                allowedExchanges[exchange] = true;
                emit ExchangeAllowed(exchange, true);
            }
        }

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712DOMAIN_TYPEHASH,
                keccak256("Polymarket Aggregator FeeCollector"),
                keccak256("2"),
                block.chainid,
                address(this)
            )
        );
    }

    // --- EIP-712 hashing --------------------------------------------------

    function hashFeeAuth(FeeAuth memory auth) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                FEE_AUTH_TYPEHASH,
                auth.signer,
                auth.vault,
                auth.exchange,
                auth.orderHash,
                auth.feeBps,
                auth.nonce,
                auth.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    // --- Main entrypoint --------------------------------------------------

    /// @notice Collect fee on the delta-filled volume of a Polymarket order.
    /// @param order Full Polymarket order (must match the posted/signed order)
    /// @param auth FeeAuth signed by the user
    /// @param authSig EIP-712 signature over FeeAuth
    function collectFee(
        IPolymarketExchange.Order calldata order,
        FeeAuth calldata auth,
        bytes calldata authSig
    ) external {
        if (paused) revert PausedError();
        if (block.timestamp > auth.deadline) revert Expired();
        if (auth.nonce != nonces[auth.signer]) revert BadNonce();
        if (auth.feeBps > MAX_FEE_BPS) revert InvalidFeeBps();
        if (!allowedExchanges[auth.exchange]) revert ExchangeNotAllowed();

        IPolymarketExchange exchange = IPolymarketExchange(auth.exchange);
        bytes32 orderHash = exchange.hashOrder(order);

        if (auth.orderHash != orderHash) revert ParamMismatch();
        if (auth.signer != order.signer) revert ParamMismatch();
        if (auth.vault != order.maker) revert ParamMismatch();

        if (!_isValidSignature(auth.signer, hashFeeAuth(auth), authSig)) revert BadSignature();

        // Consume nonce to prevent replay.
        nonces[auth.signer]++;

        IPolymarketExchange.OrderStatus memory st = exchange.getOrderStatus(orderHash);

        uint256 makerFilled;
        if (st.remaining == 0 && !st.isFilledOrCancelled) {
            makerFilled = 0;
        } else {
            makerFilled = order.makerAmount - st.remaining;
        }

        uint256 alreadyCharged = makerFilledCharged[orderHash];
        if (makerFilled <= alreadyCharged) revert NothingToCharge();

        uint256 makerDelta = makerFilled - alreadyCharged;
        makerFilledCharged[orderHash] = makerFilled;

        uint256 collateralDelta;
        if (order.side == IPolymarketExchange.Side.BUY) {
            collateralDelta = makerDelta;
        } else {
            collateralDelta = order.makerAmount == 0
                ? 0
                : (makerDelta * order.takerAmount) / order.makerAmount;
        }

        uint256 feeAmount = (collateralDelta * auth.feeBps) / MAX_FEE_BPS;
        if (feeAmount == 0) revert NothingToCharge();

        SafeERC20.safeTransferFrom(COLLATERAL, order.maker, treasury, feeAmount);

        emit FeeCollected(orderHash, order.maker, order.signer, feeAmount, makerFilled);
    }

    /// @notice Pause fee collection (owner only).
    function pause() external {
        if (msg.sender != owner) revert NotOwner();
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Unpause fee collection (owner only).
    function unpause() external {
        if (msg.sender != owner) revert NotOwner();
        paused = false;
        emit Unpaused(msg.sender);
    }

    // --- Internal: Signature verification ---------------------------------

    function _isValidSignature(
        address signer,
        bytes32 digest,
        bytes calldata sig
    ) internal view returns (bool) {
        if (signer.code.length == 0) {
            return _recover(digest, sig) == signer;
        }
        (bool ok, bytes memory result) = signer.staticcall(
            abi.encodeWithSelector(IEIP1271.isValidSignature.selector, digest, sig)
        );
        return ok && result.length >= 4 && bytes4(result) == EIP1271_MAGICVALUE;
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
