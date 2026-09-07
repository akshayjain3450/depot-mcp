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

export interface ListWorkflowsRequest {
  name?: string | undefined;
  repo?: string | undefined;
  status?: string[] | undefined;
  trigger?: string | undefined;
  sha?: string | undefined;
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

  /**
   * Per depot/proto, ListTokensResponse.Token carries only token_id and description; the secret
   * exists solely in CreateToken's response, which this server never calls. Verified live
   * 2026-09-06 (an organization without project tokens answers `{}`).
   */
  listTokens(projectId: string): Promise<JsonObject> {
    return this.client.call(rpc(CORE_PROJECT, 'ListTokens'), { projectId });
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

  listProjectUsage(
    request: UsageWindow & { pageSize?: number | undefined; pageToken?: string | undefined },
  ): Promise<JsonObject> {
    return this.client.call(rpc(CORE_USAGE, 'ListProjectUsage'), { ...request });
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

  listWorkflows(request: ListWorkflowsRequest): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'ListWorkflows'), { ...request });
  }

  getWorkflow(workflowId: string): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'GetWorkflow'), { workflowId });
  }

  getJob(jobId: string): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'GetJob'), { jobId });
  }

  getAttempt(attemptId: string): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'GetAttempt'), { attemptId });
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

  // Mutating RPCs. Only the write tools behind DEPOT_MCP_ALLOW_WRITES call these; their response
  // shapes are undocumented, so callers read whatever ids come back through `shape.ts`.
  // Request bodies confirmed against Depot on 2026-09-06: each takes a single id.

  cancelRun(runId: string): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'CancelRun'), { runId });
  }

  cancelWorkflow(workflowId: string): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'CancelWorkflow'), { workflowId });
  }

  /** CancelJobRequest is {workflowId, jobId}: verified against Depot's generated bindings and live on 2026-09-07. */
  cancelJob(jobId: string, workflowId: string): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'CancelJob'), { workflowId, jobId });
  }

  /** RetryJobRequest is {workflowId, jobId}; without the workflow Depot answers 400 "Workflow not found" (live, 2026-09-07). */
  retryJob(jobId: string, workflowId: string): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'RetryJob'), { workflowId, jobId });
  }

  retryFailedJobs(workflowId: string): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'RetryFailedJobs'), { workflowId });
  }

  rerunWorkflow(workflowId: string): Promise<JsonObject> {
    return this.client.call(rpc(CI, 'RerunWorkflow'), { workflowId });
  }

  /**
   * Mutating. Field names from Depot's CLI bindings (`pkg/proto/depot/ci/v1/ci.pb.go`,
   * `DispatchWorkflowRequest`): `repo` in owner/name form, `workflow` as the file basename, `ref`
   * a branch or tag, `inputs` a string map; `orgId` is left to the `x-depot-org` header. The
   * response carries `orgId` and `runId`. Never invoked live by this project.
   */
  dispatchWorkflow(request: DispatchWorkflowRequest): Promise<JsonObject> {
    const body: JsonObject = { repo: request.repo, workflow: request.workflow, ref: request.ref };
    if (request.inputs !== undefined && Object.keys(request.inputs).length > 0) {
      body.inputs = { ...request.inputs };
    }
    return this.client.call(rpc(CI, 'DispatchWorkflow'), body);
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

  /**
   * Mutating, beta. `StopSandboxRequest` wraps the SandboxRef under `sandbox` (depot/sandbox-sdk
   * sandbox.proto); a graceful stop that lands in FINISHED. Depot answers `failed_precondition`
   * for a sandbox already in a terminal state. Never invoked live by this project.
   */
  stopSandbox(sandboxId: string): Promise<JsonObject> {
    return this.client.call(rpc(SANDBOX, 'StopSandbox'), { sandbox: { id: sandboxId } });
  }

  /** Mutating, beta. Same shape as StopSandbox; a hard termination that lands in CANCELLED. */
  killSandbox(sandboxId: string): Promise<JsonObject> {
    return this.client.call(rpc(SANDBOX, 'KillSandbox'), { sandbox: { id: sandboxId } });
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
  /**
   * Verified live on 2026-09-06: the lookup is a oneof of `id` or `name`; a missing variable is
   * `not_found` "variable 'X' not found", neither field is `invalid_argument`.
   */
  getVariable(name: string): Promise<JsonObject> {
    return this.client.call(rpc(VARIABLES, 'GetVariable'), { name });
  }

  /** Same lookup as `getVariable`; verified live the same day ("secret 'X' not found"). */
  getSecret(name: string): Promise<JsonObject> {
    return this.client.call(rpc(SECRETS, 'GetSecret'), { name });
  }

  /**
   * Mutating. Field names for the three variable writes come from the generated bindings Depot's
   * open-source CLI vendors (`pkg/proto/depot/ci/v3beta2/variables.pb.go`), not from a live call:
   * this project has never invoked them. `variantName` defaults to "default" server-side.
   */
  setVariableVariant(request: SetVariableVariantRequest): Promise<JsonObject> {
    return this.client.call(rpc(VARIABLES, 'SetVariableVariant'), { ...request });
  }

  /** Mutating. Answers `{deletedVariable: true}` when the last variant went with it. */
  deleteVariableVariant(variantId: string): Promise<JsonObject> {
    return this.client.call(rpc(VARIABLES, 'DeleteVariableVariant'), { variantId });
  }

  /** Mutating. Removes the variable and every variant; the lookup oneof matches GetVariable. */
  deleteVariable(lookup: { id: string } | { name: string }): Promise<JsonObject> {
    return this.client.call(rpc(VARIABLES, 'DeleteVariable'), { ...lookup });
  }

  /**
   * Mutating. Shape from `depot/proto` `CreateProjectRequest`; `hardware` travels as the enum
   * name (`HARDWARE_16X32`), the spelling Depot itself uses in `ListProjects` responses.
   */
  createProject(request: CreateProjectRequest): Promise<JsonObject> {
    return this.client.call(rpc(CORE_PROJECT, 'CreateProject'), { ...request });
  }

  /**
   * Mutating. Shape from `depot/proto` `UpdateProjectRequest`: every field but `projectId` is
   * optional and an omitted one is left as it is. `cachePolicy` is a whole message, so a caller
   * changing one of its two numbers must send both or Depot reads the other as zero.
   */
  updateProject(request: UpdateProjectRequest): Promise<JsonObject> {
    return this.client.call(rpc(CORE_PROJECT, 'UpdateProject'), { ...request });
  }

  /** Mutating and irreversible. `DeleteProjectRequest` is the project id alone. */
  deleteProject(projectId: string): Promise<JsonObject> {
    return this.client.call(rpc(CORE_PROJECT, 'DeleteProject'), { projectId });
  }
}

export interface VariableAttribute {
  /** One of repository, environment, branch, workflow. */
  key: string;
  value: string;
}

export interface SetVariableVariantRequest {
  variableName: string;
  variantName?: string | undefined;
  value: string;
  description?: string | undefined;
  attributes: VariableAttribute[];
}

export interface DispatchWorkflowRequest {
  repo: string;
  workflow: string;
  ref: string;
  inputs?: Readonly<Record<string, string>> | undefined;
}

export interface CreateProjectRequest {
  name: string;
  regionId: string;
  cachePolicy?: { keepDays: number; keepGb: number } | undefined;
  hardware?: string | undefined;
}

export interface UpdateProjectRequest {
  projectId: string;
  name?: string | undefined;
  regionId?: string | undefined;
  cachePolicy?: { keepDays: number; keepGb: number } | undefined;
  hardware?: string | undefined;
}
