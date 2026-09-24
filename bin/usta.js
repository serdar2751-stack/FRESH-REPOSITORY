#!/usr/bin/env node
// Launcher: prefer the compiled build, fall back to running the TypeScript
// sources directly (Node >= 22.18 strips types natively, as does Bun).
import { existsSync } from "node:fs";

const dist = new URL("../dist/cli.js", import.meta.url);
const entry = existsSync(dist) ? dist : new URL("../src/cli.ts", import.meta.url);
await import(entry.href);
