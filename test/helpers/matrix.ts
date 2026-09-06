import { fixture, ok, type StubRoutes } from './harness.js';
import { RPC } from './rpcs.js';

/**
 * One known-good invocation per registered tool, backed by the recorded fixtures. Protocol-level
 * tests iterate this so a newly added tool cannot escape the schema and boundedness checks.
 */
export interface ToolInvocation {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly routes: StubRoutes;
}

export const TOOL_MATRIX: readonly ToolInvocation[] = [
  {
    name: 'depot_whoami',
    args: {},
    routes: {
      [RPC.listOrganizations]: ok(fixture('organizations')),
      [RPC.listProjects]: ok(fixture('projects')),
    },
  },
  {
    name: 'depot_diagnose_ci_failure',
    args: { id: 'run_7f3d9c21' },
    routes: { [RPC.getFailureDiagnosis]: ok(fixture('diagnosis-grouped')) },
  },
  {
    name: 'depot_list_ci_runs',
    args: {},
    routes: { [RPC.listRuns]: ok(fixture('list-runs')) },
  },
  {
    name: 'depot_get_ci_run',
    args: { runId: 'run_7f3d9c21' },
    routes: { [RPC.getRun]: ok(fixture('run')), [RPC.getRunStatus]: ok(fixture('run-status')) },
  },
  {
    name: 'depot_wait_for_ci_run',
    args: { runId: 'run_7f3d9c21', timeoutSeconds: 5 },
    routes: { [RPC.getRunStatus]: ok(fixture('run-status')) },
  },
  {
    name: 'depot_get_ci_logs',
    args: { id: 'att_91bc02' },
    routes: { [RPC.getJobAttemptLogs]: [ok(fixture('logs-page1')), ok(fixture('logs-page2'))] },
  },
  {
    name: 'depot_get_ci_job_summary',
    args: { id: 'job_4d0a77' },
    routes: { [RPC.getJobSummary]: ok(fixture('job-summary')) },
  },
  {
    name: 'depot_get_ci_metrics',
    args: { id: 'att_91bc02' },
    routes: { [RPC.getJobAttemptMetrics]: ok(fixture('metrics-attempt')) },
  },
  {
    name: 'depot_list_ci_artifacts',
    args: { runId: 'run_7f3d9c21', withDownloadUrl: true },
    routes: {
      [RPC.listArtifacts]: ok(fixture('artifacts')),
      [RPC.getArtifactDownloadUrl]: ok({ downloadUrl: 'https://signed.example/artifact' }),
    },
  },
  {
    name: 'depot_get_ci_artifact_url',
    args: { artifactId: 'art_7c21aa' },
    routes: {
      [RPC.getArtifactDownloadUrl]: ok({
        downloadUrl:
          'https://artifacts.example.s3.amazonaws.com/art_7c21aa?X-Amz-Date=20260906T120000Z&X-Amz-Expires=900&X-Amz-Signature=abc',
      }),
    },
  },
  {
    name: 'depot_get_build',
    args: { buildId: 'bld_4a91c7' },
    routes: { [RPC.getBuild]: ok(fixture('build')) },
  },
  {
    name: 'depot_diagnose_build',
    args: { buildId: 'bld_4a91c7', projectId: 'proj_api7f2' },
    routes: {
      [RPC.getBuild]: ok(fixture('build')),
      [RPC.getBuildSteps]: ok(fixture('build-steps')),
      [RPC.getBuildStepLogs]: ok(fixture('build-step-logs')),
    },
  },
  {
    name: 'depot_list_builds',
    args: { projectId: 'proj_api7f2' },
    routes: { [RPC.listBuilds]: ok(fixture('builds-list')) },
  },
  {
    name: 'depot_list_projects',
    args: {},
    routes: { [RPC.listProjects]: ok(fixture('projects')) },
  },
  {
    name: 'depot_get_project',
    args: { projectId: 'proj_api7f2' },
    routes: {
      [RPC.getProject]: ok({
        project: {
          projectId: 'proj_api7f2',
          name: 'api',
          regionId: 'us-east-1',
          hardware: 'HARDWARE_16X32',
          organizationId: 'org_1a2b3c',
          cachePolicy: { keepDays: 14, keepGb: 50 },
        },
      }),
      [RPC.listTrustPolicies]: ok({
        trustPolicies: [{ trustPolicyId: 'tp_1', github: { org: 'acme', repository: 'api' } }],
      }),
    },
  },
  {
    name: 'depot_get_usage',
    args: {},
    routes: { [RPC.getUsage]: ok(fixture('usage')) },
  },
  {
    name: 'depot_list_images',
    args: { projectId: 'proj_api7f2' },
    routes: { [RPC.listImages]: ok(fixture('images')) },
  },
  {
    name: 'depot_list_ci_secrets',
    args: {},
    routes: { [RPC.listSecrets]: ok(fixture('secrets')) },
  },
  {
    name: 'depot_list_ci_variables',
    args: {},
    routes: { [RPC.listVariables]: ok(fixture('variables')) },
  },
];
