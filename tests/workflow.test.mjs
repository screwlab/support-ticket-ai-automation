import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = JSON.parse(await readFile(path.join(root, 'workflows', 'ticket-routing.json'), 'utf8'));
const mockModel = JSON.parse(await readFile(path.join(root, 'workflows', 'mock-model.json'), 'utf8'));

function node(name, source = workflow) {
  const found = source.nodes.find((item) => item.name === name);
  assert.ok(found, `Missing node ${name}`);
  return found;
}

function targets(name, output = 0) {
  return workflow.connections[name]?.main?.[output]?.map((item) => item.node) || [];
}

// Runs a Code node the way n8n would. JavaScript: $input is the incoming item, $('Node') resolves to
// `ticket`, $runIndex is the node's run number inside the retry loop, $getWorkflowStaticData returns
// `staticData` (kept between calls by the caller). Python (n8n's native runner exposes only `_items`):
// the code is wrapped in a function and executed by the local python3.
function runCode(name, json, { ticket = json, staticData = {}, runIndex = 0, source = workflow } = {}) {
  const { parameters } = node(name, source);
  if (parameters.language === 'pythonNative') {
    const script = [
      'import json, sys',
      'def _run(_items):',
      ...parameters.pythonCode.split('\n').map((line) => `    ${line}`),
      'print(json.dumps(_run(json.load(sys.stdin))))',
    ].join('\n');
    const output = JSON.parse(execFileSync('python3', ['-c', script], { input: JSON.stringify([{ json }]), encoding: 'utf8' }));
    return output[0].json;
  }
  const output = vm.runInNewContext(`(function(){${parameters.jsCode}\n})()`, {
    $input: { first: () => ({ json }), all: () => [{ json }] },
    $: () => ({ first: () => ({ json: ticket }) }),
    $getWorkflowStaticData: () => staticData,
    $runIndex: runIndex,
  });
  return JSON.parse(JSON.stringify(output[0].json));
}

function maskInWorkflow(message) {
  return runCode('Validate and Mask PII', {
    body: { ticket_id: 'TK-1', customer_email: 'a@b.co', message, tier: 'Free' },
  }).sanitized_message;
}

// Walks the real graph the way n8n would for one webhook request: Code nodes run via runCode, IF nodes
// evaluate their expression, the classify HTTP node is answered by `model(callNumber, requestBody)`, Wait
// records its duration, and the first Respond node ends the run with the HTTP code and body it would send.
function simulate(request, { model = () => ({ statusCode: 500 }), staticData = {} } = {}) {
  const evaluate = (value, json) => (typeof value === 'string' && value.startsWith('={{')
    ? vm.runInNewContext(value.slice(3, -2), { $json: json })
    : value);
  const outputs = {};
  const runs = {};
  const calls = [];
  const waits = [];
  let name = 'Webhook';
  let item = { headers: request.headers || {}, params: {}, query: {}, body: request.body };
  for (let step = 0; step < 100; step++) {
    const current = node(name);
    const runIndex = runs[name] ?? 0;
    runs[name] = runIndex + 1;
    let output = 0;
    switch (current.type) {
      case 'n8n-nodes-base.webhook':
        break;
      case 'n8n-nodes-base.code':
        item = runCode(name, item, { ticket: outputs['Validate and Mask PII'], staticData, runIndex });
        break;
      case 'n8n-nodes-base.if':
        output = evaluate(current.parameters.conditions.boolean[0].value1, item) === true ? 0 : 1;
        break;
      case 'n8n-nodes-base.httpRequest': {
        const body = JSON.parse(vm.runInNewContext(current.parameters.jsonBody.match(/^=\{\{([\s\S]*)\}\}$/)[1], { $json: item }));
        calls.push({ url: evaluate(current.parameters.url, item), body });
        item = model(calls.length, body);
        break;
      }
      case 'n8n-nodes-base.wait':
        waits.push(evaluate(current.parameters.amount, item));
        break;
      case 'n8n-nodes-base.respondToWebhook':
        return { code: evaluate(current.parameters.options.responseCode, item), body: item, calls, waits, runs };
      default:
        throw new Error(`simulate: unsupported node type ${current.type}`);
    }
    outputs[name] = item;
    const next = targets(name, output);
    assert.equal(next.length, 1, `${name} output ${output} must lead to exactly one node`);
    [name] = next;
  }
  throw new Error('simulate: the graph did not reach a Respond node');
}

