// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAutomataDcapV3Attestation
/// @notice Real Automata V3 DCAP Quote Verification Interface
/// @dev Returns (bool success, bytes output) where output is ABI-encoded
///      Output struct containing raw quoteBody bytes on success.
interface IAutomataDcapV3Attestation {
    function verifyAndAttestOnChain(bytes calldata quote)
        external
        returns (bool success, bytes memory output);
}
