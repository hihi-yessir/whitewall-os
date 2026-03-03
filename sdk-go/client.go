package whitewallos

import (
	"context"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

// WhitewallOS is the main SDK client. Create one via Connect().
type WhitewallOS struct {
	client *ethclient.Client
	addrs  Addresses
	policy PolicyConfig
}

// Config holds the configuration for connecting to Whitewall OS.
type Config struct {
	Chain  ChainName
	RPCUrl string // optional override
}

// Connect creates a new WhitewallOS client and reads policy config from chain.
// This mirrors the on-chain TieredPolicy to ensure the SDK
// uses the same registries, validators, and tier requirements as ACE.
func Connect(ctx context.Context, cfg Config) (*WhitewallOS, error) {
	addrs, ok := ChainAddresses[cfg.Chain]
	if !ok {
		return nil, fmt.Errorf("unsupported chain: %s", cfg.Chain)
	}

	rpcUrl := cfg.RPCUrl
	if rpcUrl == "" {
		rpcUrl = ChainRPC[cfg.Chain]
	}

	client, err := ethclient.DialContext(ctx, rpcUrl)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to RPC: %w", err)
	}

	a := &WhitewallOS{client: client, addrs: addrs}
	if err := a.loadPolicyConfig(ctx); err != nil {
		return nil, fmt.Errorf("failed to read policy config from chain: %w", err)
	}

	return a, nil
}

// loadPolicyConfig reads all config values from TieredPolicy.
func (a *WhitewallOS) loadPolicyConfig(ctx context.Context) error {
	addr := a.addrs.TieredPolicy

	identityRegistry, err := a.callAddress(ctx, addr, TieredPolicyABI, "getIdentityRegistry")
	if err != nil {
		return fmt.Errorf("getIdentityRegistry: %w", err)
	}
	worldIdValidator, err := a.callAddress(ctx, addr, TieredPolicyABI, "getWorldIdValidator")
	if err != nil {
		return fmt.Errorf("getWorldIdValidator: %w", err)
	}
	stripeKYCValidator, err := a.callAddress(ctx, addr, TieredPolicyABI, "getStripeKYCValidator")
	if err != nil {
		return fmt.Errorf("getStripeKYCValidator: %w", err)
	}
	plaidCreditValidator, err := a.callAddress(ctx, addr, TieredPolicyABI, "getPlaidCreditValidator")
	if err != nil {
		return fmt.Errorf("getPlaidCreditValidator: %w", err)
	}
	minCreditScore, err := a.callUint8(ctx, addr, TieredPolicyABI, "getMinCreditScore")
	if err != nil {
		return fmt.Errorf("getMinCreditScore: %w", err)
	}

	a.policy = PolicyConfig{
		IdentityRegistry:     identityRegistry,
		WorldIDValidator:     worldIdValidator,
		StripeKYCValidator:   stripeKYCValidator,
		PlaidCreditValidator: plaidCreditValidator,
		MinCreditScore:       minCreditScore,
	}
	return nil
}

// ─── Core Read Methods ───

// IsRegistered checks if an agent exists in the IdentityRegistry.
func (a *WhitewallOS) IsRegistered(ctx context.Context, agentId *big.Int) (bool, error) {
	owner, err := a.GetOwner(ctx, agentId)
	if err != nil {
		return false, nil // ownerOf reverts for non-existent tokens
	}
	return owner != ZeroAddress, nil
}

// IsHumanVerified checks if an agent is human-verified via WorldIDValidator.
func (a *WhitewallOS) IsHumanVerified(ctx context.Context, agentId *big.Int) (bool, error) {
	return a.callBool(ctx, a.policy.WorldIDValidator, WorldIDValidatorABI, "isHumanVerified", agentId)
}

// IsKYCVerified checks if an agent has passed Stripe KYC verification.
func (a *WhitewallOS) IsKYCVerified(ctx context.Context, agentId *big.Int) (bool, error) {
	if a.policy.StripeKYCValidator == ZeroAddress {
		return false, nil
	}
	verified, err := a.callBool(ctx, a.policy.StripeKYCValidator, StripeKYCValidatorABI, "isKYCVerified", agentId)
	if err != nil {
		return false, nil
	}
	return verified, nil
}

