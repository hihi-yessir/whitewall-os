// SPDX-License-Identifier: MIT                                                                      
pragma solidity ^0.8.20;                                                                             
                                                                                                      
contract MockWorldID {                                                                               
    bool public shouldPass = true;                                                                   
                                                                                                      
    function setShouldPass(bool _shouldPass) external {                                              
        shouldPass = _shouldPass;                                                                    
    }                                                                                                
                                                                                                      
    function verifyProof(                                                                            
        uint256,                                                                                     
        uint256,                                                                                     
        uint256,                                                                                     
        uint256,                                                                                     
        uint256,                                                                                     
        uint256[8] calldata                                                                          
    ) external view {                                                                                
        require(shouldPass, "MockWorldID: verification failed");                                     
    }                                                                                                
}                       