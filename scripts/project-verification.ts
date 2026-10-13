import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DEFAULT_API_URL, loadConfig, type DepotMcpConfig } from '../src/config.js';
import { DepotApi } from '../src/depot/api.js';
import { encodeGetBuildStepLogsRequest, encodeGetBuildStepsRequest } from '../src/depot/build-proto.js';
import { DepotClient, type FetchLike } from '../src/depot/client.js';
import { DepotApiError } from '../src/depot/errors.js';
import { decodeMessage, fieldString } from '../src/depot/protobuf.js';
import { asObject, readNumber, readObjectArray, readString, type JsonObject } from '../src/depot/shape.js';
import { isBuildFailure, parseBuild } from '../src/lib/build.js';
import { parseProject } from '../src/lib/project.js';
import { createServer } from '../src/server.js';

const RPC = {
  project: 'depot.core.v1.ProjectService/GetProject',
  builds: 'depot.core.v1.BuildService/ListBuilds',
  build: 'depot.core.v1.BuildService/GetBuild',
  steps: 'depot.build.v1.BuildService/GetBuildSteps',
  logs: 'depot.build.v1.BuildService/GetBuildStepLogs',
} as const;
const MAX_REQUESTS = 18;

export class ProjectVerificationError extends Error {}

export interface ProjectScope {
  readonly orgId: string;
  readonly projectId: string;
  readonly projectName: string;
}

/** CLI confirmation is independent of .env, so a stale default cannot select another project. */
export function projectVerificationConfig(
  env: NodeJS.ProcessEnv,
  confirmed: { readonly projectId: string; readonly projectName: string },
): { config: DepotMcpConfig; scope: ProjectScope } {
  const config = loadConfig(env);
  if (!confirmed.projectId.trim() || !confirmed.projectName.trim() ||
      config.projectId !== confirmed.projectId || config.orgId === undefined) {
    throw new ProjectVerificationError('Confirm the project ID and name; DEPOT_PROJECT_ID must match and DEPOT_ORG_ID is required.');
  }
  if (config.apiUrl !== DEFAULT_API_URL || config.allowWrites || config.allowDestructive ||
      config.enableBeta || (env.DEPOT_MCP_VERIFY_APPLY?.trim() || '0') !== '0') {
    throw new ProjectVerificationError('Use the default Depot endpoint with writes, destructive tools, beta tools, and verification apply disabled.');
  }
  return {
    config: { ...config, maxLogPages: 1, outputCharBudget: 4_000 },
    scope: { orgId: config.orgId, projectId: confirmed.projectId, projectName: confirmed.projectName },
  };
}

/** Exact request allowlist. Neither an MCP tool annotation nor a project default is a boundary. */
export function createProjectReadGuard(scope: ProjectScope, upstream: FetchLike) {
  let buildId: string | undefined;
  let blocked = false;
  const requests: string[] = [];
  const deny = (): never => {
    blocked = true;
    throw new ProjectVerificationError('Blocked a request outside the approved project verification scope.');
  };

  const guarded: FetchLike = async (url, init) => {
    if (blocked || requests.length >= MAX_REQUESTS || init.method !== 'POST' ||
        new Headers(init.headers).get('x-depot-org') !== scope.orgId) {
      return deny();
    }
    const rpc = Object.values(RPC).find((value) => url === `${DEFAULT_API_URL}/${value}`);
    if (rpc === undefined) return deny();
    const contentType = new Headers(init.headers).get('content-type');
    let expected: string | Uint8Array;
    if (rpc === RPC.project) {
      expected = JSON.stringify({ projectId: scope.projectId });
    } else if (rpc === RPC.builds) {
      expected = JSON.stringify({ projectId: scope.projectId, pageSize: 10 });
    } else {
      if (buildId === undefined) return deny();
      if (rpc === RPC.build) {
        expected = JSON.stringify({ buildId });
      } else if (rpc === RPC.steps) {
        expected = encodeGetBuildStepsRequest({ projectId: scope.projectId, buildId, pageSize: 500 });
      } else {
        if (!(init.body instanceof Uint8Array)) return deny();
        let digest: string | undefined;
        try {
          digest = fieldString(decodeMessage(init.body), 3);
        } catch {
          return deny();
        }
        if (digest === undefined || digest === '') return deny();
        expected = encodeGetBuildStepLogsRequest({
          projectId: scope.projectId, buildId, buildStepDigest: digest, pageSize: 500,
        });
      }
    }
    if (typeof expected === 'string') {
      if (contentType !== 'application/json' || init.body !== expected) return deny();
    } else {
      if (contentType !== 'application/proto' || !(init.body instanceof Uint8Array) ||
          init.body.length !== expected.length || !expected.every((byte, i) => byte === (init.body as Uint8Array)[i])) {
        return deny();
      }
    }
    requests.push(rpc);
    // Redirects must not forward the credential or evade the RPC/body checks above.
    return upstream(url, { ...init, redirect: 'error' });
  };

  return {
    fetch: guarded,
    requests,
    selectBuild(id: string): void {
      if (buildId !== undefined || !id) deny();
      buildId = id;
    },
    assertUnblocked(): void {
      if (blocked) deny();
    },
  };
}

