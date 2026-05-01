import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const retrySnapshotPath = path.resolve(__dirname, '../dist/lib/retrySnapshot.mjs');
const hasBuiltDist = fs.existsSync(retrySnapshotPath);

test('immutable retry preserves stored execution snapshot', { skip: !hasBuiltDist }, async () => {
  const { buildImmutableRetryRequest } = await import(`../dist/lib/retrySnapshot.mjs?ts=${Date.now()}`);
  const request = buildImmutableRetryRequest({ id: 'run-1', agentId: 'agent-a', agentVersion: '1.2.3', resolvedPrompt: 'ignored because runtime request exists', runtimeRequest: { prompt: 'frozen prompt', agent_id: 'agent-a', agent_version: '1.2.3', agent_role: 'reviewer', agent_capabilities: ['analyze', 'report'], run_policy: { timeoutMs: 1234, modelHint: 'frozen-model' } } });
  assert.deepEqual(request, { prompt: 'frozen prompt', agent_id: 'agent-a', agent_version: '1.2.3', agent_role: 'reviewer', agent_capabilities: ['analyze', 'report'], run_policy: { timeoutMs: 1234, modelHint: 'frozen-model' } });
});

test('legacy runs without a stored prompt cannot be retried as immutable replays', { skip: !hasBuiltDist }, async () => {
  const { buildImmutableRetryRequest } = await import(`../dist/lib/retrySnapshot.mjs?ts=${Date.now()}`);
  assert.throws(() => buildImmutableRetryRequest({ id: 'run-legacy', agentId: 'agent-a', agentVersion: '1.0.0', resolvedPrompt: null, runtimeRequest: null }), /Immutable retry unavailable/);
});
