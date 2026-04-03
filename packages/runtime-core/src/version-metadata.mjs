const VERSION_METADATA_BINDING_NAME = 'CF_VERSION_METADATA';

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export function readRuntimeVersionMetadata(env = {}) {
  const candidate = env?.[VERSION_METADATA_BINDING_NAME];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  const id = normalizeOptionalString(candidate.id);
  const tag = normalizeOptionalString(candidate.tag);
  const timestamp = normalizeOptionalString(candidate.timestamp);
  if (id == null && tag == null && timestamp == null) {
    return null;
  }
  return Object.freeze({
    id,
    tag,
    timestamp,
  });
}

export function resolveRuntimeWorkerVersionId(env = {}, fallback = null) {
  return readRuntimeVersionMetadata(env)?.id ?? fallback ?? null;
}

export function resolveRuntimeWorkerVersionTag(env = {}, fallback = null) {
  return readRuntimeVersionMetadata(env)?.tag ?? fallback ?? null;
}

export { VERSION_METADATA_BINDING_NAME };
