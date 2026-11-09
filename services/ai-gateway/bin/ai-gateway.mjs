#!/usr/bin/env node
// Pet AI gateway on http://0.0.0.0:8787/v1/pet (see services/ai-gateway/README.md).
import { register } from "tsx/esm/api";
register();
await import("../src/node/main.ts");
