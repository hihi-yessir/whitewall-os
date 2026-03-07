// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./interfaces/ISgxDcapVerifier.sol";

/// @notice IdentityRegistry read interface
interface IIdentityRegistryCredit {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice ValidationRegistry write interface
interface IValidationRegistryCredit {
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;
}

/// @title PlaidCreditValidator
/// @notice Receives CRE Confidential HTTP reports for Plaid credit score verification.
///         Called by CRE Forwarder with credit assessment results from Plaid API.
///         V2: Optionally verifies Intel SGX DCAP attestation quotes via Automata's
///         verifyAndAttestOnChain, parsing raw quoteBody at SGX enclave report offsets
///         (mrEnclave @ 112, reportData @ 368) for hardware-backed execution guarantees.
///         Maintains tamper-proof credit score state and writes responses to ValidationRegistry.
contract PlaidCreditValidator is OwnableUpgradeable, UUPSUpgradeable {
    // ============ Events ============
    event CreditScoreSet(
        uint256 indexed agentId,
        uint8 score,
        bytes32 dataHash,
        uint256 timestamp
    );

    // ============ Errors ============
    error NotForwarder();
    error AgentNotRegistered(uint256 agentId);

    // ============ Storage ============
    /// @custom:storage-location erc7201:whitewall-os.PlaidCreditValidator
    struct PlaidCreditValidatorStorage {
        // V1 fields (unchanged)
        address forwarderAddress;
        address identityRegistry;
        address validationRegistry;
        mapping(uint256 => uint8) creditScores;
        mapping(uint256 => CreditVerification) verifications;
        // V2 fields
        address sgxDcapVerifier;
        bytes32 expectedMrEnclave;
    }

    struct CreditVerification {
        uint8 score;
        bytes32 dataHash;
        uint256 verifiedAt;
        bool hasScore;
    }

    bytes32 private constant STORAGE_LOCATION =
        keccak256(abi.encode(uint256(keccak256("whitewall-os.PlaidCreditValidator")) - 1)) & ~bytes32(uint256(0xff));

    function _getStorage() private pure returns (PlaidCreditValidatorStorage storage $) {
        bytes32 slot = STORAGE_LOCATION;
        assembly {
            $.slot := slot
        }
    }

    // ============ Constructor & Initializer ============
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address forwarder_,
        address identityRegistry_,
        address validationRegistry_
    ) public initializer {
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();

        require(forwarder_ != address(0), "Invalid forwarder");
        require(identityRegistry_ != address(0), "Invalid IdentityRegistry");
        require(validationRegistry_ != address(0), "Invalid ValidationRegistry");

        PlaidCreditValidatorStorage storage $ = _getStorage();
        $.forwarderAddress = forwarder_;
        $.identityRegistry = identityRegistry_;
        $.validationRegistry = validationRegistry_;
    }

    // ============ CRE Report Handler ============

    /// @notice Called by CRE Forwarder with Plaid credit assessment result
    /// @dev V2: report can be either:
    ///   V1: abi.encode(uint256 agentId, uint8 score, bytes32 requestHash, bytes32 dataHash)
    ///   V2: abi.encode(uint256 agentId, uint8 score, bytes32 requestHash, bytes32 dataHash, bytes sgxQuote)
    function onReport(bytes calldata /* metadata */, bytes calldata report) external {
        PlaidCreditValidatorStorage storage $ = _getStorage();
        if (msg.sender != $.forwarderAddress) revert NotForwarder();

        // Try V2 decode first (5 fields), fallback to V1 (4 fields)
        uint256 agentId;
        uint8 score;
        bytes32 requestHash;
        bytes32 dataHash;
        bytes memory sgxQuote;

        if (report.length > 128) {
            // V2 format: includes sgxQuote as dynamic bytes
            (agentId, score, requestHash, dataHash, sgxQuote) =
                abi.decode(report, (uint256, uint8, bytes32, bytes32, bytes));
        } else {
            // V1 format: 4 static fields (128 bytes)
            (agentId, score, requestHash, dataHash) =
                abi.decode(report, (uint256, uint8, bytes32, bytes32));
        }

        require(score <= 100, "Score exceeds maximum");

        // Verify agent exists
        try IIdentityRegistryCredit($.identityRegistry).ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert AgentNotRegistered(agentId);
        } catch {
            revert AgentNotRegistered(agentId);
        }

