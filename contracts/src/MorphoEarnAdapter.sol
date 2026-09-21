// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IYieldVault} from "./IBatpilot.sol";

interface IERC4626Minimal {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function previewRedeem(uint256 shares) external view returns (uint256 assets);
}

/// @title MorphoEarnAdapter — IYieldVault over an ERC4626 Earn vault
/// @notice Production adapter. On Robinhood Chain mainnet the target is the
/// Steakhouse USDG vault (Morpho Vaults V2, ERC4626-shaped): idle plan USDG
/// earns the same yield as Robinhood Earn, non-custodially.
contract MorphoEarnAdapter is IYieldVault {
    using SafeERC20 for IERC20;

    IERC20 public immutable ASSET;
    IERC4626Minimal public immutable VAULT;
    address public owner;

    event OwnerSet(address indexed owner);

    modifier onlyOwner() {
        require(msg.sender == owner, "EarnAdapter: not owner");
        _;
    }

    constructor(address earnVault) {
        VAULT = IERC4626Minimal(earnVault);
        ASSET = IERC20(VAULT.asset());
        owner = msg.sender;
    }

    function setOwner(address o) external onlyOwner {
        owner = o;
        emit OwnerSet(o);
    }

    function deposit(uint256 assets) external returns (uint256 shares) {
        ASSET.safeTransferFrom(msg.sender, address(this), assets);
        ASSET.forceApprove(address(VAULT), assets);
        shares = VAULT.deposit(assets, address(this));
    }

    function withdraw(uint256 shares) external returns (uint256 assets) {
        assets = VAULT.redeem(shares, msg.sender, address(this));
    }

    function previewRedeem(uint256 shares) external view returns (uint256) {
        return VAULT.previewRedeem(shares);
    }

    function balanceOf(address) external view returns (uint256) {
        return VAULT.previewRedeem(IERC20(address(VAULT)).balanceOf(address(this)));
    }
}
