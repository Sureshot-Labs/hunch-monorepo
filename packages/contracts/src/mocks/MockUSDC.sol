// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Lightweight ERC20 mock with 6 decimals for USDC testing.
contract MockUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 currentAllowance = _allowances[from][msg.sender];
        require(currentAllowance >= amount, "allowance");
        require(_balances[from] >= amount, "balance");

        _allowances[from][msg.sender] = currentAllowance - amount;
        _balances[from] -= amount;
        _balances[to] += amount;
        return true;
    }
}
