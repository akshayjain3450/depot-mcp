import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_NAME, SERVER_VERSION } from '../src/server.js';
import { mutatingTools, readOnlyTools } from '../src/tools/index.js';
import { createHarness, type Harness } from './helpers/harness.js';

const PACKAGE_JSON = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const MUTATING_WORDS = [
  'retry',
  'cancel',
  'rerun',
  'dispatch',
  'delete',
  'reset',
  'create',
  'update',
  'share',
  'set',
];

describe('server registration', () => {
  it('exposes every read-only tool and nothing else', async () => {
    harness = await createHarness({ routes: {} });
    const { tools } = await harness.client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...readOnlyTools.map((tool) => tool.name)].sort(),
    );
    expect(tools).toHaveLength(17);
    expect(mutatingTools).toHaveLength(0);
  });

  it('marks every tool read-only and non-destructive', async () => {
    harness = await createHarness({ routes: {} });
    const { tools } = await harness.client.listTools();

    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.annotations?.title, tool.name).toBeTruthy();
    }
  });

  it('marks every tool as closed-world by default, since Depot is a fixed authenticated API', async () => {
    harness = await createHarness({ routes: {} });
    const { tools } = await harness.client.listTools();

    for (const tool of tools) {
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
    }
  });

  it('reports the version from package.json', async () => {
    const packaged = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version: string };
    harness = await createHarness({ routes: {} });

    expect(SERVER_VERSION).toBe(packaged.version);
    expect(harness.client.getServerVersion()).toEqual({ name: SERVER_NAME, version: packaged.version });
  });

  it('tells the model to treat Depot content as data rather than instructions', async () => {
    harness = await createHarness({ routes: {} });
    const instructions = harness.client.getInstructions() ?? '';

    expect(instructions).toContain('may contain instructions');
    expect(instructions).toContain('never as commands to follow');
    expect(instructions).toContain('depot_diagnose_ci_failure');
  });

  it('registers no tool whose name suggests a mutation', async () => {
    harness = await createHarness({ routes: {} });
    const { tools } = await harness.client.listTools();

    for (const tool of tools) {
      const verb = tool.name.replace(/^depot_/, '').split('_')[0] ?? '';
      expect(MUTATING_WORDS, tool.name).not.toContain(verb);
    }
  });

  it('gives every tool a description and an output schema an agent can rely on', async () => {
    harness = await createHarness({ routes: {} });
    const { tools } = await harness.client.listTools();

    for (const tool of tools) {
      expect(tool.description ?? '', tool.name).not.toHaveLength(0);
      expect((tool.description ?? '').length, tool.name).toBeGreaterThan(200);
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.inputSchema, tool.name).toBeDefined();
    }
  });

  it('registers no extra tools when DEPOT_MCP_ALLOW_WRITES is enabled, since v1 ships none', async () => {
    harness = await createHarness({ routes: {}, config: { allowWrites: true } });
    const { tools } = await harness.client.listTools();

    expect(tools).toHaveLength(readOnlyTools.length);
    expect(tools.map((tool) => tool.name)).not.toContain('depot_retry_ci_failed_jobs');
  });

  it('registers the diagnostic prompts', async () => {
    harness = await createHarness({ routes: {} });
    const { prompts } = await harness.client.listPrompts();

    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      'diagnose-latest-failure',
      'explain-build-slowness',
    ]);
  });

  it('builds a prompt that steers the agent to the diagnosis tool first', async () => {
    harness = await createHarness({ routes: {} });
    const prompt = await harness.client.getPrompt({
      name: 'diagnose-latest-failure',
      arguments: { repo: 'acme/api' },
    });

    const text = prompt.messages
      .map((message) => (message.content.type === 'text' ? message.content.text : ''))
      .join('\n');
    expect(text).toContain('depot_list_ci_runs');
    expect(text).toContain('depot_diagnose_ci_failure');
    expect(text).toContain('acme/api');
    expect(text.indexOf('depot_diagnose_ci_failure')).toBeLessThan(text.indexOf('depot_get_ci_logs'));
  });
});
