import { createHash } from 'node:crypto';

import { buildThumbnailObjectKey } from './object-keyspace.mjs';
import { assertPlainObject, normalizeBoolean, normalizeInteger, normalizeString } from './persistence-common.mjs';

export const DEFAULT_MEDIA_PENDING_UPLOAD_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_MEDIA_ORPHAN_RETENTION_MS = 60 * 60 * 1000;
export const DEFAULT_MEDIA_FETCH_TIMEOUT_MS = 20_000;
export const MAX_MEDIA_FETCH_TIMEOUT_MS = 60_000;
export const MEDIA_WRITE_BACKOFF_TTL_SECONDS = 60;
export const CLOUDFLARE_KNOWN_LENGTH_STREAM = Symbol.for('matrix.cloudflare-known-length-stream');
const ANIMATABLE_MEDIA_CONTENT_TYPES = new Set([
  'image/gif',
]);
export const DEFAULT_MEDIA_THUMBNAIL_VARIANTS = Object.freeze([
  Object.freeze({ width: 96, height: 96, method: 'scale', animated: false }),
]);

function normalizeMediaContentType(contentType) {
  return normalizeString(contentType ?? 'application/octet-stream', 'contentType')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

export function buildMxcUri(serverName, mediaId) {
  return `mxc://${normalizeString(serverName, 'serverName')}/${normalizeString(mediaId, 'mediaId')}`;
}

export function parseLegacyUnauthFreezeAt(value) {
  if (value == null || value === '') {
    return null;
  }
  const iso = normalizeString(value, 'legacy_unauth_media_freeze_at');
  const epochMs = Date.parse(iso);
  if (!Number.isFinite(epochMs)) {
    throw new TypeError('legacy_unauth_media_freeze_at must be a valid RFC 3339 timestamp');
  }
  return Object.freeze({
    iso,
    epoch_ms: epochMs,
  });
}

export function computeLegacyUnauthAccessFlag(firstSeenAt, freezeAt) {
  const normalizedFirstSeenAt = normalizeString(firstSeenAt, 'firstSeenAt');
  if (!freezeAt) {
    return true;
  }
  const firstSeenEpochMs = Date.parse(normalizedFirstSeenAt);
  if (!Number.isFinite(firstSeenEpochMs)) {
    throw new TypeError('firstSeenAt must be a valid RFC 3339 timestamp');
  }
  return firstSeenEpochMs < freezeAt.epoch_ms;
}

export function buildMediaConfig(maxUploadBytes) {
  return {
    'm.upload.size': normalizeInteger(maxUploadBytes, 'maxUploadBytes', { min: 1 }),
  };
}

export function isAnimatableMediaContentType(contentType) {
  if (contentType == null) {
    return false;
  }
  return ANIMATABLE_MEDIA_CONTENT_TYPES.has(normalizeMediaContentType(contentType));
}

export function resolveThumbnailAnimationPreference(animated, contentType) {
  return animated === true && isAnimatableMediaContentType(contentType);
}

function buildThumbnailPrefix(variant) {
  const normalizedVariant = normalizeMediaThumbnailJobVariant(variant, 0);
  return Buffer.from(
    `thumbnail:${normalizedVariant.width}x${normalizedVariant.height}:${normalizedVariant.method}:${normalizedVariant.animated ? 'animated' : 'static'}\n`,
    'utf8',
  );
}

export function normalizeDownloadOptions(url, {
  requireThumbnail = false,
} = {}) {
  const width = url.searchParams.get('width');
  const height = url.searchParams.get('height');
  const method = url.searchParams.get('method') ?? 'scale';
  const animated = url.searchParams.get('animated');
  if (requireThumbnail) {
    if (!/^[0-9]+$/.test(width ?? '') || !/^[0-9]+$/.test(height ?? '')) {
      throw new TypeError('width and height are required integer query parameters');
    }
  }
  const normalizedMethod = normalizeString(method, 'method');
  if (!['crop', 'scale'].includes(normalizedMethod)) {
    throw new RangeError('method must be crop or scale');
  }
  return Object.freeze({
    allow_redirect: url.searchParams.get('allow_redirect') === 'true',
    allow_remote: url.searchParams.get('allow_remote') !== 'false',
    timeout_ms: clampTimeout(url.searchParams.get('timeout_ms')),
    width: width == null ? null : normalizeInteger(Number.parseInt(width, 10), 'width', { min: 1 }),
    height: height == null ? null : normalizeInteger(Number.parseInt(height, 10), 'height', { min: 1 }),
    method: normalizedMethod,
    animated: animated == null ? null : normalizeBoolean(animated === 'true', 'animated'),
  });
}

function clampTimeout(rawValue) {
  if (rawValue == null || rawValue === '') {
    return DEFAULT_MEDIA_FETCH_TIMEOUT_MS;
  }
  if (!/^[0-9]+$/.test(String(rawValue))) {
    throw new TypeError('timeout_ms must be a positive integer');
  }
  return Math.min(
    normalizeInteger(Number.parseInt(String(rawValue), 10), 'timeout_ms', { min: 1 }),
    MAX_MEDIA_FETCH_TIMEOUT_MS,
  );
}

export async function readReadableStreamWithDigest(stream, {
  maxBytes,
} = {}) {
  if (!stream || typeof stream.getReader !== 'function') {
    return {
      bytes: Buffer.alloc(0),
      byte_size: 0,
      sha256: createHash('sha256').digest('base64url'),
    };
  }
  const reader = stream.getReader();
  const hash = createHash('sha256');
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (Number.isInteger(maxBytes) && total > maxBytes) {
      throw createContentTooLargeError(maxBytes);
    }
    hash.update(chunk);
    chunks.push(chunk);
  }
  return {
    bytes: Buffer.concat(chunks),
    byte_size: total,
    sha256: hash.digest('base64url'),
  };
}

