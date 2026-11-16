pragma solidity ^0.8.20;

contract SampleVault {
    uint256 public totalAssets;
    uint256 public totalShares;
    uint256 public totalReserves;

    function deposit(uint256 amount) external {}
    function redeem(uint256 shares) external {}
    function withdrawExcess(uint256 amount) external {}
}
