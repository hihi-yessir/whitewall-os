// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/ISgxDcapVerifier.sol";

/// @title SgxVerifiedCreditValidator
/// @notice Standalone (non-upgradeable) test vehicle for SGX DCAP quote verification.
///         Uses real Automata V3 interface with inline assembly offset parsing.
///         ReportData format: sha256("agent:{agentId}|hash:{requestHash}|score:{score}")
contract SgxVerifiedCreditValidator {
    event CreditScoreVerified(string indexed agentId, uint8 score);

    IAutomataDcapV3Attestation public immutable dcapVerifier;
    bytes32 public immutable expectedMrEnclave;

    mapping(string => uint8) public creditScores;

    constructor(address _dcapVerifier, bytes32 _expectedMrEnclave) {
        dcapVerifier = IAutomataDcapV3Attestation(_dcapVerifier);
        expectedMrEnclave = _expectedMrEnclave;
    }

    /// @notice Verify an SGX DCAP quote and store the credit score
    function onReport(bytes calldata quote, string calldata agentId, bytes32 requestHash, uint8 score) external {
        // 1. Verify quote via Automata's verifier
        (bool success, bytes memory output) = dcapVerifier.verifyAndAttestOnChain(quote);
        require(success, "SGX quote verification failed");

        // 2. Parse Automata's abi.encodePacked output:
        //    uint16 version (2) + uint16 bodyType (2) + uint8 tcbStatus (1) + bytes6 fmspc (6) = 11 byte header
        //    followed by 384-byte SGX Enclave Report Body
        //    mrEnclave at report offset 64  → output offset 75
        //    reportData at report offset 320 → output offset 331
        bytes32 extractedMrEnclave;
        bytes32 extractedReportData;

        assembly {
            extractedMrEnclave := mload(add(add(output, 32), 75))
            extractedReportData := mload(add(add(output, 32), 331))
        }

        // 4. Check MRENCLAVE matches approved enclave binary
        require(
            extractedMrEnclave == expectedMrEnclave,
            "Untrusted TEE Code (MRENCLAVE mismatch)"
        );

        // 5. Check reportData hash: sha256("agent:{agentId}|hash:{requestHash}|score:{score}")
        bytes32 expectedHash = sha256(
            abi.encodePacked("agent:", agentId, "|hash:", _bytes32ToHexString(requestHash), "|score:", _uint8ToString(score))
        );
        require(
            extractedReportData == expectedHash,
            "Data manipulated in transit"
        );

        // 6. Store score
        creditScores[agentId] = score;
        emit CreditScoreVerified(agentId, score);
    }

    function _bytes32ToHexString(bytes32 value) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(66);
        str[0] = "0";
        str[1] = "x";
        for (uint256 i = 0; i < 32; i++) {
            str[2 + i * 2] = alphabet[uint8(value[i] >> 4)];
            str[3 + i * 2] = alphabet[uint8(value[i] & 0x0f)];
        }
        return string(str);
    }

    function _uint8ToString(uint8 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint8 temp = value;
        uint8 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint8(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
