// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Policy} from "./vendor/core/Policy.sol";
import {IPolicyEngine} from "./vendor/interfaces/IPolicyEngine.sol";

// Read-only interfaces for on-chain state verification
interface IIdentityRegistryReaderKYC {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory);
}

interface IWorldIDValidatorReaderKYC {
    function isHumanVerified(uint256 agentId) external view returns (bool);
}

interface IStripeKYCValidatorReader {
    function isKYCVerified(uint256 agentId) external view returns (bool);
}

/**
 * @title KYCPolicy
 * @notice On-chain safety net for Tier 3 (KYC-verified) access requests.
 *         Superset of HumanVerifiedPolicy — requires all 5 human checks PLUS
 *         tamper-proof KYC verification from StripeKYCValidator.
 *
 * 6-check protection:
 *   1. CRE report says approved == true
 *   2. tier >= requiredTier (3)
 *   3. IdentityRegistry: agent is registered (ownerOf doesn't revert)
 *   4. IdentityRegistry: agent has "humanVerified" metadata
 *   5. WorldIDValidator: independently confirms human verification
 *   6. StripeKYCValidator: independently confirms KYC (tamper-proof)
 */
contract KYCPolicy is Policy {
    // ── Storage ──
    /// @custom:storage-location erc7201:whitewall-os.KYCPolicy
    struct KYCPolicyStorage {
        IIdentityRegistryReaderKYC identityRegistry;
        IWorldIDValidatorReaderKYC worldIdValidator;
        IStripeKYCValidatorReader kycValidator;
        uint8 requiredTier;
    }

    bytes32 private constant STORAGE_LOCATION =
        keccak256(abi.encode(uint256(keccak256("whitewall-os.KYCPolicy")) - 1)) & ~bytes32(uint256(0xff));

    function _getStorage() private pure returns (KYCPolicyStorage storage $) {
        bytes32 slot = STORAGE_LOCATION;
        assembly {
            $.slot := slot
        }
    }

    // ── Initialization ──

    /**
     * @dev configParams = abi.encode(address identityRegistry, address worldIdValidator, address kycValidator, uint8 requiredTier)
     */
    function configure(bytes calldata configParams) internal override {
        (
            address identityRegistry_,
            address worldIdValidator_,
            address kycValidator_,
            uint8 requiredTier_
        ) = abi.decode(configParams, (address, address, address, uint8));

        KYCPolicyStorage storage $ = _getStorage();
        $.identityRegistry = IIdentityRegistryReaderKYC(identityRegistry_);
        $.worldIdValidator = IWorldIDValidatorReaderKYC(worldIdValidator_);
        $.kycValidator = IStripeKYCValidatorReader(kycValidator_);
        $.requiredTier = requiredTier_;
    }

    // ── Policy execution ──

    /**
     * @notice Runs the Tier 3 (KYC) policy check.
     * @dev Parameters mapped by PolicyEngine from WhitewallExtractor output:
     *   parameters[0] = agentId (uint256)
     *   parameters[1] = approved (bool)
     *   parameters[2] = tier (uint8)
     *   parameters[3] = accountableHuman (address)
     */
    function run(
        address,          /* caller */
        address,          /* subject */
        bytes4,           /* selector */
        bytes[] calldata parameters,
        bytes calldata    /* context */
    ) public view override returns (IPolicyEngine.PolicyResult) {
        // Check 1: CRE says approved
        bool approved = abi.decode(parameters[1], (bool));
        if (!approved) {
            revert IPolicyEngine.PolicyRejected("CRE: agent not approved");
        }

        // Check 2: sufficient tier
        uint8 tier = abi.decode(parameters[2], (uint8));
        KYCPolicyStorage storage $ = _getStorage();
        if (tier < $.requiredTier) {
            revert IPolicyEngine.PolicyRejected("Insufficient verification tier");
        }

        // Check 3: on-chain — agent must be registered
        uint256 agentId = abi.decode(parameters[0], (uint256));
        try $.identityRegistry.ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) {
                revert IPolicyEngine.PolicyRejected("Agent not registered");
            }
        } catch {
            revert IPolicyEngine.PolicyRejected("Agent not registered");
        }

        // Check 4: on-chain — agent must have humanVerified metadata
        bytes memory humanMeta = $.identityRegistry.getMetadata(agentId, "humanVerified");
        if (humanMeta.length == 0) {
            revert IPolicyEngine.PolicyRejected("Agent not human-verified on-chain");
        }

        // Check 5: on-chain — WorldIDValidator independently confirms
        if (!$.worldIdValidator.isHumanVerified(agentId)) {
            revert IPolicyEngine.PolicyRejected("WorldIDValidator: verification not confirmed");
        }

        // Check 6: on-chain — StripeKYCValidator independently confirms KYC
        if (!$.kycValidator.isKYCVerified(agentId)) {
            revert IPolicyEngine.PolicyRejected("StripeKYCValidator: KYC not verified");
        }

        return IPolicyEngine.PolicyResult.Allowed;
    }

    // ── View helpers ──

    function getRequiredTier() external view returns (uint8) {
        return _getStorage().requiredTier;
    }

    function getIdentityRegistry() external view returns (address) {
        return address(_getStorage().identityRegistry);
    }

    function getWorldIdValidator() external view returns (address) {
        return address(_getStorage().worldIdValidator);
    }

    function getStripeKYCValidator() external view returns (address) {
        return address(_getStorage().kycValidator);
    }
}
