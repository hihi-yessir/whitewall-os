// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Mock forwarder that can call onReport on any target
contract MockForwarder {
    function forwardReport(address target, bytes calldata metadata, bytes calldata report) external {
        (bool success, bytes memory returnData) = target.call(
            abi.encodeWithSignature("onReport(bytes,bytes)", metadata, report)
        );
        if (!success) {
            // Bubble up the revert reason
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }
    }
}
