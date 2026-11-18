// TapeGate agent — circuit-gated spend authoriser for X Layer x TapeOut.
//
// Adapted from GateCheck (zkVerify Agent Games gatekeeper): same skeleton —
// deterministic decisions, HMAC-signed responses, seen-set replay memory,
// fail-closed on malformed input — but the decision here is a real one:
// evaluate the spend-policy NAND circuit (circuit/spend-policy.json) and,
// on APPROVE, ECDSA-sign the decision hash the vault verifies on-chain
// (TapeGateVault.decisionHash). The vault re-evaluates the circuit itself,
// so a buggy or malicious agent cannot force a spend through: the circuit
// check would still block it on-chain.
//
// Env:
//   PORT                default 8080
//   AGENT_HMAC_SECRET   HMAC-SHA256 secret for response signing (bare hex,
//                       GateCheck convention). Unset => unsigned (dev only).
//   AGENT_PRIVATE_KEY   ECDSA key that signs APPROVE decisions. Must match
//                       the `agent` address registered in the vault.
//                       Unset => agent runs in verify-only mode (no signing).
//   XLAYER_RPC_URL      default https://rpc.xlayer.tech
//   VAULT_ADDRESS       deployed TapeGateVault (unset => standalone mode:
//                       the agent evaluates caller-supplied inputs only and
//                       says so in the response; no vault reads, no signing
//                       unless a vault is set, because the decision hash
//                       binds the vault address).
//   CHAIN_ID            default 196 (X Layer mainnet)
//
// Endpoints:
//   GET  /health   {ok, protocolVersion, mode, agent, vault, chainId}
//   GET  /circuit  the netlist + inputs + TapeOut processor reference
//   GET  /tapeout  live read-only TapeOut state on X Layer (processor fee,
//                   container-opener fee) via public RPC — no wallet.
//   POST /decide   {requestId, recipient, amount, deadline, agentOK?,
//                   inputs?} -> APPROVE + signature, or REJECT + reason.
//                   With VAULT_ADDRESS set, inputs are read from the vault
//                   (buildInputs) and caller-supplied inputs are ignored.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { CIRCUIT, evaluateCircuit, failingInputs, INPUT_NAMES } from './circuit.mjs';

const PORT = Number(process.env.PORT || 8080);
const HMAC_SECRET = process.env.AGENT_HMAC_SECRET || '';
const RPC_URL = process.env.XLAYER_RPC_URL || 'https://rpc.xlayer.tech';
const VAULT_ADDRESS = (process.env.VAULT_ADDRESS || '').toLowerCase() || null;
const CHAIN_ID = Number(process.env.CHAIN_ID || 196);
const SEEN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seen.json');

// Official TapeOut on X Layer — verified live 2026-11-18 via public RPC:
// processor TAPELIQUID has code + TAPEOUT_FEE() = 0.0013 OKB;
// container opener has code + FEE() = 0.08 OKB.
export const TAPEOUT = {
  chainId: 196,
  processor: '0x69F663931209096037474d7C20402232E5C762cA', // TAPELIQUID, factory #265
  processorIndex: 265,
  opener: '0x536adD8F30f03b69f6fbF29d425A816A0dC50106',
  areaCode: 2, // X Layer area code in TapeOut circuit names: <id>.2.265.tape
};

const VAULT_ABI = [
  'function buildInputs(address recipient, uint256 amount, bool agentOK) view returns (uint256)',
  'function netlistHash() view returns (bytes32)',
  'function decisionHash(bytes32 requestId, address recipient, uint256 amount, uint256 inputs, uint256 deadline) view returns (bytes32)',
  'function tapeoutCircuitId() view returns (uint256)',
  'function agent() view returns (address)',
];

let wallet = null;
if (process.env.AGENT_PRIVATE_KEY) {
  wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY);
}

let seen = new Set();
try {
  seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
} catch { /* starts empty */ }
function persistSeen() {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]) + '\n'); } catch { /* best-effort */ }
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const vault = VAULT_ADDRESS ? new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider) : null;

function signBody(body) {
  if (!HMAC_SECRET) return null;
  return crypto.createHmac('sha256', HMAC_SECRET).update(body).digest('hex');
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  const headers = { 'content-type': 'application/json' };
  const sig = signBody(body);
  if (sig) headers['x-tapegate-signature'] = sig;
  res.writeHead(status, headers);
  res.end(body);
}

function log(...a) { console.log(new Date().toISOString(), ...a); }

