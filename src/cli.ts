#!/usr/bin/env node
import { main } from "./main.ts";

main().then(
  (code) => {
    process.exitCode = code;
    // Let stdout drain, then exit even if handles (MCP servers, timers) linger.
    setTimeout(() => process.exit(code), 50).unref();
  },
  (err: Error) => {
    console.error(`usta: ${err.message}`);
    process.exit(1);
  },
);
