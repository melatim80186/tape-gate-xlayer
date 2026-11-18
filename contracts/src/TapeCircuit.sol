// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TapeCircuit — pure on-chain NAND-netlist evaluator
/// @notice Evaluates a TapeGate netlist v1 (see docs/NETLIST.md) on-chain.
///  A netlist is a NAND-only circuit: TapeOut's base primitive is the NAND
///  gate (one transistor), so any combinational policy can be expressed in
///  this form. The evaluator is deliberately tiny and gas-cheap so the
///  vault can re-check the agent's off-chain evaluation on-chain, with no
///  trust in the agent's computation — only in its signature (see vault).
///
///  Netlist byte format:
///    [0x01 version][nInputs u8][nOutputs u8][nGates u8]
///    [gate a u8, gate b u8, gate out u8] * nGates
///    [output signal index u8] * nOutputs
///  Signals 0..nInputs-1 are inputs (bit i of `inputs`); gate outputs are
///  assigned sequential signal indices starting at nInputs, in gate order.
///  Each gate computes out = NOT (a AND b).
library TapeCircuit {
    error BadNetlist();

    /// @notice Evaluate `netlist` with the low `nInputs` bits of `inputs`.
    /// @return outputs Packed output bits (output j in bit j).
    function evaluate(bytes memory netlist, uint256 inputs) internal pure returns (uint256 outputs) {
        if (netlist.length < 4 || netlist[0] != 0x01) revert BadNetlist();
        uint256 nInputs = uint8(netlist[1]);
        uint256 nOutputs = uint8(netlist[2]);
        uint256 nGates = uint8(netlist[3]);
        if (nInputs == 0 || nInputs > 32 || nOutputs == 0 || nOutputs > 32 || nGates > 64) revert BadNetlist();
        if (netlist.length != 4 + nGates * 3 + nOutputs) revert BadNetlist();

        // Signal values: inputs first, then one slot per gate output.
        uint256[] memory sig = new uint256[](nInputs + nGates);
        for (uint256 i; i < nInputs; i++) sig[i] = (inputs >> i) & 1;

        uint256 p = 4;
        for (uint256 g; g < nGates; g++) {
            uint256 a = uint8(netlist[p]);
            uint256 b = uint8(netlist[p + 1]);
            uint256 o = uint8(netlist[p + 2]);
            p += 3;
            if (a >= nInputs + g || b >= nInputs + g || o != nInputs + g) revert BadNetlist();
            sig[o] = (sig[a] == 1 && sig[b] == 1) ? 0 : 1;
        }
        for (uint256 j; j < nOutputs; j++) {
            uint256 o = uint8(netlist[p + j]);
            if (o >= nInputs + nGates) revert BadNetlist();
            if (sig[o] == 1) outputs |= (1 << j);
        }
    }

    /// @notice keccak256 of a netlist — the circuit's content address.
    function netlistHash(bytes memory netlist) internal pure returns (bytes32) {
        return keccak256(netlist);
    }
}
