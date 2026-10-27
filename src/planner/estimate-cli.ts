import { loadPlanFile } from "./bridge.js";
import { estimatePlan } from "./estimate.js";

function usage(): never {
  console.log(`cliyard estimate-plan — heuristic cost/time/turn estimate

Usage:
  cliyard estimate-plan <plan.json|->

Ranges are planning aids, not invoices. guardBudgetUsd is a conservative
Claude Code local budget. apiCostCny* is a historical deepseek-flash public
price reference; it does not describe the current account's price or balance.
`);
  process.exit(1);
}

export function runEstimatePlanCli(argv: string[]): void {
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    usage();
  }
  const file = argv.find((value) => value === "-" || !value.startsWith("--"));
  if (!file) usage();
  console.log(JSON.stringify(estimatePlan(loadPlanFile(file!)), null, 2));
}
