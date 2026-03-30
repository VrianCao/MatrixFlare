import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

import { makeId, sha256Base64UrlFromBytes } from './fingerprints.mjs';
import { normalizeString } from './persistence-common.mjs';

const textEncoder = new TextEncoder();
const LOCALPART_PATTERN = /^[a-z0-9._=+\-/]+$/;

export const DEFAULT_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_UIA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function normalizePassword(password, label = 'password') {
  const normalized = normalizeString(password, label);
  if (normalized.length > 512) {
    throw new RangeError(`${label} must be 512 characters or fewer`);
  }
  return normalized;
}

function toIsoStringAfter(nowIso, milliseconds) {
  const nowMs = Date.parse(normalizeString(nowIso, 'nowIso'));
  if (!Number.isFinite(nowMs)) {
    throw new RangeError('nowIso must be a valid ISO-8601 timestamp');
  }
  return new Date(nowMs + milliseconds).toISOString();
}

function decodeBase64UrlText(value, label) {
  try {
    return Buffer.from(normalizeString(value, label), 'base64url').toString('utf8');
  } catch (error) {
    throw new RangeError(`${label} must be valid base64url text: ${error.message}`);
  }
}

function decodeBase64UrlBytes(value, label) {
  try {
    return Buffer.from(normalizeString(value, label), 'base64url');
  } catch (error) {
    throw new RangeError(`${label} must be valid base64url bytes: ${error.message}`);
  }
}

function normalizeCompletedStages(stages) {
  if (stages == null) {
    return [];
  }
  if (!Array.isArray(stages)) {
    throw new TypeError('completedStages must be an array when provided');
  }
  return [...new Set(stages.map((stage) => normalizeString(stage, 'completedStage')))];
}

function decodeKeyMaterial(entry, version) {
  if (typeof entry === 'string' && entry.length > 0) {
    return Buffer.from(entry, 'utf8');
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError(`session root key ${version} must be a string or JSON object`);
  }
  if (typeof entry.secret_base64 === 'string' && entry.secret_base64.length > 0) {
    return Buffer.from(entry.secret_base64, 'base64');
  }
  if (typeof entry.secret_text === 'string' && entry.secret_text.length > 0) {
    return Buffer.from(entry.secret_text, 'utf8');
  }
  if (typeof entry.secret === 'string' && entry.secret.length > 0) {
    return Buffer.from(entry.secret, 'utf8');
  }
  throw new TypeError(`session root key ${version} must define secret_base64, secret_text, or secret`);
}

function signOpaqueTokenPayload(secretBytes, signingInput) {
  return createHmac('sha256', secretBytes).update(signingInput).digest('base64url');
}

function normalizeTokenRevision(tokenRevision) {
  if (!Number.isInteger(tokenRevision) || tokenRevision < 0) {
    throw new RangeError('tokenRevision must be a non-negative integer');
  }
  return tokenRevision;
}

export function normalizeLocalpart(localpart) {
  const normalized = normalizeString(localpart, 'localpart').toLowerCase();
  if (!LOCALPART_PATTERN.test(normalized)) {
    throw new RangeError('localpart must match the Matrix localpart grammar');
  }
  return normalized;
}

export function buildLocalUserId(localpart, serverName) {
  return `@${normalizeLocalpart(localpart)}:${normalizeString(serverName, 'serverName')}`;
}

export function normalizeLocalUserIdentifier(identifier, serverName) {
  const normalized = normalizeString(identifier, 'identifier');
  const normalizedServerName = normalizeString(serverName, 'serverName');
  if (!normalized.startsWith('@')) {
    return normalizeLocalpart(normalized);
  }

  const match = /^@([^:]+):(.+)$/.exec(normalized);
  if (!match) {
    throw new RangeError('identifier must be a local Matrix user ID or localpart');
  }
  if (match[2] !== normalizedServerName) {
    throw new RangeError('identifier must target the local homeserver');
  }
  return normalizeLocalpart(match[1]);
}

export function extractLoginLocalpart(requestBody, serverName) {
  if (requestBody && typeof requestBody.user === 'string') {
    return normalizeLocalUserIdentifier(requestBody.user, serverName);
  }
  const identifier = requestBody?.identifier;
  if (
    identifier
    && typeof identifier === 'object'
    && !Array.isArray(identifier)
    && identifier.type === 'm.id.user'
    && typeof identifier.user === 'string'
  ) {
    return normalizeLocalUserIdentifier(identifier.user, serverName);
  }
  throw new TypeError('request must include user or identifier.user');
}