export async function readReadableStreamDigest(stream, {
  maxBytes,
} = {}) {
  if (!stream || typeof stream.getReader !== 'function') {
    return {
      byte_size: 0,
      sha256: createHash('sha256').digest('base64url'),
    };
  }
  const reader = stream.getReader();
  const hash = createHash('sha256');
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (Number.isInteger(maxBytes) && total > maxBytes) {
      throw createContentTooLargeError(maxBytes);
    }
    hash.update(chunk);
  }
  return {
    byte_size: total,
    sha256: hash.digest('base64url'),
  };
}

export function markCloudflareKnownLengthStream(stream, streamKind = 'request-or-response-body') {
  if (!stream || typeof stream.getReader !== 'function') {
    return stream;
  }
  try {
    Object.defineProperty(stream, CLOUDFLARE_KNOWN_LENGTH_STREAM, {
      value: streamKind,
      configurable: true,
    });
  } catch {
    // Best-effort marker for local fail-closed fakes only.
  }
  return stream;
}

export function teeBodyStreamWithDigest(source, {
  maxBytes,
} = {}) {
  if (!source?.body || typeof source.body.getReader !== 'function') {
    return null;
  }
  const contentLengthHeader = source.headers?.get?.('content-length') ?? null;
  if (!/^[0-9]+$/.test(contentLengthHeader ?? '')) {
    return null;
  }
  const knownLength = Number.parseInt(contentLengthHeader, 10);
  const reader = source.body.getReader();
  const hash = createHash('sha256');
  let total = 0;
  let digestSettled = false;
  let resolveDigest = null;
  let rejectDigest = null;
  const settleDigestSuccess = () => {
    if (digestSettled) {
      return;
    }
    digestSettled = true;
    resolveDigest({
      byte_size: total,
      sha256: hash.digest('base64url'),
    });
  };
  const settleDigestError = (reason) => {
    if (digestSettled) {
      return;
    }
    digestSettled = true;
    rejectDigest(reason instanceof Error ? reason : new Error('Media stream cancelled'));
  };
  const digestPromise = new Promise((resolve, reject) => {
    resolveDigest = resolve;
    rejectDigest = reject;
  });
  if (typeof FixedLengthStream === 'function') {
    const fixedLength = new FixedLengthStream(knownLength);
    const writer = fixedLength.writable.getWriter();
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            settleDigestSuccess();
            await writer.close();
            return;
          }
          const chunk = Buffer.from(value);
          total += chunk.byteLength;
          if (Number.isInteger(maxBytes) && total > maxBytes) {
            throw createContentTooLargeError(maxBytes);
          }
          hash.update(chunk);
          await writer.write(chunk);
        }
      } catch (error) {
        settleDigestError(error);
        await reader.cancel(error).catch(() => {});
        await writer.abort(error).catch(() => {});
      }
    })();
    return {
      upload_stream: markCloudflareKnownLengthStream(fixedLength.readable, 'fixed-length-stream'),
      digest_promise: digestPromise,
    };
  }
  return {
    upload_stream: markCloudflareKnownLengthStream(new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            settleDigestSuccess();
            controller.close();
            return;
          }
          const chunk = Buffer.from(value);
          total += chunk.byteLength;
          if (Number.isInteger(maxBytes) && total > maxBytes) {
            const error = createContentTooLargeError(maxBytes);
            settleDigestError(error);
            await reader.cancel(error).catch(() => {});
            controller.error(error);
            return;
          }
          hash.update(chunk);
          controller.enqueue(chunk);
        } catch (error) {
          settleDigestError(error);
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } catch {
          // Ignore reader cancellation failures during consumer abort.
        }
        settleDigestError(reason);
      },
    }), 'fixed-length-stream'),
    digest_promise: digestPromise,
  };
}

