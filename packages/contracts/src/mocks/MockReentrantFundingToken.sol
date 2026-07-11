// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFundingRouterReentryTarget {
    function fund(
        uint256 expectedNonce,
        uint256 totalAmount,
        uint256 pUsdAmount
    ) external;
}

contract MockReentrantFundingToken {
    IFundingRouterReentryTarget public immutable router;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    constructor(address router_) {
        router = IFundingRouterReentryTarget(router_);
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function allowance(
        address owner,
        address spender
    ) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(
        address from,
        address,
        uint256 amount
    ) external returns (bool) {
        uint256 currentAllowance = _allowances[from][msg.sender];
        require(currentAllowance >= amount, "allowance");
        require(_balances[from] >= amount, "balance");
        router.fund(0, 1, 1);
        return true;
    }
}
