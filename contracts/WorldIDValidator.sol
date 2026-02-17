                                                                                          
// SPDX-License-Identifier: MIT                                                            
pragma solidity ^0.8.20;                                                                   
                                                                                            
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";                
                                                                                            
/// @notice WorldID 검증 인터페이스 (Worldcoin 공식)                                       
interface IWorldID {                                                                       
    function verifyProof(                                                                  
        uint256 root,                                                                      
        uint256 groupId, //어떤 증명인지. ex)1: Worldcoin Orb(홍채)                                                                 
        uint256 signalHash,                                                                
        uint256 nullifierHash,                                                             
        uint256 externalNullifierHash,                                                     
        uint256[8] calldata proof                                                          
    ) external view;                                                                       
}                                                                                          
                                                                                            
/// @notice IdentityRegistry 인터페이스                                                    
interface IIdentityRegistry {                                                              
    function ownerOf(uint256 tokenId) external view returns (address);                     
    function getApproved(uint256 tokenId) external view returns (address);                 
    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external;                                                                   
    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory);                                                                            
} 

/// @title WorldIDValidator                                                                
/// @notice WorldID 증명을 검증하고 IdentityRegistry에 "humanVerified" 메타데이터를 설정
/// @dev Agent 소유자가 이 컨트랙트를 approve 해야 setMetadata 호출 가능
contract WorldIDValidator is OwnableUpgradeable, UUPSUpgradeable {
    using Strings for uint256;                                                                                             
    // ============ Events ============                                                                                                                                           
    event HumanVerified(
        uint256 indexed agentId, //검증된 agent ID
        address indexed verifiedBy, //                                                     
        uint256 nullifierHash,
        uint256 timestamp                                                                  
    );
    event VerificationRevoked(
        uint256 indexed agentId,
        address indexed revokedBy,
        uint256 timestamp
    );                                                                                                                                                                            
    // ============ Errors ============                                                                                                                  
    error InvalidProof();                                                                  
    error AlreadyVerified(uint256 agentId);                                             
    error NullifierAlreadyUsed(uint256 nullifierHash);
    error NotApproved(uint256 agentId);                                                    
    error NotAgentOwner(uint256 agentId);                                                  
    error NotVerified(uint256 agentId);                                                    
                                                                                        
    // ============ Constants ============                                                                                                                                
    string public constant METADATA_KEY = "humanVerified";                                 
    uint256 public constant GROUP_ID = 1; // Worldcoin Orb verification group              
                                                                                            
    // ============ Storage ============
    /// @custom:storage-location erc7201:worldid.validator                                 
    struct WorldIDValidatorStorage {                                                       
        address worldIdRouter;      // WorldID 라우터 컨트랙트 주소                        
        address identityRegistry;   // ERC-8004 IdentityRegistry 주소                      
        uint256 externalNullifier;  // 이 앱의 고유 식별자
        // nullifierHash => 사용 여부 (동일인 재검증 방지)                                 
        mapping(uint256 => bool) nullifierUsed;
        // nullifierHash => agentId (어떤 agent가 이 nullifier 사용했는지)                 
        mapping(uint256 => uint256) nullifierToAgent; //이걸 Policy 더블체크 하자요
        // agentId => 검증 정보
        mapping(uint256 => VerificationData) verifications;
        // V2: per-agent external nullifier support
        uint256 appIdHash;          // hashToField(appId) — stored for per-agent nullifier computation
        string actionPrefix;        // e.g. "verify-owner-" — concatenated with agentId for per-agent action
    }                                                                                      
                                                                                            
    struct VerificationData {                                                              
        bool isVerified;                                                                   
        uint256 nullifierHash;
        uint256 verifiedAt;                                                                
        address verifiedBy; // 검증 요청한 주소 (agent 소유자)
    }
    // keccak256(abi.encode(uint256(keccak256("worldid.validator")) - 1)) & ~bytes32(uint256(0xff)) 
    bytes32 private constant STORAGE_LOCATION = 0x8a0c9d8ec1d9f8b3c4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7800;

    function _getStorage() private pure returns (WorldIDValidatorStorage storage $) {      
        assembly {                                                                         
            $.slot := STORAGE_LOCATION                                                     
        }                                                                                  
    }                                                                                      
                                                                                            
    // ============ Constructor & Initializer ============         
    /// @custom:oz-upgrades-unsafe-allow constructor                                       
    constructor() {                                                                        
        _disableInitializers();                                                            
    }                                                                                      

    /// @notice 컨트랙트 초기화                                                            
    /// @param worldIdRouter_ WorldID 라우터 주소                                          
    /// @param identityRegistry_ ERC-8004 IdentityRegistry 주소                            
    /// @param appId_ 내 프론트 app의 고유 ID (external nullifier 생성용)                          
    /// @param actionId_ 내 프론트 액션의 고유 ID                                                 
    function initialize(                                                                   
        address worldIdRouter_,
        address identityRegistry_,
        string calldata appId_,
        string calldata actionId_
    ) public initializer {
          __Ownable_init(msg.sender);
          __UUPSUpgradeable_init();

          require(worldIdRouter_ != address(0), "Invalid WorldID router");
          require(identityRegistry_ != address(0), "Invalid IdentityRegistry");
      
          WorldIDValidatorStorage storage $ = _getStorage();                                 
          $.worldIdRouter = worldIdRouter_;                                                  
          $.identityRegistry = identityRegistry_;                                            
            
          // external nullifier = hashToField(abi.encodePacked(hashToField(appId), actionId))
          // Must match World ID's ByteHasher.hashToField pattern (keccak256 >> 8)
          uint256 appIdHash = uint256(keccak256(abi.encodePacked(appId_))) >> 8;
          $.externalNullifier = uint256(keccak256(abi.encodePacked(appIdHash, actionId_))) >> 8;
    }

    /// @notice V2 migration: enable per-agent external nullifiers
    /// @dev Call once after upgrading to V1.2.0. Stores appIdHash and actionPrefix
    ///      so the contract can compute per-agent external nullifiers matching the frontend.
    /// @param appId_ Same app ID used in initialize (e.g. "app_staging_dae27f9b14a30e0e0917797aceac795a")
    /// @param actionPrefix_ Action prefix (e.g. "verify-owner-") — agentId is appended at runtime
    function initializeV2(
        string calldata appId_,
        string calldata actionPrefix_
    ) public reinitializer(2) {
        WorldIDValidatorStorage storage $ = _getStorage();
        $.appIdHash = uint256(keccak256(abi.encodePacked(appId_))) >> 8;
        $.actionPrefix = actionPrefix_;
    }

    // ============ Main Functions ============                                            

    /// @notice WorldID 증명을 검증하고 agent에 humanVerified 태그 설정 
    /// @dev 호출 전에 agent 소유자가 이 컨트랙트를 approve 해야 함 
    /// @param agentId 검증할 agent ID 
    /// @param root Merkle tree root  (fe 준비)
    /// @param nullifierHash 고유 nullifier (동일인 재검증 방지) (fe 준비)
    /// @param proof ZK proof 배열  (fe 준비)
    function verifyAndSetHumanTag(
      uint256 agentId,
      uint256 root,
      uint256 nullifierHash,
      uint256[8] calldata proof
    ) external {
        WorldIDValidatorStorage storage $ = _getStorage();                                 
        IIdentityRegistry registry = IIdentityRegistry($.identityRegistry);                

        // 1. 권한 체크: 이 컨트랙트가 해당 agent에 대해 approved 되어있는지               
        if (registry.getApproved(agentId) != address(this)) {                              
            revert NotApproved(agentId);                                                   
        }                                   
        // 2. 호출자가 agent 소유자인지 확인                                               
        address agentOwner = registry.ownerOf(agentId);                                    
        if (msg.sender != agentOwner) {                                                    
            revert NotAgentOwner(agentId);                                                 
        }
        // 3. 이미 검증된 agent인지 확인                                                   
        if ($.verifications[agentId].isVerified) {                                         
            revert AlreadyVerified(agentId);                                               
        }                                                                                  
        // 4. nullifier 재사용 방지 (per-agent nullifier — 같은 사람이 같은 agent 재검증 불가)
        if ($.nullifierUsed[nullifierHash]) {
            revert NullifierAlreadyUsed(nullifierHash);
        }
        // 5. signal = agent 소유자 주소 (검증 대상 바인딩)
        // Must use hashToField (>> 8) to match World ID's ZK circuit
        uint256 signalHash = uint256(keccak256(abi.encodePacked(agentOwner))) >> 8;
        // 6. Compute per-agent external nullifier:
        //    hashToField(abi.encodePacked(appIdHash, actionPrefix + agentId.toString()))
        //    This matches frontend IDKitWidget action="verify-owner-{agentId}"
        uint256 extNullifier;
        if ($.appIdHash != 0) {
            // V2: per-agent nullifier
            string memory action = string(abi.encodePacked($.actionPrefix, agentId.toString()));
            extNullifier = uint256(keccak256(abi.encodePacked($.appIdHash, action))) >> 8;
        } else {
            // V1 fallback: global nullifier (for agents verified before upgrade)
            extNullifier = $.externalNullifier;
        }
        // 7. WorldID 증명 검증 (실패시 revert)
        try IWorldID($.worldIdRouter).verifyProof(
            root,
            GROUP_ID,
            signalHash,
            nullifierHash,
            extNullifier,
            proof
        ) {                                                                                
            // 검증 성공                                                                   
        } catch {                                                                          
            revert InvalidProof();                                                         
        }                                                                                  
                                                                                            
        // 7. nullifier 사용 기록                                                          
        $.nullifierUsed[nullifierHash] = true;                                             
        $.nullifierToAgent[nullifierHash] = agentId;                                       
                                                                                            
        // 8. 검증 정보 저장                                                               
        $.verifications[agentId] = VerificationData({                                      
            isVerified: true,                                                              
            nullifierHash: nullifierHash,                                                  
            verifiedAt: block.timestamp,                                                   
            verifiedBy: msg.sender                       
        });                                                                                
                                                                                            
        // 9. IdentityRegistry에 넣을 메타데이터 설정                                           
        bytes memory metadataValue = abi.encode(
            true,               // humanVerified 값
            address(this),      // 검증한 컨트랙트 주소                                    
            nullifierHash,      // WorldID nullifier                                       
            block.timestamp,    // 검증 시점                                               
            msg.sender          // 검증 요청자                                             
        );    
        registry.setMetadata(agentId, METADATA_KEY, metadataValue);                        
                                                                                            
        // 10. 이벤트 발생                                                                 
        emit HumanVerified(agentId, msg.sender, nullifierHash, block.timestamp);           
    }                                                                                      
                                                                                          
    /// @notice 검증 취소 (agent 소유자만 가능)                                            
    /// @dev 메타데이터를 빈 값으로 설정하고 내부 상태도 초기화                            
    /// @param agentId 검증 취소할 agent ID                                                
    function revokeVerification(uint256 agentId) external {                                
        WorldIDValidatorStorage storage $ = _getStorage();                                 
        IIdentityRegistry registry = IIdentityRegistry($.identityRegistry);                

        // 권한 체크                                                                       
        address agentOwner = registry.ownerOf(agentId);                                    
        if (msg.sender != agentOwner) {                                                    
            revert NotAgentOwner(agentId);                                                 
        }

        // 검증된 상태인지 확인                                                            
        if (!$.verifications[agentId].isVerified) {                                        
            revert NotVerified(agentId);                                                   
        }                                                                                  
                                                                                            
        // approve 체크 (메타데이터 수정 위해 필요)                                        
        if (registry.getApproved(agentId) != address(this)) {                              
            revert NotApproved(agentId);                                                   
        }                                                                                  
                                                                                            
        // nullifier 재사용 허용 (선택적 - 보안 정책에 따라)                               
        // 주의: 이걸 활성화하면 동일인이 다른 agent로 재검증 가능                         
        // uint256 nullifierHash = $.verifications[agentId].nullifierHash;                 
        // $.nullifierUsed[nullifierHash] = false;                                         

        // 검증 상태 초기화                                                                
        $.verifications[agentId].isVerified = false;                                                               
        // 메타데이터 제거                                                                 
        registry.setMetadata(agentId, METADATA_KEY, bytes(""));                            

        emit VerificationRevoked(agentId, msg.sender, block.timestamp);                    
    }                                                                                      
                                                                                            
    // ============ View Functions ============                                            
                                                                                            
    /// @notice agent가 human verified 인지 확인                                           
    function isHumanVerified(uint256 agentId) external view returns (bool) {               
        return _getStorage().verifications[agentId].isVerified;                            
    }                                                                                      
                                                                                            
    /// @notice agent의 검증 정보 조회                                                     
    function getVerificationData(uint256 agentId) external view returns (                  
        bool isVerified,                                                                   
        uint256 nullifierHash,                                                             
        uint256 verifiedAt,                                                                
        address verifiedBy                                                                 
    ) {                                                                                    
        VerificationData memory data = _getStorage().verifications[agentId];               
        return (data.isVerified, data.nullifierHash, data.verifiedAt, data.verifiedBy);    
    }                                                                                      
                                                                                            
    /// @notice nullifier가 이미 사용되었는지 확인                                         
    function isNullifierUsed(uint256 nullifierHash) external view returns (bool) {         
        return _getStorage().nullifierUsed[nullifierHash];                                 
    }                                                                                      
                                                                                            
    /// @notice nullifier를 사용한 agentId 조회                                            
    function getAgentByNullifier(uint256 nullifierHash) external view returns (uint256) {  
        return _getStorage().nullifierToAgent[nullifierHash];                              
    }                                                                                      
                                                                                            
    /// @notice 컨트랙트 설정 정보 조회                                                    
    function getConfig() external view returns (                                           
        address worldIdRouter,                                                             
        address identityRegistry,                                                          
        uint256 externalNullifier                                                          
    ) {                                                                                    
        WorldIDValidatorStorage storage $ = _getStorage();                                 
        return ($.worldIdRouter, $.identityRegistry, $.externalNullifier);                 
    }                                                                                      
                                                                                            
    // ============ Admin Functions ============                                           
                                                                                            
    /// @notice WorldID 라우터 주소 변경 (업그레이드 대비)                                 
    function setWorldIdRouter(address newRouter) external onlyOwner {                      
        require(newRouter != address(0), "Invalid address");                               
        _getStorage().worldIdRouter = newRouter;                                           
    }                                                                                      
                                                                                            
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}   
                                                                                            
    function getVersion() external pure returns (string memory) {                          
        return "1.2.0";                                                                    
    }                                                                                      
}             