export async function readBodyWithDigest(source, {
  maxBytes,
} = {}) {
  if (source?.body && typeof source.body.getReader === 'function') {
    return readReadableStreamWithDigest(source.body, { maxBytes });
  }
  if (typeof source?.arrayBuffer === 'function') {
    const buffer = Buffer.from(await source.arrayBuffer());
    if (Number.isInteger(maxBytes) && buffer.byteLength > maxBytes) {
      throw createContentTooLargeError(maxBytes);
    }
    return {
      bytes: buffer,
      byte_size: buffer.byteLength,
      sha256: createHash('sha256').update(buffer).digest('base64url'),
    };
  }
  return {
    bytes: Buffer.alloc(0),
    byte_size: 0,
    sha256: createHash('sha256').digest('base64url'),
  };
}

function createContentTooLargeError(maxBytes) {
  return Object.assign(new Error(`Media body exceeds ${maxBytes} bytes`), {
    code: 'content_too_large',
  });
}

function prependReadableStream(prefix, stream, {
  maxBytes,
  knownLength = null,
} = {}) {
  const reader = stream.getReader();
  if (Number.isInteger(knownLength) && typeof FixedLengthStream === 'function') {
    const fixedLength = new FixedLengthStream(knownLength);
    const writer = fixedLength.writable.getWriter();
    void (async () => {
      let sourceBytesRead = 0;
      try {
        await writer.write(prefix);
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            await writer.close();
            return;
          }
          const chunk = Buffer.from(value);
          sourceBytesRead += chunk.byteLength;
          if (Number.isInteger(maxBytes) && sourceBytesRead > maxBytes) {
            throw createContentTooLargeError(maxBytes);
          }
          await writer.write(chunk);
        }
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        await writer.abort(error).catch(() => {});
      }
    })();
    return markCloudflareKnownLengthStream(fixedLength.readable, 'fixed-length-stream');
  }
  let prefixSent = false;
  let sourceBytesRead = 0;
  const readable = new ReadableStream({
    async pull(controller) {
      if (!prefixSent) {
        prefixSent = true;
        controller.enqueue(prefix);
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        const chunk = Buffer.from(value);
        sourceBytesRead += chunk.byteLength;
        if (Number.isInteger(maxBytes) && sourceBytesRead > maxBytes) {
          const error = createContentTooLargeError(maxBytes);
          await reader.cancel(error).catch(() => {});
          controller.error(error);
          return;
        }
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // Ignore cancellation failures while unwinding prefixed stream readers.
      }
    },
  });
  return Number.isInteger(knownLength)
    ? markCloudflareKnownLengthStream(readable, 'fixed-length-stream')
    : readable;
}

