// TapeGate end-to-end demo — runs the whole system against a LOCAL FORK
// of X Layer mainnet (chain 196), so no real OKB is needed.
//
//   node scripts/demo.mjs
//
// Steps:
//   1. Boot Anvil forked from https://rpc.xlayer.tech (real mainnet state:
//      the TapeOut processor + opener contracts are present in the fork).
//   2. Deploy TapeGateVault, register the spend-policy NAND circuit,
//      fund the vault with 1 native OKB (Anvil test funds).
//   3. Start the TapeGate agent (fresh throwaway key) pointed at the fork.
//   4. Scenario A (happy path): agent APPROVEs + signs, vault executes.
//   5. Scenario B (trap): recipient revoked -> agent REJECTs; then a
//      compromised-agent simulation signs the revoked spend anyway and the
//      vault STILL blocks it on-chain (circuit re-evaluation).
//   6. Scenario C (replay): re-submitting scenario A reverts.
//   7. Live TapeOut read: /tapeout returns the real processor fees.
// Writes deployments/demo-fork.json. Exits 0 only if every check passes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import os from 'node:os';

// Resolve `anvil` (Foundry lives in ~/.foundry/bin, not always on PATH).
function anvilBin() {
  if (process.env.ANVIL_BIN) return process.env.ANVIL_BIN;
  const home = path.join(os.homedir(), '.foundry', 'bin', 'anvil');
  if (fs.existsSync(home)) return home;
  return 'anvil';
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANVIL_PORT = 18545;
const AGENT_PORT = 18080;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const FORK_URLS = [
  process.env.XLAYER_FORK_URL || '',
  'https://rpc.xlayer.tech',
  'https://xlayer.drpc.org', // fallback if the official public RPC is down
].filter(Boolean);

async function pickForkUrl() {
  for (const url of FORK_URLS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      if (j?.result === '0xc4') { console.log(`   fork RPC: ${url}`); return url; }
    } catch { /* try next */ }
  }
  throw new Error('no reachable X Layer RPC (tried: ' + FORK_URLS.join(', ') + ')');
}
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra });
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs = 30000, label = '') => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await sleep(400);
  }
  throw new Error(`timeout waiting for ${label}`);
};

let anvil = null;
let agentProc = null;
const cleanup = () => { try { agentProc?.kill(); } catch {} try { anvil?.kill(); } catch {} };
process.on('SIGINT', () => { cleanup(); process.exit(130); });

