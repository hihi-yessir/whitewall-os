package whitewallos

import (
	"github.com/ethereum/go-ethereum/accounts/abi"
	"strings"
)

// ABI JSON strings for contract interactions.
// Only includes the functions the SDK actually calls.

const tieredPolicyABIJSON = `[
	{"inputs":[],"name":"getIdentityRegistry","outputs":[{"name":"","type":"address"}],"stateMutability":"view","type":"function"},
	{"inputs":[],"name":"getWorldIdValidator","outputs":[{"name":"","type":"address"}],"stateMutability":"view","type":"function"},
	{"inputs":[],"name":"getStripeKYCValidator","outputs":[{"name":"","type":"address"}],"stateMutability":"view","type":"function"},
	{"inputs":[],"name":"getPlaidCreditValidator","outputs":[{"name":"","type":"address"}],"stateMutability":"view","type":"function"},
	{"inputs":[],"name":"getMinCreditScore","outputs":[{"name":"","type":"uint8"}],"stateMutability":"view","type":"function"}
]`

const identityRegistryABIJSON = `[
	{"inputs":[{"name":"tokenId","type":"uint256"}],"name":"ownerOf","outputs":[{"name":"","type":"address"}],"stateMutability":"view","type":"function"},
	{"inputs":[{"name":"agentId","type":"uint256"}],"name":"getAgentWallet","outputs":[{"name":"","type":"address"}],"stateMutability":"view","type":"function"},
	{"inputs":[{"name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
	{"inputs":[{"name":"tokenId","type":"uint256"}],"name":"tokenURI","outputs":[{"name":"","type":"string"}],"stateMutability":"view","type":"function"},
	{"inputs":[{"name":"agentId","type":"uint256"},{"name":"metadataKey","type":"string"}],"name":"getMetadata","outputs":[{"name":"","type":"bytes"}],"stateMutability":"view","type":"function"}
]`

const validationRegistryABIJSON = `[
	{"inputs":[{"name":"agentId","type":"uint256"},{"name":"validatorAddresses","type":"address[]"},{"name":"tag","type":"string"}],"name":"getSummary","outputs":[{"name":"count","type":"uint64"},{"name":"avgResponse","type":"uint8"}],"stateMutability":"view","type":"function"},
	{"inputs":[{"name":"agentId","type":"uint256"}],"name":"getAgentValidations","outputs":[{"name":"","type":"bytes32[]"}],"stateMutability":"view","type":"function"}
]`

const worldIDValidatorABIJSON = `[
	{"inputs":[{"name":"agentId","type":"uint256"}],"name":"isHumanVerified","outputs":[{"name":"","type":"bool"}],"stateMutability":"view","type":"function"}
]`

const stripeKYCValidatorABIJSON = `[
	{"inputs":[{"name":"agentId","type":"uint256"}],"name":"isKYCVerified","outputs":[{"name":"","type":"bool"}],"stateMutability":"view","type":"function"}
]`

const plaidCreditValidatorABIJSON = `[
	{"inputs":[{"name":"agentId","type":"uint256"}],"name":"getCreditScore","outputs":[{"name":"","type":"uint8"}],"stateMutability":"view","type":"function"}
]`

var (
	TieredPolicyABI        abi.ABI
	IdentityRegistryABI    abi.ABI
	ValidationRegistryABI  abi.ABI
	WorldIDValidatorABI    abi.ABI
	StripeKYCValidatorABI  abi.ABI
	PlaidCreditValidatorABI abi.ABI
)

func init() {
	var err error
	TieredPolicyABI, err = abi.JSON(strings.NewReader(tieredPolicyABIJSON))
	if err != nil {
		panic("failed to parse TieredPolicy ABI: " + err.Error())
	}
	IdentityRegistryABI, err = abi.JSON(strings.NewReader(identityRegistryABIJSON))
	if err != nil {
		panic("failed to parse IdentityRegistry ABI: " + err.Error())
	}
	ValidationRegistryABI, err = abi.JSON(strings.NewReader(validationRegistryABIJSON))
	if err != nil {
		panic("failed to parse ValidationRegistry ABI: " + err.Error())
	}
	WorldIDValidatorABI, err = abi.JSON(strings.NewReader(worldIDValidatorABIJSON))
	if err != nil {
		panic("failed to parse WorldIDValidator ABI: " + err.Error())
	}
	StripeKYCValidatorABI, err = abi.JSON(strings.NewReader(stripeKYCValidatorABIJSON))
	if err != nil {
		panic("failed to parse StripeKYCValidator ABI: " + err.Error())
	}
	PlaidCreditValidatorABI, err = abi.JSON(strings.NewReader(plaidCreditValidatorABIJSON))
	if err != nil {
		panic("failed to parse PlaidCreditValidator ABI: " + err.Error())
	}
}