export interface ProjectVerificationOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly projectId: string;
  readonly projectName: string;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** No discovery outside this project, no writes or write previews, and no raw response output. */
export async function verifyProject(options: ProjectVerificationOptions) {
  const { config, scope } = projectVerificationConfig(options.env, options);
  const guard = createProjectReadGuard(scope, options.fetch ?? ((url, init) => fetch(url, init)));
  const api = new DepotApi(new DepotClient({
    ...config, fetch: guard.fetch, sleep: options.sleep, now: options.now,
  }));

  const project = parseProject(await api.getProject(scope.projectId));
  if (project.projectId !== scope.projectId || project.organizationId !== scope.orgId || project.name !== scope.projectName) {
    throw new ProjectVerificationError('The returned project ID, organization, or name did not match the approved scope. Stopped.');
  }
  const listed = readObjectArray(await api.listBuilds({ projectId: scope.projectId, pageSize: 10 }), 'builds');
  const builds = listed.map(parseBuild).filter((build) =>
    build.buildId !== undefined && (isBuildFailure(build.status) || build.status === 'success'),
  );
  const chosen = builds.find((build) => isBuildFailure(build.status)) ?? builds[0];
  if (chosen?.buildId === undefined) {
    throw new ProjectVerificationError('No completed build in the first 10 builds of the approved project. No other project was searched.');
  }
  guard.selectBuild(chosen.buildId);

  const { server } = createServer({ config, fetch: guard.fetch, sleep: options.sleep, now: options.now });
  const client = new Client({ name: 'depot-mcp-project-verify', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const invoke = async (name: string, args: JsonObject): Promise<JsonObject> => {
      const result = await client.callTool({ name, arguments: args });
      guard.assertUnblocked();
      const data = asObject(result.structuredContent);
      if (result.isError === true || data === undefined) {
        throw new ProjectVerificationError(`${name} failed; response content was withheld from the report.`);
      }
      return data;
    };
    const build = await invoke('depot_get_build', { buildId: chosen.buildId });
    if (build.terminal !== true || readString(asObject(build.build), 'buildId') !== chosen.buildId) {
      throw new ProjectVerificationError('The selected build did not match the completed build from the approved project. Stopped.');
    }
    const diagnosis = await invoke('depot_diagnose_build', {
      projectId: scope.projectId, buildId: chosen.buildId, tailLines: 20,
    });
    if (diagnosis.projectId !== scope.projectId || readString(asObject(diagnosis.build), 'buildId') !== chosen.buildId) {
      throw new ProjectVerificationError('Diagnosis returned a different project or build. Stopped.');
    }
    const stepCount = readNumber(diagnosis, 'stepCount') ?? 0;
    return {
      stepsAvailable: diagnosis.stepsUnavailable !== true && stepCount > 0,
      logsUnavailable: diagnosis.logsUnavailable === true,
      stepCount,
      logLinesReturned: Array.isArray(diagnosis.logTail) ? diagnosis.logTail.length : 0,
      logPageCapHit: diagnosis.logPageCapHit,
      maxPagesPerEndpoint: 1,
      requests: guard.requests,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/** Never print a Depot response, transport cause, build command, log line, or credential. */
export function verificationFailureMessage(error: unknown): string {
  if (error instanceof ProjectVerificationError) return error.message;
  if (error instanceof DepotApiError) return `Depot request failed: ${error.code}, HTTP ${error.httpStatus}.`;
  return 'Project verification failed. Details were withheld to keep credentials and private build data out of output.';
}
