package whitewallos

import "github.com/ethereum/go-ethereum/common"

// ChainName identifies a supported chain.
type ChainName string

const (
	BaseSepolia ChainName = "baseSepolia"
)

// Addresses holds the protocol entry points for a chain.
// Mirrors the TS SDK addresses.ts — includes policy engine,
// tiered policy, consumer, and validator contract addresses.
type Addresses struct {
	PolicyEngine         common.Address
	TieredPolicy         common.Address
	WhitewallConsumer    common.Address
	StripeKYCValidator   common.Address
	PlaidCreditValidator common.Address
}

// PolicyConfig holds the protocol configuration read from the
// on-chain TieredPolicy contract. The SDK reads these at connect
// time so it mirrors the actual ACE pipeline.
type PolicyConfig struct {
	IdentityRegistry     common.Address
	WorldIDValidator     common.Address
	StripeKYCValidator   common.Address
	PlaidCreditValidator common.Address
	MinCreditScore       uint8
}

// ChainRPC maps chain names to their default public RPC endpoints.
var ChainRPC = map[ChainName]string{
	BaseSepolia: "https://sepolia.base.org",
}

// ChainAddresses maps chain names to their deployed protocol addresses.
var ChainAddresses = map[ChainName]Addresses{
	BaseSepolia: {
		PolicyEngine:         common.HexToAddress("0xc7afccc4b97786e34c07e4444496256d2f2b0b9a"),
		TieredPolicy:         common.HexToAddress("0xdb20a5d22cc7eb2a43628527667021121e80e30d"),
		WhitewallConsumer:    common.HexToAddress("0x9670cc85a97c07a1bb6353fb968c6a2c153db99f"),
		StripeKYCValidator:   common.HexToAddress("0xebba79075ad00a22c5ff9a1f36a379f577265936"),
		PlaidCreditValidator: common.HexToAddress("0x07e8653b55a3cd703106c9726a140755204c1ad5"),
	},
}