        // SGX DCAP verification (V2) — Automata verifyAndAttestOnChain
        if ($.sgxDcapVerifier != address(0) && sgxQuote.length > 0) {
            (bool success, bytes memory output) =
                IAutomataDcapV3Attestation($.sgxDcapVerifier).verifyAndAttestOnChain(sgxQuote);
            require(success, "SGX quote verification failed");

            // Automata returns abi.encodePacked output:
            //   uint16 quoteVersion (2) + uint16 quoteBodyType (2) + uint8 tcbStatus (1) + bytes6 fmspc (6) = 11 byte header
            //   followed by 384-byte SGX Enclave Report Body where:
            //     mrEnclave at report offset 64  → output offset 75
            //     reportData at report offset 320 → output offset 331
            bytes32 extractedMrEnclave;
            bytes32 extractedReportData;

            assembly {
                extractedMrEnclave := mload(add(add(output, 32), 75))
                extractedReportData := mload(add(add(output, 32), 331))
            }

            require(
                extractedMrEnclave == $.expectedMrEnclave,
                "Untrusted TEE Code (MRENCLAVE mismatch)"
            );

            bytes32 expectedHash = sha256(
                abi.encodePacked("agent:", _uint256ToString(agentId), "|hash:", _bytes32ToHexString(requestHash), "|score:", _uint8ToString(score))
            );
            require(
                extractedReportData == expectedHash,
                "Data manipulated in transit"
            );
        }

        // Set tamper-proof credit score state
        $.creditScores[agentId] = score;
        $.verifications[agentId] = CreditVerification({
            score: score,
            dataHash: dataHash,
            verifiedAt: block.timestamp,
            hasScore: true
        });

        // Write response to ValidationRegistry
        IValidationRegistryCredit($.validationRegistry).validationResponse(
            requestHash,
            score,
            "",
            dataHash,
            "CREDIT_SCORE"
        );

        emit CreditScoreSet(agentId, score, dataHash, block.timestamp);
    }

    // ============ View Functions ============

    function getCreditScore(uint256 agentId) external view returns (uint8) {
        return _getStorage().creditScores[agentId];
    }

    function hasCreditScore(uint256 agentId) external view returns (bool) {
        return _getStorage().verifications[agentId].hasScore;
    }

    function getCreditData(uint256 agentId) external view returns (
        uint8 score,
        bytes32 dataHash,
        uint256 verifiedAt,
        bool hasScore
    ) {
        CreditVerification memory v = _getStorage().verifications[agentId];
        return (v.score, v.dataHash, v.verifiedAt, v.hasScore);
    }

    function getConfig() external view returns (
        address forwarderAddress,
        address identityRegistry,
        address validationRegistry
    ) {
        PlaidCreditValidatorStorage storage $ = _getStorage();
        return ($.forwarderAddress, $.identityRegistry, $.validationRegistry);
    }

    function getSgxConfig() external view returns (
        address verifier,
        bytes32 mrEnclave
    ) {
        PlaidCreditValidatorStorage storage $ = _getStorage();
        return ($.sgxDcapVerifier, $.expectedMrEnclave);
    }

    // ============ Admin Functions ============

    function setForwarder(address newForwarder) external onlyOwner {
        require(newForwarder != address(0), "Invalid address");
        _getStorage().forwarderAddress = newForwarder;
    }

    function setSgxDcapVerifier(address verifier) external onlyOwner {
        _getStorage().sgxDcapVerifier = verifier;
    }

    function setExpectedMrEnclave(bytes32 mrEnclave) external onlyOwner {
        _getStorage().expectedMrEnclave = mrEnclave;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function getVersion() external pure returns (string memory) {
        return "2.0.0";
    }

    // ============ Internal Helpers ============

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

    function _bytes32ToHexString(bytes32 value) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(66); // "0x" + 64 hex chars
        str[0] = "0";
        str[1] = "x";
        for (uint256 i = 0; i < 32; i++) {
            str[2 + i * 2] = alphabet[uint8(value[i] >> 4)];
            str[3 + i * 2] = alphabet[uint8(value[i] & 0x0f)];
        }
        return string(str);
    }

    function _uint256ToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
