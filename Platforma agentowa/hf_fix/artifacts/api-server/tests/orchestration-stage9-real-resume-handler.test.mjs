import assert from 'node:assert/strict';

// Import the factory for constructing the resume handler.  The module is
// written in plain JavaScript for testability.  It exposes a single
// exported function, createResumeWorkflowHandler().
import { createResumeWorkflowHandler } from './harness/resumeWorkflowHandler.js';

/**
 * Helper to create a stubbed database for testing.  The stub exposes
 * select(), update() and insert() methods mimicking the Drizzle API used by
 * the resume handler.  Each table is represented by a simple object with
 * a name property so the handler can distinguish between them.  Select
 * operations ignore where clauses and simply return the preconfigured
 * rows.  Update and insert operations record their calls for later
 * assertions.
 *
 * @param {Object} opts - Initial data to seed the stub.
 * @param {Array} opts.runs - Array of workflow run records.
 * @param {Array} opts.approvals - Array of approval records.
 * @param {Array} opts.checkpoints - Array of checkpoint records.
 * @param {Array} opts.nodes - Array of workflow run node records.
 * @returns {Object} db stub with tables and call logs.
 */
function makeDbStub({ runs = [], approvals = [], checkpoints = [], nodes = [] }) {
  const updates = [];
  const inserts = [];
  const db = {};
  db.workflowRunsTable = { name: 'workflowRuns' };
  db.approvalsTable = { name: 'approvals' };
  db.checkpointsTable = { name: 'checkpoints' };
  db.workflowRunNodesTable = { name: 'runNodes' };
  db.select = () => ({
    from: (table) => {
      let rows;
      switch (table.name) {
        case 'workflowRuns':
          rows = runs;
          break;
        case 'approvals':
          rows = approvals;
          break;
        case 'checkpoints':
          rows = checkpoints;
          break;
        case 'runNodes':
          rows = nodes;
          break;
        default:
          rows = [];
      }
      return {
        where: () => ({
          limit: async (n) => rows.slice(0, typeof n === 'number' ? n : rows.length),
        }),
        orderBy: async () => rows,
      };
    },
  });
  db.update = (table) => ({
    set: (values) => ({
      where: async () => {
        updates.push({ table: table.name, values });
      },
    }),
  });
  db.insert = (table) => ({
    values: async (value) => {
      inserts.push({ table: table.name, value });
      if (table.name === 'checkpoints') {
        checkpoints.push(value);
      }
    },
  });
  // expose logs for assertions
  db.__updates = updates;
  db.__inserts = inserts;
  return db;
}

// Stub implementation of evaluateResumeEligibility.  Mimics the real
// implementation by rejecting terminal runs and runs with pending approvals.
function defaultEvaluateResumeEligibility(run, pendingApprovalsCount) {
  const terminal = ['completed', 'failed', 'cancelled'];
  if (terminal.includes(run.status)) {
    return { ok: false, error: 'Cannot resume a run in terminal state' };
  }
  if (pendingApprovalsCount > 0) {
    return { ok: false, error: 'Cannot resume while approvals are pending' };
  }
  return { ok: true };
}

// Minimal validateResumeCheckpoint stub.  It can be configured per test
// scenario by returning a closure.
function makeValidateResumeCheckpointStub(ok, error) {
  return function validateResumeCheckpoint() {
    return ok ? { ok: true } : { ok: false, error };
  };
}

// Simple WorkflowResumeBody stub.  It accepts any payload and returns it
// unchanged, pretending validation succeeded.  Tests can override this if
// needed to simulate validation failures.
const WorkflowResumeBodyStub = {
  safeParse(payload) {
    return { success: true, data: payload };
  },
};

// Default configuration and error classifiers used across tests.
const getConfigStub = () => ({ defaultRunTimeoutMs: 1000 });
function classifyErrorStub(err) {
  return { statusCode: 500, message: err.message || String(err), code: 'INTERNAL_ERROR', category: 'internal_error' };
}
function classifyCoreErrorStub(err) {
  return { statusCode: 500, message: err.message || String(err), code: 'CORE_ERROR', category: 'core_error' };
}
const loggerStub = { error: () => {} };

