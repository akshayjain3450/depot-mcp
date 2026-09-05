/**
 * Encoders and decoders for the two `depot.build.v1.BuildService` RPCs this server calls over
 * Connect's binary protobuf encoding, because their JSON binding is broken on Depot's side (see
 * `protobuf.ts`). Field numbers come from Depot's published schema,
 * https://github.com/depot/proto/blob/main/proto/depot/build/v1/build.proto (fetched 2026-09-06).
 *
 * Decoders return the same camelCase JSON shape the JSON binding would have produced, so the
 * parsers in `lib/build.ts` and the recorded fixtures in `test/fixtures/` stay valid.
 */
import type { BuildStepLogsRequest, BuildStepsRequest } from './api.js';
import {
  decodeMessage,
  fieldBool,
  fieldInt,
  fieldMessages,
  fieldString,
  fieldTimestamp,
  ProtobufWriter,
  type DecodedMessage,
} from './protobuf.js';
import type { JsonObject } from './shape.js';

// GetBuildStepsRequest { project_id = 1; build_id = 2; page_size = 3; page_token = 4; }
export function encodeGetBuildStepsRequest(request: BuildStepsRequest): Uint8Array {
  return new ProtobufWriter()
    .string(1, request.projectId)
    .string(2, request.buildId)
    .int32(3, request.pageSize)
    .string(4, request.pageToken)
    .finish();
}

// GetBuildStepLogsRequest { project_id = 1; build_id = 2; build_step_digest = 3; page_size = 4; page_token = 5; }
export function encodeGetBuildStepLogsRequest(request: BuildStepLogsRequest): Uint8Array {
  return new ProtobufWriter()
    .string(1, request.projectId)
    .string(2, request.buildId)
    .string(3, request.buildStepDigest)
    .int32(4, request.pageSize)
    .string(5, request.pageToken)
    .finish();
}

const CACHE_STATE_NAMES: Readonly<Record<number, string>> = {
  0: 'CACHE_STATE_UNSPECIFIED',
  1: 'CACHE_STATE_UNCACHED',
  2: 'CACHE_STATE_CACHED',
};

// GetBuildStepsResponse.BuildStep { name = 1; digest = 2; started_at = 3; completed_at = 4;
//   cache_state = 5; error = 6; has_logs = 7; }
function decodeBuildStep(step: DecodedMessage): JsonObject {
  const cacheState = fieldInt(step, 5);
  return withoutUndefined({
    name: fieldString(step, 1),
    digest: fieldString(step, 2),
    startedAt: fieldTimestamp(step, 3),
    completedAt: fieldTimestamp(step, 4),
    cacheState: cacheState === undefined ? undefined : (CACHE_STATE_NAMES[cacheState] ?? cacheState),
    error: fieldString(step, 6),
    hasLogs: fieldBool(step, 7) ?? false,
  });
}

// GetBuildStepsResponse { repeated BuildStep build_steps = 1; optional string next_page_token = 2; }
export function decodeGetBuildStepsResponse(bytes: Uint8Array): JsonObject {
  const message = decodeMessage(bytes);
  return withoutUndefined({
    buildSteps: fieldMessages(message, 1).map(decodeBuildStep),
    nextPageToken: fieldString(message, 2),
  });
}

// GetBuildStepLogsResponse { repeated Log logs = 1; optional string next_page_token = 6; }
// Log { message = 1; timestamp = 2; }
export function decodeGetBuildStepLogsResponse(bytes: Uint8Array): JsonObject {
  const message = decodeMessage(bytes);
  return withoutUndefined({
    logs: fieldMessages(message, 1).map((log) =>
      withoutUndefined({
        message: fieldString(log, 1),
        timestamp: fieldTimestamp(log, 2),
      }),
    ),
    nextPageToken: fieldString(message, 6),
  });
}

/**
 * Test-only helper: turn an encoded request back into the object a JSON request would have
 * carried, so recorded calls can be asserted the same way for both encodings.
 */
export function decodeBuildRequestForInspection(method: string, bytes: Uint8Array): JsonObject {
  const message = decodeMessage(bytes);
  if (method === 'GetBuildStepLogs') {
    return withoutUndefined({
      projectId: fieldString(message, 1),
      buildId: fieldString(message, 2),
      buildStepDigest: fieldString(message, 3),
      pageSize: fieldInt(message, 4),
      pageToken: fieldString(message, 5),
    });
  }
  return withoutUndefined({
    projectId: fieldString(message, 1),
    buildId: fieldString(message, 2),
    pageSize: fieldInt(message, 3),
    pageToken: fieldString(message, 4),
  });
}

function withoutUndefined(object: Record<string, unknown>): JsonObject {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
