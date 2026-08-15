// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPolymarketPullDepositWallet {
    function owner() external view returns (address);
}

interface IPolymarketPullDepositWalletFactory {
    function BEACON() external view returns (address);
}

/// @title PolymarketDepositWalletPuller
/// @notice Pulls an exact pUSD amount from the caller's canonical Polymarket
/// deposit wallet back to the caller after that wallet has approved this
/// immutable contract.
/// @dev The token, source-wallet derivation, and recipient are fixed. There is
/// no administration, proxy, arbitrary target, token, recipient, or calldata.
contract PolymarketDepositWalletPuller is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public constant PUSD = IERC20(0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB);
    address public constant DEPOSIT_WALLET_FACTORY =
        0x00000000000Fb5C9ADea0298D729A0CB3823Cc07;
    address public constant LEGACY_DEPOSIT_WALLET_IMPLEMENTATION =
        0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB;

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

    mapping(address => uint256) public pullNonce;

    event PusdPulled(
        address indexed owner,
        address indexed depositWallet,
        uint256 indexed nonce,
        uint256 amount
    );

    error BalanceDeltaMismatch();
    error InvalidAmount();
    error InvalidDepositWallet();
    error InvalidNonce();
    error PullerRetainedPusd();

    function depositWalletOf(address owner) public view returns (address) {
        if (owner == address(0)) revert InvalidDepositWallet();

        address legacyWallet = _deriveUupsDepositWallet(owner);
        address beacon = _factoryBeacon();
        if (beacon == address(0) || legacyWallet.code.length != 0) {
            return legacyWallet;
        }
        return _deriveBeaconDepositWallet(owner, beacon);
    }

    /// @notice Pulls pUSD from msg.sender's canonical Deposit Wallet to
    /// msg.sender. The exact nonce makes retries and recovery idempotent.
    function pullPusd(uint256 expectedNonce, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 currentNonce = pullNonce[msg.sender];
        if (expectedNonce != currentNonce) revert InvalidNonce();

        address depositWallet = depositWalletOf(msg.sender);
        if (depositWallet.code.length == 0) revert InvalidDepositWallet();
        try IPolymarketPullDepositWallet(depositWallet).owner() returns (
            address owner
        ) {
            if (owner != msg.sender) revert InvalidDepositWallet();
        } catch {
            revert InvalidDepositWallet();
        }

        pullNonce[msg.sender] = currentNonce + 1;

        uint256 sourceBefore = PUSD.balanceOf(depositWallet);
        uint256 recipientBefore = PUSD.balanceOf(msg.sender);
        uint256 retainedBefore = PUSD.balanceOf(address(this));
        PUSD.safeTransferFrom(depositWallet, msg.sender, amount);
        uint256 sourceAfter = PUSD.balanceOf(depositWallet);
        uint256 recipientAfter = PUSD.balanceOf(msg.sender);

        if (
            sourceBefore < sourceAfter ||
            sourceBefore - sourceAfter != amount ||
            recipientAfter < recipientBefore ||
            recipientAfter - recipientBefore != amount
        ) revert BalanceDeltaMismatch();
        if (PUSD.balanceOf(address(this)) != retainedBefore) {
            revert PullerRetainedPusd();
        }

        emit PusdPulled(msg.sender, depositWallet, currentNonce, amount);
    }

    function _deriveUupsDepositWallet(address owner) private pure returns (address) {
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

    function _depositWalletArgs(address owner) private pure returns (bytes memory) {
        return abi.encode(DEPOSIT_WALLET_FACTORY, bytes32(uint256(uint160(owner))));
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
        try IPolymarketPullDepositWalletFactory(DEPOSIT_WALLET_FACTORY).BEACON() returns (
            address beacon
        ) {
            return beacon;
        } catch {
            return address(0);
        }
    }
}
