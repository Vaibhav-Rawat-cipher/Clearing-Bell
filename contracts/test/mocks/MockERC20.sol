// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20
/// @notice Minimal mintable ERC20 used as a deterministic test fixture.
///         Acts as either the bond token (18 decimals) or settlement token (6 decimals).
contract MockERC20 is ERC20 {
    error MockERC20__ZeroAddress();

    uint8 private immutable _decimals;

    constructor(string memory name, string memory symbol, uint8 decimals_) ERC20(name, symbol) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mint tokens to an address. Test fixture only — no access control.
    function mint(address to, uint256 amount) external {
        if (to == address(0)) revert MockERC20__ZeroAddress();
        _mint(to, amount);
    }
}
