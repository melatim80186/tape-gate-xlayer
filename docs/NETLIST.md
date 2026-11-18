# TapeGate netlist v1

A TapeGate netlist is a **NAND-only combinational circuit** — TapeOut's base
primitive is the NAND gate (one NAND = one transistor), so any policy can be
expressed this way. The same bytes are evaluated by:

- `agent/circuit.mjs` (off-chain, JS) — what the agent decides on;
- `contracts/src/TapeCircuit.sol` (on-chain, Solidity) — what the vault enforces.

Both are cross-checked exhaustively (all 64 input combinations) in
`contracts/test/TapeGate.t.sol` and `agent/test-local.mjs`.

## Byte format

```
[0x01 version][nInputs u8][nOutputs u8][nGates u8]
[gate a u8, gate b u8, gate out u8] * nGates
[output signal index u8] * nOutputs
```

- Signals `0..nInputs-1` are the inputs (bit `i` of the `inputs` word).
- Gate outputs are assigned sequential signal indices starting at `nInputs`,
  in gate order. Gate `g` must write signal `nInputs + g` and may only read
  signals `< nInputs + g` (no forward references, no cycles).
- Each gate computes `out = NOT (a AND b)`.

## Spend-policy circuit (`circuit/spend-policy.json`)

`OUT = agentOK & budgetOK & notRevoked & windowOK & amountOK & fundedOK`

`AND(a,b)` in NAND-only form is `NOT(NAND(a,b))`, i.e. two gates.
A 6-input AND needs 5 × AND2 = **10 NAND gates**, 35 bytes:

```
0x0106010a00010606060707020808080909030a0a0a0b0b040c0c0c0d0d050e0e0e0f0f
```

| Input bit | Name | Meaning |
|---|---|---|
| 0 | agentOK | agent's own policy checks passed |
| 1 | budgetOK | amount ≤ remaining budget |
| 2 | notRevoked | recipient not on the revoke list |
| 3 | windowOK | now inside [windowStart, windowEnd] |
| 4 | amountOK | amount ≤ per-spend cap |
| 5 | fundedOK | vault balance ≥ amount |

Only `0b111111` (63) authorises. Regenerate with
`node circuit/build-netlist.mjs` (also rebuilds the truth table).

## Relation to TapeOut's own netlist format

TapeOut's on-chain netlist VM uses its own instruction encoding (e.g. opcode
`0x02` = REF, verified from the official `@taperelay/client` source — see
`docs/TAPEOUT.md`). TapeGate's v1 format is deliberately separate and
documented here: it is the *policy logic* the vault evaluates. The project's
on-chain TapeOut identity is a separate, real tapeout on the official X Layer
processor (scripts/tapeout-identity.mjs), not a claim that this byte format
is TapeOut's VM encoding.
