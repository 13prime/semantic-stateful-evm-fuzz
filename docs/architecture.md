# Architecture Notes

## Current vertical slice

The bootstrap version of the project is intentionally narrow:

1. Load a manifest describing a toy protocol.
2. Build seed scenarios from manifest metadata.
3. Execute each scenario against a local deterministic harness.
4. Evaluate solvency and conservation invariants.
5. Persist replay artifacts under `artifacts/<manifest-id>/`.

## Near-term evolution

- Replace the local harness with an Anvil-backed executor.
- Move seed scenarios out of manifest metadata into generators and mutators.
- Add semantic extraction outputs as first-class inputs.
- Expand invariants to economic-profit and accounting templates.
