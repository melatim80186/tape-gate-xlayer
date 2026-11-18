// Deploy TapeGateVault to X Layer (testnet 1952 or mainnet 196).
// NOT run by the agent — needs a funded deployer wallet (user step).
//
//   DEPLOYER_KEY=0x... node scripts/deploy-xlayer.mjs --network testnet
//   DEPLOYER_KEY=0x... node scripts/deploy-xlayer.mjs --network mainnet
//
// Costs (mainnet, Nov 2026): contract deploy gas only (~1-2M gas at
// ~0.00000002 OKB/gas = a few hundredths of an OKB). Use a THROWAWAY
// deployer funded with ~0.1 OKB. Writes deployments/<chainId>.json.
// The deployer becomes the vault owner; transfer ownership / set the real
// agent address afterwards (see README "After deploy").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NETWORKS = {
  testnet: { chainId: 1952, rpc: 'https://testnet-rpc.xlayer.tech', name: 'X Layer Testnet' },
  mainnet: { chainId: 196, rpc: 'https://rpc.xlayer.tech', name: 'X Layer Mainnet' },
};
const network = (process.argv.find((a) => a.startsWith('--network=')) || '--network=testnet').split('=')[1];
const net = NETWORKS[network];
if (!net) { console.error(`unknown network ${network}; use testnet or mainnet`); process.exit(1); }
if (!process.env.DEPLOYER_KEY) { console.error('DEPLOYER_KEY env required (throwaway deployer, funded with ~0.1 OKB)'); process.exit(1); }

const provider = new ethers.JsonRpcProvider(net.rpc);
const deployer = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);
console.log(`network: ${net.name} (chain ${net.chainId})`);
console.log(`deployer: ${deployer.address} balance: ${ethers.formatEther(await provider.getBalance(deployer.address))} OKB`);

const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'out', 'TapeGateVault.sol', 'TapeGateVault.json'), 'utf8'));
const circuit = JSON.parse(fs.readFileSync(path.join(ROOT, 'circuit', 'spend-policy.json'), 'utf8'));

// Agent address: the agent's signing key. Default: deployer (replace with
// the real agent key via AGENT_ADDRESS, then run the agent with its key).
const agentAddress = process.env.AGENT_ADDRESS || deployer.address;
const now = Math.floor(Date.now() / 1000);
const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
const vault = await factory.deploy(agentAddress, ethers.parseEther('10'), ethers.parseEther('1'), now, now + 30 * 86400);
await vault.waitForDeployment();
const vaultAddr = await vault.getAddress();
console.log(`vault deployed: ${vaultAddr}`);
await (await vault.registerCircuit(circuit.netlistHex)).wait();
console.log(`circuit registered: ${circuit.netlistHex} hash=${ethers.keccak256(circuit.netlistHex)}`);

const outDir = path.join(ROOT, 'deployments');
fs.mkdirSync(outDir, { recursive: true });
const record = {
  network: net.name, chainId: net.chainId, vault: vaultAddr, agent: agentAddress,
  deployer: deployer.address, netlistHash: ethers.keccak256(circuit.netlistHex),
  netlistHex: circuit.netlistHex,
  tapeoutProcessor: '0x69F663931209096037474d7C20402232E5C762cA',
  tapeoutCircuitId: process.env.TAPEOUT_CIRCUIT_ID ? Number(process.env.TAPEOUT_CIRCUIT_ID) : null,
  explorer: `https://www.okx.com/web3/explorer/xlayer/address/${vaultAddr}`,
};
fs.writeFileSync(path.join(outDir, `${net.chainId}.json`), JSON.stringify(record, null, 2) + '\n');
console.log(`wrote deployments/${net.chainId}.json`);
console.log('Next: fund the vault (deposit OKB), start the agent with VAULT_ADDRESS + AGENT_PRIVATE_KEY, run scripts/tapeout-identity.mjs for the TapeOut circuit id.');
