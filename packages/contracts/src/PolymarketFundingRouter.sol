// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPolymarketCollateralOnramp {
    function wrap(address asset, address to, uint256 amount) external;
}

interface IPolymarketDepositWallet {
    function owner() external view returns (address);
}

interface IPolymarketDepositWalletFactory {
    function BEACON() external view returns (address);
}

/// @title PolymarketFundingRouter
/// @notice Atomically consolidates pUSD and/or USDC.e from a caller and the
/// caller's canonical deposit wallet into pUSD in that deposit wallet.
/// @dev The destination is derived on-chain and is never supplied by the caller.
/// The CREATE2 derivation mirrors the Polymarket builder-relayer client.
contract PolymarketFundingRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public constant PUSD = IERC20(0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB);
    IERC20 public constant USDCE = IERC20(0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174);
    IPolymarketCollateralOnramp public constant COLLATERAL_ONRAMP =
        IPolymarketCollateralOnramp(0x93070a847efEf7F70739046A929D47a521F5B8ee);
    address public constant DEPOSIT_WALLET_FACTORY =
        0x00000000000Fb5C9ADea0298D729A0CB3823Cc07;
    address public constant LEGACY_DEPOSIT_WALLET_IMPLEMENTATION =
        0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB;

    // Byte constants from Solady v0.1.26 LibClone, matching Polymarket's
    // builder-relayer-client deposit-wallet derivation.
    bytes32 private constant ERC1967_CONST1 =
        0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3;
    bytes32 private constant ERC1967_CONST2 =
        0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076;
    uint80 private constant ERC1967_PREFIX = 0x61003d3d8160233d3973;
    bytes32 private constant ERC1967_BEACON_CONST1 =
        0xb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3;
    bytes32 private constant ERC1967_BEACON_CONST2 =
        0x1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6c;
    bytes23 private constant ERC1967_BEACON_CONST3 =
        0x60195155f3363d3d373d3d363d602036600436635c60da;
    uint80 private constant ERC1967_BEACON_PREFIX = 0x6100523d8160233d3973;

    mapping(address => uint256) public fundingNonce;

    event Funded(
        address indexed owner,
        address indexed depositWallet,
        uint256 indexed nonce,
        uint256 totalAmount,
        uint256 pUsdAmount,
        uint256 depositUsdceAmount,
        uint256 signerUsdceAmount
    );

    error BalanceDeltaMismatch();
    error InvalidAmount();
    error InvalidDepositWallet();
    error InvalidNonce();
    error RouterRetainedUsdce();

    /// @notice Returns the canonical Polymarket deposit wallet for an owner.
    /// Legacy UUPS wallets take precedence when already deployed; otherwise the
    /// current factory beacon derivation is used.
    function depositWalletOf(address owner) public view returns (address) {
        if (owner == address(0)) revert InvalidDepositWallet();

        address legacyWallet = _deriveUupsDepositWallet(owner);
        address beacon = _factoryBeacon();
        if (beacon == address(0) || legacyWallet.code.length != 0) {
            return legacyWallet;
        }
        return _deriveBeaconDepositWallet(owner, beacon);
    }

    /// @notice Funds the caller's canonical deposit wallet in one atomic call.
    /// @param expectedNonce Current fundingNonce for msg.sender.
    /// @param totalAmount Total pUSD buying power to add (6 decimals).
    /// @param pUsdAmount Portion pulled directly from the caller as pUSD. The
    /// remainder is sourced from router-approved USDC.e in the deposit wallet
    /// first, then from the caller, and wrapped back into the deposit wallet.
    function fund(
        uint256 expectedNonce,
        uint256 totalAmount,
        uint256 pUsdAmount
    ) external nonReentrant {
        if (totalAmount == 0 || pUsdAmount > totalAmount) {
            revert InvalidAmount();
        }
        uint256 currentNonce = fundingNonce[msg.sender];
        if (expectedNonce != currentNonce) revert InvalidNonce();

        address depositWallet = depositWalletOf(msg.sender);
        if (depositWallet.code.length == 0) revert InvalidDepositWallet();
        try IPolymarketDepositWallet(depositWallet).owner() returns (
            address owner
        ) {
            if (owner != msg.sender) revert InvalidDepositWallet();
        } catch {
            revert InvalidDepositWallet();
        }

        fundingNonce[msg.sender] = currentNonce + 1;

        uint256 depositBalanceBefore = PUSD.balanceOf(depositWallet);
        uint256 routerUsdceBefore = USDCE.balanceOf(address(this));
        uint256 usdceAmount = totalAmount - pUsdAmount;
        uint256 depositUsdceAmount;
        uint256 signerUsdceAmount;

        if (pUsdAmount != 0) {
            PUSD.safeTransferFrom(msg.sender, depositWallet, pUsdAmount);
        }
        if (usdceAmount != 0) {
            uint256 depositUsdceBalance = USDCE.balanceOf(depositWallet);
            uint256 depositUsdceAllowance = USDCE.allowance(
                depositWallet,
                address(this)
            );
            depositUsdceAmount = _min(
                usdceAmount,
                _min(depositUsdceBalance, depositUsdceAllowance)
            );
            signerUsdceAmount = usdceAmount - depositUsdceAmount;
            if (depositUsdceAmount != 0) {
                USDCE.safeTransferFrom(
                    depositWallet,
                    address(this),
                    depositUsdceAmount
                );
            }
            if (signerUsdceAmount != 0) {
                USDCE.safeTransferFrom(
                    msg.sender,
                    address(this),
                    signerUsdceAmount
                );
            }
            USDCE.forceApprove(address(COLLATERAL_ONRAMP), usdceAmount);
            COLLATERAL_ONRAMP.wrap(address(USDCE), depositWallet, usdceAmount);
            USDCE.forceApprove(address(COLLATERAL_ONRAMP), 0);
        }

        if (USDCE.balanceOf(address(this)) != routerUsdceBefore) {
            revert RouterRetainedUsdce();
        }
        uint256 depositBalanceAfter = PUSD.balanceOf(depositWallet);
        if (
            depositBalanceAfter < depositBalanceBefore ||
            depositBalanceAfter - depositBalanceBefore != totalAmount
        ) {
            revert BalanceDeltaMismatch();
        }

        emit Funded(
            msg.sender,
            depositWallet,
            currentNonce,
            totalAmount,
            pUsdAmount,
            depositUsdceAmount,
            signerUsdceAmount
        );
    }

    function _min(uint256 left, uint256 right) private pure returns (uint256) {
        return left < right ? left : right;
    }

    function _deriveUupsDepositWallet(
        address owner
    ) private pure returns (address) {
        bytes memory args = _depositWalletArgs(owner);
        bytes32 salt = keccak256(args);
        uint80 prefix = ERC1967_PREFIX + uint80(args.length << 56);
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                bytes10(prefix),
                LEGACY_DEPOSIT_WALLET_IMPLEMENTATION,
                hex"6009",
                ERC1967_CONST2,
                ERC1967_CONST1,
                args
            )
        );
        return _create2Address(salt, initCodeHash);
    }

    function _deriveBeaconDepositWallet(
        address owner,
        address beacon
    ) private pure returns (address) {
        bytes memory args = _depositWalletArgs(owner);
        bytes32 salt = keccak256(args);
        uint80 prefix = ERC1967_BEACON_PREFIX + uint80(args.length << 56);
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                bytes10(prefix),
                beacon,
                ERC1967_BEACON_CONST3,
                ERC1967_BEACON_CONST2,
                ERC1967_BEACON_CONST1,
                args
            )
        );
        return _create2Address(salt, initCodeHash);
    }

    function _depositWalletArgs(
        address owner
    ) private pure returns (bytes memory) {
        return
            abi.encode(
                DEPOSIT_WALLET_FACTORY,
                bytes32(uint256(uint160(owner)))
            );
    }

    function _create2Address(
        bytes32 salt,
        bytes32 initCodeHash
    ) private pure returns (address) {
        return
            address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(
                                bytes1(0xff),
                                DEPOSIT_WALLET_FACTORY,
                                salt,
                                initCodeHash
                            )
                        )
                    )
                )
            );
    }

    function _factoryBeacon() private view returns (address) {
        try IPolymarketDepositWalletFactory(DEPOSIT_WALLET_FACTORY).BEACON() returns (
            address beacon
        ) {
            return beacon;
        } catch {
            return address(0);
        }
    }
}
