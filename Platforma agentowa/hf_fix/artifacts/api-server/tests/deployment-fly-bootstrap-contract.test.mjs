import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("Fly API config does not require a release command that the runtime image cannot satisfy", () => {
  const flyToml = fs.readFileSync(path.resolve(__dirname, "../../../fly.hyperflow-api.toml"), "utf8");
  const dockerfile = fs.readFileSync(path.resolve(__dirname, "../Dockerfile"), "utf8");

  assert.doesNotMatch(flyToml, /^\[deploy\]/m, "Fly API config should not define a deploy release_command for the slim runtime image");
  assert.match(dockerfile, /Migrations are NOT run by this image/, "API Dockerfile must continue to declare migrations as out-of-band");
});
