# TapeGate — Circuit-Gated Agent Treasury on X Layer × TapeOut

Entry for the **X Layer TapeOut Accelerate** hackathon
([official page](https://web3.okx.com/xlayer/build-x-series)):
an agent-guarded treasury on X Layer whose every spend must pass a real
**NAND-gate circuit** — TapeOut's base primitive — evaluated **twice**:
once off-chain by the agent, once on-chain by the vault contract.
A buggy or compromised agent cannot force a spend through, because the
vault re-evaluates the circuit itself.

## Verification (done 2026-11-18, before building)

Checked against the official page — all confirmed, nothing invented:

| Claim | Status |
|---|---|
| Deadline **7 Dec 2026, 23:59 UTC** | ✅ on official page — **provisional** (page says the final date will be confirmed there) |
| Prize pool **100,000 USDT** (1st 20,000; 5× 2nd 10,000; 5× 3rd 6,000) | ✅ on official page |
| Online; shortlisted teams attend offline Demo Day | ✅ |
| 18+; individuals and teams; existing projects eligible with substantial new work | ✅ |
| Must use TapeOut circuits, contracts or on-chain data on X Layer (or run on X Layer DeWEB); circuit projects submit processor contract address + circuit ID; demo video ≤ 3 min recommended | ✅ |
| TapeOut processor **TAPELIQUID on X Layer**: `0x69F663931209096037474d7C20402232E5C762cA` (factory #265), `TAPEOUT_FEE()` = **0.0013 OKB**; container opener `0x536adD8F30f03b69f6fbF29d425A816A0dC50106`, `FEE()` = **0.08 OKB** | ✅ verified live via public X Layer RPC + official `@taperelay/client` source |

Full evidence: [`docs/TAPEOUT.md`](docs/TAPEOUT.md).

## How it works

```
spend request ──► TapeGate agent ──► circuit? ──► ECDSA signature
                      │  (NAND netlist, JS)        │
                      ▼                              ▼
                 X Layer RPC               TapeGateVault (Solidity)
                 (vault state)              ├─ re-evaluates circuit on-chain
                                            ├─ verifies agent signature
                                            └─ executes transfer (or reverts)
```

**Spend-policy circuit** — 10 NAND gates, 35 bytes
(`circuit/spend-policy.json`, format in [`docs/NETLIST.md`](docs/NETLIST.md)):

```
OUT = agentOK & budgetOK & notRevoked & windowOK & amountOK & fundedOK
```

Only `0b111111` authorises. The agent and the vault evaluate the *same*
netlist bytes; both are exhaustively cross-checked on all 64 input combos.
The vault **recomputes the circuit inputs from live chain state itself** —
the agent's signature only asserts bit 0 (`agentOK`), so a compromised
agent cannot fake the budget / revoke / window / cap / balance bits.

**TapeOut link** — the project tapes out an identity circuit on the official
X Layer processor TAPELIQUID via the official `@taperelay/client`
(`scripts/tapeout-identity.mjs`, REF netlist — burns no transistors, no BEM;
cost 0.0813 OKB + gas). The vault records the processor + circuit id
(`setTapeoutCircuit`), which is exactly what the submission form asks for.

## Quickstart (no funds needed — demo runs on a fork of X Layer mainnet)

```bash
# 1. Contracts: build + test (11 tests, incl. exhaustive 64-combo evaluator)
cd contracts && forge install && forge test

# 2. Agent: install + test (17 checks, incl. trap matrix + live fee reads)
cd ../agent && npm install && npm test

# 3. End-to-end demo (13 checks): Anvil fork of X Layer mainnet (chain 196),
#    deploy vault, register circuit, agent APPROVEs a valid spend, agent +
#    chain both block a revoked spend, replay reverts, live TapeOut fees read.
cd .. && node scripts/demo.mjs

# 4. Demo UI (after the demo ran — it writes web/config.js):
npx serve web   # or: python3 -m http.server -d web
```

Other read-only checks (no wallet, no transaction):

```bash
node scripts/tapeout-identity.mjs --dry-run   # live starter plan + fees from X Layer
```

## Repo map

| Path | What it is |
|---|---|
| `contracts/src/TapeCircuit.sol` | Pure on-chain NAND-netlist evaluator |
| `contracts/src/TapeGateVault.sol` | Circuit-gated treasury (ECDSA agent auth, replay + expiry + pause + revoke) |
| `contracts/test/TapeGate.t.sol` | 11 Foundry tests |
| `circuit/build-netlist.mjs` + `spend-policy.json` | Circuit generator + netlist + truth table |
| `agent/server.mjs` | Agent (HMAC-signed responses, seen-set, vault reads, ECDSA signing) |
| `agent/circuit.mjs` | JS mirror of the on-chain evaluator |
| `agent/test-local.mjs` | 17 agent checks |
| `scripts/demo.mjs` | One-command end-to-end demo on an X Layer mainnet fork |
| `scripts/deploy-xlayer.mjs` | Deploy vault to X Layer testnet/mainnet (needs funded deployer) |
| `scripts/tapeout-identity.mjs` | Tape out identity circuit on TAPELIQUID (needs ~0.1 OKB) |
| `web/` | Static demo UI (circuit diagram, ask-the-agent) |
| `docs/` | `TAPEOUT.md` (verification evidence), `NETLIST.md` (byte format), `SUBMISSION.md` (submission draft) |

## Deploying for real (user steps — nothing here spends user funds)

1. **Fund a throwaway deployer** with ~0.1 OKB on X Layer mainnet (or get
   testnet OKB for chain 1952).
2. `DEPLOYER_KEY=0x... node scripts/deploy-xlayer.mjs --network mainnet`
   (or `--network testnet`). Writes `deployments/<chainId>.json`.
3. `HOLDER_KEY=0x... node scripts/tapeout-identity.mjs` — tapes out the
   identity circuit (~0.0813 OKB + gas), writes
   `deployments/tapeout-circuit.json`. Then call
   `vault.setTapeoutCircuit(<id>)` from the owner account.
4. Fund the vault (`deposit`), start the agent with `VAULT_ADDRESS` +
   `AGENT_PRIVATE_KEY` (the key whose address is the vault's `agent`).
5. Record a ≤ 3-min demo video (problem, core features, users + business
   model, how TapeOut is used) and submit via the official form before
   **7 Dec 2026 23:59 UTC** (provisional — re-check the page before submitting).

Submission draft (description, users, revenue model, video outline):
[`docs/SUBMISSION.md`](docs/SUBMISSION.md).

## Honest status / limits

- **Not yet deployed to X Layer mainnet/testnet.** Everything is verified on
  a local fork of mainnet state (real processor/opener contracts present) plus
  live read-only RPC calls. Deployment + tapeout need ~0.1–0.2 OKB of funding
  and a human holding the keys — deliberately not done by the agent.
- The spend-policy netlist uses TapeGate's own documented byte format, not
  TapeOut's VM encoding; the on-chain TapeOut link is the identity circuit
  on TAPELIQUID (step 3 above). Both facts are stated as such in the docs —
  the submission does not claim otherwise.
- Agent seen-set is a local JSON file (same best-effort caveat as GateCheck);
  the vault's on-chain replay protection is authoritative.
- No accounts were created, no forms submitted, no fees paid, nothing posted.
