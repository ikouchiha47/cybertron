#!/usr/bin/env bun
/**
 * Phase 7 CLI Test Runner
 *
 * Usage:
 *   bun run tests/phase7/run.ts                    # run all
 *   bun run tests/phase7/run.ts S4 S15             # select specific
 *   bun run tests/phase7/run.ts S4 --baseline-pitch=45
 *   bun run tests/phase7/run.ts --list
 */

import path from "path";
import { fileURLToPath } from "url";
import { readdirSync } from "fs";
import { runScenarios } from "./harness";
import type { Scenario } from "./harness";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load scenario modules
const scenariosDir = path.join(__dirname, "scenarios");
const files = readdirSync(scenariosDir).filter(f => f.endsWith(".ts") && f !== "index.ts");

const all: Scenario[] = [];
for (const file of files) {
  const mod = await import(`./scenarios/${file}`);
  if (mod.scenario) {
    all.push(mod.scenario);
  }
}

// CLI parse
const args = process.argv.slice(2);
const overrides: Record<string, any> = {};
const targetIds: string[] = [];
let showList = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--list") showList = true;
  else if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=");
    const val = v === "true" ? true : v === "false" ? false : isNaN(Number(v)) ? v : Number(v);
    overrides[k] = val;
  } else {
    targetIds.push(a);
  }
}

if (showList) {
  console.log("Available scenarios:");
  for (const s of all) {
    console.log(`  ${s.id.padEnd(20)} ${s.name}`);
    console.log(`${"".padEnd(22)}params: ${JSON.stringify(s.params)}`);
  }
  process.exit(0);
}

const toRun = targetIds.length === 0 ? all : all.filter(s => targetIds.includes(s.id) || targetIds.includes(s.name.toLowerCase().replace(/\s+/g, "-")));

console.log(`\n═══ Phase 7 — ${toRun.length} scenario(s) ═══\n`);

const result = runScenarios(toRun, overrides);

console.log(`\n${"=".repeat(50)}`);
console.log(`${result.passed} passed, ${result.failed} failed`);
if (result.errors.length) {
  console.log("\nFailures:");
  for (const e of result.errors) {
    console.log(`\n${e.id}:\n${e.error}`);
  }
}
process.exit(result.failed === 0 ? 0 : 1);