const assignmentTicket = {
  ticket_id: 'TK-9082',
  customer_email: 'john.doe@techcorp.com',
  message: 'Hi, your API returns 500 error on /v1/billing endpoint. Fix this ASAP!',
  tier: 'Enterprise',
};
const modelSays = (severity, summary = 'API outage on billing endpoint') => () => ({
  statusCode: 200, body: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ severity, summary }) } }] },
});

const piiSamples = [
  'Please contact John at john.smith@company.com or call +1-202-555-0143 regarding order #4412.',
  'Call +1-555-0199 or 88005553535, ref ID 12345678, card 4111 1111 1111 1111, not a card 1234 5678 9012 3456.',
  'Reach +7 (800) 555-35-35 or a.b@sub.example.co.uk; ticket TK-9082, server 500 on /v1/billing.',
];

test('export: short id, credential referenced by name only, every connection resolves', () => {
  const names = new Set(workflow.nodes.map((item) => item.name));
  assert.equal(workflow.id, 'ticket-routing', 'the id doubles as the file name, which make start relies on');
  assert.ok(workflow.id.length <= 21, 'n8n only persists workflow static data for ids of at most 21 chars');
  assert.equal(workflow.active, false);
  assert.equal(node('Webhook').parameters.path, 'support-ticket');
  assert.equal(node('Webhook').parameters.authentication, 'none');
  for (const source of [workflow, mockModel]) {
    // Without webhookId n8n registers the path as <workflowId>/<nodeName>/<path> instead of <path>.
    assert.match(node('Webhook', source).webhookId ?? '', /^[0-9a-f-]{36}$/, `${source.id}: Webhook node needs a webhookId`);
  }
  const withCredentials = workflow.nodes.filter((item) => item.credentials).map((item) => item.name);
  assert.deepEqual(withCredentials, ['Classify Ticket']);
  // id: null makes n8n resolve the credential by name+type at import time, so no instance id or secret is committed.
  assert.deepEqual(node('Classify Ticket').credentials, { deepSeekApi: { id: null, name: 'DeepSeek account' } });
  assert.doesNotMatch(JSON.stringify([workflow, mockModel]), /sk-[A-Za-z0-9]{8,}/);
  for (const [source, branches] of Object.entries(workflow.connections)) {
    assert.ok(names.has(source), `unknown source ${source}`);
    for (const output of branches.main) {
      for (const connection of output) assert.ok(names.has(connection.node), `missing ${connection.node}`);
    }
  }
});