// GetCreditScore returns the Plaid credit score for an agent.
func (a *WhitewallOS) GetCreditScore(ctx context.Context, agentId *big.Int) (uint8, error) {
	if a.policy.PlaidCreditValidator == ZeroAddress {
		return 0, nil
	}
	score, err := a.callUint8(ctx, a.policy.PlaidCreditValidator, PlaidCreditValidatorABI, "getCreditScore", agentId)
	if err != nil {
		return 0, nil
	}
	return score, nil
}

// GetOwner returns the owner address of an agent NFT.
func (a *WhitewallOS) GetOwner(ctx context.Context, agentId *big.Int) (common.Address, error) {
	return a.callAddress(ctx, a.policy.IdentityRegistry, IdentityRegistryABI, "ownerOf", agentId)
}

// GetAgentWallet returns the operating wallet address of an agent.
func (a *WhitewallOS) GetAgentWallet(ctx context.Context, agentId *big.Int) (common.Address, error) {
	return a.callAddress(ctx, a.policy.IdentityRegistry, IdentityRegistryABI, "getAgentWallet", agentId)
}

// GetTokenURI returns the token URI for an agent.
func (a *WhitewallOS) GetTokenURI(ctx context.Context, agentId *big.Int) (string, error) {
	return a.callString(ctx, a.policy.IdentityRegistry, IdentityRegistryABI, "tokenURI", agentId)
}

// GetMetadata returns metadata bytes for an agent and key.
func (a *WhitewallOS) GetMetadata(ctx context.Context, agentId *big.Int, key string) ([]byte, error) {
	return a.callBytes(ctx, a.policy.IdentityRegistry, IdentityRegistryABI, "getMetadata", agentId, key)
}

// ─── Composite ───

// GetAgentStatus returns the basic verification status of an agent.
func (a *WhitewallOS) GetAgentStatus(ctx context.Context, agentId *big.Int) (*AgentStatus, error) {
	registered, err := a.IsRegistered(ctx, agentId)
	if err != nil {
		return nil, err
	}
	if !registered {
		return &AgentStatus{}, nil
	}

	owner, err := a.GetOwner(ctx, agentId)
	if err != nil {
		return nil, err
	}
	wallet, err := a.GetAgentWallet(ctx, agentId)
	if err != nil {
		return nil, err
	}
	humanVerified, err := a.IsHumanVerified(ctx, agentId)
	if err != nil {
		return nil, err
	}

	tier := uint8(1)
	if humanVerified {
		tier = 2
	}

	return &AgentStatus{
		IsRegistered:    true,
		IsHumanVerified: humanVerified,
		Tier:            tier,
		Owner:           owner,
		AgentWallet:     wallet,
	}, nil
}

// GetFullStatus returns the complete verification status including KYC, credit, and effective tier.
// Mirrors the TS SDK getFullStatus logic.
func (a *WhitewallOS) GetFullStatus(ctx context.Context, agentId *big.Int) (*FullAgentStatus, error) {
	base, err := a.GetAgentStatus(ctx, agentId)
	if err != nil {
		return nil, err
	}
	if !base.IsRegistered {
		return &FullAgentStatus{
			AgentStatus:   *base,
			IsKYCVerified: false,
			CreditScore:   0,
			EffectiveTier: 0,
		}, nil
	}

	kycVerified, err := a.IsKYCVerified(ctx, agentId)
	if err != nil {
		kycVerified = false
	}
	creditScore, err := a.GetCreditScore(ctx, agentId)
	if err != nil {
		creditScore = 0
	}

	// Compute effective tier (cumulative):
	// 0 = not registered, 1 = registered, 2 = human verified,
	// 3 = + KYC, 4 = + credit score
	effectiveTier := base.Tier // 1 or 2
	if base.IsHumanVerified && kycVerified {
		effectiveTier = 3
		minScore := a.policy.MinCreditScore
		if minScore == 0 {
			minScore = 50
		}
		if creditScore >= minScore {
			effectiveTier = 4
		}
	}

	return &FullAgentStatus{
		AgentStatus:   *base,
		IsKYCVerified: kycVerified,
		CreditScore:   creditScore,
		EffectiveTier: effectiveTier,
	}, nil
}

