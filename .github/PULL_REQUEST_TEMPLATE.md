## What and why

<!-- One or two sentences. Link the issue: "Closes #123". -->

## How I checked it

<!-- Commands you ran, a screenshot or short clip for UI changes. -->

## Checklist

- [ ] `pnpm typecheck` and `pnpm test` pass locally
- [ ] Added or updated tests for the behavior I changed (a new part has a `model.test.ts` with datasheet numbers)
- [ ] Ran `pnpm gen` and committed the generated files (parts registry, JSON Schema)
- [ ] Parts: `fidelity.json` is updated and honest about what the model does **not** emulate
- [ ] Parts: the visual is original work (nothing copied from closed-source simulators)
- [ ] UI: checked with Playwright on **desktop** and **mobile** (`pnpm test:e2e`), and by eye at phone width
- [ ] Contracts: if I changed a public API, I updated `docs/contracts.md`
- [ ] No secrets, tokens or personal data in the diff
