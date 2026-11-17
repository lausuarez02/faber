#!/usr/bin/env node
// Local firmware build service on http://127.0.0.1:7781 (see services/runner/README.md).
import { register } from "tsx/esm/api";
register();
await import("../src/main.ts");
