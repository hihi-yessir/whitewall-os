package whitewallos

import (
	"context"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

// ─── Test helpers ───

func connectOrSkip(t *testing.T) *WhitewallOS {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	a, err := Connect(ctx, Config{Chain: BaseSepolia})
	if err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	t.Cleanup(func() { a.Close() })
	return a
}

var (
	existingAgent    = big.NewInt(1)
	nonExistentAgent = big.NewInt(999999)
)

// ─── Connect: Policy Config from Chain ───

func TestConnect_ReadsPolicyConfig(t *testing.T) {
	a := connectOrSkip(t)
	cfg := a.GetPolicyConfig()

	if cfg.IdentityRegistry == ZeroAddress {
		t.Error("IdentityRegistry is zero address")
	}
	if cfg.WorldIDValidator == ZeroAddress {
		t.Error("WorldIDValidator is zero address")
	}
	if cfg.StripeKYCValidator == ZeroAddress {
		t.Error("StripeKYCValidator is zero address")
	}
	if cfg.PlaidCreditValidator == ZeroAddress {
		t.Error("PlaidCreditValidator is zero address")
	}
	t.Logf("MinCreditScore = %d", cfg.MinCreditScore)
}

func TestConnect_DiscoveredAddressesMatchDeployed(t *testing.T) {
	a := connectOrSkip(t)
	cfg := a.GetPolicyConfig()

	if cfg.IdentityRegistry == ZeroAddress {
		t.Error("IdentityRegistry should be non-zero")
	}
	t.Logf("IdentityRegistry = %s", cfg.IdentityRegistry.Hex())
}

func TestConnect_UnsupportedChain(t *testing.T) {
	ctx := context.Background()
	_, err := Connect(ctx, Config{Chain: "fakechain"})
	if err == nil {
		t.Error("expected error for unsupported chain, got nil")
	}
}

// ─── IsRegistered ───

func TestIsRegistered_ExistingAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	registered, err := a.IsRegistered(ctx, existingAgent)
	if err != nil {
		t.Fatalf("IsRegistered error: %v", err)
	}
	if !registered {
		t.Error("agent #1 should be registered")
	}
}

func TestIsRegistered_NonExistentAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	registered, err := a.IsRegistered(ctx, nonExistentAgent)
	if err != nil {
		t.Fatalf("IsRegistered error: %v", err)
	}
	if registered {
		t.Error("agent #999999 should NOT be registered")
	}
}

// ─── GetOwner ───

func TestGetOwner_ExistingAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	owner, err := a.GetOwner(ctx, existingAgent)
	if err != nil {
		t.Fatalf("GetOwner error: %v", err)
	}
	if owner == ZeroAddress {
		t.Error("owner should not be zero address")
	}
	t.Logf("Agent #1 owner: %s", owner.Hex())
}

func TestGetOwner_NonExistentAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	_, err := a.GetOwner(ctx, nonExistentAgent)
	if err == nil {
		t.Error("GetOwner should error for non-existent agent")
	}
}

// ─── GetAgentWallet ───

func TestGetAgentWallet_ExistingAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	wallet, err := a.GetAgentWallet(ctx, existingAgent)
	if err != nil {
		t.Fatalf("GetAgentWallet error: %v", err)
	}
	t.Logf("Agent #1 wallet: %s", wallet.Hex())
}

// ─── IsHumanVerified ───

func TestIsHumanVerified_ExistingAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	verified, err := a.IsHumanVerified(ctx, existingAgent)
	if err != nil {
		t.Fatalf("IsHumanVerified error: %v", err)
	}
	t.Logf("Agent #1 human verified: %v", verified)
}

// ─── IsKYCVerified ───

func TestIsKYCVerified_ExistingAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	kycVerified, err := a.IsKYCVerified(ctx, existingAgent)
	if err != nil {
		t.Fatalf("IsKYCVerified error: %v", err)
	}
	t.Logf("Agent #1 KYC verified: %v", kycVerified)
}

// ─── GetCreditScore ───

func TestGetCreditScore_ExistingAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	score, err := a.GetCreditScore(ctx, existingAgent)
	if err != nil {
		t.Fatalf("GetCreditScore error: %v", err)
	}
	t.Logf("Agent #1 credit score: %d", score)
}

// ─── BalanceOf ───

func TestBalanceOf_KnownOwner(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	owner, err := a.GetOwner(ctx, existingAgent)
	if err != nil {
		t.Fatalf("GetOwner error: %v", err)
	}
	balance, err := a.BalanceOf(ctx, owner)
	if err != nil {
		t.Fatalf("BalanceOf error: %v", err)
	}
	if balance.Cmp(big.NewInt(0)) <= 0 {
		t.Error("balance should be > 0 for known owner")
	}
	t.Logf("Owner %s has %d agents", owner.Hex(), balance.Int64())
}

