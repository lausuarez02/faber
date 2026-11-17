# Contributing to Faber

Thanks for helping. Faber gets better mostly through **parts**: one new, well-tested part is worth more than a big refactor. This guide covers setup, the commands you will use, how we write commits, and how to add a part.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

You need:

- **Node 24.** `.nvmrc` pins it, so `nvm use` or `fnm use` picks it up.
- **pnpm 10.** Run `corepack enable` and the version pinned in `package.json` is used.
- **Docker.** Only needed to rebuild firmware with `toolchains/arduino`. Tests and the app use the committed golden `.hex` files, so you can skip it.

```sh
git clone <your fork>
cd faber
pnpm i
pnpm --filter @faber/web exec playwright install chromium   # once, for the browser tests
pnpm dev                                # http://localhost:5173
```

## Commands

| Command | Use it when |
| --- | --- |
| `pnpm dev` | Working on the app. |
| `pnpm typecheck` | Before every commit. Strict TypeScript across all packages. |
| `pnpm test` | Before every commit. Unit tests for all packages (Vitest). |
| `pnpm test:watch` | While writing a model or a solver change. |
| `pnpm test:e2e` | After any UI change. Playwright runs desktop Chrome and a Pixel 7 viewport. |
| `pnpm gen` | After adding or changing anything in `packages/parts/src/parts/` or the project schema. Commit the generated files. |
| `pnpm --filter @faber/<pkg> test` | To test a single package. |

CI runs the same steps (see `.github/workflows/ci.yml`). CI also fails if `pnpm gen` produces a diff, so always commit the regenerated files.

## Ground rules

- **Original work only.** Do not copy assets, SVGs or code from closed-source simulators (Wokwi's parts included). Draw your own part visuals from datasheets and photos of the real part.
- **License compatible.** Every dependency and asset has to be MIT, Apache-2.0, BSD, ISC or OFL (fonts). If you are not sure, ask in the PR.
- **Deterministic simulation.** `sim-core`, `sim-backends` and part models must never read wall-clock time (`Date`, `performance.now`), timers or `Math.random`. Time comes from the simulation clock. If you need noise, use a seeded generator.
- **Honest fidelity.** If a part does not model something, say so in its `fidelity.json`. Do not make an unsimulated feature look like it works. Read [docs/fidelity.md](docs/fidelity.md).
- **No secrets** in commits, fixtures or screenshots.

## Commit style

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <what changed, imperative, lower case>
```

- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`, `build`.
- Scopes: a package or area, e.g. `parts`, `sim-core`, `sim-backends`, `project-format`, `web`, `brand`, `docs`, `ci`. For a single part, use `parts/<part-id>`.

Examples:

```
feat(parts/dht22): add DHT22 temperature and humidity sensor
fix(sim-core): treat an open switch as not stamped instead of a leak
docs: explain how ground nets are merged in M0
```

Keep commits small and focused. Explain *why* in the body when it isn't obvious from the diff.

## Adding a part

The full walkthrough is in **[docs/adding-a-part.md](docs/adding-a-part.md)**. The short version:

1. Create `packages/parts/src/parts/<part-id>/` with these files:
   - `part.json`: pins, props, limits and buy links.
   - `visual.svg`: original artwork, with `data-pin` and `data-bind` attributes.
   - `model.ts`: exports `create`.
   - `fidelity.json`: what the model does and does not emulate.
   - `model.test.ts`: tests against numbers from the datasheet.
2. Run `pnpm gen`, then `pnpm test`.
3. Check the part on the canvas with `pnpm dev`, and check it at a phone width too.
4. Open a PR using the template. The checklist asks for tests, an updated `fidelity.json`, and a Playwright check on desktop and mobile.

The part spec is in [docs/part-spec.md](docs/part-spec.md). If you want to add a whole board or emulator, read [docs/adding-a-board-backend.md](docs/adding-a-board-backend.md).

### Labels

- **`good first issue: part`** is a part request that is ready to pick up. The issue includes a datasheet link, the protocols it needs, and a buy link. Comment on the issue to claim it so two people don't build the same part.
- **`part request`** is a new part someone asked for that still needs details (datasheet, protocols). Maintainers move it to `good first issue: part` once those are filled in.
- **`board backend`** is a request for a new MCU or board family. These are larger and should start with a design note in `docs/decisions/`.
- **`fidelity`** is anything where the sim and real hardware disagree. These reports are very valuable, so please include what the real board did.

## Pull requests

- One topic per PR.
- If you change behavior, add a test that fails without your change.
- If you change the UI, include a screenshot or short clip. Check it at desktop width and at phone width (`pnpm test:e2e` covers both).
- Before changing a public contract (anything in `docs/contracts.md`), update that file too, and say so in the PR description.
- Bigger design changes (a new dependency, a new backend, a format change) start with a short note in `docs/decisions/`. Use the existing ones as a template: options, choice, and why.

## Questions

Open a discussion or a draft PR. Asking early is fine.
