// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "insufficient allowance");
        require(balanceOf[from] >= amount, "insufficient balance");
        allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract ToyVault {
    MockERC20 public immutable underlying;
    mapping(address => uint256) public deposits;
    uint256 public totalAssets;
    uint256 public totalShares;
    uint256 public totalReserves;

    constructor(address underlying_) {
        underlying = MockERC20(underlying_);
    }

    function deposit(uint256 amount) external {
        require(amount > 0, "amount=0");
        require(underlying.transferFrom(msg.sender, address(this), amount), "transfer failed");
        deposits[msg.sender] += amount;
        totalAssets += amount;
        totalShares += amount;
        totalReserves += amount;
    }

    function redeem(uint256 amount) external {
        require(deposits[msg.sender] >= amount, "insufficient deposit");
        deposits[msg.sender] -= amount;
        totalAssets -= amount;
        totalShares -= amount;
        totalReserves -= amount;
        require(underlying.transfer(msg.sender, amount), "transfer failed");
    }

    function withdrawExcess(uint256 amount) external {
        require(totalReserves >= amount, "insufficient reserves");
        totalAssets -= amount;
        totalReserves -= amount;
        require(underlying.transfer(msg.sender, amount), "transfer failed");
    }
}