export function generateDeviceId() {
  return `DEVICE${randomBytes(6).toString('hex').toUpperCase()}`;
}

export function generateSessionId() {
  return makeId('sess');
}

export function hashOpaqueToken(token) {
  return sha256Base64UrlFromBytes(textEncoder.encode(normalizeString(token, 'token')));
}

function issueOpaqueUserToken(prefix, userId, {
  sessionId,
  tokenRevision = 0,
  secretValue,
  tokenRootKeyVersion = null,
}) {
  const ring = parseSessionRootKeyRing(secretValue);
  const encodedUserId = Buffer.from(normalizeString(userId, 'userId'), 'utf8').toString('base64url');
  const normalizedSessionId = normalizeString(sessionId, 'sessionId');
  const normalizedTokenRevision = normalizeTokenRevision(tokenRevision);
  const rootKeyVersion = tokenRootKeyVersion == null
    ? ring.active_version
    : normalizeString(tokenRootKeyVersion, 'tokenRootKeyVersion');
  if (!ring.keys[rootKeyVersion]) {
    throw new RangeError(`tokenRootKeyVersion ${rootKeyVersion} is missing from the session root key ring`);
  }
  const signingInput = `${prefix}.${encodedUserId}.${rootKeyVersion}.${normalizedSessionId}.${normalizedTokenRevision}`;
  const signature = signOpaqueTokenPayload(ring.keys[rootKeyVersion], signingInput);
  return `${prefix}.${encodedUserId}.${rootKeyVersion}.${normalizedTokenRevision}.${signature}`;
}

function parseOpaqueUserToken(token, expectedPrefix) {
  const parts = normalizeString(token, 'token').split('.');
  if (![3, 5].includes(parts.length) || parts[0] !== expectedPrefix) {
    throw new RangeError(`token must be a valid ${expectedPrefix} token`);
  }
  const userId = decodeBase64UrlText(parts[1], 'token user hint');
  if (!/^@[^:]+:.+$/.test(userId)) {
    throw new RangeError('token user hint must be a local Matrix user ID');
  }
  return {
    user_id: userId,
    nonce: parts.slice(2).join('.'),
  };
}

export function issueAccessToken(userId, options) {
  return issueOpaqueUserToken('atk', userId, options);
}

export function issueRefreshToken(userId, options) {
  return issueOpaqueUserToken('rtk', userId, options);
}

export function getAccessTokenUserIdHint(token) {
  return parseOpaqueUserToken(token, 'atk').user_id;
}

export function getRefreshTokenUserIdHint(token) {
  return parseOpaqueUserToken(token, 'rtk').user_id;
}

