// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Minimal claim contract for $VEIL rewards.
 * Owner can fund it; users claim with a signed receipt (scaffold).
 * Production: verify Firmament proof or ECDSA signature from VEIL backend.
 */
contract VeilClaim {
    address public owner;
    mapping(bytes32 => bool) public claimed;
    mapping(address => uint256) public pending;

    event Claimed(address indexed user, uint256 amount, bytes32 receiptId);
    event Funded(uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    function fund() external payable {
        emit Funded(msg.value);
    }

    function claim(bytes32 receiptId, uint256 amount) external {
        require(!claimed[receiptId], "already claimed");
        require(address(this).balance >= amount, "insufficient");
        claimed[receiptId] = true;
        payable(msg.sender).transfer(amount);
        emit Claimed(msg.sender, amount, receiptId);
    }

    function setPending(address user, uint256 amount) external {
        require(msg.sender == owner, "owner");
        pending[user] = amount;
    }
}