async function decide(input) {
  const fail = (reason_code, detail) => ({ decision: 'REJECT', reason_code, detail });
  if (!input || typeof input !== 'object') return fail('MALFORMED', 'body must be a JSON object');
  const { requestId, recipient, amount, deadline } = input;
  if (typeof requestId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(requestId)) return fail('MALFORMED', 'requestId must be a 0x bytes32 hex string');
  if (typeof recipient !== 'string' || !ethers.isAddress(recipient)) return fail('MALFORMED', 'recipient must be an address');
  let amt;
  try { amt = BigInt(amount ?? '0'); } catch { return fail('MALFORMED', 'amount must be a uint string'); }
  if (amt <= 0n) return fail('MALFORMED', 'amount must be > 0');
  const dl = Number(deadline);
  if (!Number.isFinite(dl) || dl <= 0) return fail('MALFORMED', 'deadline must be a unix timestamp');
  if (Math.floor(Date.now() / 1000) > dl) return fail('EXPIRED', 'deadline already passed');
  if (seen.has(requestId.toLowerCase())) return fail('REPLAY', 'requestId already approved');

  // Inputs: from the vault when deployed (authoritative), else caller-supplied.
  let inputs;
  let inputsSource = 'caller';
  if (vault) {
    try {
      inputs = Number(await vault.buildInputs(recipient, amt, true));
      inputsSource = 'vault';
    } catch (e) {
      return fail('RPC_UNAVAILABLE', `vault read failed: ${e?.shortMessage || e?.message || e}`);
    }
  } else {
    if (typeof input.inputs !== 'number' || input.inputs < 0 || input.inputs > 63) {
      return fail('MALFORMED', 'inputs (0-63) required in standalone mode');
    }
    inputs = input.inputs;
  }

  let out;
  try { out = evaluateCircuit(CIRCUIT.netlistHex, inputs); } catch (e) {
    return fail('CIRCUIT_ERROR', e.message);
  }
  if (out !== 1) {
    return fail('CIRCUIT_REJECT', `circuit output 0; failing checks: ${failingInputs(inputs).join(', ') || 'none'}`);
  }

  // Circuit authorises. Record the decision FIRST (replay protection
  // applies in every mode, including verify-only) and then sign it when
  // a wallet + vault are configured.
  seen.add(requestId.toLowerCase());
  persistSeen();
  if (!wallet || !vault) {
    return {
      decision: 'APPROVE',
      reason_code: 'VALID_CIRCUIT',
      detail: 'circuit authorises; no signature (verify-only mode: set AGENT_PRIVATE_KEY + VAULT_ADDRESS)',
      requestId, recipient, amount: amt.toString(), inputs, inputsSource, signature: null,
      agent: wallet?.address ?? null, vault: VAULT_ADDRESS, chainId: CHAIN_ID,
    };
  }
  const inner = ethers.solidityPackedKeccak256(
    ['uint256', 'address', 'bytes32', 'address', 'uint256', 'uint256', 'uint256'],
    [CHAIN_ID, VAULT_ADDRESS, requestId, recipient, amt, inputs, dl],
  );
  const signature = await wallet.signMessage(ethers.getBytes(inner));
  return {
    decision: 'APPROVE', reason_code: 'VALID_CIRCUIT', requestId,
    recipient, amount: amt.toString(), inputs, inputsSource, deadline: dl,
    signature, agent: wallet.address, vault: VAULT_ADDRESS, chainId: CHAIN_ID,
  };
}

async function tapeoutState() {
  const sel = (sig) => '0x' + Buffer.from(ethers.keccak256(ethers.toUtf8Bytes(sig)).slice(2, 10), 'hex').toString('hex');
  const readUint = async (to, data) => {
    const r = await provider.call({ to, data });
    return BigInt(r).toString();
  };
  const [tapeoutFee, openFee] = await Promise.all([
    readUint(TAPEOUT.processor, sel('TAPEOUT_FEE()')),
    readUint(TAPEOUT.opener, sel('FEE()')),
  ]);
  let circuitId = null;
  if (vault) { try { circuitId = (await vault.tapeoutCircuitId()).toString(); } catch { /* ignore */ } }
  return {
    ...TAPEOUT,
    tapeoutFeeWei: tapeoutFee,
    openFeeWei: openFee,
    circuitName: circuitId && circuitId !== '0' ? `${circuitId}.2.265.tape` : null,
    circuitId,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return send(res, 200, { ok: true, protocolVersion: 'v1', service: 'tapegate-agent', mode: vault ? 'vault' : 'standalone', agent: wallet?.address ?? null, vault: VAULT_ADDRESS, chainId: CHAIN_ID });
  }
  if (req.method === 'GET' && url.pathname === '/circuit') {
    return send(res, 200, { name: CIRCUIT.name, inputs: INPUT_NAMES, outputs: CIRCUIT.outputs, gates: CIRCUIT.gates.length, netlistHex: CIRCUIT.netlistHex, netlistBytes: CIRCUIT.netlistBytes, tapeout: TAPEOUT });
  }
  if (req.method === 'GET' && url.pathname === '/tapeout') {
    try { return send(res, 200, await tapeoutState()); }
    catch (e) { return send(res, 502, { ok: false, error: `X Layer RPC read failed: ${e?.message || e}` }); }
  }
  if (req.method === 'POST' && (url.pathname === '/decide' || url.pathname === '/task')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let input;
      try { input = JSON.parse(raw); } catch { return send(res, 200, { decision: 'REJECT', reason_code: 'MALFORMED', detail: 'body is not valid JSON' }); }
      const out = await decide(input);
      log('decide', input?.requestId?.slice(0, 10), out.decision, out.reason_code, 'inputs=' + out.inputs);
      return send(res, 200, out);
    });
    return;
  }
  return send(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, () => {
  log(`TapeGate agent on :${PORT} mode=${vault ? 'vault' : 'standalone'} agent=${wallet?.address ?? 'none'} vault=${VAULT_ADDRESS ?? 'none'} chain=${CHAIN_ID}`);
});
