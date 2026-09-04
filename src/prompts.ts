import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

function userPrompt(text: string) {
  return {
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
  };
}

/**
 * Prompts encode Depot's run -> workflow -> job -> attempt hierarchy and the preferred tool order,
 * so an agent does not have to rediscover either.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'diagnose-latest-failure',
    {
      title: 'Diagnose the latest Depot CI failure',
      description:
        'Find the most recent failed Depot CI run, explain why it failed, and propose a fix.',
      argsSchema: {
        repo: z
          .string()
          .optional()
          .describe('Optional "owner/name" to restrict the search to one repository.'),
      },
    },
    ({ repo }) =>
      userPrompt(
        [
          'Find and explain my most recent Depot CI failure, then propose a fix.',
          '',
          'Steps:',
          `1. Call depot_list_ci_runs with status=["failed"] and limit=1${
            repo === undefined ? '' : ` and repo="${repo}"`
          }.`,
          '2. Call depot_diagnose_ci_failure with the runId from step 1. Read its failureGroups (or representativeAttempts) — each carries an error message, a diagnosis, a suggested fix, and the evidence lines.',
          '3. If the state is over_limit, re-call depot_diagnose_ci_failure with one of the ids in narrowerTargets.',
          '4. Only if the diagnosis is not specific enough, call depot_get_ci_logs on the failing attempt id, using a grep term drawn from the error message.',
          '',
          "Then tell me: what broke, which job and step, why, and the smallest change that would fix it. Depot's diagnoses are AI-generated — say which parts you verified against the evidence lines and which you are taking on trust.",
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'explain-build-slowness',
    {
      title: 'Explain why Depot builds are slow',
      description:
        'Analyse recent container builds and usage to work out whether slowness is cache misses, cold builds, or genuinely more work.',
      argsSchema: {
        projectId: z
          .string()
          .optional()
          .describe('Optional project to focus on. Omit to pick from the available projects.'),
      },
    },
    ({ projectId }) =>
      userPrompt(
        [
          'Work out why my Depot container builds are slow.',
          '',
          'Steps:',
          projectId === undefined
            ? '1. Call depot_list_projects and pick the project that looks most active.'
            : `1. Use project ${projectId}.`,
          '2. Call depot_list_builds for it with limit=20. For each build compare cachedSteps against totalSteps, and look at savedDurationSeconds versus buildDurationSeconds.',
          '3. Call depot_get_usage for the last 30 days to see billed minutes against minutes saved.',
          '4. Call depot_diagnose_build on the slowest recent build to see which step dominated and whether it was cached.',
          '',
          'Then tell me whether the cause is a low cache hit ratio (and which step keeps invalidating), an undersized runner, or simply more work than before. Note the project cache policy from step 1 if retention could be evicting layers early.',
        ].join('\n'),
      ),
  );
}
