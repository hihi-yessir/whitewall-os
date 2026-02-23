// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @notice IdentityRegistry read interface
interface IIdentityRegistryKYC {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice ValidationRegistry write interface
interface IValidationRegistryKYC {
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;
}

/// @title StripeKYCValidator
/// @notice Receives CRE Confidential HTTP reports for Stripe Identity KYC verification.
///         Called by CRE Forwarder with verification results from Stripe API.
///         Maintains tamper-proof KYC state and writes responses to ValidationRegistry.
contract StripeKYCValidator is OwnableUpgradeable, UUPSUpgradeable {
    // ============ Events ============
    event KYCVerified(
        uint256 indexed agentId,
        address indexed verifiedBy,
        bytes32 sessionHash,
        uint256 timestamp
    );

    // ============ Errors ============
    error NotForwarder();
    error AgentNotRegistered(uint256 agentId);

    // ============ Storage ============
    /// @custom:storage-location erc7201:whitewall-os.StripeKYCValidator
    struct StripeKYCValidatorStorage {
        address forwarderAddress;
        address identityRegistry;
        address validationRegistry;
        mapping(uint256 => bool) kycVerified;
        mapping(uint256 => KYCVerification) verifications;
    }

    struct KYCVerification {
        bool verified;
        bytes32 sessionHash;
        uint256 verifiedAt;
    }

    bytes32 private constant STORAGE_LOCATION =
        keccak256(abi.encode(uint256(keccak256("whitewall-os.StripeKYCValidator")) - 1)) & ~bytes32(uint256(0xff));

    function _getStorage() private pure returns (StripeKYCValidatorStorage storage $) {
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

        StripeKYCValidatorStorage storage $ = _getStorage();
        $.forwarderAddress = forwarder_;
        $.identityRegistry = identityRegistry_;
        $.validationRegistry = validationRegistry_;
    }

    // ============ CRE Report Handler ============

    /// @notice Called by CRE Forwarder with Stripe Identity verification result
    /// @param report abi.encode(uint256 agentId, bool verified, bytes32 requestHash, bytes32 sessionHash)
    function onReport(bytes calldata /* metadata */, bytes calldata report) external {
        StripeKYCValidatorStorage storage $ = _getStorage();
        if (msg.sender != $.forwarderAddress) revert NotForwarder();

        (
            uint256 agentId,
            bool verified,
            bytes32 requestHash,
            bytes32 sessionHash
        ) = abi.decode(report, (uint256, bool, bytes32, bytes32));

        // Verify agent exists
        try IIdentityRegistryKYC($.identityRegistry).ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert AgentNotRegistered(agentId);
        } catch {
            revert AgentNotRegistered(agentId);
        }

        // Set tamper-proof KYC state
        $.kycVerified[agentId] = verified;
        $.verifications[agentId] = KYCVerification({
            verified: verified,
            sessionHash: sessionHash,
            verifiedAt: block.timestamp
        });

        // Write response to ValidationRegistry
        uint8 score = verified ? 100 : 0;
        IValidationRegistryKYC($.validationRegistry).validationResponse(
            requestHash,
            score,
            "",
            bytes32(0),
            "KYC_VERIFIED"
        );

        if (verified) {
            emit KYCVerified(agentId, msg.sender, sessionHash, block.timestamp);
        }
    }

    // ============ View Functions ============

    function isKYCVerified(uint256 agentId) external view returns (bool) {
        return _getStorage().kycVerified[agentId];
    }

    function getKYCData(uint256 agentId) external view returns (
        bool verified,
        bytes32 sessionHash,
        uint256 verifiedAt
    ) {
        KYCVerification memory v = _getStorage().verifications[agentId];
        return (v.verified, v.sessionHash, v.verifiedAt);
    }

    function getConfig() external view returns (
        address forwarderAddress,
        address identityRegistry,
        address validationRegistry
    ) {
        StripeKYCValidatorStorage storage $ = _getStorage();
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
