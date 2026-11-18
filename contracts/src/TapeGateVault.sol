// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TapeCircuit} from "./TapeCircuit.sol";

/// @title TapeGateVault — a treasury whose spends must pass a NAND-gate circuit
/// @notice X Layer (chain 196) x TapeOut Accelerate entry.
///
///  Every spend is authorised TWICE, independently:
///   1. Off-chain, the TapeGate agent evaluates the same NAND netlist and
///      signs the decision with its ECDSA key (see agent/server.mjs).
///   2. On-chain, this vault recomputes the circuit inputs from live chain
///      state and re-evaluates the registered netlist on them. The agent's
///      signature only asserts bit 0 (agentOK); the budget / revoke /
///      window / cap / balance bits come from the chain, never from the caller.
///
///  Spend-policy circuit inputs (bit i of `inputs`, see circuit/):
///    bit 0 agentOK     — agent's own policy checks passed
///    bit 1 budgetOK    — amount <= remaining budget
///    bit 2 notRevoked  — recipient not on the revoke list
///    bit 3 windowOK    — block.timestamp inside [windowStart, windowEnd]
///    bit 4 amountOK    — amount <= per-spend cap
///    bit 5 fundedOK    — vault balance >= amount
///  OUT = AND of all six (10 NAND gates). Only 0b111111 authorises.
///
///  TapeOut link: the project tapes out an identity circuit on the official
///  X Layer processor TAPELIQUID (0x69F663931209096037474d7C20402232E5C762cA,
///  processor #265 in the TapeOut factory) — see scripts/tapeout-identity.mjs
///  and docs/TAPEOUT.md. The vault records that processor + circuit id
///  (setTapeoutCircuit) so the submission's "processor contract address and
///  circuit ID" fields point at a real on-chain TapeOut circuit. Until the
///  tapeout is done (it needs a funded wallet, ~0.025 OKB + gas), the id is
///  0 and the vault still works — the circuit logic itself lives here.
contract TapeGateVault {
    using TapeCircuit for bytes;

    address public owner;
    address public agent; // ECDSA signer of agent decisions
    bool public paused;

    // Spend policy.
    bytes public netlist;
    bytes32 public netlistHash;
    uint256 public budgetCap; // max total spendable (wei OKB)
    uint256 public perSpendCap; // max per spend (wei OKB)
    uint256 public windowStart;
    uint256 public windowEnd;
    uint256 public spentTotal;
    mapping(address => bool) public revoked;
    mapping(bytes32 => bool) public usedRequestIds;

    // TapeOut identity (official X Layer processor + our circuit on it).
    address public constant TAPEOUT_PROCESSOR = 0x69F663931209096037474d7C20402232E5C762cA; // TAPELIQUID, #265
    address public constant TAPEOUT_OPENER = 0x536adD8F30f03b69f6fbF29d425A816A0dC50106; // container opener
    uint256 public tapeoutCircuitId; // 0 until scripts/tapeout-identity.mjs runs

    event CircuitRegistered(bytes32 indexed netlistHash, uint256 nGates);
    event TapeoutCircuitSet(uint256 indexed circuitId);
    event AgentSet(address indexed agent);
    event Paused(bool paused);
    event Revoked(address indexed account, bool revoked);
    event Deposited(address indexed from, uint256 amount);
    event SpendExecuted(bytes32 indexed requestId, address indexed recipient, uint256 amount, uint256 inputs);
    event SpendRejected(bytes32 indexed requestId, string reason);

    error NotOwner();
    error CircuitNotRegistered();
    error CircuitRejected();
    error BadSignature();
    error Replay();
    error Expired();
    error PausedVault();
    error InsufficientBalance();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _agent, uint256 _budgetCap, uint256 _perSpendCap, uint256 _windowStart, uint256 _windowEnd) {
        owner = msg.sender;
        agent = _agent;
        budgetCap = _budgetCap;
        perSpendCap = _perSpendCap;
        windowStart = _windowStart;
        windowEnd = _windowEnd;
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function deposit() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Register the spend-policy netlist (owner only). Replaces any previous one.
    function registerCircuit(bytes calldata _netlist) external onlyOwner {
        // Sanity-evaluate the policy shape: all-zero inputs must NOT
        // authorise, all-ones inputs MUST authorise.
        if (_netlist.evaluate(0) != 0) revert TapeCircuit.BadNetlist();
        uint256 allOnes = (1 << uint8(_netlist[1])) - 1;
        if (_netlist.evaluate(allOnes) != 1) revert TapeCircuit.BadNetlist();
        netlist = _netlist;
        netlistHash = _netlist.netlistHash();
        emit CircuitRegistered(netlistHash, uint8(_netlist[3]));
    }

    function setAgent(address _agent) external onlyOwner {
        agent = _agent;
        emit AgentSet(_agent);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    function setRevoked(address account, bool _revoked) external onlyOwner {
        revoked[account] = _revoked;
        emit Revoked(account, _revoked);
    }

    /// @notice Record the TapeOut circuit id taped out on TAPELIQUID (owner only).
    function setTapeoutCircuit(uint256 circuitId) external onlyOwner {
        tapeoutCircuitId = circuitId;
        emit TapeoutCircuitSet(circuitId);
    }

    /// @notice The 6 circuit inputs for a spend, computed from live state.
    ///  The vault ALWAYS recomputes these itself in executeSpend — a caller
    ///  can never smuggle in favourable inputs. Bit 0 (agentOK) is asserted
    ///  by the agent's signature, which is what the signature is for.
    function buildInputs(address recipient, uint256 amount, bool agentOK) public view returns (uint256 inputs) {
        if (agentOK) inputs |= 1 << 0;
        if (spentTotal + amount <= budgetCap) inputs |= 1 << 1;
        if (!revoked[recipient]) inputs |= 1 << 2;
        if (block.timestamp >= windowStart && block.timestamp <= windowEnd) inputs |= 1 << 3;
        if (amount <= perSpendCap) inputs |= 1 << 4;
        if (address(this).balance >= amount) inputs |= 1 << 5;
    }

    /// @notice Decision hash the agent signs (EIP-191 personal-sign prefix).
    function decisionHash(bytes32 requestId, address recipient, uint256 amount, uint256 inputs, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 h = keccak256(abi.encodePacked(block.chainid, address(this), requestId, recipient, amount, inputs, deadline));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
    }

    /// @notice Execute a spend authorised by the circuit AND the agent's signature.
    ///  The vault recomputes the circuit inputs from LIVE state itself
    ///  (buildInputs) — the agent's signature only asserts bit 0 (agentOK).
    ///  A compromised agent can sign anything, but it cannot fake the
    ///  budget / revoke / window / cap / balance bits: those come from the
    ///  chain, and the circuit blocks the spend if any of them is 0.
    function executeSpend(bytes32 requestId, address recipient, uint256 amount, uint256 deadline, bytes calldata agentSig)
        external
    {
        if (paused) revert PausedVault();
        if (netlist.length == 0) revert CircuitNotRegistered();
        if (usedRequestIds[requestId]) revert Replay();
        if (block.timestamp > deadline) revert Expired();
        if (amount > address(this).balance) revert InsufficientBalance();

        uint256 inputs = buildInputs(recipient, amount, true);
        // 1. On-chain circuit check on live-state inputs.
        if (TapeCircuit.evaluate(netlist, inputs) != 1) {
            emit SpendRejected(requestId, "circuit");
            revert CircuitRejected();
        }
        // 2. Agent signature check over the same computed inputs.
        address signer = ecrecover(decisionHash(requestId, recipient, amount, inputs, deadline), _v(agentSig), _r(agentSig), _s(agentSig));
        if (signer != agent) {
            emit SpendRejected(requestId, "signature");
            revert BadSignature();
        }

        usedRequestIds[requestId] = true;
        spentTotal += amount;
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "transfer failed");
        emit SpendExecuted(requestId, recipient, amount, inputs);
    }

    function _v(bytes calldata sig) internal pure returns (uint8) {
        return uint8(sig[64]);
    }

    function _r(bytes calldata sig) internal pure returns (bytes32) {
        return bytes32(sig[0:32]);
    }

    function _s(bytes calldata sig) internal pure returns (bytes32) {
        return bytes32(sig[32:64]);
    }
}
