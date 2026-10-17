#!/usr/bin/env bun
/** Standalone launcher so you can run `bun run fbcli.ts ...` without installing. */
import { main } from "./src/cli.ts";

// Python's `except KeyboardInterrupt: return 130` — Ctrl-C leaves the same code.
process.on("SIGINT", () => process.exit(130));

process.exitCode = await main();
