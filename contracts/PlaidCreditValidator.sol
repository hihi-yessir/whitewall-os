// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

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
        address forwarderAddress;
        address identityRegistry;
        address validationRegistry;
        mapping(uint256 => uint8) creditScores;
        mapping(uint256 => CreditVerification) verifications;
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
    /// @param report abi.encode(uint256 agentId, uint8 score, bytes32 requestHash, bytes32 dataHash)
    function onReport(bytes calldata /* metadata */, bytes calldata report) external {
        PlaidCreditValidatorStorage storage $ = _getStorage();
        if (msg.sender != $.forwarderAddress) revert NotForwarder();

        (
            uint256 agentId,
            uint8 score,
            bytes32 requestHash,
            bytes32 dataHash
        ) = abi.decode(report, (uint256, uint8, bytes32, bytes32));

        require(score <= 100, "Score exceeds maximum");

        // Verify agent exists
        try IIdentityRegistryCredit($.identityRegistry).ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert AgentNotRegistered(agentId);
        } catch {
            revert AgentNotRegistered(agentId);
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

    // ============ Admin Functions ============

    function setForwarder(address newForwarder) external onlyOwner {
        require(newForwarder != address(0), "Invalid address");
        _getStorage().forwarderAddress = newForwarder;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function getVersion() external pure returns (string memory) {
        return "1.0.0";
    }
}
