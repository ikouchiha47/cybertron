#!/usr/bin/env tsx
// Build-time combo validator — npm run validate-combos
// Imports adapter default maps directly — no duplication.

import { ANDROIDTV_DEFAULT_MAPPING, MACDAEMON_DEFAULT_MAPPING } from "../src/devices/adapters/defaultMappings";
import { validateComboMap }           from "../src/gestures/ComboValidator";

const MAPS: Record<string, Record<string, unknown>> = {
  AndroidTV:  ANDROIDTV_DEFAULT_MAPPING,
  MacDaemon:  MACDAEMON_DEFAULT_MAPPING,
};

const errors: string[] = [];

for (const [name, map] of Object.entries(MAPS)) {
  for (const err of validateComboMap(map)) {
    errors.push(`  ${name}: ${err}`);
  }
}

if (errors.length > 0) {
  console.error("❌  Combo validation failed:\n" + errors.join("\n"));
  process.exit(1);
}

console.log("✅  All combo maps valid.");
