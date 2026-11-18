# TapeGate — submission draft (X Layer TapeOut Accelerate)

> DRAFT — fill in the bracketed fields after the real deploy + tapeout.
> Do NOT submit until: vault deployed on X Layer, identity circuit taped out,
> demo video recorded. Deadline: **7 Dec 2026, 23:59 UTC (PROVISIONAL —
> re-check https://web3.okx.com/xlayer/build-x-series before submitting).**

## Project description

**TapeGate** is a circuit-gated agent treasury on X Layer. AI agents are
increasingly given wallets and budgets — but an agent that can move money on
its own is a liability if it is buggy, prompt-injected or compromised.
TapeGate makes every spend pass a real NAND-gate circuit (TapeOut's base
primitive) twice: the agent evaluates the spend-policy circuit off-chain and
signs approved spends, and the vault contract re-evaluates the same netlist
on-chain before executing. The circuit — not the agent's word — is the final
authority, so a rogue agent signature alone cannot move funds.

## TapeOut usage (addresses for the form)

- **Processor contract address:** `0x69F663931209096037474d7C20402232E5C762cA`
  (TAPELIQUID, official X Layer processor, factory #265)
- **Circuit ID:** [fill after `scripts/tapeout-identity.mjs` — circuit name
  will be `<id>.2.265.tape`]
- **Vault contract:** [fill after `scripts/deploy-xlayer.mjs` — `deployments/<chainId>.json`]
- **Spend-policy circuit:** 10-gate NAND netlist, `circuit/spend-policy.json`;
  evaluated on-chain by `TapeCircuit.sol`. TapeOut ecosystem features used:
  existing processor + circuits/tools (per FAQ, building on existing
  TapeOut infrastructure is explicitly allowed); identity via TapeRelay's
  circuit-name scheme.

## Target users

- Teams running autonomous agents with on-chain budgets (trading, grants,
  operations) who need a verifiable spending guardrail.
- DAO / project treasuries that want agent execution with deterministic,
  auditable policy instead of a multisig bottleneck.
- Developers building on TapeOut who need a reference for "circuit as
  authorisation logic".

## Revenue model

- Free for small treasuries (self-hosted agent + vault).
- Paid hosted tier: managed agent + monitoring + policy templates (e.g.
  $19–$49/mo per treasury) and a small basis-point fee on guarded volume for
  large treasuries. Users keep paying because the circuit proof is the audit
  trail: every spend is provably policy-checked, which is what insurers and
  DAO voters ask for before letting an agent touch money.

## Demo video outline (≤ 3 min)

1. (0:00–0:30) Problem: agents with wallets, no guardrails; one bad decision
   drains a treasury.
2. (0:30–1:30) Live demo: valid spend approved by agent + executed on the
   X Layer fork; revoked-recipient spend rejected by the agent AND blocked
   on-chain even with a rogue signature; replay reverts.
3. (1:30–2:15) The circuit: 10 NAND gates on screen, all-ones authorises;
   TapeOut processor + live fees on X Layer.
4. (2:15–3:00) Users, business model, links (repo, vault, circuit id).

## Links

- Repo: https://github.com/melatim80186/tape-gate-xlayer
- Demo: `node scripts/demo.mjs` (13 checks, fork of X Layer mainnet)
- Live demo UI: `web/` (after demo run)
