import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as nodeSign,
  verify as nodeVerify,
  webcrypto,
} from 'node:crypto';

import { canonicalJsonBytes, sha256Base64UrlFromBytes } from '../../runtime-core/src/index.mjs';

function normalizeString(value, label, { allowNull = false } = {}) {
  if (value == null) {
    if (allowNull) {
      return null;
    }
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function base64UrlToBytes(value) {
  const normalized = normalizeString(value, 'base64url value');
  return Uint8Array.from(Buffer.from(normalized, 'base64url'));
}

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function decodeJsonSegment(segment, label) {
  const bytes = base64UrlToBytes(segment);
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

function encodeJsonSegment(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function getJwtVerificationDefinition(alg) {
  if (alg === 'RS256') {
    return {
      importAlgorithm: {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      verifyAlgorithm: 'RSASSA-PKCS1-v1_5',
    };
  }
  if (alg === 'RS384') {
    return {
      importAlgorithm: {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-384',
      },
      verifyAlgorithm: 'RSASSA-PKCS1-v1_5',
    };
  }
  if (alg === 'RS512') {
    return {
      importAlgorithm: {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-512',
      },
      verifyAlgorithm: 'RSASSA-PKCS1-v1_5',
    };
  }
  throw new RangeError(`Unsupported JWT alg ${alg}`);
}

async function importJwkForVerification(jwk, alg) {
  const definition = getJwtVerificationDefinition(alg);
  return webcrypto.subtle.importKey(
    'jwk',
    jwk,
    definition.importAlgorithm,
    false,
    ['verify'],
  );
}

async function verifyJwtSignature({ jwt, jwk }) {
  const parts = normalizeString(jwt, 'jwt').split('.');
  if (parts.length !== 3) {
    throw new TypeError('jwt must contain exactly three segments');
  }
  const header = decodeJsonSegment(parts[0], 'JWT header');
  const payload = decodeJsonSegment(parts[1], 'JWT payload');
  const signature = base64UrlToBytes(parts[2]);
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
  const cryptoKey = await importJwkForVerification(jwk, header.alg);
  const definition = getJwtVerificationDefinition(header.alg);
  const verified = await webcrypto.subtle.verify(
    definition.verifyAlgorithm,
    cryptoKey,
    signature,
    signingInput,
  );
  return {
    header,
    payload,
    verified,
  };
}

export function parseJwt(jwt) {
  const parts = normalizeString(jwt, 'jwt').split('.');
  if (parts.length !== 3) {
    throw new TypeError('jwt must contain exactly three segments');
  }
  return {
    header: decodeJsonSegment(parts[0], 'JWT header'),
    payload: decodeJsonSegment(parts[1], 'JWT payload'),
    signature: parts[2],
  };
}

export function createAccessJwkCache() {
  return new Map();
}

export async function fetchAccessJwkSet({
  teamDomain,
  fetchImpl = globalThis.fetch,
  cache = createAccessJwkCache(),
  now = () => Date.now(),
  forceRefresh = false,
}) {
  const normalizedTeamDomain = normalizeString(teamDomain, 'teamDomain');
  const cacheKey = normalizedTeamDomain.toLowerCase();
  const cached = cache.get(cacheKey) ?? null;
  if (!forceRefresh && cached != null) {
    return cached;
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function');
  }
  const response = await fetchImpl(`https://${normalizedTeamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) {
    throw new Error(`Access cert fetch failed with status ${response.status}`);
  }
  const body = await response.json();
  if (!body || !Array.isArray(body.keys)) {
    throw new TypeError('Access cert response must contain keys[]');
  }
  const entry = Object.freeze({
    team_domain: cacheKey,
    fetched_at_ms: now(),
    keys: body.keys.map((key) => Object.freeze({ ...key })),
  });
  cache.set(cacheKey, entry);
  return entry;
}

function normalizeIssuer(teamDomain) {
  return `https://${normalizeString(teamDomain, 'teamDomain')}`;
}

function createAccessJwtAuthError(message) {
  return Object.assign(new Error(message), { code: 'unauthorized' });
}

function audienceMatches(expectedAudience, audClaim) {
  const expected = normalizeString(expectedAudience, 'expectedAudience');
  if (typeof audClaim === 'string') {
    return audClaim === expected;
  }
  if (Array.isArray(audClaim)) {
    return audClaim.includes(expected);
  }
  return false;
}

export async function verifyAccessJwt({
  assertion,
  teamDomain,
  audience,
  fetchImpl = globalThis.fetch,
  cache = createAccessJwkCache(),
  now = () => new Date(),
}) {
  const normalizedAssertion = normalizeString(assertion, 'assertion');
  let parsed;
  try {
    parsed = parseJwt(normalizedAssertion);
  } catch (error) {
    throw createAccessJwtAuthError(error.message);
  }
  const jwkSet = await fetchAccessJwkSet({
    teamDomain,
    fetchImpl,
    cache,
  });
  let jwk = jwkSet.keys.find((candidate) => candidate.kid === parsed.header.kid) ?? null;
  if (jwk == null) {
    const refreshed = await fetchAccessJwkSet({
      teamDomain,
      fetchImpl,
      cache,
      forceRefresh: true,
    });
    jwk = refreshed.keys.find((candidate) => candidate.kid === parsed.header.kid) ?? null;
  }
  if (jwk == null) {
    throw createAccessJwtAuthError('No matching Access JWK for token kid');
  }
  let verification;
  try {
    verification = await verifyJwtSignature({
      jwt: normalizedAssertion,
      jwk,
    });
  } catch (error) {
    throw createAccessJwtAuthError(error.message);
  }
  if (!verification.verified) {
    throw createAccessJwtAuthError('Access JWT signature verification failed');
  }
  const currentEpochSeconds = Math.floor(now().getTime() / 1000);
  if (verification.payload.iss !== normalizeIssuer(teamDomain)) {
    throw createAccessJwtAuthError('Access JWT issuer mismatch');
  }
  if (!audienceMatches(audience, verification.payload.aud)) {
    throw createAccessJwtAuthError('Access JWT audience mismatch');
  }
  if (!Number.isFinite(verification.payload.exp) || verification.payload.exp <= currentEpochSeconds) {
    throw createAccessJwtAuthError('Access JWT exp is missing or expired');
  }
  if (verification.payload.nbf != null && (!Number.isFinite(verification.payload.nbf) || verification.payload.nbf > currentEpochSeconds)) {
    throw createAccessJwtAuthError('Access JWT nbf is missing or not yet valid');
  }
  if (typeof verification.payload.sub !== 'string' || verification.payload.sub.trim().length === 0) {
    throw createAccessJwtAuthError('Access JWT sub must be a non-empty string');
  }
  return Object.freeze({
    header: verification.header,
    claims: verification.payload,
    jwk,
  });
}

function readClaimByPath(claims, claimPath) {
  const normalizedPath = normalizeString(claimPath, 'claimPath');
  return normalizedPath.split('.').reduce((current, segment) => (
    current && typeof current === 'object' && !Array.isArray(current)
      ? current[segment]
      : undefined
  ), claims);
}

export function computeStableSubject({
  claims,
  principalType,
  accessSubjectBinding,
}) {
  const normalizedPrincipalType = normalizeString(principalType, 'principalType');
  if (normalizedPrincipalType === 'human') {
    return normalizeString(claims.sub, 'claims.sub');
  }
  const binding = typeof accessSubjectBinding === 'string'
    ? JSON.parse(accessSubjectBinding)
    : accessSubjectBinding;
  if (!binding || typeof binding !== 'object') {
    throw new TypeError('accessSubjectBinding must be an object');
  }
  if (binding.mode === 'sub') {
    return normalizeString(claims.sub, 'claims.sub');
  }
  if (binding.mode === 'claim_priority') {
    if (!Array.isArray(binding.claims) || binding.claims.length === 0) {
      throw new TypeError('claim_priority binding must declare claims[]');
    }
    for (const claimPath of binding.claims) {
      const value = readClaimByPath(claims, claimPath);
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    throw new Error('No stable service claim matched the configured claim priority');
  }
  throw new RangeError(`Unsupported access subject binding mode ${binding.mode}`);
}

export function canonicalHash(value) {
  return sha256Base64UrlFromBytes(canonicalJsonBytes(value));
}

export function parseExportKeyRing(secretValue) {
  const normalized = normalizeString(secretValue, 'secretValue');
  const parsed = JSON.parse(normalized);
  const signing = parsed?.signing;
  const encryption = parsed?.encryption;
  if (!signing || !encryption) {
    throw new TypeError('Export key ring must contain signing and encryption sections');
  }
  const signingActive = normalizeString(signing.active, 'signing.active');
  const encryptionActive = normalizeString(encryption.active, 'encryption.active');
  const signingKey = signing.keys?.[signingActive];
  const encryptionKey = encryption.keys?.[encryptionActive];
  if (!signingKey || !encryptionKey) {
    throw new TypeError('Active signing/encryption key versions must exist in the key ring');
  }
  return Object.freeze({
    signing: Object.freeze({
      active: signingActive,
      private_key_pem: normalizeString(signingKey.private_key_pem, 'signing.private_key_pem'),
      public_key_pem: normalizeString(signingKey.public_key_pem, 'signing.public_key_pem'),
    }),
    encryption: Object.freeze({
      active: encryptionActive,
      key_bytes: Buffer.from(normalizeString(encryptionKey.key_base64, 'encryption.key_base64'), 'base64'),
    }),
  });
}

export function signCanonicalPayload(unsignedPayload, keyRing) {
  const canonicalBytes = canonicalJsonBytes(unsignedPayload);
  const privateKey = createPrivateKey(keyRing.signing.private_key_pem);
  const signature = nodeSign(null, canonicalBytes, privateKey);
  return {
    payload: unsignedPayload,
    payload_hash: bytesToBase64Url(createHash('sha256').update(canonicalBytes).digest()),
    signature: bytesToBase64Url(signature),
    signature_algorithm: 'Ed25519',
    signing_key_version: keyRing.signing.active,
    encryption_algorithm: 'AES-256-GCM',
    encryption_key_version: keyRing.encryption.active,
  };
}

export function verifyCanonicalPayloadSignature(signedPayload, publicKeyPem) {
  const payload = signedPayload?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('signedPayload.payload must be an object');
  }
  const signature = base64UrlToBytes(signedPayload.signature);
  const publicKey = createPublicKey(normalizeString(publicKeyPem, 'publicKeyPem'));
  return nodeVerify(null, canonicalJsonBytes(payload), publicKey, signature);
}

export function encryptBytes(bytes, keyRing, { aad = null } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (keyRing.encryption.key_bytes.length !== 32) {
    throw new TypeError('AES-256-GCM encryption key must be 32 bytes');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyRing.encryption.key_bytes, iv);
  if (aad != null) {
    cipher.setAAD(Buffer.from(aad));
  }
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Object.freeze({
    ciphertext_base64url: bytesToBase64Url(ciphertext),
    iv_base64url: bytesToBase64Url(iv),
    tag_base64url: bytesToBase64Url(tag),
    encryption_algorithm: 'AES-256-GCM',
    encryption_key_version: keyRing.encryption.active,
  });
}

export function decryptBytes(envelope, keyRing, { aad = null } = {}) {
  const ciphertext = base64UrlToBytes(envelope.ciphertext_base64url);
  const iv = base64UrlToBytes(envelope.iv_base64url);
  const tag = base64UrlToBytes(envelope.tag_base64url);
  const decipher = createDecipheriv('aes-256-gcm', keyRing.encryption.key_bytes, iv);
  if (aad != null) {
    decipher.setAAD(Buffer.from(aad));
  }
  decipher.setAuthTag(Buffer.from(tag));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
}

export function createSignedManifest({
  unsignedManifest,
  keyRing,
}) {
  const manifestToSign = Object.freeze({
    ...unsignedManifest,
    signature_algorithm: unsignedManifest?.signature_algorithm ?? 'Ed25519',
    signing_key_version: unsignedManifest?.signing_key_version ?? keyRing.signing.active,
    encryption_algorithm: unsignedManifest?.encryption_algorithm ?? 'AES-256-GCM',
    encryption_key_version: unsignedManifest?.encryption_key_version ?? keyRing.encryption.active,
  });
  const signed = signCanonicalPayload(manifestToSign, keyRing);
  return Object.freeze({
    ...signed.payload,
    manifest_hash: signed.payload_hash,
    signature: signed.signature,
  });
}

export function extractUnsignedManifest(signedManifest) {
  const cloned = { ...signedManifest };
  delete cloned.manifest_hash;
  delete cloned.signature;
  return cloned;
}

export function verifySignedManifest(signedManifest, publicKeyPem) {
  const unsignedManifest = extractUnsignedManifest(signedManifest);
  const expectedHash = canonicalHash(unsignedManifest);
  if (expectedHash !== signedManifest.manifest_hash) {
    return false;
  }
  return verifyCanonicalPayloadSignature({
    payload: unsignedManifest,
    signature: signedManifest.signature,
  }, publicKeyPem);
}

export function createJwtForTest({
  header,
  payload,
  privateKeyPem,
}) {
  const encodedHeader = encodeJsonSegment(header);
  const encodedPayload = encodeJsonSegment(payload);
  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8');
  const signature = nodeSign('sha256', signingInput, createPrivateKey(privateKeyPem));
  return `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`;
}
