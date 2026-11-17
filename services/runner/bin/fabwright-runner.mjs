#!/usr/bin/env node
// Local firmware build service on http://127.0.0.1:7781 (see services/runner/README.md).
import { register } from "tsx/esm/api";
register();
// JUMPER_* variables from before the rename still work when the FABWRIGHT_* one is not set.
(await import("@fabwright/project-format/legacy")).applyLegacyEnv(process.env);
await import("../src/main.ts");