// ─── KYC Data ───

func TestGetKYCData_ExistingAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	data, err := a.GetKYCData(ctx, existingAgent)
	if err != nil {
		t.Fatalf("GetKYCData error: %v", err)
	}
	t.Logf("Agent #1 KYC data: verified=%v verifiedAt=%s sessionHash=%x",
		data.Verified, data.VerifiedAt.String(), data.SessionHash)
}

// ─── Credit Data ───

func TestHasCreditScore_ExistingAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	has, err := a.HasCreditScore(ctx, existingAgent)
	if err != nil {
		t.Fatalf("HasCreditScore error: %v", err)
	}
	t.Logf("Agent #1 has credit score: %v", has)
}

func TestGetCreditData_ExistingAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	data, err := a.GetCreditData(ctx, existingAgent)
	if err != nil {
		t.Fatalf("GetCreditData error: %v", err)
	}
	t.Logf("Agent #1 credit data: score=%d hasScore=%v verifiedAt=%s dataHash=%x",
		data.Score, data.HasScore, data.VerifiedAt.String(), data.DataHash)
}

// ─── TEE / SGX ───

func TestGetSgxConfig(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	config, err := a.GetSgxConfig(ctx)
	if err != nil {
		t.Fatalf("GetSgxConfig error: %v", err)
	}
	t.Logf("SGX config: verifier=%s mrEnclave=%x", config.Verifier.Hex(), config.MrEnclave)
}

func TestIsTeeEnabled(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	enabled, err := a.IsTeeEnabled(ctx)
	if err != nil {
		t.Fatalf("IsTeeEnabled error: %v", err)
	}
	t.Logf("TEE enabled: %v", enabled)
}

// ─── ValidationRegistry ───

func TestGetValidationSummary_ExistingAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	summary, err := a.GetValidationSummary(ctx, existingAgent, nil, "")
	if err != nil {
		t.Fatalf("GetValidationSummary error: %v", err)
	}
	t.Logf("Agent #1 validation summary: count=%d avgScore=%d", summary.Count, summary.AvgScore)
}

func TestGetAgentValidations_ExistingAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	hashes, err := a.GetAgentValidations(ctx, existingAgent)
	if err != nil {
		t.Fatalf("GetAgentValidations error: %v", err)
	}
	t.Logf("Agent #1 has %d validations", len(hashes))
	for i, h := range hashes {
		t.Logf("  validation[%d]: %x", i, h)
	}
}

func TestGetValidationStatus_FirstHash(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	hashes, err := a.GetAgentValidations(ctx, existingAgent)
	if err != nil {
		t.Fatalf("GetAgentValidations error: %v", err)
	}
	if len(hashes) == 0 {
		t.Skip("no validations to check")
	}
	status, err := a.GetValidationStatus(ctx, hashes[0])
	if err != nil {
		t.Fatalf("GetValidationStatus error: %v", err)
	}
	if status.AgentId.Cmp(existingAgent) != 0 {
		t.Errorf("agentId = %s, want 1", status.AgentId.String())
	}
	t.Logf("Validation status: validator=%s response=%d tag=%s",
		status.ValidatorAddress.Hex(), status.Response, status.Tag)
}

func TestGetValidatorRequests(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Use the WorldIDValidator as a validator address for testing
	cfg := a.GetPolicyConfig()
	hashes, err := a.GetValidatorRequests(ctx, cfg.WorldIDValidator)
	if err != nil {
		t.Fatalf("GetValidatorRequests error: %v", err)
	}
	t.Logf("WorldIDValidator has %d requests", len(hashes))
}

// ─── GetAgentStatus (basic composite) ───

func TestGetAgentStatus_ExistingAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	status, err := a.GetAgentStatus(ctx, existingAgent)
	if err != nil {
		t.Fatalf("GetAgentStatus error: %v", err)
	}

	if !status.IsRegistered {
		t.Error("agent #1 should be registered")
	}
	if status.Owner == ZeroAddress {
		t.Error("owner should not be zero")
	}
	if status.Tier < 1 || status.Tier > 2 {
		t.Errorf("tier should be 1 or 2, got %d", status.Tier)
	}

	t.Logf("Agent #1 status: registered=%v verified=%v tier=%d owner=%s wallet=%s",
		status.IsRegistered, status.IsHumanVerified, status.Tier,
		status.Owner.Hex(), status.AgentWallet.Hex())
}

