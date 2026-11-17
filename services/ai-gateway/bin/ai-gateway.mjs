#!/usr/bin/env node
// Pet AI gateway on http://0.0.0.0:8787/v1/pet (see services/ai-gateway/README.md).
import { register } from "tsx/esm/api";
register();
// JUMPER_* variables from before the rename still work when the FABWRIGHT_* one is not set.
(await import("@fabwright/project-format/legacy")).applyLegacyEnv(process.env);
await import("../src/node/main.ts");
