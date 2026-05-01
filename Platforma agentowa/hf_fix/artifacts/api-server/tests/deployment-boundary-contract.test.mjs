import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configSource = fs.readFileSync(path.resolve(__dirname, "../src/lib/config.ts"), "utf8");
const replitSource = fs.readFileSync(path.resolve(__dirname, "../../../.replit"), "utf8");

test("hardened mode defaults on and deployment workflow requires API_TOKEN", () => {
  assert.match(configSource, /env\("HARDENED_MODE", "true"\) === "true"/);
  assert.match(replitSource, /API_TOKEN:\?API_TOKEN must be set/);
  assert.doesNotMatch(replitSource, /externalPort = 8000/);
  assert.match(replitSource, /HARDENED_MODE=true/);
});
