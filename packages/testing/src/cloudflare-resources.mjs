import { GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS } from '../../runtime-core/src/index.mjs';

export const RATE_LIMIT_NAMESPACE_ENVIRONMENT_OFFSETS = Object.freeze({
  'ci-integration': 100_000,
  staging: 200_000,
  'pre-release': 300_000,
});

function assertEnvironmentName(environmentName) {
  if (!Object.hasOwn(RATE_LIMIT_NAMESPACE_ENVIRONMENT_OFFSETS, environmentName)) {
    throw new RangeError(`Unknown rate-limit environment: ${environmentName}`);
  }
  return environmentName;
}

export function buildEnvironmentRateLimitNamespaceId(environmentName, namespaceId) {
  const normalizedEnvironmentName = assertEnvironmentName(environmentName);
  const offset = RATE_LIMIT_NAMESPACE_ENVIRONMENT_OFFSETS[normalizedEnvironmentName];
  const normalizedNamespaceId = String(namespaceId);
  if (!/^[1-9]\d*$/.test(normalizedNamespaceId)) {
    throw new TypeError(`namespaceId must be a positive integer string, received ${namespaceId}`);
  }
  const parsed = Number(normalizedNamespaceId);
  return String(parsed + offset);
}

export function listEnvironmentRateLimitNamespaces(environmentName) {
  assertEnvironmentName(environmentName);
  return Object.freeze(
    Object.values(GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS)
      .map((definition) => buildEnvironmentRateLimitNamespaceId(environmentName, definition.default_namespace_id))
      .sort(),
  );
}

export function listProductionRateLimitNamespaces() {
  return Object.freeze(
    Object.values(GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS)
      .map((definition) => definition.default_namespace_id)
      .sort(),
  );
}
