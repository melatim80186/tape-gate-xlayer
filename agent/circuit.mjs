// TapeGate circuit evaluator (JS mirror of contracts/src/TapeCircuit.sol).
// Same netlist bytes, same semantics — cross-checked exhaustively in
// contracts/test (Solidity) and agent/test-local.mjs (JS) against the
// truth table in circuit/spend-policy.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const doc = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'circuit', 'spend-policy.json'), 'utf8'),
);

export const CIRCUIT = doc;
export const INPUT_NAMES = doc.inputs;

/** Evaluate the NAND netlist with the low 6 bits of `inputs`. Returns 0/1. */
export function evaluateCircuit(netlistHex, inputs) {
  const b = Buffer.from(netlistHex.slice(2), 'hex');
  if (b.length < 4 || b[0] !== 0x01) throw new Error('bad netlist version');
  const nInputs = b[1];
  const nOutputs = b[2];
  const nGates = b[3];
  if (b.length !== 4 + nGates * 3 + nOutputs) throw new Error('bad netlist length');
  const sig = new Array(nInputs + nGates).fill(0);
  for (let i = 0; i < nInputs; i++) sig[i] = (inputs >> i) & 1;
  let p = 4;
  for (let g = 0; g < nGates; g++) {
    const a = b[p];
    const bb = b[p + 1];
    const o = b[p + 2];
    p += 3;
    if (a >= nInputs + g || bb >= nInputs + g || o !== nInputs + g) throw new Error('bad gate wiring');
    sig[o] = sig[a] === 1 && sig[bb] === 1 ? 0 : 1;
  }
  let out = 0;
  for (let j = 0; j < nOutputs; j++) if (sig[b[p + j]] === 1) out |= 1 << j;
  return out;
}

/** Which input bits are 0 (the failing checks) — for human-readable rejects. */
export function failingInputs(inputs) {
  return INPUT_NAMES.filter((_, i) => ((inputs >> i) & 1) === 0);
}
