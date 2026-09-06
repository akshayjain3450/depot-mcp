#!/usr/bin/env node
// CI smoke test for the built server. Starts `node dist/index.js` over stdio with a dummy
// token, performs the MCP initialize handshake, lists tools, and checks the result.
// No network access is needed: nothing here calls the Depot API.
//
// Usage: node .github/scripts/mcp-smoke.mjs [path/to/dist/index.js]

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

const EXPECTED_TOOL_COUNT = 19;
const EXPECTED_PROMPTS = ['diagnose-latest-failure', 'explain-build-slowness'];
const PROTOCOL_VERSION = '2025-11-25';
const TIMEOUT_MS = 20_000;

const entry = path.resolve(process.argv[2] ?? 'dist/index.js');

const child = spawn(process.execPath, [entry], {
  env: { ...process.env, DEPOT_TOKEN: 'dummy-token-for-smoke-test' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const pending = new Map();
let nextId = 1;

const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(`stdout carried a non-JSON line, which would corrupt the JSON-RPC stream: ${line}`);
    return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(`${message.error.code}: ${message.error.message}`));
    } else {
      resolve(message.result);
    }
  }
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  if (stderr) console.error(`--- server stderr ---\n${stderr}`);
  child.kill('SIGTERM');
  process.exit(1);
}

const timer = setTimeout(() => fail(`no response within ${TIMEOUT_MS}ms`), TIMEOUT_MS);

try {
  const init = await request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'depot-mcp-ci-smoke', version: '0.0.0' },
  });
  if (init.serverInfo?.name !== 'depot-mcp') {
    fail(`unexpected serverInfo: ${JSON.stringify(init.serverInfo)}`);
  }
  if (!init.capabilities?.tools) {
    fail('server did not advertise the tools capability');
  }
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const { tools } = await request('tools/list');
  if (!Array.isArray(tools) || tools.length !== EXPECTED_TOOL_COUNT) {
    fail(`expected ${EXPECTED_TOOL_COUNT} tools, got ${Array.isArray(tools) ? tools.length : typeof tools}`);
  }
  const notReadOnly = tools.filter(
    (tool) => tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint !== false,
  );
  if (notReadOnly.length > 0) {
    fail(`tools missing readOnlyHint/destructiveHint annotations: ${notReadOnly.map((t) => t.name).join(', ')}`);
  }
  const badNames = tools.filter((tool) => !/^depot_[a-z_]+$/.test(tool.name));
  if (badNames.length > 0) {
    fail(`tool names outside the depot_<verb>_<noun> convention: ${badNames.map((t) => t.name).join(', ')}`);
  }

  const { prompts } = await request('prompts/list');
  const promptNames = (prompts ?? []).map((p) => p.name).sort();
  for (const expected of EXPECTED_PROMPTS) {
    if (!promptNames.includes(expected)) {
      fail(`prompt ${expected} is missing; got ${promptNames.join(', ') || '(none)'}`);
    }
  }

  if (stderr.includes('dummy-token-for-smoke-test')) {
    fail('the token was echoed to stderr');
  }

  clearTimeout(timer);
  console.log(
    `SMOKE OK: ${tools.length} read-only tools, ${promptNames.length} prompts, protocol ${init.protocolVersion}`,
  );
  child.kill('SIGTERM');
  await once(child, 'exit');
  process.exit(0);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
