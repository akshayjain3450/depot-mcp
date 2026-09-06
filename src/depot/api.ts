import {
  decodeGetBuildStepLogsResponse,
  decodeGetBuildStepsResponse,
  encodeGetBuildStepLogsRequest,
  encodeGetBuildStepsRequest,
} from './build-proto.js';
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
const SANDBOX = 'depot.sandbox.v1.SandboxService';
const REGISTRY = 'depot.registry.v1beta1.RegistryService';

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

/**
 * Verified live on 2026-09-06: GetFailureDiagnosis accepts `targetType` only as the protobuf enum
 * number. Every symbolic spelling (`RUN`, `TARGET_TYPE_RUN`, `run`, snake_case field name) is
 * answered with 400 "target_type is required"; 5 gives "Unsupported target_type: 5".
 */
export const DIAGNOSIS_TARGET_TYPE_WIRE: Readonly<Record<DiagnosisTargetType, number>> = {
  RUN: 1,
  WORKFLOW: 2,
  JOB: 3,
  ATTEMPT: 4,
};

/** The same table read backwards, for responses that echo the target as a number. */
export const DIAGNOSIS_TARGET_TYPE_NAMES: Readonly<Record<number, string>> = {
  1: 'run',
  2: 'workflow',
  3: 'job',
  4: 'attempt',
};

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
 * From depot/sandbox-sdk sandbox.proto. Protobuf JSON spells enum values by their full name, and
 * Depot's JSON binding accepted `SANDBOX_STATUS_RUNNING` inside `filter.states` on 2026-09-06.
 */
export interface ListSandboxesRequest {
  pageSize?: number | undefined;
  pageToken?: string | undefined;
  filter?:
    | {
        states?: string[] | undefined;
        createdAfter?: string | undefined;
        createdBefore?: string | undefined;
      }
    | undefined;
}

/** The registry service pages by number (`page`, `pageSize`, `hasMore`), not by token. */
export interface RegistryPageRequest {
  page?: number | undefined;
  pageSize?: number | undefined;
  query?: string | undefined;
}

export interface ListRegistryImagesRequest {
  repository: string;
  page?: number | undefined;
  pageSize?: number | undefined;
  tagQuery?: string | undefined;
  tagStatus?: string | undefined;
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

  /**
   * Both build-step RPCs go over Connect's binary protobuf encoding: their JSON binding fails on
   * Depot's side (the server cannot encode its own response, observed 2026-09-06), while the
   * binary encoding works. Decoded into the shape the JSON binding would have produced.
   */
  async getBuildSteps(request: BuildStepsRequest): Promise<JsonObject> {
    const result = await this.client.callBinary(
      rpc(BUILD, 'GetBuildSteps'),
      encodeGetBuildStepsRequest(request),
    );
    return result instanceof Uint8Array ? decodeGetBuildStepsResponse(result) : result;
  }

  async getBuildStepLogs(request: BuildStepLogsRequest): Promise<JsonObject> {
    const result = await this.client.callBinary(
      rpc(BUILD, 'GetBuildStepLogs'),
      encodeGetBuildStepLogsRequest(request),
    );
    return result instanceof Uint8Array ? decodeGetBuildStepLogsResponse(result) : result;
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
    return this.client.call(rpc(CI, 'GetFailureDiagnosis'), {
      targetId,
      targetType: DIAGNOSIS_TARGET_TYPE_WIRE[targetType],
    });
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

  // Beta surfaces below. Both services answered the JSON binding with an Organization token on
  // 2026-09-06 (empty lists on a trial organization; `not_found` for unknown ids), so no binary
  // codec is needed. They are reachable only through tools gated by DEPOT_MCP_ENABLE_BETA.

  listSandboxes(request: ListSandboxesRequest = {}): Promise<JsonObject> {
    return this.client.call(rpc(SANDBOX, 'ListSandboxes'), { ...request });
  }

  /** GetSandbox takes a SandboxRef, whose only selector today is `id`. */
  getSandbox(sandboxId: string): Promise<JsonObject> {
    return this.client.call(rpc(SANDBOX, 'GetSandbox'), { id: sandboxId });
  }

  listRegistryRepositories(request: RegistryPageRequest = {}): Promise<JsonObject> {
    return this.client.call(rpc(REGISTRY, 'ListRepositories'), { ...request });
  }

  /** Answers `invalid_argument: Invalid repository` unless `repository` is set (observed live). */
  listRegistryImages(request: ListRegistryImagesRequest): Promise<JsonObject> {
    return this.client.call(rpc(REGISTRY, 'ListImages'), { ...request });
  }

  /** `reference` is a tag or a digest. */
  getRegistryImageDetail(request: { repository: string; reference: string }): Promise<JsonObject> {
    return this.client.call(rpc(REGISTRY, 'GetImageDetail'), { ...request });
  }

  /** An empty object means no policy is configured for the repository. */
  getRegistryRetentionPolicy(repository: string): Promise<JsonObject> {
    return this.client.call(rpc(REGISTRY, 'GetRetentionPolicy'), { repository });
  }
}