test('graph: validate -> dedupe -> classify loop (3 attempts, 1s/2s backoff) -> route -> respond', () => {
  assert.deepEqual(targets('Webhook'), ['Validate and Mask PII']);
  assert.deepEqual(targets('Validate and Mask PII'), ['Valid Ticket?']);
  assert.deepEqual(targets('Valid Ticket?'), ['Deduplicate Ticket']);
  assert.deepEqual(targets('Valid Ticket?', 1), ['Respond 400 Invalid']);
  assert.deepEqual(targets('Deduplicate Ticket'), ['New Ticket?']);
  assert.deepEqual(targets('New Ticket?'), ['Classify Ticket']);
  assert.deepEqual(targets('New Ticket?', 1), ['Respond 200 Duplicate']);
  assert.deepEqual(targets('Classify Ticket'), ['Normalize Classification']);
  assert.deepEqual(targets('Normalize Classification'), ['Classified?']);
  assert.deepEqual(targets('Classified?'), ['Enterprise Critical?']);
  assert.deepEqual(targets('Classified?', 1), ['Retry?']);
  assert.deepEqual(targets('Retry?'), ['Wait']);
  assert.deepEqual(targets('Retry?', 1), ['Needs Review Response']);
  assert.deepEqual(targets('Wait'), ['Classify Ticket'], 'the retry loop feeds the same classify node again');
  assert.equal(node('Retry?').parameters.conditions.boolean[0].value1, '={{ $json.classification_status === "retryable" && $json.attempt < 3 }}');
  assert.deepEqual(node('Wait').parameters, { resume: 'timeInterval', amount: '={{ $json.attempt }}', unit: 'seconds' });
  assert.deepEqual(targets('Enterprise Critical?'), ['Mock Asana Task']);
  assert.deepEqual(targets('Enterprise Critical?', 1), ['Mock HubSpot Ticket']);
  assert.deepEqual(targets('Mock Asana Task'), ['Mock Slack Alert']);
  assert.deepEqual(targets('Mock Slack Alert'), ['Critical Response']);
  assert.deepEqual(targets('Mock HubSpot Ticket'), ['Standard Response']);
  for (const response of ['Critical Response', 'Standard Response', 'Needs Review Response']) {
    assert.deepEqual(targets(response), ['Respond to Webhook']);
  }
  for (const name of ['Respond 400 Invalid', 'Respond 200 Duplicate', 'Respond to Webhook']) {
    assert.equal(node(name).type, 'n8n-nodes-base.respondToWebhook');
    assert.equal(node(name).parameters.options.responseCode, '={{ $json.http_status }}');
  }
});

test('validation: masks the assignment examples exactly and never echoes the raw email', () => {
  assert.equal(
    maskInWorkflow(piiSamples[0]),
    'Please contact John at [REDACTED_EMAIL] or call [REDACTED_PHONE] regarding order #4412.',
  );
  assert.equal(
    maskInWorkflow(piiSamples[1]),
    'Call [REDACTED_PHONE] or [REDACTED_PHONE], ref ID 12345678, card [REDACTED_CARD], not a card 1234 5678 9012 3456.',
  );
  assert.equal(
    maskInWorkflow('Pay with 4111.1111.1111.1111 and mail ivan@example.рф'),
    'Pay with [REDACTED_CARD] and mail [REDACTED_EMAIL]',
  );
  const valid = runCode('Validate and Mask PII', {
    body: { ticket_id: 'TK-9082', customer_email: 'john.doe@techcorp.com', message: 'Hi', tier: 'Enterprise' },
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.customer_email, '[REDACTED_EMAIL]');
  assert.doesNotMatch(JSON.stringify(valid), /techcorp/);
  const invalid = runCode('Validate and Mask PII', {
    body: { ticket_id: 'TK-1', customer_email: 'not-an-email', message: 'Hi', tier: 'Enterprise' },
  });
  assert.equal(invalid.http_status, 400);
  assert.equal(invalid.valid, undefined);
  assert.doesNotMatch(JSON.stringify(invalid), /not-an-email/);
});

test('validation: the node is src/pii.py verbatim plus n8n glue - one implementation in the repository', async () => {
  const { language, pythonCode } = node('Validate and Mask PII').parameters;
  assert.equal(language, 'pythonNative');
  const pii = await readFile(path.join(root, 'src', 'pii.py'), 'utf8');
  assert.ok(pythonCode.startsWith(pii), 'Validate and Mask PII must begin with the exact content of src/pii.py');
  assert.match(pythonCode.slice(pii.length), /sanitize_pii\(message\)/);
  assert.equal(JSON.stringify(workflow).includes('REDACTED_PHONE]\' : candidate'), false, 'no JavaScript copy of the masking rules');
});

test('classify: request sends only the masked message and asks DeepSeek for strict JSON', () => {
  {
    const model = node('Classify Ticket');
    assert.equal(model.type, 'n8n-nodes-base.httpRequest');
    const url = model.parameters.url.match(/^=\{\{([\s\S]*)\}\}$/)?.[1];
    assert.equal(vm.runInNewContext(url, { $json: {} }), 'https://api.deepseek.com/chat/completions');
    assert.equal(vm.runInNewContext(url, { $json: { mock_model_status: 429 } }), 'http://localhost:5678/webhook/mock-model?status=429');
    assert.equal(model.parameters.authentication, 'predefinedCredentialType');
    assert.equal(model.parameters.nodeCredentialType, 'deepSeekApi');
    assert.equal(model.onError, 'continueRegularOutput');
    assert.equal(model.parameters.options.response.response.fullResponse, true);
    assert.equal(model.parameters.options.response.response.neverError, true);
    const expression = model.parameters.jsonBody.match(/^=\{\{([\s\S]*)\}\}$/)?.[1];
    const body = JSON.parse(vm.runInNewContext(expression, { $json: { sanitized_message: 'masked text', customer_email: 'x@y.z', ticket_id: 'TK-1' } }));
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.max_tokens, 256);
    assert.equal(body.messages[1].content, 'masked text');
    assert.match(body.messages[0].content, /Low, Medium, High, or Critical/);
    assert.equal(body.messages.some((message) => /x@y\.z|TK-1/.test(message.content)), false);
  }
});

