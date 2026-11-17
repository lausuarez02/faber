# Security policy

## Supported versions

Fabwright is pre-1.0. Only the latest commit on `main` gets security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report it privately through GitHub's "Report a vulnerability" button (Security → Advisories) on the repository. If that is not available, email **security@fabwright.dev (TBD)**.

Please include:

- what an attacker can do, and what they need first (for example, "a crafted `fabwright.json` opened in the app runs script in the page");
- steps or a minimal project file that reproduces it;
- the commit or version you tested.

You will get a reply within 7 days. We will keep you updated while we work on a fix and credit you in the release notes unless you prefer not to be named.

## What is in scope

Fabwright runs untrusted input in the browser, so these matter most:

- **Project files** (`fabwright.json`): anything that gets past schema validation and reaches the DOM, the filesystem or the network.
- **Part visuals** (`visual.svg`): SVGs are inlined into the page. Scripts, event handlers, external references or `foreignObject` content that survives into the page is a vulnerability.
- **Firmware**: an emulated program must not be able to affect the host page beyond its declared outputs (pin states, serial bytes).
- **Build toolchains** (`toolchains/`): a sketch that escapes the build container, or a build that pulls unpinned code.
- **CI configuration** in `.github/`.

Out of scope: problems that need an already compromised machine or browser, and reports that only list missing best-practice headers without a working attack.