// Helper to make a mock response object capturing status and JSON body.
function makeRes() {
  return {
    statusCode: undefined,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
}

// Test 1: Terminal run rejection.
{
  const db = makeDbStub({ runs: [{ id: 'run1', status: 'completed', runtimeRequest: {} }] });
  const pythonClient = { resumeWorkflow: async () => { throw new Error('Should not be called'); } };
  const handler = createResumeWorkflowHandler({
    db,
    pythonClient,
    evaluateResumeEligibility: defaultEvaluateResumeEligibility,
    validateResumeCheckpoint: makeValidateResumeCheckpointStub(true),
    WorkflowResumeBody: WorkflowResumeBodyStub,
    getConfig: getConfigStub,
    classifyError: classifyErrorStub,
    classifyCoreError: classifyCoreErrorStub,
    logger: loggerStub,
  });
  const req = { params: { id: 'run1' }, body: { completedNodes: [] }, correlationId: undefined };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 409, 'Terminal run should yield 409');
  assert.ok(res.body && res.body.error.includes('terminal'), 'Response should mention terminal state');
  assert.equal(db.__updates.length, 1, 'One DB update should occur for resumability metadata');
  assert.equal(db.__inserts.length, 0, 'No inserts should occur');
  const update1 = db.__updates[0];
  assert.equal(update1.values.resumabilityReason, 'terminal');
  assert.equal(update1.values.blockedNodeId, null);
}

// Test 2: Pending approval rejection.
{
  const db = makeDbStub({ runs: [{ id: 'run2', status: 'running', runtimeRequest: {} }], approvals: [{ id: 'a1', status: 'pending', runId: 'run2', nodeId: 'Node42' }] });
  const pythonClient = { resumeWorkflow: async () => { throw new Error('Should not be called'); } };
  const handler = createResumeWorkflowHandler({
    db,
    pythonClient,
    evaluateResumeEligibility: defaultEvaluateResumeEligibility,
    validateResumeCheckpoint: makeValidateResumeCheckpointStub(true),
    WorkflowResumeBody: WorkflowResumeBodyStub,
    getConfig: getConfigStub,
    classifyError: classifyErrorStub,
    classifyCoreError: classifyCoreErrorStub,
    logger: loggerStub,
  });
  const req = { params: { id: 'run2' }, body: { completedNodes: [] }, correlationId: undefined };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 409, 'Pending approvals should yield 409');
  assert.ok(res.body && res.body.error.includes('approvals'), 'Response should mention approvals');
  assert.equal(db.__updates.length, 1);
  assert.equal(db.__inserts.length, 0);
  const update2 = db.__updates[0];
  assert.equal(update2.values.resumabilityReason, 'pending_approval');
  assert.equal(update2.values.blockedNodeId, 'Node42');
}

// Test 3: Invalid/stale checkpoint rejection.
{
  const db = makeDbStub({ runs: [{ id: 'run3', status: 'running', runtimeRequest: {}, lastCheckpointId: 'chk1', resumableCheckpointId: 'chk1' }], checkpoints: [{ id: 'chk1', runId: 'run3' }] });
  const pythonClient = { resumeWorkflow: async () => { throw new Error('Should not be called'); } };
  const handler = createResumeWorkflowHandler({
    db,
    pythonClient,
    evaluateResumeEligibility: defaultEvaluateResumeEligibility,
    validateResumeCheckpoint: makeValidateResumeCheckpointStub(false, 'Invalid checkpoint'),
    WorkflowResumeBody: WorkflowResumeBodyStub,
    getConfig: getConfigStub,
    classifyError: classifyErrorStub,
    classifyCoreError: classifyCoreErrorStub,
    logger: loggerStub,
  });
  const req = { params: { id: 'run3' }, body: { completedNodes: [], checkpointId: 'chkForeign' }, correlationId: undefined };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 409, 'Invalid checkpoint should yield 409');
  assert.ok(res.body && res.body.error.includes('Invalid'), 'Response should mention invalid checkpoint');
  assert.equal(db.__updates.length, 1);
  assert.equal(db.__inserts.length, 0);
  const update3 = db.__updates[0];
  assert.equal(update3.values.resumabilityReason, 'invalid_checkpoint');
  assert.equal(update3.values.blockedNodeId, null);
}

