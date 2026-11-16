# Semantic Stateful EVM Fuzz

A greenfield prototype for semantically guided, state-aware, economically scored Web3 fuzzing.

## Current scope

This first bootstrap focuses on a runnable vertical slice:

- manifest-driven protocol description
- seed scenario execution
- local harness executor for a toy lending protocol
- profit and solvency oracles
- artifact persistence for replay and triage

The repository is structured so a real Anvil/Foundry-backed executor and LLM-assisted semantic extraction can be added without rewriting the core flow.

## Quick start

```bash
npm install
npm run fuzz:run -- --target fixtures/protocols/toy-lending/manifest.json
```

## Notes

- The default executor is `local-harness` so the prototype runs even if Anvil/Foundry are not installed yet.
- Foundry workspace files now live under `contracts/` with `foundry.toml`; use `npm run foundry:build` to compile the Solidity fixtures.
- The `anvil` executor is being brought up incrementally; the first implementation target is the toy vault fixture.
