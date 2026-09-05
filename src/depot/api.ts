import type { DepotClient } from './client.js';
import type { RpcTarget } from './errors.js';
import type { JsonObject } from './shape.js';

const CI = 'depot.ci.v1.CIService';
const SECRETS = 'depot.ci.v3beta2.SecretService';
const VARIABLES = 'depot.ci.v3beta2.VariableService';
const CORE_ORGANIZATION = 'depot.core.v1.OrganizationService';
const CORE_PROJECT = 'depot.core.v1.ProjectService';
const CORE_BUILD = 'depot.core.v1.BuildService';
const CORE_USAGE = 'depot.core.v1.UsageService';
const BUILD = 'depot.build.v1.BuildService';
const BUILD_REGISTRY = 'depot.build.v1.RegistryService';

function rpc(service: string, method: string): RpcTarget {
  return { service, method };
}

export interface ListRunsRequest {
  status?: string[] | undefined;
  repo?: string | undefined;
  sha?: string | undefined;
  trigger?: string | undefined;
  pr?: number | undefined;
  pageSize?: number | undefined;
  pageToken?: string | undefined;
}

export interface LogsRequest {
  attemptId?: string | undefined;
  jobId?: string | undefined;
  pageToken?: string | undefined;
}

export interface ListArtifactsRequest {
  runId?: string | undefined;
  workflowId?: string | undefined;
  jobId?: string | undefined;
  attemptId?: string | undefined;
  pageSize?: number | undefined;
  pageToken?: string | undefined;
}

export type DiagnosisTargetType = 'RUN' | 'WORKFLOW' | 'JOB' | 'ATTEMPT';

export interface BuildStepsRequest {
  projectId: string;
  buildId: string;
  pageSize?: number | undefined;
  pageToken?: string | undefined;
}

export interface BuildStepLogsRequest extends BuildStepsRequest {
  buildStepDigest: string;
}

export interface UsageWindow {
  startAt: string;
  endAt: string;
}

/**
 * Typed entry points for the Depot RPCs this server actually uses. Responses stay as
 * `JsonObject`: `depot.ci.v1` is documented in prose but published in neither `depot/proto` nor
 * the Buf Schema Registry, so hand-written response interfaces would assert a contract nobody
 * publishes. Callers read fields through the tolerant accessors in `shape.ts` instead.
 */
export class DepotApi {
  constructor(private readonly client: DepotClient) {}

  listOrganizations(): Promise<JsonObject> {
    return this.client.call(rpc(CORE_ORGANIZATION, 'ListOrganizations'), {});
  }

  listProjects(
    request: {
      regionId?: string | undefined;
      pageSize?: number | undefined;
      pageToken?: string | undefined;
    } = {},
  ): Promise<JsonObject> {
    return this.client.call(rpc(CORE_PROJECT, 'ListProjects'), { ...request });
  }

  getProject(projectId: string): Promise<JsonObject> {
    return this.client.call(rpc(CORE_PROJECT, 'GetProject'), { projectId });
  }

  listTrustPolicies(projectId: string): Promise<JsonObject> {
    return this.client.call(rpc(CORE_PROJECT, 'ListTrustPolicies'), { projectId });
  }

  listBuilds(request: {
    projectId: string;
    pageSize?: number | undefined;
    pageToken?: string | undefined;
  }): Promise<JsonObject> {
    return this.client.call(rpc(CORE_BUILD, 'ListBuilds'), { ...request });
  }

  getBuild(buildId: string): Promise<JsonObject> {
    return this.client.call(rpc(CORE_BUILD, 'GetBuild'), { buildId });
  }

  getBuildSteps(request: BuildStepsRequest): Promise<JsonObject> {
    return this.client.call(rpc(BUILD, 'GetBuildSteps'), { ...request });
  }

  getBuildStepLogs(request: BuildStepLogsRequest): Promise<JsonObject> {
    return this.client.call(rpc(BUILD, 'GetBuildStepLogs'), { ...request });
  }

  listImages(request: {
    projectId: string;
    pageSize?: number | undefined;
    pageToken?: string | undefined;
  }): Promise<JsonObject> {
    return this.client.call(rpc(BUILD_REGISTRY, 'ListImages'), { ...request });
  }

  getUsage(window: UsageWindow): Promise<JsonObject> {
    return this.client.call(rpc(CORE_USAGE, 'GetUsage'), { ...window });
  }

  getProjectUsage(request: UsageWindow & { projectId: string }): Promise<JsonObject> {
    return this.client.call(rpc(CORE_USAGE, 'GetProjectUsage'), { ...request });
  }

  listRuns(request: ListRunsRequest): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'ListRuns'), { ...request });
  }

  getRun(runId: string): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'GetRun'), { runId });
  }

  getRunStatus(runId: string): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'GetRunStatus'), { runId });
  }

  getRunMetrics(runId: string): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'GetRunMetrics'), { runId });
  }

  getJobMetrics(jobId: string): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'GetJobMetrics'), { jobId });
  }

  getJobAttemptMetrics(attemptId: string): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'GetJobAttemptMetrics'), { attemptId });
  }

  getJobSummary(request: {
    jobId?: string | undefined;
    attemptId?: string | undefined;
  }): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'GetJobSummary'), { ...request });
  }

  getJobAttemptLogs(request: LogsRequest): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'GetJobAttemptLogs'), { ...request });
  }

  listArtifacts(request: ListArtifactsRequest): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'ListArtifacts'), { ...request });
  }

  getArtifactDownloadUrl(artifactId: string): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'GetArtifactDownloadURL'), { artifactId });
  }

  getFailureDiagnosis(targetId: string, targetType: DiagnosisTargetType): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'GetFailureDiagnosis'), { targetId, targetType });
  }

  /**
   * v3beta2 secret/variable list filters are undocumented, and Connect's JSON codec rejects
   * unknown fields, so the request is deliberately empty and all filtering happens client-side.
   */
  listSecrets(): Promise<JsonObject> {
    return this.client.call(rpc(SECRETS, 'ListSecrets'), {});
  }

  listVariables(): Promise<JsonObject> {
    return this.client.call(rpc(VARIABLES, 'ListVariables'), {});
  }
}