// Test 4: Valid checkpoint translation and forwarding.
{
  // Node ID mapping: persisted checkpoint 'chk10' maps to node 'node2'.
  const db = makeDbStub({ runs: [{ id: 'run4', status: 'running', runtimeRequest: {}, lastCheckpointId: 'chk10', resumableCheckpointId: 'chk10' }], checkpoints: [{ id: 'chk10', runId: 'run4', nodeId: 'node2' }] });
  let pythonCallCount = 0;
  let lastPayload;
  const pythonClient = {
    resumeWorkflow: async (payload) => {
      pythonCallCount += 1;
      lastPayload = payload;
      return { ok: true, data: { status: 'running', nodes: [] } };
    },
  };
  const handler = createResumeWorkflowHandler({
    db,
    pythonClient,
    evaluateResumeEligibility: defaultEvaluateResumeEligibility,
    validateResumeCheckpoint: makeValidateResumeCheckpointStub(true),
    WorkflowResumeBody: WorkflowResumeBodyStub,
    getConfig: getConfigStub,
    classifyError: classifyErrorStub,
    classifyCoreError: classifyCoreErrorStub,
    logger: loggerStub,
  });
  const req = { params: { id: 'run4' }, body: { completedNodes: [] }, correlationId: undefined };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, undefined, 'No status set means default 200');
  assert.equal(pythonCallCount, 1, 'Python client should be called once');
  assert.ok(lastPayload.checkpointId === 'node2', 'checkpointId should be forwarded as nodeId');
  assert.equal(db.__updates.length, 1, 'Run table should be updated once');
  // No node updates/inserts as no nodes in response
}

// Test 5: Missing checkpoint node mapping omits checkpointId.
{
  const db = makeDbStub({ runs: [{ id: 'run5', status: 'running', runtimeRequest: {}, lastCheckpointId: 'chkX', resumableCheckpointId: 'chkX' }], checkpoints: [{ id: 'chkX', runId: 'run5', nodeId: null }] });
  let pythonPayload;
  const pythonClient = {
    resumeWorkflow: async (payload) => {
      pythonPayload = payload;
      return { ok: true, data: { status: 'running', nodes: [] } };
    },
  };
  const handler = createResumeWorkflowHandler({
    db,
    pythonClient,
    evaluateResumeEligibility: defaultEvaluateResumeEligibility,
    validateResumeCheckpoint: makeValidateResumeCheckpointStub(true),
    WorkflowResumeBody: WorkflowResumeBodyStub,
    getConfig: getConfigStub,
    classifyError: classifyErrorStub,
    classifyCoreError: classifyCoreErrorStub,
    logger: loggerStub,
  });
  const req = { params: { id: 'run5' }, body: { completedNodes: [] }, correlationId: undefined };
  const res = makeRes();
  await handler(req, res);
  assert.ok(!('checkpointId' in pythonPayload), 'checkpointId should be omitted when no node mapping exists');
  assert.equal(db.__updates.length, 1);
}