func TestGetAgentStatus_NonExistentAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	status, err := a.GetAgentStatus(ctx, nonExistentAgent)
	if err != nil {
		t.Fatalf("GetAgentStatus error: %v", err)
	}

	if status.IsRegistered {
		t.Error("non-existent agent should not be registered")
	}
	if status.IsHumanVerified {
		t.Error("non-existent agent should not be verified")
	}
	if status.Tier != 0 {
		t.Errorf("tier should be 0, got %d", status.Tier)
	}
	if status.Owner != ZeroAddress {
		t.Errorf("owner should be zero address, got %s", status.Owner.Hex())
	}
}

// ─── GetFullStatus ───

func TestGetFullStatus_ExistingAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	full, err := a.GetFullStatus(ctx, existingAgent)
	if err != nil {
		t.Fatalf("GetFullStatus error: %v", err)
	}

	if !full.IsRegistered {
		t.Error("agent #1 should be registered")
	}
	if full.EffectiveTier < 1 {
		t.Errorf("effectiveTier should be >= 1 for registered agent, got %d", full.EffectiveTier)
	}

	t.Logf("Agent #1 full status: registered=%v verified=%v kyc=%v credit=%d tier=%d effectiveTier=%d owner=%s wallet=%s",
		full.IsRegistered, full.IsHumanVerified, full.IsKYCVerified,
		full.CreditScore, full.Tier, full.EffectiveTier,
		full.Owner.Hex(), full.AgentWallet.Hex())
}

func TestGetFullStatus_NonExistentAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	full, err := a.GetFullStatus(ctx, nonExistentAgent)
	if err != nil {
		t.Fatalf("GetFullStatus error: %v", err)
	}

	if full.IsRegistered {
		t.Error("non-existent agent should not be registered")
	}
	if full.EffectiveTier != 0 {
		t.Errorf("effectiveTier should be 0, got %d", full.EffectiveTier)
	}
	if full.IsKYCVerified {
		t.Error("non-existent agent should not be KYC verified")
	}
	if full.CreditScore != 0 {
		t.Errorf("credit score should be 0, got %d", full.CreditScore)
	}
}

// ─── GetTokenURI ───

func TestGetTokenURI_ExistingAgent(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	uri, err := a.GetTokenURI(ctx, existingAgent)
	if err != nil {
		t.Fatalf("GetTokenURI error: %v", err)
	}
	t.Logf("Agent #1 URI: %s", uri)
}

// ─── Policy Config Consistency ───

func TestPolicyConfig_AllValidatorsNonZero(t *testing.T) {
	a := connectOrSkip(t)
	cfg := a.GetPolicyConfig()

	if cfg.WorldIDValidator == ZeroAddress {
		t.Error("WorldIDValidator should not be zero")
	}
	if cfg.StripeKYCValidator == ZeroAddress {
		t.Error("StripeKYCValidator should not be zero")
	}
	if cfg.PlaidCreditValidator == ZeroAddress {
		t.Error("PlaidCreditValidator should not be zero")
	}

	t.Logf("Policy: identityRegistry=%s worldIdValidator=%s stripeKYCValidator=%s plaidCreditValidator=%s minCreditScore=%d",
		cfg.IdentityRegistry.Hex(), cfg.WorldIDValidator.Hex(),
		cfg.StripeKYCValidator.Hex(), cfg.PlaidCreditValidator.Hex(), cfg.MinCreditScore)
}

// ─── Cross-SDK consistency: same results as TS SDK ───

func TestCrossSDKConsistency_AgentStatus(t *testing.T) {
	a := connectOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	status, err := a.GetAgentStatus(ctx, existingAgent)
	if err != nil {
		t.Fatalf("GetAgentStatus error: %v", err)
	}

	// These values should match what the TS SDK returns:
	// Agent #1: registered=true, verified=false, tier=1,
	// owner=0x21fdEd74C901129977B8e28C2588595163E1e235
	expectedOwner := common.HexToAddress("0x21fdEd74C901129977B8e28C2588595163E1e235")

	if !status.IsRegistered {
		t.Error("should be registered (TS SDK says true)")
	}
	if status.IsHumanVerified {
		t.Error("should not be verified (TS SDK says false)")
	}
	if status.Tier != 1 {
		t.Errorf("tier = %d, want 1 (TS SDK says 1)", status.Tier)
	}
	if !strings.EqualFold(status.Owner.Hex(), expectedOwner.Hex()) {
		t.Errorf("owner = %s, want %s (TS SDK confirmed)", status.Owner.Hex(), expectedOwner.Hex())
	}
}
