// TapeGate agent local test — standalone mode (no vault, no keys).
// Spawns the server on port 18099 and checks:
//  - JS evaluator matches the truth table for all 64 input combos
//  - /health, /circuit, /tapeout (live X Layer RPC read) respond
//  - /decide trap matrix: valid -> APPROVE, each failing bit -> REJECT
//    CIRCUIT_REJECT, replay of an approved id -> REJECT REPLAY,
//    malformed / expired -> REJECT fail-closed
//  - responses carry the HMAC header when AGENT_HMAC_SECRET is set
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CIRCUIT, evaluateCircuit } from './circuit.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18099;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

// 1. Evaluator vs truth table (all 64 combos).
console.log('== evaluator vs truth table ==');
for (const row of CIRCUIT.truthTable) {
  if (evaluateCircuit(CIRCUIT.netlistHex, row.inputs) !== row.out) {
    check(`inputs=${row.inputs}`, false, `expected ${row.out}`);
  }
}
check('all 64 combos match truth table', fail === 0);

// 2. Spawn server (standalone, HMAC secret set for the header check).
console.log('== server ==');
fs.writeFileSync(path.join(DIR, 'seen.json'), '[]\n');
const proc = spawn('node', ['server.mjs'], {
  cwd: DIR,
  env: { ...process.env, PORT: String(PORT), AGENT_HMAC_SECRET: 'test-secret' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const waitFor = async (fn, timeoutMs = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};
const up = await waitFor(async () => (await fetch(`${BASE}/health`)).ok);
check('server starts', up);
if (!up) { console.log(proc.stderr?.toString?.() || ''); process.exit(1); }

const get = async (p) => { const r = await fetch(`${BASE}${p}`); return { status: r.status, hmac: r.headers.get('x-tapegate-signature'), body: await r.json() }; };
const post = async (p, obj) => {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  return { status: r.status, hmac: r.headers.get('x-tapegate-signature'), body: await r.json() };
};

const health = await get('/health');
check('health ok + standalone mode', health.body.ok === true && health.body.mode === 'standalone', JSON.stringify(health.body));
check('HMAC header present (bare hex)', /^[0-9a-f]{64}$/.test(health.hmac || ''), String(health.hmac));

const circ = await get('/circuit');
check('circuit endpoint returns netlist', circ.body.netlistHex === CIRCUIT.netlistHex && circ.body.gates === 10, JSON.stringify(circ.body).slice(0, 120));

let tp = await get('/tapeout');
// The public X Layer RPC occasionally times out once; retry a single time.
if (!tp.body.tapeoutFeeWei) { await new Promise((r) => setTimeout(r, 2000)); tp = await get('/tapeout'); }
check('tapeout endpoint reads live X Layer fees', tp.body.tapeoutFeeWei === '1300000000000000' && tp.body.openFeeWei === '80000000000000000', JSON.stringify(tp.body));

const req = (over = {}) => ({
  requestId: '0x' + '11'.repeat(32), recipient: '0x000000000000000000000000000000000000beef',
  amount: '100000000000000000', deadline: Math.floor(Date.now() / 1000) + 3600, inputs: 63, ...over,
});

console.log('== decide trap matrix ==');
let r = await post('/decide', req());
check('all-ones -> APPROVE (verify-only, no signature)', r.body.decision === 'APPROVE' && r.body.reason_code === 'VALID_CIRCUIT' && r.body.signature === null, JSON.stringify(r.body));
r = await post('/decide', req());
check('replay of approved id -> REJECT REPLAY', r.body.decision === 'REJECT' && r.body.reason_code === 'REPLAY', JSON.stringify(r.body));
for (let bit = 0; bit < 6; bit++) {
  r = await post('/decide', req({ requestId: '0x' + (0x20 + bit).toString(16).padStart(2, '0').repeat(32), inputs: 63 & ~(1 << bit) }));
  check(`bit ${bit} clear -> REJECT CIRCUIT_REJECT`, r.body.decision === 'REJECT' && r.body.reason_code === 'CIRCUIT_REJECT', JSON.stringify(r.body));
}
r = await post('/decide', req({ requestId: '0x' + '33'.repeat(32), deadline: Math.floor(Date.now() / 1000) - 10 }));
check('expired -> REJECT EXPIRED', r.body.decision === 'REJECT' && r.body.reason_code === 'EXPIRED', JSON.stringify(r.body));
r = await post('/decide', { recipient: 'not-an-address' });
check('malformed -> REJECT MALFORMED', r.body.decision === 'REJECT' && r.body.reason_code === 'MALFORMED', JSON.stringify(r.body));
const badJson = await fetch(`${BASE}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
const badBody = await badJson.json();
check('invalid JSON -> REJECT MALFORMED', badBody.decision === 'REJECT' && badBody.reason_code === 'MALFORMED', JSON.stringify(badBody));

proc.kill();
fs.writeFileSync(path.join(DIR, 'seen.json'), '[]\n');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