// Test 6: Successful resume with node updates and checkpoint persistence.
{
  const now = new Date();
  const db = makeDbStub({ runs: [{ id: 'run6', status: 'running', runtimeRequest: {}, lastCheckpointId: null, resumableCheckpointId: null }], checkpoints: [] });
  const pythonClient = {
    resumeWorkflow: async () => {
      return { ok: true, data: { status: 'running', nodes: [ { nodeId: 'nodeA', status: 'completed', result: { value: 42 }, startedAt: now.toISOString(), completedAt: now.toISOString() } ] } };
    },
  };
  const handler = createResumeWorkflowHandler({
    db,
    pythonClient,
    evaluateResumeEligibility: defaultEvaluateResumeEligibility,
    validateResumeCheckpoint: makeValidateResumeCheckpointStub(true),
    WorkflowResumeBody: WorkflowResumeBodyStub,
    getConfig: getConfigStub,
    classifyError: classifyErrorStub,
    classifyCoreError: classifyCoreErrorStub,
    logger: loggerStub,
  });
  const req = { params: { id: 'run6' }, body: { completedNodes: [] }, correlationId: undefined };
  const res = makeRes();
  await handler(req, res);
  // There should be one node update, one checkpoint insert, and one run update
  assert.equal(db.__updates.length, 2, 'Should perform two updates (one node, one run)');
  assert.equal(db.__inserts.length, 1, 'Should insert one checkpoint');
  const inserted = db.__inserts[0];
  assert.equal(inserted.table, 'checkpoints');
  assert.equal(inserted.value.nodeId, 'nodeA');
  // The run update (last update) should reset resumability metadata
  const runUpdate = db.__updates[db.__updates.length - 1];
  assert.equal(runUpdate.values.blockedNodeId, null);
  assert.equal(runUpdate.values.resumabilityReason, 'none');
  assert.ok(res.body && res.body.runId === 'run6', 'Response should include runId');
}

// Test 7: Python failure is surfaced.
{
  const db = makeDbStub({ runs: [{ id: 'run7', status: 'running', runtimeRequest: {} }] });
  let callCount = 0;
  const pythonClient = {
    resumeWorkflow: async () => {
      callCount += 1;
      return { ok: false, error: new Error('core fail') };
    },
  };
  const handler = createResumeWorkflowHandler({
    db,
    pythonClient,
    evaluateResumeEligibility: defaultEvaluateResumeEligibility,
    validateResumeCheckpoint: makeValidateResumeCheckpointStub(true),
    WorkflowResumeBody: WorkflowResumeBodyStub,
    getConfig: getConfigStub,
    classifyError: classifyErrorStub,
    classifyCoreError: classifyCoreErrorStub,
    logger: loggerStub,
  });
  const req = { params: { id: 'run7' }, body: { completedNodes: [] }, correlationId: undefined };
  const res = makeRes();
  await handler(req, res);
  assert.equal(callCount, 1, 'Python client should be invoked');
  assert.equal(res.statusCode, 500, 'Failure should surface as 500');
  assert.ok(res.body && res.body.error.includes('core fail'), 'Error message should propagate');
  assert.equal(db.__updates.length, 0);
  assert.equal(db.__inserts.length, 0);
}

// Test 8: Exception in handler is classified and surfaced.
{
  // Trigger an exception by making db.select throw.  This should be
  // classified via classifyErrorStub and surfaced to the client.
  const err = new Error('db failure');
  const db = {
    workflowRunsTable: { name: 'workflowRuns' },
    approvalsTable: { name: 'approvals' },
    checkpointsTable: { name: 'checkpoints' },
    workflowRunNodesTable: { name: 'runNodes' },
    select() {
      throw err;
    },
    update() {
      throw err;
    },
    insert() {
      throw err;
    },
  };
  const pythonClient = { resumeWorkflow: async () => ({ ok: true, data: {} }) };
  const handler = createResumeWorkflowHandler({
    db,
    pythonClient,
    evaluateResumeEligibility: defaultEvaluateResumeEligibility,
    validateResumeCheckpoint: makeValidateResumeCheckpointStub(true),
    WorkflowResumeBody: WorkflowResumeBodyStub,
    getConfig: getConfigStub,
    classifyError: classifyErrorStub,
    classifyCoreError: classifyCoreErrorStub,
    logger: loggerStub,
  });
  const req = { params: { id: 'run8' }, body: { completedNodes: [] }, correlationId: undefined };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 500, 'Exceptions should produce 500');
  assert.ok(res.body && res.body.error, 'Error response should exist');
}