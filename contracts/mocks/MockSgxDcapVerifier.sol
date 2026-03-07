// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/ISgxDcapVerifier.sol";

/// @title MockSgxDcapVerifier
/// @notice Mock that mimics Automata's verifyAndAttestOnChain return format.
///         Returns abi.encodePacked output: 11-byte header + 384-byte SGX Enclave Report Body.
///         Header: uint16 quoteVersion + uint16 bodyType + uint8 tcbStatus + bytes6 fmspc
///         Report body: mrEnclave at offset 64, reportData at offset 320.
contract MockSgxDcapVerifier is IAutomataDcapV3Attestation {
    bool public shouldPass = true;
    bytes32 public mockMrEnclave;
    bytes32 public mockReportDataHash;

    function setMockSuccess(bool _success) external {
        shouldPass = _success;
    }

    function setMockMrEnclave(bytes32 _mrEnclave) external {
        mockMrEnclave = _mrEnclave;
    }

    function setMockReportData(bytes32 actualHash) external {
        mockReportDataHash = actualHash;
    }

    function verifyAndAttestOnChain(bytes calldata /* quote */)
        external
        view
        override
        returns (bool success, bytes memory output)
    {
        if (!shouldPass) {
            return (false, "");
        }

        // Build abi.encodePacked output matching real Automata format:
        // 11-byte header: uint16 version(3) + uint16 bodyType(0) + uint8 tcbStatus(0) + bytes6 fmspc
        // 384-byte SGX Enclave Report Body: mrEnclave @ offset 64, reportData @ offset 320
        // Total: 395 bytes
        bytes memory packed = new bytes(395);

        // Write header: version=3 at byte 0-1 (big-endian)
        packed[1] = 0x03;

        bytes32 mEnclave = mockMrEnclave;
        bytes32 mReportData = mockReportDataHash;

        assembly {
            // mrEnclave at report body offset 64 → packed offset 75 (11 header + 64)
            mstore(add(add(packed, 32), 75), mEnclave)
            // reportData at report body offset 320 → packed offset 331 (11 header + 320)
            mstore(add(add(packed, 32), 331), mReportData)
        }

        return (true, packed);
    }
}