test('fixture: mock-model answers with the requested status, an error body or a chat completion', () => {
  assert.equal(mockModel.id, 'mock-model');
  assert.equal(node('Webhook', mockModel).parameters.path, 'mock-model');
  assert.equal(node('Respond', mockModel).parameters.options.responseCode, '={{ $json.http_status }}');
  const reply = (query) => runCode('Build Mock Reply', { query }, { source: mockModel });
  for (const status of [429, 503]) {
    const mocked = reply({ status: String(status) });
    assert.equal(mocked.http_status, status);
    assert.match(mocked.body.error.message, /simulated/);
  }
  assert.equal(reply({ status: '200' }).body.choices[0].message.content, 'not json');
  assert.equal(reply({ status: '200', content: '{"severity":"High","summary":"x"}' }).body.choices[0].finish_reason, 'stop');
  assert.equal(reply({}).http_status, 503);
});

// --- End-to-end scenarios, one per requirement in the assignment (Block 1) ---

test('scenario: the assignment ticket (Enterprise, model says Critical) -> Asana task + Slack alert, 202', () => {
  const run = simulate({ body: assignmentTicket }, { model: modelSays('Critical') });
  assert.equal(run.code, 202);
  assert.equal(run.body.route, 'asana_slack');
  assert.equal(run.body.severity, 'Critical');
  assert.equal(run.body.summary, 'API outage on billing endpoint');
  assert.equal(run.body.asana_task.simulated, true);
  assert.equal(run.body.slack_alert.simulated, true);
  assert.match(run.body.asana_task.name, /\[Critical\] TK-9082/);
  assert.match(run.body.slack_alert.text, /Critical Enterprise ticket TK-9082/);
  assert.equal(run.calls.length, 1);
  assert.deepEqual(run.waits, []);
});

