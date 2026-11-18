# TapeOut on X Layer — what is real, what is verified, what is left

## Verified live (2026-11-18, public X Layer RPC `https://rpc.xlayer.tech`)

| Item | Address / value | How verified |
|---|---|---|
| X Layer mainnet | chain 196, RPC live, `eth_chainId` = `0xc4` | `curl` eth_chainId / eth_blockNumber |
| TapeOut processor **TAPELIQUID** | `0x69F663931209096037474d7C20402232E5C762cA`, factory #265 | has code on mainnet; address from official `@taperelay/client` v0.1.0-test.132 `src/starter.mjs` (`STARTERS[196]`) |
| `TAPEOUT_FEE()` on processor | **0.0013 OKB** (1,300,000,000,000,000 wei) | `eth_call` selector `0xadfb2b69`, live |
| Container opener | `0x536adD8F30f03b69f6fbF29d425A816A0dC50106` | has code on mainnet; same source |
| `FEE()` on opener | **0.08 OKB** (80,000,000,000,000,000 wei) | `eth_call` selector `0xc57981b5`, live |
| TapeRelay on X Layer | 3 contracts, 5 nodes (relay1–5), live since 2026-11-10 | KuCoin analysis of @Blonskr's 2026-11-18 announcement; client libs `@taperelay/client`, `@tapestore/client` published 2026-11-17 |
| One-click setup cost | **0.0813 OKB + gas** (tapeout fee + open fee) | `node scripts/tapeout-identity.mjs --dry-run` (read-only, official client code path) |

The 0.0813 OKB figure matches the ~0.08 OKB quoted in the TapeRelay
announcement coverage. Gas price at check time: ~0.00000002 OKB/gas.

## What TapeOut is (context for the submission)

- One NAND gate = one transistor (ERC-1155); a taped-out circuit is an
  ERC-721 NFT whose logic is pure data. Processors are factories that mint
  components and tape out circuits; a circuit's on-chain name is
  `<id>.<area>.<processor>.tape` (X Layer area code `2`, so ours will be
  `<id>.2.265.tape`).
- Identity circuits are the TapeRelay/DeWEB identity primitive: a developer's
  files, keys and plans are registered under their circuit name.
- The hackathon FAQ explicitly allows building on existing TapeOut
  processors/circuits/tools, and says interfaces/computation may run outside
  circuits — what matters is that the project *uses* TapeOut circuits,
  contracts or on-chain data on X Layer and provides the addresses.

## How TapeGate uses TapeOut (honest mapping)

1. **Policy circuit (this repo):** the spend policy is a real NAND netlist
   (`circuit/spend-policy.json`, 10 gates), evaluated on-chain by
   `TapeCircuit.sol`. This is TapeOut-style logic (NAND primitives), in
   TapeGate's own documented byte format — see `docs/NETLIST.md`. It is
   NOT claimed to be a TapeOut VM netlist.
2. **Identity circuit (user step, ~0.0813 OKB + gas):**
   `scripts/tapeout-identity.mjs` tapes out a 1-instruction REF circuit on
   TAPELIQUID via the official `@taperelay/client` (`starterPlan` /
   `refNetlist` — REF burns no transistors, needs no BEM) and opens its
   container. The resulting circuit id is recorded on the vault with
   `setTapeoutCircuit(id)` and goes in the submission form as the
   "processor contract address and circuit ID".
3. **Live reads:** the agent's `GET /tapeout` reads both fees from X Layer
   mainnet on every call (no wallet, no signing) — the demo shows this live.

## What is NOT done yet (needs the user)

- The identity tapeout itself (needs a throwaway wallet funded with ~0.1 OKB
  on X Layer mainnet). `--dry-run` is verified; the real run is 2 transactions.
- Deployment of the vault to X Layer testnet/mainnet (needs a funded deployer;
  `scripts/deploy-xlayer.mjs` is ready).
- Nothing here required, or used, any account, email or funds of the user.
