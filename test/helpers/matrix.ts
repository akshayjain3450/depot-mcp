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
    name: 'depot_get_ci_job',
    args: { jobId: 'job_4d0a77' },
    routes: { [RPC.getJob]: ok(fixture('job')) },
  },
  {
    name: 'depot_get_ci_attempt',
    args: { attemptId: 'att_91bc02' },
    routes: { [RPC.getAttempt]: ok(fixture('attempt')) },
  },
  {
    name: 'depot_list_ci_workflows',
    args: {},
    routes: { [RPC.listWorkflows]: ok(fixture('workflows-list')) },
  },
  {
    name: 'depot_get_ci_workflow',
    args: { workflowId: 'wf_2b8e11' },
    routes: { [RPC.getWorkflow]: ok(fixture('workflow')) },
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
    name: 'depot_compare_ci_runs',
    args: { runA: 'run_cmp_a', runB: 'run_cmp_b' },
    routes: {
      [RPC.getRun]: [ok(fixture('compare-run-a')), ok(fixture('compare-run-b'))],
      [RPC.getRunStatus]: [ok(fixture('compare-status-a')), ok(fixture('compare-status-b'))],
      [RPC.getRunMetrics]: [ok(fixture('compare-metrics-a')), ok(fixture('compare-metrics-b'))],
      [RPC.getFailureDiagnosis]: [
        ok(fixture('compare-diagnosis-a')),
        ok(fixture('compare-diagnosis-b')),
      ],
    },
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
    name: 'depot_audit_trust_policies',
    args: {},
    routes: {
      [RPC.listProjects]: ok(fixture('projects')),
      [RPC.listTrustPolicies]: ok({
        trustPolicies: [{ trustPolicyId: 'tp_1', github: { repositoryOwner: 'acme', repository: 'api' } }],
      }),
    },
  },
  {
    name: 'depot_list_project_tokens',
    args: { projectId: 'proj_api7f2' },
    routes: { [RPC.listTokens]: ok(fixture('project-tokens')) },
  },
  {
    name: 'depot_get_usage',
    args: {},
    routes: { [RPC.getUsage]: ok(fixture('usage')) },
  },
  {
    name: 'depot_list_project_usage',
    args: {},
    routes: {
      [RPC.listProjectUsage]: ok(fixture('project-usage')),
      [RPC.listProjects]: ok(fixture('projects')),
    },
  },
  {
    name: 'depot_get_cache_summary',
    args: { projectId: 'proj_api7f2' },
    routes: {
      [RPC.getProject]: ok({
        project: { projectId: 'proj_api7f2', name: 'api', cachePolicy: { keepDays: 14, keepGb: 50 } },
      }),
      [RPC.listProjectUsage]: ok(fixture('project-usage')),
      [RPC.listBuilds]: ok(fixture('builds-list')),
      [RPC.getUsage]: ok(fixture('usage')),
    },
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

/** The same, for the tools registered only when DEPOT_MCP_ENABLE_BETA is set. */
export const BETA_TOOL_MATRIX: readonly ToolInvocation[] = [
  {
    name: 'depot_list_sandboxes',
    args: { states: ['running', 'failed'] },
    routes: { [RPC.listSandboxes]: ok(fixture('sandboxes')) },
  },
  {
    name: 'depot_get_sandbox',
    args: { sandboxId: 'sbx_01j9hzzz0a1b2c3d4e5f' },
    routes: { [RPC.getSandbox]: ok(fixture('sandbox')) },
  },
  {
    name: 'depot_list_registry_repositories',
    args: {},
    routes: {
      [RPC.listRegistryRepositories]: ok(fixture('registry-repositories')),
      [RPC.getRegistryRetentionPolicy]: ok(fixture('registry-retention-policy')),
    },
  },
  {
    name: 'depot_get_registry_image',
    args: { repository: 'acme/api', tag: 'main' },
    routes: { [RPC.getRegistryImageDetail]: ok(fixture('registry-image-detail')) },
  },
];

/**
 * The write tools, one dry-run invocation each. They are only registered with allowWrites on, so
 * the protocol suite iterates this list separately. Every route here is a read RPC: a dry run
 * must never reach a mutating one, and the harness has no route for those anyway.
 */
export const WRITE_TOOL_MATRIX: readonly ToolInvocation[] = [
  {
    name: 'depot_cancel_ci_run',
    args: { runId: 'run_9a1b2c' },
    routes: { [RPC.getRunStatus]: ok(fixture('run-status-running')) },
  },
  {
    name: 'depot_cancel_ci_job',
    args: { jobId: 'job_bb22' },
    routes: { [RPC.getJob]: ok({ ...fixture('job-write'), jobStatus: 'running', jobConclusion: undefined }) },
  },
  {
    name: 'depot_retry_ci_failed_jobs',
    args: { workflowId: 'wf_2b8e11' },
    routes: { [RPC.getWorkflow]: ok(fixture('workflow-write')) },
  },
  {
    name: 'depot_retry_ci_job',
    args: { jobId: 'job_4d0a77' },
    routes: { [RPC.getJob]: ok(fixture('job-write')) },
  },
  {
    name: 'depot_rerun_ci_workflow',
    args: { workflowId: 'wf_2b8e11', allowFullRerun: true },
    routes: { [RPC.getWorkflow]: ok(fixture('workflow-write')) },
  },
  {
    name: 'depot_dispatch_ci_workflow',
    args: { repo: 'acme/api', workflow: 'ci.yml', ref: 'main' },
    routes: { [RPC.listWorkflows]: ok(fixture('workflows-list')) },
  },
  {
    name: 'depot_set_ci_variable',
    args: { name: 'DEPLOY_ENV', value: 'staging' },
    routes: { [RPC.getVariable]: ok(fixture('variable')), [RPC.listSecrets]: ok(fixture('secrets')) },
  },
  {
    name: 'depot_delete_ci_variable',
    args: { name: 'DEPLOY_ENV', allVariants: true },
    routes: { [RPC.getVariable]: ok(fixture('variable')) },
  },
  {
    name: 'depot_create_project',
    args: { name: 'new-project' },
    routes: { [RPC.listProjects]: ok(fixture('projects')) },
  },
  {
    name: 'depot_update_project',
    args: { projectId: 'proj_api7f2', cacheKeepDays: 7 },
    routes: { [RPC.getProject]: ok(fixture('project')) },
  },
];

/**
 * The destructive tools, registered only with allowDestructive on top of allowWrites. The
 * fixture's last build is days before the harness epoch, so the recent-build rule stays quiet.
 */
export const DESTRUCTIVE_TOOL_MATRIX: readonly ToolInvocation[] = [
  {
    name: 'depot_delete_project',
    args: { projectId: 'proj_api7f2', confirmProjectName: 'api' },
    routes: {
      [RPC.getProject]: ok(fixture('project')),
      [RPC.listBuilds]: ok(fixture('builds-list')),
    },
  },
];
