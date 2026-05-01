import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.resolve(__dirname, '../dist/app.mjs');
const hasBuiltDist = fs.existsSync(appPath);

async function withServer(fn) {
  process.env.NODE_ENV = 'test';
  process.env.HARDENED_MODE = 'true';
  process.env.API_TOKEN = 'test-token';
  process.env.DATABASE_URL = 'postgres://user:pass@127.0.0.1:5432/hyperflow_test';
  process.env.HYPERFLOW_CORE_URL = 'http://127.0.0.1:65535';
  const mod = await import(`../dist/app.mjs?ts=${Date.now()}`);
  const app = mod.default;
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try { await fn(baseUrl); } finally { await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
}

test('only livez stays public while other read surfaces require auth', { skip: !hasBuiltDist }, async () => {
  await withServer(async (baseUrl) => {
    const livezResp = await fetch(`${baseUrl}/api/livez`); assert.equal(livezResp.status, 200);
    const readyzResp = await fetch(`${baseUrl}/api/readyz`); assert.equal(readyzResp.status, 401);
    const healthResp = await fetch(`${baseUrl}/api/healthz`); assert.equal(healthResp.status, 401);
    const agentsResp = await fetch(`${baseUrl}/api/agents`); assert.equal(agentsResp.status, 401);
    const metricsResp = await fetch(`${baseUrl}/api/metrics`); assert.equal(metricsResp.status, 401);
  });
});

test('valid bearer token unlocks protected metrics surface', { skip: !hasBuiltDist }, async () => {
  await withServer(async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/metrics`, { headers: { Authorization: 'Bearer test-token' } });
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.match(text, /hyperflow_active_runs|http_requests_total/);
  });
});
