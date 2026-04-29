// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IPolymarketExchangeV2} from "./PolymarketInterfacesV2.sol";

interface IEIP1271V2 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/// @title PolymarketFeeCollectorClobV2
/// @notice Non-custodial fee collector for Polymarket CLOB V2 pUSD orders on Polygon.
/// @dev Uses ECDSA-first signature validation so delegated EOAs still validate.
contract PolymarketFeeCollectorClobV2 {
    using SafeERC20 for IERC20;

    bytes32 private constant EIP712DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant FEE_AUTH_TYPEHASH =
        keccak256(
            "FeeAuthV3(address signer,address vault,address exchange,bytes32 orderHash,uint256 feeBps,uint256 deadline)"
        );

    bytes4 private constant EIP1271_MAGICVALUE = 0x1626ba7e;
    uint256 private constant MAX_FEE_BPS = 10_000;

    IERC20 public immutable COLLATERAL;
    mapping(address => bool) public allowedExchanges;
    bytes32 public immutable DOMAIN_SEPARATOR;
    address public immutable owner;
    address public immutable treasury;

    mapping(bytes32 => bool) public feeAuthUsed;
    mapping(bytes32 => uint256) public makerFilledCharged;
    bool public paused;

    struct FeeAuthV3 {
        address signer;
        address vault;
        address exchange;
        bytes32 orderHash;
        uint256 feeBps;
        uint256 deadline;
    }

    struct FeePreview {
        bytes32 orderHash;
        bool signatureValid;
        uint256 makerFilled;
        uint256 alreadyCharged;
        uint256 collateralDelta;
        uint256 feeAmount;
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
    error FeeAuthUsed();
    error InvalidFeeBps();
    error InvalidFeeAuthSignature();
    error NoFill();
    error InvalidOrderHash();
    error InvalidOrderSigner();
    error InvalidVault();
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
                keccak256("3"),
                block.chainid,
                address(this)
            )
        );
    }

    function hashFeeAuth(FeeAuthV3 memory auth) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                FEE_AUTH_TYPEHASH,
                auth.signer,
                auth.vault,
                auth.exchange,
                auth.orderHash,
                auth.feeBps,
                auth.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function isValidFeeAuthSignature(
        FeeAuthV3 calldata auth,
        bytes calldata authSig
    ) external view returns (bool) {
        return _isValidSignature(auth.signer, hashFeeAuth(auth), authSig);
    }

    function previewCollectFee(
        IPolymarketExchangeV2.Order calldata order,
        FeeAuthV3 calldata auth,
        bytes calldata authSig
    ) external view returns (FeePreview memory preview) {
        preview = _preview(order, auth, authSig);
    }

    function collectFee(
        IPolymarketExchangeV2.Order calldata order,
        FeeAuthV3 calldata auth,
        bytes calldata authSig
    ) external {
        if (paused) revert PausedError();
        if (block.timestamp > auth.deadline) revert Expired();
        if (auth.feeBps > MAX_FEE_BPS) revert InvalidFeeBps();
        if (!allowedExchanges[auth.exchange]) revert ExchangeNotAllowed();

        FeePreview memory preview = _preview(order, auth, authSig);
        if (!preview.signatureValid) revert InvalidFeeAuthSignature();
        if (feeAuthUsed[preview.orderHash]) revert FeeAuthUsed();
        if (preview.makerFilled <= preview.alreadyCharged || preview.feeAmount == 0) {
            revert NoFill();
        }

        makerFilledCharged[preview.orderHash] = preview.makerFilled;
        feeAuthUsed[preview.orderHash] = true;

        SafeERC20.safeTransferFrom(COLLATERAL, order.maker, treasury, preview.feeAmount);

        emit FeeCollected(preview.orderHash, order.maker, order.signer, preview.feeAmount, preview.makerFilled);
    }

    function pause() external {
        if (msg.sender != owner) revert NotOwner();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external {
        if (msg.sender != owner) revert NotOwner();
        paused = false;
        emit Unpaused(msg.sender);
    }

    function _preview(
        IPolymarketExchangeV2.Order calldata order,
        FeeAuthV3 calldata auth,
        bytes calldata authSig
    ) internal view returns (FeePreview memory preview) {
        IPolymarketExchangeV2 exchange = IPolymarketExchangeV2(auth.exchange);
        bytes32 orderHash = exchange.hashOrder(order);

        if (auth.orderHash != orderHash) revert InvalidOrderHash();
        if (auth.signer != order.signer) revert InvalidOrderSigner();
        if (auth.vault != order.maker) revert InvalidVault();

        preview.orderHash = orderHash;
        preview.signatureValid = _isValidSignature(auth.signer, hashFeeAuth(auth), authSig);
        preview.makerFilled = _makerFilled(order, exchange.getOrderStatus(orderHash));
        preview.alreadyCharged = makerFilledCharged[orderHash];
        preview.collateralDelta = _collateralDelta(order, preview.makerFilled, preview.alreadyCharged);
        preview.feeAmount = (preview.collateralDelta * auth.feeBps) / MAX_FEE_BPS;
    }

    function _makerFilled(
        IPolymarketExchangeV2.Order calldata order,
        IPolymarketExchangeV2.OrderStatus memory status
    ) internal pure returns (uint256) {
        uint256 remaining = uint256(status.remaining);
        if (!status.filled && remaining == 0) {
            return 0;
        }
        return order.makerAmount > remaining ? order.makerAmount - remaining : 0;
    }

    function _collateralDelta(
        IPolymarketExchangeV2.Order calldata order,
        uint256 makerFilled,
        uint256 alreadyCharged
    ) internal pure returns (uint256) {
        uint256 makerDelta = makerFilled > alreadyCharged ? makerFilled - alreadyCharged : 0;
        if (order.side == IPolymarketExchangeV2.Side.BUY) {
            return makerDelta;
        }
        return order.makerAmount == 0 ? 0 : (makerDelta * order.takerAmount) / order.makerAmount;
    }

    function _isValidSignature(
        address signer,
        bytes32 digest,
        bytes calldata sig
    ) internal view returns (bool) {
        if (_recover(digest, sig) == signer) {
            return true;
        }
        if (signer.code.length == 0) {
            return false;
        }
        (bool ok, bytes memory result) = signer.staticcall(
            abi.encodeWithSelector(IEIP1271V2.isValidSignature.selector, digest, sig)
        );
        return ok && result.length >= 4 && bytes4(result) == EIP1271_MAGICVALUE;
    }

    function _recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, sig);
        return error == ECDSA.RecoverError.NoError ? recovered : address(0);
    }
}