try {
  // 1. Anvil fork of X Layer mainnet.
  console.log('== 1. Anvil fork of X Layer mainnet (chain 196) ==');
  const forkUrl = await pickForkUrl();
  anvil = spawn(anvilBin(), ['--fork-url', forkUrl, '--chain-id', '196', '--port', String(ANVIL_PORT)], { stdio: 'pipe' });
  // Wait for Anvil's HTTP port before creating an ethers provider, so
  // ethers' network-detection retries don't spam the log.
  await waitFor(async () => {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
    return r.ok;
  }, 60000, 'anvil http');
  const provider = new ethers.JsonRpcProvider(RPC);
  const forkChain = (await provider.getNetwork()).chainId;
  check('fork chain id is 196 (X Layer)', forkChain === 196n, `got ${forkChain}`);
  // The real TapeOut processor is present in the fork (not a mock).
  const code = await provider.getCode('0x69F663931209096037474d7C20402232E5C762cA');
  check('TAPELIQUID processor code present in fork', code !== '0x' && code.length > 100, `${(code.length - 2) / 2} bytes`);

  const deployer = (await provider.getSigner(0));
  const deployerAddr = await deployer.getAddress();
  console.log(`   deployer (anvil #0): ${deployerAddr}`);

  // 2. Deploy vault + register circuit + fund.
  console.log('== 2. Deploy vault, register circuit, fund ==');
  const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'out', 'TapeGateVault.sol', 'TapeGateVault.json'), 'utf8'));
  const agentWallet = ethers.Wallet.createRandom();
  console.log(`   agent key (throwaway, demo only): ${agentWallet.address}`);
  const now = Math.floor(Date.now() / 1000);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const vault = await factory.deploy(agentWallet.address, ethers.parseEther('10'), ethers.parseEther('1'), now, now + 30 * 86400);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log(`   vault: ${vaultAddr}`);
  const circuit = JSON.parse(fs.readFileSync(path.join(ROOT, 'circuit', 'spend-policy.json'), 'utf8'));
  await (await vault.registerCircuit(circuit.netlistHex)).wait();
  check('circuit registered', (await vault.netlistHash()) === ethers.keccak256(circuit.netlistHex));
  await (await deployer.sendTransaction({ to: vaultAddr, value: ethers.parseEther('1') })).wait();
  check('vault funded with 1 OKB', (await provider.getBalance(vaultAddr)) === ethers.parseEther('1'));

  // 3. Start agent pointed at the fork.
  console.log('== 3. Start agent (vault mode) ==');
  agentProc = spawn('node', ['server.mjs'], {
    cwd: path.join(ROOT, 'agent'),
    env: { ...process.env, PORT: String(AGENT_PORT), VAULT_ADDRESS: vaultAddr, AGENT_PRIVATE_KEY: agentWallet.privateKey, AGENT_HMAC_SECRET: 'demo-secret', XLAYER_RPC_URL: RPC, CHAIN_ID: '196' },
    stdio: 'pipe',
  });
  const agentBase = `http://127.0.0.1:${AGENT_PORT}`;
  await waitFor(async () => (await fetch(`${agentBase}/health`)).ok, 20000, 'agent');
  const health = await (await fetch(`${agentBase}/health`)).json();
  check('agent healthy in vault mode', health.mode === 'vault' && health.agent === agentWallet.address, JSON.stringify(health));

  const decide = async (body) => {
    const r = await fetch(`${agentBase}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  };
  const recipient = ethers.Wallet.createRandom().address;
  const amount = ethers.parseEther('0.1');
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  // 4. Scenario A — happy path.
  console.log('== 4. Scenario A: valid spend ==');
  const requestIdA = ethers.keccak256(ethers.toUtf8Bytes('demo-req-A'));
  const dA = await decide({ requestId: requestIdA, recipient, amount: amount.toString(), deadline });
  check('agent APPROVEs valid spend', dA.decision === 'APPROVE' && dA.inputs === 63 && !!dA.signature, JSON.stringify(dA).slice(0, 200));
  const balBefore = await provider.getBalance(recipient);
  const txA = await vault.executeSpend(requestIdA, recipient, amount, deadline, dA.signature);
  await txA.wait();
  check('vault executed spend', (await provider.getBalance(recipient)) - balBefore === amount);
  check('spentTotal tracked', (await vault.spentTotal()) === amount);

  // 5. Scenario B — revoked recipient: agent rejects, chain blocks anyway.
  console.log('== 5. Scenario B: revoked recipient (agent + chain both block) ==');
  await (await vault.setRevoked(recipient, true)).wait();
  const requestIdB = ethers.keccak256(ethers.toUtf8Bytes('demo-req-B'));
  const dB = await decide({ requestId: requestIdB, recipient, amount: amount.toString(), deadline });
  check('agent REJECTs revoked spend', dB.decision === 'REJECT' && dB.reason_code === 'CIRCUIT_REJECT', JSON.stringify(dB).slice(0, 200));
  // Compromised-agent simulation: sign the revoked inputs directly.
  const inputsB = Number(await vault.buildInputs(recipient, amount, true));
  check('revoked inputs fail the circuit (bit 2 = 0)', (inputsB & 4) === 0, `inputs=${inputsB}`);
  const innerB = ethers.solidityPackedKeccak256(
    ['uint256', 'address', 'bytes32', 'address', 'uint256', 'uint256', 'uint256'],
    [196, vaultAddr, requestIdB, recipient, amount, inputsB, deadline],
  );
  const rogueSig = await agentWallet.signMessage(ethers.getBytes(innerB));
  let revertedB = false;
  try { await vault.executeSpend.staticCall(requestIdB, recipient, amount, deadline, rogueSig); }
  catch (e) { revertedB = /CircuitRejected/.test(e?.message || '') || /reverted/.test(e?.message || ''); }
  check('vault blocks rogue-signed revoked spend on-chain', revertedB);
  await (await vault.setRevoked(recipient, false)).wait();

  // 6. Scenario C — replay.
  console.log('== 6. Scenario C: replay ==');
  let revertedC = false;
  try { await vault.executeSpend.staticCall(requestIdA, recipient, amount, deadline, dA.signature); }
  catch (e) { revertedC = /Replay/.test(e?.message || ''); }
  check('replay of scenario A reverts', revertedC);

  // 7. Live TapeOut read through the agent (fork carries mainnet state).
  console.log('== 7. Live TapeOut state ==');
  const tp = await (await fetch(`${agentBase}/tapeout`)).json();
  check('tapeout fees readable', tp.tapeoutFeeWei === '1300000000000000' && tp.openFeeWei === '80000000000000000', JSON.stringify(tp));
  console.log(`   TAPEOUT_FEE=${tp.tapeoutFeeWei} wei (0.0013 OKB), opener FEE=${tp.openFeeWei} wei (0.08 OKB)`);

  // Record deployment.
  const outDir = path.join(ROOT, 'deployments');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'demo-fork.json'), JSON.stringify({
    network: 'X Layer mainnet fork (Anvil)', chainId: 196, vault: vaultAddr,
    agent: agentWallet.address, recipient, netlistHash: ethers.keccak256(circuit.netlistHex),
    tapeoutProcessor: '0x69F663931209096037474d7C20402232E5C762cA', tapeoutCircuitId: null,
    note: 'Demo only. Real X Layer deployment needs a funded deployer — see scripts/deploy-xlayer.mjs.',
  }, null, 2) + '\n');
  // Web UI config for the demo.
  fs.writeFileSync(path.join(ROOT, 'web', 'config.js'), `// Generated by scripts/demo.mjs — demo fork only.\nwindow.TAPEGATE_CONFIG = { agentBase: '${agentBase}', vault: '${vaultAddr}', chainId: 196, rpc: '${RPC}' };\n`);
} catch (e) {
  console.error('DEMO ERROR:', e?.message || e);
  results.push({ name: 'demo completed without exception', ok: false, extra: String(e?.message || e) });
} finally {
  cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n==== demo: ${results.length - failed.length}/${results.length} checks passed ====`);
if (failed.length) { for (const f of failed) console.log('FAILED:', f.name, f.extra); process.exit(1); }
