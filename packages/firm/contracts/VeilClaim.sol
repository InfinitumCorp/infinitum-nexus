// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Claim contract for $VEIL rewards.
 * Owner funds it. Users claim with a receiptId + amount.
 * Production path: verify an ECDSA signature or Firmament proof over (receiptId, amount, user).
 */
contract VeilClaim {
    address public owner;
    address public signer; // expected signer of claim receipts
    mapping(bytes32 => bool) public claimed;
    mapping(address => uint256) public pending;

    event Claimed(address indexed user, uint256 amount, bytes32 receiptId);
    event Funded(uint256 amount);
    event SignerUpdated(address indexed signer);

    constructor(address _signer) {
        owner = msg.sender;
        signer = _signer;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "owner");
        _;
    }

    function fund() external payable {
        emit Funded(msg.value);
    }

    function setSigner(address _signer) external onlyOwner {
        signer = _signer;
        emit SignerUpdated(_signer);
    }

    function setPending(address user, uint256 amount) external onlyOwner {
        pending[user] = amount;
    }

    /// @notice Simple claim (no signature). For testing only.
    function claim(bytes32 receiptId, uint256 amount) external {
        require(!claimed[receiptId], "already claimed");
        require(address(this).balance >= amount, "insufficient");
        claimed[receiptId] = true;
        payable(msg.sender).transfer(amount);
        emit Claimed(msg.sender, amount, receiptId);
    }

    /// @notice Claim with a signature over (receiptId, amount, msg.sender).
    /// Signature verification is a scaffold — production should use ecrecover or a proper verifier.
    function claimWithSig(bytes32 receiptId, uint256 amount, bytes calldata /*sig*/) external {
        require(!claimed[receiptId], "already claimed");
        require(address(this).balance >= amount, "insufficient");
        // TODO: bytes32 hash = keccak256(abi.encodePacked(receiptId, amount, msg.sender));
        // TODO: require(recover(hash, sig) == signer, "bad sig");
        claimed[receiptId] = true;
        payable(msg.sender).transfer(amount);
        emit Claimed(msg.sender, amount, receiptId);
    }
}
