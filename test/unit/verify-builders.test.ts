import { afterEach, describe, expect, it } from 'vitest';
import { betaMutatingTools, betaTools, mutatingTools, readOnlyTools } from '../../src/tools/index.js';
import {
  emptyDiscovery,
  expandTemplate,
  fullDiscovery,
  PROMPT_ARGUMENTS,
  READ_TOOL_ARGUMENTS,
  RESOURCE_TEMPLATE_ARGUMENTS,
  WRITE_DRY_RUN_ARGUMENTS,
} from '../../scripts/verify-scenarios.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const readNames = [...readOnlyTools, ...betaTools].map((tool) => tool.name);
const writeNames = [...mutatingTools, ...betaMutatingTools].map((tool) => tool.name);

describe('verify argument builders', () => {
  it('cover every read-only and beta tool, and nothing else', () => {
    expect(Object.keys(READ_TOOL_ARGUMENTS).sort()).toEqual([...readNames].sort());
  });

  it('cover every mutating tool with a dry-run scenario, and nothing else', () => {
    expect(Object.keys(WRITE_DRY_RUN_ARGUMENTS).sort()).toEqual([...writeNames].sort());
  });

  it('cover every registered tool when both gates are open', async () => {
    harness = await createHarness({ routes: {}, config: { allowWrites: true, enableBeta: true } });
    const { tools } = await harness.client.listTools();

    for (const tool of tools) {
      const builder =
        tool.annotations?.readOnlyHint === false
          ? WRITE_DRY_RUN_ARGUMENTS[tool.name]
          : READ_TOOL_ARGUMENTS[tool.name];
      expect(builder, `no verify builder for ${tool.name}`).toBeDefined();
    }
  });

  it('produce arguments for every tool once discovery has found every id', () => {
    const discovery = fullDiscovery();
    for (const [name, build] of Object.entries(READ_TOOL_ARGUMENTS)) {
      expect('args' in build(discovery), name).toBe(true);
    }
    for (const [name, scenario] of Object.entries(WRITE_DRY_RUN_ARGUMENTS)) {
      const built = scenario.build(discovery);
      expect('args' in built, name).toBe(true);
      if ('args' in built) {
        // The dry-run phase proves the default changes nothing, so no builder may set the flag.
        expect(built.args.dryRun, name).toBeUndefined();
      }
    }
  });

  it('skip rather than guess when discovery found nothing', () => {
    const discovery = emptyDiscovery('20260101-0000');
    for (const [name, build] of Object.entries(READ_TOOL_ARGUMENTS)) {
      expect(() => build(discovery), name).not.toThrow();
    }
    for (const [name, scenario] of Object.entries(WRITE_DRY_RUN_ARGUMENTS)) {
      expect(() => scenario.build(discovery), name).not.toThrow();
    }
    expect(READ_TOOL_ARGUMENTS.depot_get_ci_job?.(discovery)).toEqual({
      skip: 'no job available',
    });
  });

  it('cover every prompt and resource template the server advertises', async () => {
    harness = await createHarness({ routes: {} });
    const { prompts } = await harness.client.listPrompts();
    const { resourceTemplates } = await harness.client.listResourceTemplates();

    expect(Object.keys(PROMPT_ARGUMENTS).sort()).toEqual(prompts.map((prompt) => prompt.name).sort());
    expect(Object.keys(RESOURCE_TEMPLATE_ARGUMENTS).sort()).toEqual(
      resourceTemplates.map((template) => template.uriTemplate).sort(),
    );

    const discovery = fullDiscovery();
    for (const prompt of prompts) {
      const built = PROMPT_ARGUMENTS[prompt.name]?.(discovery);
      expect(built !== undefined && 'args' in built, prompt.name).toBe(true);
      if (built !== undefined && 'args' in built) {
        for (const argument of prompt.arguments ?? []) {
          if (argument.required === true) {
            expect(built.args[argument.name], `${prompt.name}.${argument.name}`).toBeTypeOf('string');
          }
        }
      }
    }
    for (const template of resourceTemplates) {
      const built = RESOURCE_TEMPLATE_ARGUMENTS[template.uriTemplate]?.(discovery);
      expect(built !== undefined && 'args' in built, template.uriTemplate).toBe(true);
      if (built !== undefined && 'args' in built) {
        expect(expandTemplate(template.uriTemplate, built.args)).not.toContain('{');
      }
    }
  });
});
