#!/usr/bin/env node
import { startMonitorServer, readLedgerSnapshot } from "./monitor.js";
import { resolve } from "node:path";
import { resolveRepoRoot } from "./paths.js";

function arg(flag, argv) {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return undefined;
}

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help")) {
  console.log(`dsh-cliyard-monitor — ledger monitor console

Usage:
  node lib/monitor-cli.js [--port 3927] [--repo path] [--ledger path] [--once]
`);
  process.exit(0);
}

const repoRoot = resolveRepoRoot(arg("--repo", argv));
const ledgerPath =
  arg("--ledger", argv) ?? resolve(repoRoot, ".cliyard/ledger.json");

if (argv.includes("--once")) {
  console.log(JSON.stringify(readLedgerSnapshot(ledgerPath), null, 2));
  process.exit(0);
}

const port = Number(arg("--port", argv) ?? 3927);
const mon = await startMonitorServer({ repoRoot, ledgerPath, port });
console.log(`[dsh-cliyard] monitor ${mon.url}`);
console.log(`[dsh-cliyard] ledger ${mon.ledgerPath}`);
console.log("Press Ctrl+C to stop.");
