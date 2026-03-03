// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Policy} from "./vendor/core/Policy.sol";
import {IPolicyEngine} from "./vendor/interfaces/IPolicyEngine.sol";

// Read-only interfaces for on-chain state verification
interface IIdentityRegistryReaderCredit {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory);
}

interface IWorldIDValidatorReaderCredit {
    function isHumanVerified(uint256 agentId) external view returns (bool);
}

interface IStripeKYCValidatorReaderCredit {
    function isKYCVerified(uint256 agentId) external view returns (bool);
}

interface IPlaidCreditValidatorReader {
    function hasCreditScore(uint256 agentId) external view returns (bool);
    function getCreditScore(uint256 agentId) external view returns (uint8);
}

/**
 * @title CreditPolicy
 * @notice On-chain safety net for Tier 4 (credit-verified) access requests.
 *         Superset of KYCPolicy — requires all 6 KYC checks PLUS
 *         tamper-proof credit score from PlaidCreditValidator.
 *
 *         Designed for PolicyEngine chaining: returns Continue for tier < 4
 *         so lower-tier policies (KYCPolicy, HumanVerifiedPolicy) can handle.
 *
 * 8-check protection (when tier >= 4):
 *   1. CRE report says approved == true
 *   2. tier >= requiredTier (4) — else Continue
 *   3. IdentityRegistry: agent is registered
 *   4. IdentityRegistry: agent has "humanVerified" metadata
 *   5. WorldIDValidator: independently confirms human verification
 *   6. StripeKYCValidator: independently confirms KYC
 *   7. PlaidCreditValidator: has a credit score
 *   8. PlaidCreditValidator: credit score >= minCreditScore
 */
contract CreditPolicy is Policy {
    // ── Storage ──
    /// @custom:storage-location erc7201:whitewall-os.CreditPolicy
    struct CreditPolicyStorage {
        IIdentityRegistryReaderCredit identityRegistry;
        IWorldIDValidatorReaderCredit worldIdValidator;
        IStripeKYCValidatorReaderCredit kycValidator;
        IPlaidCreditValidatorReader creditValidator;
        uint8 requiredTier;
        uint8 minCreditScore;
    }

    bytes32 private constant STORAGE_LOCATION =
        keccak256(abi.encode(uint256(keccak256("whitewall-os.CreditPolicy")) - 1)) & ~bytes32(uint256(0xff));

    function _getStorage() private pure returns (CreditPolicyStorage storage $) {
        bytes32 slot = STORAGE_LOCATION;
        assembly {
            $.slot := slot
        }
    }

    // ── Initialization ──

    /**
     * @dev configParams = abi.encode(
     *   address identityRegistry, address worldIdValidator,
     *   address kycValidator, address creditValidator,
     *   uint8 requiredTier, uint8 minCreditScore
     * )
     */
    function configure(bytes calldata configParams) internal override {
        (
            address identityRegistry_,
            address worldIdValidator_,
            address kycValidator_,
            address creditValidator_,
            uint8 requiredTier_,
            uint8 minCreditScore_
        ) = abi.decode(configParams, (address, address, address, address, uint8, uint8));

        CreditPolicyStorage storage $ = _getStorage();
        $.identityRegistry = IIdentityRegistryReaderCredit(identityRegistry_);
        $.worldIdValidator = IWorldIDValidatorReaderCredit(worldIdValidator_);
        $.kycValidator = IStripeKYCValidatorReaderCredit(kycValidator_);
        $.creditValidator = IPlaidCreditValidatorReader(creditValidator_);
        $.requiredTier = requiredTier_;
        $.minCreditScore = minCreditScore_;
    }

    // ── Policy execution ──

    /**
     * @notice Runs the Tier 4 (credit) policy check.
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

        // Check 2: tier routing — not our tier? pass to next policy in chain
        uint8 tier = abi.decode(parameters[2], (uint8));
        CreditPolicyStorage storage $ = _getStorage();
        if (tier < $.requiredTier) {
            return IPolicyEngine.PolicyResult.Continue;
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

        // Check 7: on-chain — PlaidCreditValidator has a score
        if (!$.creditValidator.hasCreditScore(agentId)) {
            revert IPolicyEngine.PolicyRejected("PlaidCreditValidator: no credit score");
        }

        // Check 8: on-chain — credit score meets minimum threshold
        uint8 creditScore = $.creditValidator.getCreditScore(agentId);
        if (creditScore < $.minCreditScore) {
            revert IPolicyEngine.PolicyRejected("PlaidCreditValidator: credit score too low");
        }

        return IPolicyEngine.PolicyResult.Allowed;
    }

    // ── View helpers ──

    function getRequiredTier() external view returns (uint8) {
        return _getStorage().requiredTier;
    }

    function getMinCreditScore() external view returns (uint8) {
        return _getStorage().minCreditScore;
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

    function getPlaidCreditValidator() external view returns (address) {
        return address(_getStorage().creditValidator);
    }
}
