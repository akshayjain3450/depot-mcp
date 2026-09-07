import { afterEach, describe, expect, it } from 'vitest';
import { signedUrlExpiry, URL_HANDLING_WARNING } from '../../src/tools/ci-artifacts.js';
import {
  callTool,
  connectError,
  createHarness,
  HARNESS_EPOCH,
  ok,
  type Harness,
} from '../helpers/harness.js';
import { RPC } from '../helpers/rpcs.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const SIGNED_URL =
  'https://depot-artifacts.s3.us-east-1.amazonaws.com/org/art_7c21aa/junit-results.xml?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260906T120000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeef';

describe('depot_get_ci_artifact_url', () => {
  it('sends the artifact id, returns the URL with its expiry, and never fetches it', async () => {
    harness = await createHarness({
      routes: { [RPC.getArtifactDownloadUrl]: ok({ downloadUrl: SIGNED_URL }) },
    });

    const result = await callTool(harness, 'depot_get_ci_artifact_url', { artifactId: 'art_7c21aa' });

    expect(result.isError, result.text).toBe(false);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.body).toEqual({ artifactId: 'art_7c21aa' });
    expect(result.structured).toEqual({
      artifactId: 'art_7c21aa',
      downloadUrl: SIGNED_URL,
      expiresAt: '2026-09-06T12:15:00.000Z',
      expiresInSeconds: 900,
      warning: URL_HANDLING_WARNING,
    });
    expect(result.text).toContain('expires in about 15 minutes, at 2026-09-06T12:15:00.000Z');
    expect(result.text).toContain(SIGNED_URL);
    expect(result.text).toContain('bearer capability');
    expect(result.text).toContain('do not paste it into commit messages');
  });

  it('accepts snake_case and alternative field names for the URL', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getArtifactDownloadUrl]: ok({
          download_url: 'https://signed.example/plain',
          expires_at: '2026-09-06T12:30:00Z',
        }),
      },
    });

    const result = await callTool(harness, 'depot_get_ci_artifact_url', { artifactId: 'art_7c21aa' });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured).toMatchObject({
      downloadUrl: 'https://signed.example/plain',
      expiresAt: '2026-09-06T12:30:00Z',
    });
    expect(result.structured.expiresInSeconds).toBeUndefined();
    expect(result.text).toContain('(short-lived)');
  });

  it('warns when the signature has already lapsed by the server clock', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getArtifactDownloadUrl]: ok({
          url: 'https://signed.example/old?X-Amz-Date=20260906T110000Z&X-Amz-Expires=60',
        }),
      },
    });

    const result = await callTool(harness, 'depot_get_ci_artifact_url', { artifactId: 'art_old' });

    expect(result.isError).toBe(false);
    expect(result.structured.expiresInSeconds).toBeLessThan(0);
    expect(result.text).toContain('appears to have expired already');
  });

  it('errors clearly when Depot answers without a URL', async () => {
    harness = await createHarness({ routes: { [RPC.getArtifactDownloadUrl]: ok({}) } });

    const result = await callTool(harness, 'depot_get_ci_artifact_url', { artifactId: 'art_gone' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('without a download URL for artifact art_gone');
    expect(result.text).toContain('depot_list_ci_artifacts');
  });

  it('translates not_found into a tool error', async () => {
    harness = await createHarness({
      routes: { [RPC.getArtifactDownloadUrl]: connectError(404, 'not_found', 'artifact not found') },
    });

    const result = await callTool(harness, 'depot_get_ci_artifact_url', { artifactId: 'art_missing' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not_found');
  });

  it('rejects a blank artifact id before calling Depot', async () => {
    harness = await createHarness({ routes: {} });

    const result = await callTool(harness, 'depot_get_ci_artifact_url', { artifactId: '  ' });

    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
});

describe('signedUrlExpiry', () => {
  it('derives the expiry from X-Amz-Date and X-Amz-Expires', () => {
    expect(signedUrlExpiry(SIGNED_URL, HARNESS_EPOCH)).toEqual({
      expiresAt: '2026-09-06T12:15:00.000Z',
      expiresInSeconds: 900,
    });
  });

  it('returns undefined for URLs without a readable lifetime', () => {
    expect(signedUrlExpiry('https://signed.example/plain', HARNESS_EPOCH)).toBeUndefined();
    expect(signedUrlExpiry('https://x/?X-Amz-Date=bad&X-Amz-Expires=900', HARNESS_EPOCH)).toBeUndefined();
    expect(signedUrlExpiry('https://x/?X-Amz-Date=20260906T120000Z&X-Amz-Expires=0', HARNESS_EPOCH)).toBeUndefined();
    expect(signedUrlExpiry('not a url', HARNESS_EPOCH)).toBeUndefined();
  });
});