export async function createThumbnailBodyInput(source, variant, {
  maxBytes,
} = {}) {
  const prefix = buildThumbnailPrefix(variant);
  const sourceStream = source?.body && typeof source.body.getReader === 'function'
    ? source.body
    : null;
  const sourceSize = Number.isInteger(source?.size)
    ? source.size
    : (Buffer.isBuffer(source?.body) ? source.body.byteLength : null);
  if (Number.isInteger(maxBytes) && Number.isInteger(sourceSize) && sourceSize > maxBytes) {
    await sourceStream?.cancel?.(createContentTooLargeError(maxBytes)).catch(() => {});
    throw createContentTooLargeError(maxBytes);
  }
  if (sourceStream) {
    if (Number.isInteger(sourceSize)) {
      return prependReadableStream(prefix, sourceStream, {
        maxBytes,
        knownLength: prefix.byteLength + sourceSize,
      });
    }
    const bodyInfo = await readReadableStreamWithDigest(sourceStream, { maxBytes });
    return Buffer.concat([prefix, bodyInfo.bytes]);
  }
  if (Buffer.isBuffer(source?.body)) {
    if (Number.isInteger(maxBytes) && source.body.byteLength > maxBytes) {
      throw createContentTooLargeError(maxBytes);
    }
    return Buffer.concat([prefix, source.body]);
  }
  if (typeof source?.arrayBuffer === 'function') {
    const buffer = Buffer.from(await source.arrayBuffer());
    if (Number.isInteger(maxBytes) && buffer.byteLength > maxBytes) {
      throw createContentTooLargeError(maxBytes);
    }
    return Buffer.concat([prefix, buffer]);
  }
  if (typeof source?.text === 'function') {
    const buffer = Buffer.from(await source.text(), 'utf8');
    if (Number.isInteger(maxBytes) && buffer.byteLength > maxBytes) {
      throw createContentTooLargeError(maxBytes);
    }
    return Buffer.concat([prefix, buffer]);
  }
  return prefix;
}

export function normalizeMediaThumbnailJobVariant(value, index) {
  const normalized = assertPlainObject(value, `variants[${index}]`);
  const method = normalizeString(normalized.method, `variants[${index}].method`);
  if (!['crop', 'scale'].includes(method)) {
    throw new RangeError(`variants[${index}].method must be crop or scale`);
  }
  return Object.freeze({
    width: normalizeInteger(normalized.width, `variants[${index}].width`, { min: 1 }),
    height: normalizeInteger(normalized.height, `variants[${index}].height`, { min: 1 }),
    method,
    animated: normalized.animated === true,
  });
}

export function buildThumbnailBody(sourceBytes, variant) {
  const prefix = buildThumbnailPrefix(variant);
  return Buffer.concat([
    prefix,
    Buffer.isBuffer(sourceBytes) ? sourceBytes : Buffer.from(sourceBytes),
  ]);
}

export function createDefaultThumbnailJob({
  mxcUri,
  sourceKind,
  r2ObjectKey,
  contentType,
  byteSize = null,
  contentHash = null,
  enqueuedAt = new Date().toISOString(),
  variants = DEFAULT_MEDIA_THUMBNAIL_VARIANTS,
}) {
  return {
    schema_version: 1,
    mxc_uri: normalizeString(mxcUri, 'mxcUri'),
    source_kind: normalizeString(sourceKind, 'sourceKind'),
    r2_object_key: normalizeString(r2ObjectKey, 'r2ObjectKey'),
    content_type: normalizeString(contentType, 'contentType'),
    ...(byteSize == null ? {} : {
      byte_size: normalizeInteger(byteSize, 'byteSize', { min: 0 }),
    }),
    ...(contentHash == null ? {} : {
      content_hash: normalizeString(contentHash, 'contentHash'),
    }),
    enqueued_at: normalizeString(enqueuedAt, 'enqueuedAt'),
    variants: variants.map((variant, index) => normalizeMediaThumbnailJobVariant(variant, index)),
  };
}

export function buildThumbnailDescriptor({
  sourceKind,
  mediaId,
  width,
  height,
  method,
  animated = false,
  originServerName = null,
}) {
  const key = buildThumbnailObjectKey({
    sourceKind,
    mediaId,
    width,
    height,
    method,
    animated,
    originServerName,
  });
  return Object.freeze({
    key,
    metadata: {
      source_kind: sourceKind,
      source_origin_server_name: originServerName,
      source_media_id: mediaId,
      width,
      height,
      method,
      animated,
    },
  });
}
