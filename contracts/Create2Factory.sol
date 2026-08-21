// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Create2Factory
/// @notice A minimal CREATE2 deployer. Exists because Uniswap v4 hook
///         addresses must be mined to encode the hook's permission flags
///         in their low bits (see `AncillaSwapHook`), which needs a fixed,
///         known deployer address to mine a salt against — deploying a
///         hook via a plain `ContractFactory.deploy()` uses regular CREATE
///         (nonce-based), which gives no control over the resulting
///         address at all.
///
///         Functionally equivalent to the well-known deterministic
///         deployment proxy already live at
///         `0x4e59b44847b379578588920cA78FbF26c0B4956C` on most EVM chains
///         (confirmed present on Arbitrum Sepolia too) — written as our
///         own tiny contract instead of depending on that one sight-unseen,
///         same reasoning as `AncillaHookRouter` not depending on
///         Uniswap's test-only router contracts.
contract Create2Factory {
    event Deployed(address indexed addr, bytes32 indexed salt);

    error DeployFailed();

    /// @param salt      the salt to deploy with — mined off-chain (see
    ///                  scripts/lib/hookMiner.ts) so the resulting address
    ///                  has the right hook permission bits.
    /// @param bytecode  creation code with constructor arguments already
    ///                  ABI-encoded and appended.
    function deploy(bytes32 salt, bytes memory bytecode) external returns (address addr) {
        assembly {
            addr := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
        }
        if (addr == address(0)) revert DeployFailed();
        emit Deployed(addr, salt);
    }

    /// @notice Predicts the address `deploy` would produce for a given
    ///         salt and bytecode, without deploying anything. Mirrors the
    ///         same formula `scripts/lib/hookMiner.ts` uses off-chain
    ///         (EIP-1014) — kept on-chain too so a script can double-check
    ///         its own off-chain computation against this contract before
    ///         spending gas on a real deployment.
    function computeAddress(bytes32 salt, bytes memory bytecode) external view returns (address) {
        bytes32 initCodeHash = keccak256(bytecode);
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash));
        return address(uint160(uint256(hash)));
    }
}
