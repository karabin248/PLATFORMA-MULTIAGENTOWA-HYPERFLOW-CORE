import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entrypoint = path.resolve(__dirname, '../dist/index.mjs');
const hasBuiltDist = fs.existsSync(entrypoint);

test('server startup fails fast when DATABASE_URL is missing', { skip: !hasBuiltDist }, async () => {
  const child = spawn(process.execPath, [entrypoint], { env: { ...process.env, PORT: '18081', NODE_ENV: 'test', HARDENED_MODE: 'false', API_TOKEN: '', HYPERFLOW_CORE_URL: 'http://127.0.0.1:65535', DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.notEqual(exitCode, 0); assert.match(stderr, /DATABASE_URL must be set/);
});
