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
		PolicyEngine:         common.HexToAddress("0x12816c0c79981726627a550b73e9627b81be95be"),
		TieredPolicy:         common.HexToAddress("0x63b4d2e051180c3c0313eb71a9bdda8554432e23"),
		WhitewallConsumer:    common.HexToAddress("0xb5845901c590f06ffa480c31b96aca7eff4dfb3e"),
		StripeKYCValidator:   common.HexToAddress("0x12b456dcc0e669eeb1d96806c8ef87b713d39cc8"),
		PlaidCreditValidator: common.HexToAddress("0x9a0ed706f1714961bf607404521a58decddc2636"),
	},
}
