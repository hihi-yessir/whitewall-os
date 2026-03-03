// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Policy} from "./vendor/core/Policy.sol";
import {IPolicyEngine} from "./vendor/interfaces/IPolicyEngine.sol";

// ── Read-only interfaces for on-chain state verification ──

interface IIdentityRegistryTiered {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory);
}

interface IWorldIDValidatorTiered {
    function isHumanVerified(uint256 agentId) external view returns (bool);
}

interface IStripeKYCValidatorTiered {
    function isKYCVerified(uint256 agentId) external view returns (bool);
}

interface IPlaidCreditValidatorTiered {
    function hasCreditScore(uint256 agentId) external view returns (bool);
    function getCreditScore(uint256 agentId) external view returns (uint8);
}

/**
 * @title TieredPolicy
 * @notice Unified on-chain safety net for Whitewall OS tiered access (tiers 2–4).
 *         Composes all verification checks into a single policy with dynamic depth
 *         based on the CRE-reported tier.
 *
 *         Registered as the sole policy on PolicyEngine for WhitewallConsumer.onReport.
 *         Internally composes three verification layers:
 *
 *         Base layer (always, tier >= 2):
 *           1. CRE report says approved == true
 *           2. tier >= 2 (minimum bar)
 *           3. IdentityRegistry: agent is registered (ownerOf)
 *           4. IdentityRegistry: agent has "humanVerified" metadata
 *           5. WorldIDValidator: tamper-proof human verification
 *
 *         KYC layer (tier >= 3):
 *           6. StripeKYCValidator: tamper-proof KYC verification
 *
 *         Credit layer (tier >= 4):
 *           7. PlaidCreditValidator: has a credit score
 *           8. PlaidCreditValidator: score >= minCreditScore
 *
 *         Double protection: CRE computes tier off-chain, this policy independently
 *         re-verifies on-chain state. A compromised CRE claiming tier=4 for an agent
 *         without credit verification gets caught at check 7.
 */
contract TieredPolicy is Policy {
    // ── Storage ──
    /// @custom:storage-location erc7201:whitewall-os.TieredPolicy
    struct TieredPolicyStorage {
        IIdentityRegistryTiered identityRegistry;
        IWorldIDValidatorTiered worldIdValidator;
        IStripeKYCValidatorTiered kycValidator;
        IPlaidCreditValidatorTiered creditValidator;
        uint8 minCreditScore;
    }

    bytes32 private constant STORAGE_LOCATION =
        keccak256(abi.encode(uint256(keccak256("whitewall-os.TieredPolicy")) - 1)) & ~bytes32(uint256(0xff));

    function _getStorage() private pure returns (TieredPolicyStorage storage $) {
        bytes32 slot = STORAGE_LOCATION;
        assembly {
            $.slot := slot
        }
    }

    // ── Initialization ──

    /**
     * @dev configParams = abi.encode(
     *   address identityRegistry,
     *   address worldIdValidator,
     *   address kycValidator,
     *   address creditValidator,
     *   uint8 minCreditScore
     * )
     */
    function configure(bytes calldata configParams) internal override {
        (
            address identityRegistry_,
            address worldIdValidator_,
            address kycValidator_,
            address creditValidator_,
            uint8 minCreditScore_
        ) = abi.decode(configParams, (address, address, address, address, uint8));

        TieredPolicyStorage storage $ = _getStorage();
        $.identityRegistry = IIdentityRegistryTiered(identityRegistry_);
        $.worldIdValidator = IWorldIDValidatorTiered(worldIdValidator_);
        $.kycValidator = IStripeKYCValidatorTiered(kycValidator_);
        $.creditValidator = IPlaidCreditValidatorTiered(creditValidator_);
        $.minCreditScore = minCreditScore_;
    }

    // ── Policy execution ──

    /**
     * @notice Runs the tiered ACCESS policy check with dynamic depth.
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
        // ════════════════════════════════════════════
        // BASE LAYER — always checked (tier >= 2)
        // ════════════════════════════════════════════

        // Check 1: CRE says approved
        bool approved = abi.decode(parameters[1], (bool));
        if (!approved) {
            revert IPolicyEngine.PolicyRejected("CRE: agent not approved");
        }

        // Check 2: minimum tier bar
        uint8 tier = abi.decode(parameters[2], (uint8));
        if (tier < 2) {
            revert IPolicyEngine.PolicyRejected("Insufficient verification tier");
        }

        // Check 3: on-chain — agent must be registered
        uint256 agentId = abi.decode(parameters[0], (uint256));
        TieredPolicyStorage storage $ = _getStorage();
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

        // Check 5: on-chain — WorldIDValidator independently confirms (tamper-proof)
        if (!$.worldIdValidator.isHumanVerified(agentId)) {
            revert IPolicyEngine.PolicyRejected("WorldIDValidator: verification not confirmed");
        }

        // ════════════════════════════════════════════
        // KYC LAYER — checked when tier >= 3
        // ════════════════════════════════════════════

        if (tier >= 3) {
            // Check 6: on-chain — StripeKYCValidator independently confirms KYC
            if (!$.kycValidator.isKYCVerified(agentId)) {
                revert IPolicyEngine.PolicyRejected("StripeKYCValidator: KYC not verified");
            }
        }

        // ════════════════════════════════════════════
        // CREDIT LAYER — checked when tier >= 4
        // ════════════════════════════════════════════

        if (tier >= 4) {
            // Check 7: on-chain — PlaidCreditValidator has a score
            if (!$.creditValidator.hasCreditScore(agentId)) {
                revert IPolicyEngine.PolicyRejected("PlaidCreditValidator: no credit score");
            }

            // Check 8: on-chain — credit score meets minimum threshold
            uint8 creditScore = $.creditValidator.getCreditScore(agentId);
            if (creditScore < $.minCreditScore) {
                revert IPolicyEngine.PolicyRejected("PlaidCreditValidator: credit score too low");
            }
        }

        return IPolicyEngine.PolicyResult.Allowed;
    }

    // ── View helpers ──

    function getIdentityRegistry() external view returns (address) {
        return address(_getStorage().identityRegistry);
    }

    function getWorldIdValidator() external view returns (address) {
        return address(_getStorage().worldIdValidator);
    }

    function getStripeKYCValidator() external view returns (address) {
        return address(_getStorage().kycValidator);
    }

    function getPlaidCreditValidator() external view returns (address) {
        return address(_getStorage().creditValidator);
    }

    function getMinCreditScore() external view returns (uint8) {
        return _getStorage().minCreditScore;
    }
}
