import { getWorkerRuntimeManifest } from './runtime-manifest.mjs';
import { recordDeploymentRecord } from './telemetry.mjs';

function parseJsonString(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractActiveSecretVersion(secretValue) {
  const parsed = parseJsonString(secretValue);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  if (typeof parsed.active_version === 'string') {
    return parsed.active_version;
  }
  if (typeof parsed.active === 'string') {
    return parsed.active;
  }
  if (parsed.signing && typeof parsed.signing.active === 'string') {
    const encryptionActive = parsed.encryption && typeof parsed.encryption.active === 'string'
      ? parsed.encryption.active
      : null;
    return encryptionActive
      ? { signing: parsed.signing.active, encryption: encryptionActive }
      : { signing: parsed.signing.active };
  }
  return null;
}

function buildSecretVersionSummary(config) {
  const summary = {};
  for (const logicalName of config.secrets.names()) {
    const secretValue = config.secrets.get(logicalName);
    summary[logicalName] = extractActiveSecretVersion(secretValue);
  }
  return summary;
}

function resolveDeploymentComposition(config) {
  const parsed = parseJsonString(config.text.ACTIVE_DEPLOYMENT_COMPOSITION);
  if (Array.isArray(parsed) && parsed.length > 0) {
    return parsed;
  }
  if (parsed && typeof parsed === 'object') {
    return [parsed];
  }
  return [{
    worker_name: config.workerName,
    worker_version_id: config.text.WORKER_VERSION_ID,
    deployment_id: config.text.DEPLOYMENT_ID,
  }];
}

export function buildDeploymentRecord({
  workerName,
  config,
  startupTimeMs = null,
  observedAt = new Date().toISOString(),
}) {
  const manifest = getWorkerRuntimeManifest(workerName);
  const resolvedStartupTimeMs = Number.isInteger(startupTimeMs)
    ? startupTimeMs
    : config.text.STARTUP_TIME_MS;
  return {
    worker_name: workerName,
    worker_version_id: config.text.WORKER_VERSION_ID,
    deployment_id: config.text.DEPLOYMENT_ID,
    compatibility_date: config.compatibilityDate,
    cpu_limit_class: config.text.CPU_LIMIT_CLASS,
    startup_time_ms: resolvedStartupTimeMs,
    release_profile: config.releaseProfile,
    environment_name: config.environmentName,
    deployment_composition: resolveDeploymentComposition(config),
    feature_gates: { ...config.featureGates },
    secret_versions: buildSecretVersionSummary(config),
    durable_object_classes: manifest.bindings.durableObjects.map((entry) => entry.className),
    observed_at: observedAt,
  };
}

export function ensureDeploymentRecord(env, {
  workerName,
  config,
  startupTimeMs = null,
  observedAt = new Date().toISOString(),
}) {
  const record = buildDeploymentRecord({
    workerName,
    config,
    startupTimeMs,
    observedAt,
  });
  return recordDeploymentRecord(env, record);
}