test('scenario: only the masked message reaches the model; the raw email reaches nothing downstream', () => {
  const ticket = { ...assignmentTicket, message: 'Reach me at john.doe@techcorp.com or +1-202-555-0143 - API is down' };
  const run = simulate({ body: ticket }, { model: modelSays('Critical') });
  const request = JSON.stringify(run.calls[0].body);
  assert.equal(run.calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(run.calls[0].body.messages[1].content, 'Reach me at [REDACTED_EMAIL] or [REDACTED_PHONE] - API is down');
  assert.doesNotMatch(request, /techcorp|202-555|TK-9082|Enterprise/);
  assert.doesNotMatch(JSON.stringify(run.body), /john\.doe|techcorp|202-555/);
});

test('scenario: the same ticket_id a second time -> 200 duplicate, no model call, no Asana/Slack', () => {
  const staticData = {};
  const first = simulate({ body: assignmentTicket }, { model: modelSays('Critical'), staticData });
  assert.equal(first.body.route, 'asana_slack');
  const second = simulate({ body: assignmentTicket }, { model: modelSays('Critical'), staticData });
  assert.equal(second.code, 200);
  assert.deepEqual(Object.keys(second.body).sort(), ['first_seen_at', 'http_status', 'status', 'ticket_id']);
  assert.equal(second.body.status, 'duplicate');
  assert.equal(second.calls.length, 0);
  assert.equal(second.runs['Mock Asana Task'], undefined);
  assert.equal(second.runs['Mock Slack Alert'], undefined);
  staticData.seen_tickets['TK-9082'] = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const expired = simulate({ body: assignmentTicket }, { model: modelSays('Critical'), staticData });
  assert.equal(expired.body.route, 'asana_slack', 'an id older than the 7-day TTL is processed again');
});

test('scenario: prototype property names are ordinary ticket_id values and still deduplicate', () => {
  for (const ticketId of ['constructor', 'toString', '__proto__']) {
    const staticData = {};
    const ticket = { ...assignmentTicket, ticket_id: ticketId };
    const first = simulate({ body: ticket }, { model: modelSays('Critical'), staticData });
    assert.equal(first.body.route, 'asana_slack', ticketId + ': first request must be processed');
    const second = simulate({ body: ticket }, { model: modelSays('Critical'), staticData });
    assert.equal(second.code, 200, ticketId);
    assert.equal(second.body.status, 'duplicate', ticketId);
    assert.equal(second.body.ticket_id, ticketId);
    assert.equal(second.calls.length, 0, ticketId + ': duplicate must not reach the model');
  }
});

test('scenario: an ordinary ticket (Free tier, model says Low) -> HubSpot ticket, 202', () => {
  const run = simulate({ body: { ...assignmentTicket, tier: 'Free' } }, { model: modelSays('Low', 'Question about billing') });
  assert.equal(run.code, 202);
  assert.equal(run.body.route, 'hubspot');
  assert.equal(run.body.hubspot_ticket.simulated, true);
  assert.match(run.body.hubspot_ticket.subject, /\[Low\] TK-9082: Question about billing/);
  assert.equal(run.body.asana_task, undefined);
  assert.equal(run.body.slack_alert, undefined);
});

test('scenario: the alert branch needs both conditions - Enterprise+High and Free+Critical go to HubSpot', () => {
  for (const [tier, severity] of [['Enterprise', 'High'], ['Enterprise', 'Medium'], ['Free', 'Critical'], ['Pro', 'Critical']]) {
    const run = simulate({ body: { ...assignmentTicket, tier } }, { model: modelSays(severity) });
    assert.equal(run.body.route, 'hubspot', `${tier} + ${severity}`);
    assert.equal(run.body.severity, severity);
  }
});

test('scenario: invalid payloads -> 400 before any model call, without echoing the bad input', () => {
  const cases = [
    { ...assignmentTicket, customer_email: 'not-an-email' },
    { ...assignmentTicket, message: '' },
    { ...assignmentTicket, ticket_id: 'TK 9082!' },
    { customer_email: 'a@b.co', message: 'Hi', tier: 'Free' },
    { ...assignmentTicket, tier: '' },
  ];
  for (const body of cases) {
    const run = simulate({ body }, { model: modelSays('Critical') });
    assert.equal(run.code, 400, JSON.stringify(body));
    assert.equal(run.body.status, 'invalid_request');
    assert.ok(run.body.errors.length >= 1);
    assert.equal(run.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(run.body), /not-an-email/);
  }
});

test('scenario: model rate-limited (429) on every attempt -> 3 calls, waits 1s then 2s, 202 needs_review', () => {
  const run = simulate({ body: assignmentTicket }, { model: () => ({ statusCode: 429, body: { error: { message: 'rate limited' } } }) });
  assert.equal(run.code, 202);
  assert.deepEqual(run.body, { status: 'needs_review', ticket_id: 'TK-9082', reason: 'model_unavailable', http_status: 202 });
  assert.equal(run.calls.length, 3);
  assert.deepEqual(run.waits, [1, 2]);
  assert.equal(run.runs['Mock Asana Task'], undefined);
  assert.equal(run.runs['Mock HubSpot Ticket'], undefined);
});

test('scenario: model 503 twice, then healthy -> classified on the third attempt and routed normally', () => {
  const healthy = modelSays('Critical');
  const run = simulate({ body: assignmentTicket }, { model: (call, body) => (call < 3 ? { statusCode: 503 } : healthy(call, body)) });
  assert.equal(run.code, 202);
  assert.equal(run.body.route, 'asana_slack');
  assert.equal(run.calls.length, 3);
  assert.deepEqual(run.waits, [1, 2]);
});

test('scenario: transport error (no HTTP status) is retried like an outage', () => {
  const run = simulate({ body: assignmentTicket }, { model: () => ({ error: { message: 'connect ECONNREFUSED' } }) });
  assert.equal(run.body.status, 'needs_review');
  assert.equal(run.calls.length, 3);
  assert.deepEqual(run.waits, [1, 2]);
});

test('scenario: non-retryable failures (401, bad JSON, severity outside the enum) -> needs_review after one call', () => {
  const replies = {
    unauthorized: () => ({ statusCode: 401, body: { error: { message: 'bad key' } } }),
    notJson: () => ({ statusCode: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'Critical outage!' } }] } }),
    badEnum: modelSays('Urgent'),
    emptySummary: modelSays('High', ''),
    truncated: () => ({ statusCode: 200, body: { choices: [{ finish_reason: 'length', message: { content: '{"severity":"High"' } }] } }),
  };
  for (const [label, model] of Object.entries(replies)) {
    const run = simulate({ body: assignmentTicket }, { model });
    assert.equal(run.code, 202, label);
    assert.equal(run.body.status, 'needs_review', label);
    assert.equal(run.body.reason, label === 'unauthorized' ? 'model_unavailable' : 'invalid_classification', label);
    assert.equal(run.calls.length, 1, `${label}: no retry for a non-retryable failure`);
    assert.deepEqual(run.waits, [], label);
  }
});

