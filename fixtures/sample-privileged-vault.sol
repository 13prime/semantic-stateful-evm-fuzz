pragma solidity ^0.8.20;

contract SamplePrivilegedVault {
    address public owner;
    address public oracle;
    uint256 public totalAssets;
    uint256 public totalShares;
    uint256 public totalReserves;

    constructor(address oracle_) {
        owner = msg.sender;
        oracle = oracle_;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyOracle() {
        require(msg.sender == oracle, "not oracle");
        _;
    }

    function deposit(uint256 amount) external {}
    function redeem(uint256 shares) external {}
    function withdrawExcess(uint256 amount) external {}
    function setOracle(address newOracle) external onlyOwner {}
    function updatePrice(uint256 newPrice) external onlyOracle {}
    function emergencyWithdraw(uint256 amount) external onlyOwner {}
}
