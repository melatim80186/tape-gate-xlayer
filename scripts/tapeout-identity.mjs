// Tape out the TapeGate identity circuit on the official X Layer
// processor TAPELIQUID, using the OFFICIAL @taperelay/client library
// (the same starter flow TapeRelay documents for developers).
//
// What it does (2 transactions + 1 signature, ~0.0813 OKB + gas):
//   1. tapeout() on processor 0x69F663931209096037474d7C20402232E5C762cA
//      with a 1-instruction REF netlist (0x02 + processor + circuit id 1
//      + pins) — REF burns no transistors, no BEM needed; the fee is the
//      processor's TAPEOUT_FEE (live: 0.0013 OKB).
//   2. open() on opener 0x536adD8F30f03b69f6fbF29d425A816A0dC50106 to create
//      the circuit's container (live FEE: 0.08 OKB).
// The new circuit's name is <id>.2.265.tape (X Layer area code 2,
// TAPELIQUID factory #265). The id is written to
// deployments/tapeout-circuit.json and should then be recorded on the
// vault via setTapeoutCircuit(id) and in the submission form.
//
//   HOLDER_KEY=0x... node scripts/tapeout-identity.mjs [--dry-run]
//
// --dry-run only reads the fees (no signing, no transaction) — safe to run
// now. A real run needs HOLDER_KEY funded with ~0.1 OKB on X Layer mainnet
// (user step; never paste a main wallet key here — use a throwaway).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { starterPlan, circuitIdFromReceipt } from '@taperelay/client/src/starter.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RPC_URL = 'https://rpc.xlayer.tech';
const DRY = process.argv.includes('--dry-run');

// Minimal `chain` adapter the client library expects: call + send.
function makeChain(provider, signer) {
  return {
    async call({ to, data }) {
      return provider.call({ to, data });
    },
    async send({ to, data, value }) {
      const tx = await signer.sendTransaction({ to, data, value: value ?? 0n });
      return tx.wait();
    },
  };
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const chain = makeChain(provider, null);
const plan = await starterPlan(chain, 196);
console.log('starter plan (live, X Layer mainnet):');
console.log(`  processor : ${plan.cpu} (#${plan.cpuIndex}, TAPELIQUID)`);
console.log(`  opener    : ${plan.opener}`);
console.log(`  netlist   : ${plan.netlist}`);
console.log(`  tapeoutFee: ${plan.tapeoutFee} wei (${ethers.formatEther(plan.tapeoutFee)} OKB)`);
console.log(`  openFee   : ${plan.openFee} wei (${ethers.formatEther(plan.openFee)} OKB)`);
console.log(`  total     : ${plan.total} wei (${ethers.formatEther(plan.total)} OKB) + gas`);
if (DRY) { console.log('--dry-run: no transaction sent.'); process.exit(0); }

if (!process.env.HOLDER_KEY) { console.error('HOLDER_KEY env required for a real tapeout (throwaway, ~0.1 OKB)'); process.exit(1); }
const holder = new ethers.Wallet(process.env.HOLDER_KEY, provider);
console.log(`holder: ${holder.address} balance: ${ethers.formatEther(await provider.getBalance(holder.address))} OKB`);
const liveChain = makeChain(provider, holder);

// 1. tapeout the REF identity circuit.
const tapeoutData = '0x7bd3ac1d' + // tapeout(bytes,uint32,uint32)
  ethers.AbiCoder.defaultAbiCoder().encode(['bytes', 'uint32', 'uint32'], [plan.netlist, plan.nIn, plan.nOut]).slice(2);
const rc1 = await liveChain.send({ to: plan.cpu, data: tapeoutData, value: plan.tapeoutFee });
const circuitId = circuitIdFromReceipt({ status: rc1.status, logs: rc1.logs }, plan.cpu);
console.log(`taped out! circuit id: ${circuitId} (name: ${circuitId}.2.265.tape) tx: ${rc1.hash}`);

// 2. open its container.
const openData = '0x0a0e5c9d' + // open(address,uint256)
  ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [plan.cpu, BigInt(circuitId)]).slice(2);
const rc2 = await liveChain.send({ to: plan.opener, data: openData, value: plan.openFee });
console.log(`container opened. tx: ${rc2.hash}`);

const outDir = path.join(ROOT, 'deployments');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'tapeout-circuit.json'), JSON.stringify({
  chainId: 196, processor: plan.cpu, processorIndex: plan.cpuIndex,
  circuitId: Number(circuitId), circuitName: `${circuitId}.2.265.tape`,
  tapeoutTx: rc1.hash, openTx: rc2.hash,
  tapeoutFeeWei: plan.tapeoutFee.toString(), openFeeWei: plan.openFee.toString(),
}, null, 2) + '\n');
console.log('wrote deployments/tapeout-circuit.json');
console.log(`Next: vault.setTapeoutCircuit(${circuitId}) from the owner, then put the processor + circuit id in the submission form.`);