// ─── Utilities ───

// GetPolicyConfig returns the protocol policy config read from chain.
func (a *WhitewallOS) GetPolicyConfig() PolicyConfig {
	return a.policy
}

// GetAddresses returns the protocol entry point addresses.
func (a *WhitewallOS) GetAddresses() Addresses {
	return a.addrs
}

// Close closes the underlying RPC client.
func (a *WhitewallOS) Close() {
	a.client.Close()
}

// ─── Internal helpers ───

func (a *WhitewallOS) callRaw(ctx context.Context, to common.Address, abiDef interface{ Pack(string, ...interface{}) ([]byte, error) }, method string, args ...interface{}) ([]byte, error) {
	data, err := abiDef.Pack(method, args...)
	if err != nil {
		return nil, fmt.Errorf("pack %s: %w", method, err)
	}
	return a.client.CallContract(ctx, ethereum.CallMsg{To: &to, Data: data}, nil)
}

func (a *WhitewallOS) callAddress(ctx context.Context, to common.Address, abiDef interface {
	Pack(string, ...interface{}) ([]byte, error)
	Unpack(string, []byte) ([]interface{}, error)
}, method string, args ...interface{}) (common.Address, error) {
	result, err := a.callRaw(ctx, to, abiDef, method, args...)
	if err != nil {
		return ZeroAddress, err
	}
	unpacked, err := abiDef.Unpack(method, result)
	if err != nil {
		return ZeroAddress, fmt.Errorf("unpack %s: %w", method, err)
	}
	return unpacked[0].(common.Address), nil
}

func (a *WhitewallOS) callBool(ctx context.Context, to common.Address, abiDef interface {
	Pack(string, ...interface{}) ([]byte, error)
	Unpack(string, []byte) ([]interface{}, error)
}, method string, args ...interface{}) (bool, error) {
	result, err := a.callRaw(ctx, to, abiDef, method, args...)
	if err != nil {
		return false, err
	}
	unpacked, err := abiDef.Unpack(method, result)
	if err != nil {
		return false, fmt.Errorf("unpack %s: %w", method, err)
	}
	return unpacked[0].(bool), nil
}

func (a *WhitewallOS) callUint8(ctx context.Context, to common.Address, abiDef interface {
	Pack(string, ...interface{}) ([]byte, error)
	Unpack(string, []byte) ([]interface{}, error)
}, method string, args ...interface{}) (uint8, error) {
	result, err := a.callRaw(ctx, to, abiDef, method, args...)
	if err != nil {
		return 0, err
	}
	unpacked, err := abiDef.Unpack(method, result)
	if err != nil {
		return 0, fmt.Errorf("unpack %s: %w", method, err)
	}
	return unpacked[0].(uint8), nil
}

func (a *WhitewallOS) callString(ctx context.Context, to common.Address, abiDef interface {
	Pack(string, ...interface{}) ([]byte, error)
	Unpack(string, []byte) ([]interface{}, error)
}, method string, args ...interface{}) (string, error) {
	result, err := a.callRaw(ctx, to, abiDef, method, args...)
	if err != nil {
		return "", err
	}
	unpacked, err := abiDef.Unpack(method, result)
	if err != nil {
		return "", fmt.Errorf("unpack %s: %w", method, err)
	}
	return unpacked[0].(string), nil
}

func (a *WhitewallOS) callBytes(ctx context.Context, to common.Address, abiDef interface {
	Pack(string, ...interface{}) ([]byte, error)
	Unpack(string, []byte) ([]interface{}, error)
}, method string, args ...interface{}) ([]byte, error) {
	result, err := a.callRaw(ctx, to, abiDef, method, args...)
	if err != nil {
		return nil, err
	}
	unpacked, err := abiDef.Unpack(method, result)
	if err != nil {
		return nil, fmt.Errorf("unpack %s: %w", method, err)
	}
	return unpacked[0].([]byte), nil
}
