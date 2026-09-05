import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join(ROOT, 'dist', 'index.js');
const PACKAGE_VERSION = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  version: string;
}).version;

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Spawned {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<Exit>;
}

/** Spawns the built server with a controlled environment: only what the test passes, plus PATH. */
function spawnServer(args: string[], env: Record<string, string> = {}): Spawned {
  const child = spawn(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    err += chunk;
  });
  const exited = new Promise<Exit>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, stdout: () => out, stderr: () => err, exited };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not happen within ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

interface InitializeResult {
  serverInfo: { name: string; version: string };
  instructions?: string;
}

/** Sends the initialize request and resolves with its result, the first JSON line on stdout. */
async function initialize(spawned: Spawned): Promise<InitializeResult> {
  const { child } = spawned;
  if (child.stdout === null || child.stdin === null) {
    throw new Error('child has no stdio');
  }
  const lines = createInterface({ input: child.stdout });
  const firstLine = new Promise<string>((resolve) => {
    lines.once('line', resolve);
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0.0.0' },
      },
    })}\n`,
  );
  const line = await withTimeout(firstLine, 10_000, 'initialize response');
  const message = JSON.parse(line) as { id?: number; result?: InitializeResult; error?: unknown };
  expect(message.id).toBe(1);
  expect(message.error).toBeUndefined();
  if (message.result === undefined) {
    throw new Error(`initialize returned no result: ${line}`);
  }
  return message.result;
}

beforeAll(() => {
  execSync('npm run build', { cwd: ROOT, stdio: 'pipe' });
}, 120_000);

describe('dist/index.js over stdio', () => {
  it('exits 78 with guidance on stderr and nothing on stdout when DEPOT_TOKEN is unset', async () => {
    const spawned = spawnServer([]);
    const exit = await withTimeout(spawned.exited, 10_000, 'exit');

    expect(exit.code).toBe(78);
    expect(spawned.stderr()).toContain('DEPOT_TOKEN is not set');
    expect(spawned.stdout()).toBe('');
  });

  it('prints the package version for --version without needing a token', async () => {
    const spawned = spawnServer(['--version']);
    const exit = await withTimeout(spawned.exited, 10_000, 'exit');

    expect(exit.code).toBe(0);
    expect(spawned.stdout().trim()).toBe(PACKAGE_VERSION);
  });

  it('prints usage for --help and exits 0', async () => {
    const spawned = spawnServer(['--help']);
    const exit = await withTimeout(spawned.exited, 10_000, 'exit');

    expect(exit.code).toBe(0);
    expect(spawned.stdout()).toContain('DEPOT_TOKEN');
    expect(spawned.stdout()).toContain('DEPOT_API_URL');
    expect(spawned.stdout()).toContain('README');
  });

  it('answers initialize on stdout, then exits cleanly when stdin closes', async () => {
    const spawned = spawnServer([], { DEPOT_TOKEN: 'dummy' });

    const result = await initialize(spawned);
    expect(result.serverInfo.name).toBe('depot-mcp');
    expect(result.serverInfo.version).toBe(PACKAGE_VERSION);
    expect(result.instructions ?? '').toContain('depot_diagnose_ci_failure');

    spawned.child.stdin?.end();
    const exit = await withTimeout(spawned.exited, 2_000, 'exit after stdin closed');
    expect(exit.code).toBe(0);
    expect(spawned.stderr()).toContain('ready on stdio');
    expect(spawned.stderr()).not.toContain('—');
  });

  it('exits cleanly on SIGTERM', async () => {
    const spawned = spawnServer([], { DEPOT_TOKEN: 'dummy' });
    await initialize(spawned);

    spawned.child.kill('SIGTERM');
    const exit = await withTimeout(spawned.exited, 2_000, 'exit after SIGTERM');

    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
    expect(spawned.stderr()).toContain('SIGTERM');
  });
});

/** Reads the next line from stdout after `initialize` has consumed the first one. */
function nextStdoutLine(spawned: Spawned, label: string): Promise<string> {
  const { child } = spawned;
  if (child.stdout === null) {
    throw new Error('child has no stdout');
  }
  const lines = createInterface({ input: child.stdout });
  return withTimeout(
    new Promise<string>((resolve) => {
      lines.once('line', resolve);
    }),
    10_000,
    label,
  );
}

describe('dist/index.js over stdio: configuration and protocol details', () => {
  it('exits 78 for an invalid numeric setting without writing to stdout', async () => {
    const spawned = spawnServer([], { DEPOT_TOKEN: 'dummy', DEPOT_MCP_MAX_LOG_PAGES: 'zero' });
    const exit = await withTimeout(spawned.exited, 10_000, 'exit');

    expect(exit.code).toBe(78);
    expect(spawned.stdout()).toBe('');
    expect(spawned.stderr()).toContain('DEPOT_MCP_MAX_LOG_PAGES must be a positive integer');
  });

  it('answers tools/list with all 16 tools and writes nothing but JSON lines to stdout', async () => {
    const spawned = spawnServer([], { DEPOT_TOKEN: 'dummy-token-e2e' });
    await initialize(spawned);

    const reply = nextStdoutLine(spawned, 'tools/list response');
    spawned.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    spawned.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const list = JSON.parse(await reply) as { id?: number; result?: { tools?: unknown[] } };

    expect(list.id).toBe(2);
    expect(list.result?.tools).toHaveLength(16);

    spawned.child.stdin?.end();
    const exit = await withTimeout(spawned.exited, 2_000, 'exit after stdin closed');
    expect(exit.code).toBe(0);

    const stdoutLines = spawned.stdout().split('\n').filter((line) => line.trim() !== '');
    expect(stdoutLines).toHaveLength(2);
    for (const line of stdoutLines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    expect(spawned.stdout()).not.toContain('dummy-token-e2e');
    expect(spawned.stderr()).not.toContain('dummy-token-e2e');
    expect(spawned.stderr()).toContain('16 read-only tool(s), 0 mutating tool(s)');
  });

  it('warns on stderr that DEPOT_MCP_ALLOW_WRITES has no effect', async () => {
    const spawned = spawnServer([], { DEPOT_TOKEN: 'dummy', DEPOT_MCP_ALLOW_WRITES: '1' });
    await initialize(spawned);

    spawned.child.stdin?.end();
    const exit = await withTimeout(spawned.exited, 2_000, 'exit after stdin closed');

    expect(exit.code).toBe(0);
    expect(spawned.stderr()).toContain('no effect');
  });
});
