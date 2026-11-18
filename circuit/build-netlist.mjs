// TapeGate — spend-policy circuit builder.
// Builds the spend-authorisation policy as a PURE NAND-gate netlist
// (TapeOut's base primitive: one NAND gate = one transistor).
//
// Policy (6 inputs -> 1 output):
//   OUT = agentOK & budgetOK & notRevoked & windowOK & amountOK & fundedOK
// i.e. a spend is authorised only when every check passes.
// AND(a,b) in NAND-only form: NOT(NAND(a,b)) = NAND(NAND(a,b), NAND(a,b)).
// 6-input AND = 5 x AND2 = 10 NAND gates.
//
// Netlist byte format (TapeGate netlist v1, documented in docs/NETLIST.md):
//   [0x01 version][nInputs u8][nOutputs u8][nGates u8]
//   [gate a u8, gate b u8, gate out u8] * nGates
//   [output signal index u8] * nOutputs
// Signals 0..nInputs-1 are the inputs; gate outputs are assigned the
// sequential signal indices starting at nInputs, in gate order.
// Evaluator semantics are implemented identically in:
//   - agent/circuit.mjs  (off-chain, agent side)
//   - contracts/src/TapeCircuit.sol (on-chain, vault side)
// and cross-checked exhaustively (all 64 input combinations) in tests.
//
// This netlist is the LOGIC of the circuit. The project's on-chain
// TapeOut identity is a separate step: scripts/tapeout-identity.mjs
// tapes out an identity circuit on the official X Layer processor
// TAPELIQUID (0x69f663931209096037474d7c20402232e5c762ca) using the
// official @taperelay/client REF netlist — see docs/TAPEOUT.md.
// The vault records that processor address + circuit id once taped out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INPUTS = ['agentOK', 'budgetOK', 'notRevoked', 'windowOK', 'amountOK', 'fundedOK'];

// Build AND6 from AND2 blocks. sig counter starts after the inputs.
const gates = [];
let nextSig = INPUTS.length;
function and2(a, b) {
  const nandOut = nextSig++;
  gates.push({ op: 'NAND', a, b, out: nandOut });
  const andOut = nextSig++;
  gates.push({ op: 'NAND', a: nandOut, b: nandOut, out: andOut });
  return andOut;
}
let acc = 0;
for (let i = 1; i < INPUTS.length; i++) acc = and2(acc, i);
const OUT_SIG = acc;

// Serialise.
const bytes = [0x01, INPUTS.length, 1, gates.length];
for (const g of gates) bytes.push(g.a, g.b, g.out);
bytes.push(OUT_SIG);
const netlistHex = '0x' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

// Reference evaluator (truth table, all 64 combos).
function evaluate(inputsBits) {
  const sig = new Array(INPUTS.length + gates.length).fill(0);
  for (let i = 0; i < INPUTS.length; i++) sig[i] = (inputsBits >> i) & 1;
  for (const g of gates) sig[g.out] = sig[g.a] && sig[g.b] ? 0 : 1;
  return sig[OUT_SIG];
}
const truthTable = [];
for (let v = 0; v < 64; v++) truthTable.push({ inputs: v, out: evaluate(v) });

const doc = {
  name: 'TapeGate spend-policy circuit',
  version: 1,
  description:
    'OUT = agentOK & budgetOK & notRevoked & windowOK & amountOK & fundedOK, built from 10 NAND gates.',
  inputs: INPUTS,
  outputs: ['authorised'],
  gates,
  outSignal: OUT_SIG,
  netlistHex,
  netlistBytes: bytes.length,
  truthTable,
};

const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'spend-policy.json');
fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${outPath}`);
console.log(`gates=${gates.length} bytes=${bytes.length} netlist=${netlistHex}`);
console.log(`truth table: ${truthTable.filter((t) => t.out === 1).length} of 64 combos authorise (expect 1: only 0b111111)`);
