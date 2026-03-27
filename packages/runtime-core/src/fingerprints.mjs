import { createHash, randomUUID } from 'node:crypto';

import { canonicalJsonBytes, canonicalizeJsonValue } from './canonical-json.mjs';

const textEncoder = new TextEncoder();
const jsonTextDecoder = new TextDecoder('utf-8', { fatal: true });

function normalizeContentType(contentType) {
  if (contentType == null) {
    return 'application/json';
  }
  if (typeof contentType !== 'string' || contentType.trim().length === 0) {
    throw new TypeError('contentType must be a non-empty string when provided');
  }
  return contentType.split(';', 1)[0].trim().toLowerCase();
}

function isJsonLikeContentType(contentType) {
  return contentType === 'application/json' || contentType.endsWith('+json');
}

function sha256Base64Url(bytes) {
  return createHash('sha256').update(bytes).digest('base64url');
}

function normalizeMethod(method) {
  if (typeof method !== 'string' || method.trim().length === 0) {
    throw new TypeError('method must be a non-empty string');
  }
  return method.trim().toUpperCase();
}

function normalizeRouteTemplate(routeTemplate) {
  if (typeof routeTemplate !== 'string' || routeTemplate.trim().length === 0) {
    throw new TypeError('routeTemplate must be a non-empty string');
  }
  return routeTemplate.trim();
}

function normalizeSchemaVersion(schemaVersion) {
  if (schemaVersion == null) {
    return 1;
  }
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new TypeError('schemaVersion must be a positive integer');
  }
  return schemaVersion;
}

function normalizePrincipalId(principalId) {
  if (principalId == null) {
    return null;
  }
  if (typeof principalId !== 'string' || principalId.trim().length === 0) {
    throw new TypeError('principalId must be a non-empty string when provided');
  }
  return principalId.trim();
}

export function sha256Base64UrlFromBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('bytes must be a Uint8Array');
  }
  return sha256Base64Url(bytes);
}

export function canonicalJsonHash(input) {
  return sha256Base64Url(canonicalJsonBytes(input));
}

export function hashRequestBody(body, { contentType = 'application/json' } = {}) {
  if (body == null) {
    return null;
  }

  const normalizedContentType = normalizeContentType(contentType);
  if (body instanceof Uint8Array) {
    if (isJsonLikeContentType(normalizedContentType)) {
      try {
        return canonicalJsonHash(jsonTextDecoder.decode(body));
      } catch (error) {
        throw new TypeError(`JSON request body bytes must be valid UTF-8: ${error.message}`);
      }
    }
    return sha256Base64Url(body);
  }
  if (typeof body === 'string') {
    if (isJsonLikeContentType(normalizedContentType)) {
      return canonicalJsonHash(body);
    }
    return sha256Base64Url(textEncoder.encode(body));
  }
  return canonicalJsonHash(body);
}

export function buildNormalizedRequestObject({
  method,
  routeTemplate,
  principalId = null,
  semanticQuery = null,
  body = null,
  bodyHash = undefined,
  contentType = 'application/json',
  schemaVersion = 1,
}) {
  const normalizedContentType = normalizeContentType(contentType);
  const resolvedBodyHash = bodyHash === undefined
    ? hashRequestBody(body, { contentType: normalizedContentType })
    : bodyHash;

  if (resolvedBodyHash != null && (typeof resolvedBodyHash !== 'string' || resolvedBodyHash.length === 0)) {
    throw new TypeError('bodyHash must be null or a non-empty string');
  }

  return {
    method: normalizeMethod(method),
    route_template: normalizeRouteTemplate(routeTemplate),
    principal_id: normalizePrincipalId(principalId),
    query: semanticQuery ?? null,
    body_sha256: resolvedBodyHash,
    content_type: normalizedContentType,
    schema_version: normalizeSchemaVersion(schemaVersion),
  };
}

export function createRequestFingerprint(input) {
  return canonicalJsonHash(buildNormalizedRequestObject(input));
}

export function createCanonicalFilterHash(filterJson) {
  return canonicalJsonHash(filterJson);
}

export function makeId(prefix) {
  if (typeof prefix !== 'string' || prefix.trim().length === 0) {
    throw new TypeError('prefix must be a non-empty string');
  }
  return `${prefix.trim()}_${randomUUID()}`;
}

export function stableCanonicalPreview(value) {
  return canonicalizeJsonValue(value);
}