test('scenario: needs_review releases the dedupe claim so a later request can be processed', () => {
  const failures = {
    unavailable: () => ({ statusCode: 503, body: { error: { message: 'temporarily unavailable' } } }),
    invalid: () => ({ statusCode: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] } }),
  };
  for (const [label, model] of Object.entries(failures)) {
    const staticData = {};
    const failed = simulate({ body: assignmentTicket }, { model, staticData });
    assert.equal(failed.body.status, 'needs_review', label);
    assert.equal(
      Object.prototype.hasOwnProperty.call(staticData.seen_tickets, assignmentTicket.ticket_id),
      false,
      label + ': needs_review must release the claim',
    );
    const retried = simulate({ body: assignmentTicket }, { model: modelSays('Critical'), staticData });
    assert.equal(retried.body.route, 'asana_slack', label);
    assert.equal(retried.calls.length, 1, label);
  }
});

test('scenario: X-Mock-Model-Status reroutes the classify call to the local fixture', () => {
  const run = simulate({ headers: { 'x-mock-model-status': '503' }, body: assignmentTicket }, { model: () => ({ statusCode: 503 }) });
  assert.equal(run.calls[0].url, 'http://localhost:5678/webhook/mock-model?status=503');
  assert.equal(run.calls.length, 3);
  assert.equal(run.body.status, 'needs_review');
  assert.equal(simulate({ body: assignmentTicket }, { model: modelSays('Low') }).calls[0].url, 'https://api.deepseek.com/chat/completions');
});