export function hashPassword(password) {
  const normalizedPassword = normalizePassword(password);
  const salt = randomBytes(16);
  const digest = scryptSync(normalizedPassword, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${Buffer.from(digest).toString('base64url')}`;
}

export function verifyPassword(password, storedHash) {
  if (typeof storedHash !== 'string' || storedHash.length === 0) {
    return false;
  }
  const [algorithm, saltBase64Url, digestBase64Url] = storedHash.split('$');
  if (algorithm !== 'scrypt' || !saltBase64Url || !digestBase64Url) {
    return false;
  }

  try {
    const salt = decodeBase64UrlBytes(saltBase64Url, 'stored password salt');
    const expectedDigest = decodeBase64UrlBytes(digestBase64Url, 'stored password digest');
    const candidateDigest = scryptSync(normalizePassword(password), salt, expectedDigest.length);
    return timingSafeEqual(expectedDigest, candidateDigest);
  } catch {
    return false;
  }
}

export function parseSessionRootKeyRing(secretValue) {
  const normalizedSecret = normalizeString(secretValue, 'secretValue');
  try {
    const parsed = JSON.parse(normalizedSecret);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('session root key ring JSON must be an object');
    }
    const activeVersion = normalizeString(parsed.active ?? parsed.active_version, 'active session root key version');
    const keysObject = parsed.keys;
    if (!keysObject || typeof keysObject !== 'object' || Array.isArray(keysObject)) {
      throw new TypeError('session root key ring JSON must define a keys object');
    }
    const keys = Object.fromEntries(
      Object.entries(keysObject).map(([version, entry]) => [version, decodeKeyMaterial(entry, version)]),
    );
    if (!keys[activeVersion]) {
      throw new TypeError(`active session root key version ${activeVersion} is missing from the key ring`);
    }
    return Object.freeze({
      active_version: activeVersion,
      keys,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Object.freeze({
        active_version: 'v1',
        keys: Object.freeze({
          v1: Buffer.from(normalizedSecret, 'utf8'),
        }),
      });
    }
    throw error;
  }
}

export function issueUiaChallengeToken({
  secretValue,
  routeFamily,
  method,
  authSubjectHint = null,
  completedStages = [],
  nonce = makeId('uia'),
  ttlMs = DEFAULT_UIA_CHALLENGE_TTL_MS,
  now = new Date().toISOString(),
}) {
  const ring = parseSessionRootKeyRing(secretValue);
  const payload = Object.freeze({
    route_family: normalizeString(routeFamily, 'routeFamily'),
    method: normalizeString(method, 'method').toUpperCase(),
    issued_at: normalizeString(now, 'now'),
    expires_at: toIsoStringAfter(now, ttlMs),
    auth_subject_hint: authSubjectHint == null ? null : normalizeString(authSubjectHint, 'authSubjectHint'),
    completed_stages: normalizeCompletedStages(completedStages),
    nonce: normalizeString(nonce, 'nonce'),
    root_key_version: ring.active_version,
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `uia.${ring.active_version}.${encodedPayload}`;
  const signature = signOpaqueTokenPayload(ring.keys[ring.active_version], signingInput);
  return Object.freeze({
    token: `${signingInput}.${signature}`,
    payload,
  });
}

export function verifyUiaChallengeToken({
  token,
  secretValue,
  expectedRouteFamily,
  expectedMethod,
  now = new Date().toISOString(),
}) {
  try {
    const parts = normalizeString(token, 'token').split('.');
    if (parts.length !== 4 || parts[0] !== 'uia') {
      return Object.freeze({ valid: false, reason: 'invalid_format' });
    }

    const [, rootKeyVersion, encodedPayload, signature] = parts;
    const ring = parseSessionRootKeyRing(secretValue);
    const secretBytes = ring.keys[rootKeyVersion];
    if (!secretBytes) {
      return Object.freeze({ valid: false, reason: 'unknown_root_key_version' });
    }

    const signingInput = `uia.${rootKeyVersion}.${encodedPayload}`;
    const expectedSignature = signOpaqueTokenPayload(secretBytes, signingInput);
    const providedSignatureBytes = Buffer.from(signature, 'utf8');
    const expectedSignatureBytes = Buffer.from(expectedSignature, 'utf8');
    if (
      providedSignatureBytes.length !== expectedSignatureBytes.length
      || !timingSafeEqual(providedSignatureBytes, expectedSignatureBytes)
    ) {
      return Object.freeze({ valid: false, reason: 'invalid_signature' });
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return Object.freeze({ valid: false, reason: 'invalid_payload' });
    }
    if (payload.route_family !== normalizeString(expectedRouteFamily, 'expectedRouteFamily')) {
      return Object.freeze({ valid: false, reason: 'route_family_mismatch' });
    }
    if (payload.method !== normalizeString(expectedMethod, 'expectedMethod').toUpperCase()) {
      return Object.freeze({ valid: false, reason: 'method_mismatch' });
    }
    const nowMs = Date.parse(normalizeString(now, 'now'));
    const expiresAtMs = Date.parse(normalizeString(payload.expires_at, 'payload.expires_at'));
    if (!Number.isFinite(nowMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      return Object.freeze({ valid: false, reason: 'expired' });
    }
    return Object.freeze({
      valid: true,
      payload: Object.freeze({
        route_family: payload.route_family,
        method: payload.method,
        issued_at: payload.issued_at,
        expires_at: payload.expires_at,
        auth_subject_hint: payload.auth_subject_hint ?? null,
        completed_stages: normalizeCompletedStages(payload.completed_stages),
        nonce: normalizeString(payload.nonce, 'payload.nonce'),
        root_key_version: normalizeString(payload.root_key_version, 'payload.root_key_version'),
      }),
    });
  } catch {
    return Object.freeze({ valid: false, reason: 'invalid_token' });
  }
}
