import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Verify that the Python core is not exposed directly on the host in docker-compose.
// The core service should not define a host port mapping (e.g. "8000:8000").  It
// must only be reachable internally via the api-server.  This regression test
// fails if a ports section is present in the core service definition.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("core service has no host port mapping", () => {
  const compose = fs.readFileSync(path.resolve(__dirname, "../../../docker-compose.yml"), "utf8");
  const lines = compose.split(/\r?\n/);
  let inCore = false;
  for (const line of lines) {
    // Detect entering the core service section (two-space indent followed by 'core:')
    if (/^\s*core:\s*$/.test(line)) {
      inCore = true;
      continue;
    }
    // Detect leaving the core section on the next top-level key (no leading spaces or starting a new service)
    if (inCore && /^  [A-Za-z0-9_-]+:\s*$/.test(line)) {
      break;
    }
    if (inCore && /^\S/.test(line)) {
      break;
    }
    // Within the core section, a ports key indicates a host port mapping.  This must not exist.
    if (inCore && !/^\s*#/.test(line) && /^\s*ports:\s*$/.test(line)) {
      assert.fail("Core service should not define a host port mapping in docker-compose.yml");
    }
  }
});