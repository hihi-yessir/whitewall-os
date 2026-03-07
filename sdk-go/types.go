package whitewallos

import (
	"github.com/ethereum/go-ethereum/common"
	"math/big"
)

// AgentStatus is the basic verification status of a Whitewall OS agent.
type AgentStatus struct {
	IsRegistered    bool
	IsHumanVerified bool
	Tier            uint8
	Owner           common.Address
	AgentWallet     common.Address
}

// FullAgentStatus extends AgentStatus with KYC, credit, and effective tier.
type FullAgentStatus struct {
	AgentStatus
	IsKYCVerified bool
	CreditScore   uint8
	EffectiveTier uint8 // 0-4 computed from all verification states
}

// ValidationSummary holds the result of a getSummary call.
type ValidationSummary struct {
	Count    uint64
	AvgScore uint8
}

// ValidationStatus holds the result of a getValidationStatus call.
type ValidationStatus struct {
	ValidatorAddress common.Address
	AgentId          *big.Int
	Response         uint8
	ResponseHash     [32]byte
	Tag              string
	LastUpdate       *big.Int
}

// KYCData holds the result of a getKYCData call.
type KYCData struct {
	Verified   bool
	SessionHash [32]byte
	VerifiedAt *big.Int
}

// CreditData holds the result of a getCreditData call.
type CreditData struct {
	Score      uint8
	DataHash   [32]byte
	VerifiedAt *big.Int
	HasScore   bool
}

// SgxConfig holds the result of a getSgxConfig call.
type SgxConfig struct {
	Verifier  common.Address
	MrEnclave [32]byte
}

// ZeroAddress is the Ethereum zero address.
var ZeroAddress = common.Address{}

// ZeroBigInt is a zero-value *big.Int.
var ZeroBigInt = big.NewInt(0)
