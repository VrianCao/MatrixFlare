import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  analyzeRepository,
  reserveFreshOutputPaths,
  resolveEvidenceRunTimestamp,
  writeGovernanceEvidence,
} from '../../spec-tools/src/governance.mjs';
import {
  normalizeRolloutSkewProbeResponse,
} from '../../control-plane/src/index.mjs';
import {
  getRequiredTestFiles,
  getTestEnvironmentDefinition,
  getTestEnvironmentDirectory,
} from './bootstrap.mjs';
import {
  listEnvironmentRateLimitNamespaces,
  listProductionRateLimitNamespaces,
} from './cloudflare-resources.mjs';

const execFileAsync = promisify(execFile);

const SHARED_RUN_ENVIRONMENTS = Object.freeze([
  'local',
  'ci-integration',
  'staging',
  'pre-release',
]);

const NON_LOCAL_ENVIRONMENT_ARTIFACT_REQUIREMENTS = Object.freeze({
  'ci-integration': Object.freeze({
    artifact_id: 'ci_integration_run_report',
    description: 'CI integration environment-backed run artifact for the same evidence run.',
  }),
  staging: Object.freeze({
    artifact_id: 'staging_run_report',
    description: 'Staging environment-backed run artifact for the same evidence run.',
  }),
  'pre-release': Object.freeze({
    artifact_id: 'pre_release_run_report',
    description: 'Pre-release environment-backed run artifact for the same evidence run.',
  }),
});

const ATTESTATION_SCHEMA_VERSION = 1;

const MANUAL_ARTIFACT_ATTESTATION_REQUIREMENTS = Object.freeze({
  ci_integration_run_report: Object.freeze({
    attestation_kind: 'environment_run',
    source_environment: 'ci-integration',
    payload_label: 'environment run report',
  }),
  staging_run_report: Object.freeze({
    attestation_kind: 'environment_run',
    source_environment: 'staging',
    payload_label: 'environment run report',
  }),
  pre_release_run_report: Object.freeze({
    attestation_kind: 'environment_run',
    source_environment: 'pre-release',
    payload_label: 'environment run report',
  }),
  prod_cost_snapshot: Object.freeze({
    attestation_kind: 'prod_cost_snapshot',
    source_environment: 'prod',
    payload_label: 'prod_cost_snapshot',
  }),
});

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const WELL_FORMED_URN_RE = /^urn:[a-z0-9][a-z0-9-]{0,31}:.+/i;
const RUN_TIMESTAMP_RE = /^\d{8}T\d{6}Z$/;
const L1_SHARED_TEST_RUN_ROOT = 'evidence/common/_test-runs';
const CLOUDFLARE_RESOURCE_NAMES = Object.freeze([
  'workers',
  'durable_objects',
  'd1_databases',
  'r2_buckets',
  'kv_namespaces',
  'ratelimit_namespaces',
  'queues',
]);
const EXPECTED_CLOUDFLARE_QUEUE_BASE_NAMES = Object.freeze([
  'matrix-search-index-job',
  'matrix-media-thumbnail-job',
  'matrix-appservice-txn-job',
  'matrix-rebuild-shard-job',
  'matrix-export-shard-job',
  'matrix-restore-shard-job',
  'matrix-repair-shard-job',
]);
const EXPECTED_DURABLE_OBJECT_NAMES = Object.freeze([
  'RemoteServerDO',
  'RoomDO',
  'UserDO',
]);
const EXPECTED_WORKER_BASE_NAMES = Object.freeze([
  'gateway-worker',
  'jobs-worker',
  'ops-worker',
]);
const PRE_RELEASE_TEST_FILE_PREFIXES = Object.freeze({
  ops: 'test-ops-001',
  cost: 'test-cost-001',
});
const PRE_RELEASE_COST_SURFACES = Object.freeze([
  'workers',
  'durable_objects',
  'd1',
  'r2',
  'kv',
  'queues',
]);

const L1_TEST_IMPLEMENTATION_FILES = Object.freeze({
  'TEST-CS-001': Object.freeze({
    local: Object.freeze(['tests/local/client-identity/phase-04.test.mjs']),
    'ci-integration': Object.freeze(['tests/integration/test-cs-001.test.mjs']),
    staging: Object.freeze(['tests/staging/test-cs-001.test.mjs']),
  }),
  'TEST-CS-002': Object.freeze({
    local: Object.freeze(['tests/local/client-identity/phase-05.test.mjs']),
    staging: Object.freeze(['tests/staging/test-cs-002.test.mjs']),
  }),
  'TEST-CS-003': Object.freeze({
    local: Object.freeze([
      'tests/local/client-identity/phase-05.test.mjs',
      'tests/local/client-identity/phase-05a.test.mjs',
    ]),
    staging: Object.freeze(['tests/staging/test-cs-003.test.mjs']),
  }),
  'TEST-CS-004': Object.freeze({
    local: Object.freeze(['tests/local/client-identity/phase-04.test.mjs']),
    'ci-integration': Object.freeze(['tests/integration/test-cs-004.test.mjs']),
    staging: Object.freeze(['tests/staging/test-cs-004.test.mjs']),
  }),
  'TEST-ROOM-001': Object.freeze({
    local: Object.freeze(['tests/local/client-identity/phase-06.test.mjs']),
    'ci-integration': Object.freeze(['tests/integration/test-room-001.test.mjs']),
    staging: Object.freeze(['tests/staging/test-room-001.test.mjs']),
  }),
  'TEST-ROOM-002': Object.freeze({
    local: Object.freeze(['tests/local/client-identity/phase-06.test.mjs']),
    'ci-integration': Object.freeze(['tests/integration/test-room-002.test.mjs']),
    staging: Object.freeze(['tests/staging/test-room-002.test.mjs']),
  }),
  'TEST-MEDIA-001': Object.freeze({
    local: Object.freeze(['tests/local/client-identity/phase-07.test.mjs']),
    staging: Object.freeze(['tests/staging/test-media-001.test.mjs']),
    'pre-release': Object.freeze(['tests/pre-release/test-media-001.test.mjs']),
  }),
  'TEST-DER-001': Object.freeze({
    local: Object.freeze(['tests/local/client-identity/phase-07.test.mjs']),
    staging: Object.freeze(['tests/staging/test-der-001.test.mjs']),
    'pre-release': Object.freeze(['tests/pre-release/test-der-001.test.mjs']),
  }),
  'TEST-SEC-001': Object.freeze({
    local: Object.freeze([
      'tests/local/client-identity/phase-04.test.mjs',
      'tests/local/runtime-foundations/phase-08-runtime-controls.test.mjs',
    ]),
    staging: Object.freeze(['tests/staging/test-sec-001.test.mjs']),
    'pre-release': Object.freeze(['tests/pre-release/test-sec-001.test.mjs']),
  }),
  'TEST-OPS-001': Object.freeze({
    local: Object.freeze([
      'tests/local/runtime-foundations/phase-08-runtime-controls.test.mjs',
      'tests/local/control-plane/phase-08-ops.test.mjs',
    ]),
    'pre-release': Object.freeze(['tests/pre-release/test-ops-001.test.mjs']),
  }),
  'TEST-COST-001': Object.freeze({
    local: Object.freeze(['tests/local/runtime-foundations/phase-08-runtime-controls.test.mjs']),
    'pre-release': Object.freeze(['tests/pre-release/test-cost-001.test.mjs']),
  }),
});

const L1_EVIDENCE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'EVID-CS-001',
    scope: 'L1',
    test_ids: ['TEST-CS-001'],
    evidence_type: 'integration/protocol',
    generation_method: 'client-core CI + staging attestation bundle',
    required_environments: ['ci-integration', 'staging'],
    declared_source_ids: ['MX-CS-001', 'MX-CS-002', 'MX-CS-003', 'MX-CS-005', 'MX-CS-006', 'MX-CS-019', 'MX-CS-024', 'MX-CS-026'],
    pass_criteria: 'Client discovery, capabilities, registration, login, password/UIA, deactivation, refresh, logout, profile fields, and propagation must pass in CI integration and staging.',
  }),
  Object.freeze({
    id: 'EVID-CS-002',
    scope: 'L1',
    test_ids: ['TEST-CS-002'],
    evidence_type: 'protocol',
    generation_method: '/sync conformance attested staging report',
    required_environments: ['staging'],
    declared_source_ids: ['MX-CS-004', 'MX-CS-006', 'MX-CS-007', 'MX-CS-010', 'MX-CS-015'],
    pass_criteria: 'Filter lifecycle, sync modes, include_leave, lazy-load members, push rules, and notification counts must pass in staging.',
  }),
  Object.freeze({
    id: 'EVID-CS-003',
    scope: 'L1',
    test_ids: ['TEST-CS-003'],
    evidence_type: 'protocol',
    generation_method: 'devices/E2EE transport attested staging report',
    required_environments: ['staging'],
    declared_source_ids: ['MX-CS-013', 'MX-CS-014'],
    pass_criteria: 'Device CRUD/delete UIA, to-device transport, one-time key at-most-once, cross-signing upload/signature handling, /sync device_lists increments, /sync device_one_time_keys_count and device_unused_fallback_key_types truth, and backup metadata/object handling must pass in staging.',
  }),
  Object.freeze({
    id: 'EVID-CS-004',
    scope: 'L1',
    test_ids: ['TEST-CS-004'],
    evidence_type: 'protocol/governance',
    generation_method: 'stub-only/unsupported route guard attested CI + staging report',
    required_environments: ['ci-integration', 'staging'],
    declared_source_ids: ['MX-CS-003', 'MX-CS-005', 'MX-CS-012', 'MX-CS-016', 'MX-CS-018', 'MX-CS-020', 'MX-CS-021', 'MX-CS-022', 'MX-CS-023', 'MX-CS-025', 'MX-CS-027', 'MX-CS-028', 'MX-CS-029'],
    pass_criteria: 'Stub-only and unsupported client routes must return deterministic wire behavior without truth writes or discoverability drift in CI integration and staging.',
  }),
  Object.freeze({
    id: 'EVID-ROOM-001',
    scope: 'L1',
    test_ids: ['TEST-ROOM-001'],
    evidence_type: 'property/integration',
    generation_method: 'room-core attested CI + staging report',
    required_environments: ['ci-integration', 'staging'],
    declared_source_ids: ['MX-CS-008', 'MX-CS-009', 'MX-CS-010'],
    pass_criteria: 'Room creation, membership, event send, fanout, receipts, and typing must pass in CI integration and staging.',
  }),
  Object.freeze({
    id: 'EVID-ROOM-002',
    scope: 'L1',
    test_ids: ['TEST-ROOM-002'],
    evidence_type: 'protocol/property',
    generation_method: 'room-version attested CI + staging report',
    required_environments: ['ci-integration', 'staging'],
    declared_source_ids: ['MX-RV-011', 'MX-RV-012'],
    l1_excluded_source_ids: ['MX-RV-011'],
    pass_criteria: 'For L1, room version 12 defaults and behavior must pass in CI integration and staging.',
  }),
  Object.freeze({
    id: 'EVID-MEDIA-001',
    scope: 'L1',
    test_ids: ['TEST-MEDIA-001'],
    evidence_type: 'integration/load',
    generation_method: 'media pipeline attested staging + pre-release report',
    required_environments: ['staging', 'pre-release'],
    declared_source_ids: ['MX-CS-011', 'MX-FED-008'],
    l1_excluded_source_ids: ['MX-FED-008'],
    pass_criteria: 'For L1, local media upload/download/thumbnail, authenticated current surfaces, legacy unauthenticated freeze behavior, and animated-thumbnail cache isolation must pass in staging and pre-release.',
  }),
  Object.freeze({
    id: 'EVID-DER-001',
    scope: 'L1',
    test_ids: ['TEST-DER-001'],
    evidence_type: 'integration/rebuild',
    generation_method: 'derived-data attested staging + pre-release report',
    required_environments: ['staging', 'pre-release'],
    declared_source_ids: ['MX-CS-017', 'MX-FED-006'],
    l1_excluded_source_ids: ['MX-FED-006'],
    pass_criteria: 'For L1, search, user directory, public rooms, hierarchy, and rebuild consistency must pass in staging and pre-release, including publicRooms dispatch and deterministic rejection of unauthenticated POST.',
  }),
  Object.freeze({
    id: 'EVID-SEC-001',
    scope: 'common',
    test_ids: ['TEST-SEC-001'],
    evidence_type: 'security',
    generation_method: 'security attested staging + pre-release bundle',
    required_environments: ['staging', 'pre-release'],
    declared_source_ids: ['REQ-SEC-*', 'MX-CS-002', 'MX-CS-003', 'MX-CS-005', 'MX-CS-016', 'MX-CS-024', 'MX-CS-025', 'MX-CS-026', 'MX-CS-028', 'MX-FED-002'],
    l1_excluded_source_ids: ['REQ-SEC-005', 'MX-FED-002'],
    pass_criteria: 'For L1, token revocation, UIA route binding, secret handling, and baseline abuse guards on always-on surfaces must pass in staging and pre-release.',
  }),
  Object.freeze({
    id: 'EVID-OPS-001',
    scope: 'common',
    test_ids: ['TEST-OPS-001'],
    evidence_type: 'deploy',
    generation_method: 'rollout compatibility attested pre-release report',
    required_environments: ['pre-release'],
    declared_source_ids: ['REQ-OPS-010', 'REQ-OPS-011', 'REQ-OPS-012'],
    pass_criteria: 'Worker/authority version skew paths must pass in pre-release.',
  }),
  Object.freeze({
    id: 'EVID-COST-001',
    scope: 'common',
    test_ids: ['TEST-COST-001'],
    evidence_type: 'cost',
    generation_method: 'attested monthly dashboard snapshot + model comparison',
    required_environments: ['pre-release'],
    declared_source_ids: ['REQ-OPS-003', 'CF-WKR-015', 'CF-WKR-016', 'CF-WKR-017', 'CF-WKR-018', 'CF-WKR-019', 'CF-DO-011', 'CF-DO-012', 'CF-DO-013', 'CF-D1-006', 'CF-KV-003', 'CF-R2-005', 'CF-QUE-001'],
    required_manual_artifacts: [
      Object.freeze({
        artifact_id: 'prod_cost_snapshot',
        description: 'Production monthly dashboard snapshot attestation for the same evidence run.',
      }),
    ],
    pass_criteria: 'Metrics and cost-attribution surfaces must produce stable pre-release evidence without budget-model drift signals, and the same bundle must include the corresponding production monthly dashboard snapshot/model comparison artifact.',
  }),
]);

export function getL1EvidenceDefinition(evidenceId) {
  const definition = L1_EVIDENCE_DEFINITIONS.find((candidate) => candidate.id === evidenceId);
  if (!definition) {
    throw new RangeError(`Unknown L1 evidence definition "${evidenceId}"`);
  }
  return definition;
}

export function listL1EvidenceBundleIds() {
  return ['EVID-GOV-001', ...L1_EVIDENCE_DEFINITIONS.map((definition) => definition.id)];
}

export function getRequiredTestImplementationFiles(testId, environmentName = 'local') {
  const mapping = L1_TEST_IMPLEMENTATION_FILES[testId];
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new RangeError(`Unknown L1 test implementation mapping for "${testId}"`);
  }
  const files = mapping[environmentName] ?? mapping.default ?? null;
  if (!Array.isArray(files) || files.length === 0) {
    throw new RangeError(`Missing L1 test implementation mapping for "${testId}" in environment "${environmentName}"`);
  }
  validateRequiredTestImplementationFiles(testId, environmentName, files);
  return [...files];
}

function validateRequiredTestImplementationFiles(testId, environmentName, files) {
  if (environmentName === 'local') {
    return;
  }
  const environmentDirectory = normalizeRepoRelativePath(getTestEnvironmentDefinition(environmentName).directory);
  if (environmentDirectory == null) {
    throw new RangeError(`Unknown non-local test environment directory for "${environmentName}"`);
  }
  const normalizedFiles = files.map((file) => normalizeRepoRelativePath(file));
  const invalidDirectoryFile = normalizedFiles.find((file) => file == null || !pathUsesPrefix(file, environmentDirectory));
  if (invalidDirectoryFile != null) {
    throw new RangeError(
      `Non-local L1 test implementation mapping for "${testId}" in environment "${environmentName}" must stay within dedicated environment directory "${environmentDirectory}"`,
    );
  }
  const invalidNonTestFile = normalizedFiles.find((file) => !file.endsWith('.test.mjs'));
  if (invalidNonTestFile != null) {
    throw new RangeError(
      `Non-local L1 test implementation mapping for "${testId}" in environment "${environmentName}" must use dedicated .test.mjs files`,
    );
  }
  const invalidGenericEntrypoint = normalizedFiles.find((file) => {
    const basename = path.posix.basename(file);
    return basename === 'bootstrap.test.mjs' || basename === 'l1-mandatory.test.mjs';
  });
  if (invalidGenericEntrypoint != null) {
    throw new RangeError(
      `Non-local L1 test implementation mapping for "${testId}" in environment "${environmentName}" cannot point at generic entrypoint "${invalidGenericEntrypoint}"`,
    );
  }
  const invalidDedicatedSuiteName = normalizedFiles.find((file) => !matchesDedicatedNonLocalTestImplementationFileName(testId, file));
  if (invalidDedicatedSuiteName != null) {
    throw new RangeError(
      `Non-local L1 test implementation mapping for "${testId}" in environment "${environmentName}" must use dedicated .test.mjs files whose basename is anchored by "${testId.toLowerCase()}"`,
    );
  }
}

function matchesDedicatedNonLocalTestImplementationFileName(testId, file) {
  const basename = path.posix.basename(file);
  const escapedTestId = escapeRegularExpression(String(testId).trim().toLowerCase());
  return new RegExp(`^${escapedTestId}(?:[.-][a-z0-9-]+)?\\.test\\.mjs$`, 'u').test(basename);
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listL1EnvironmentImplementationFiles(environmentName = 'local') {
  const requiredFiles = new Set();
  for (const mapping of Object.values(L1_TEST_IMPLEMENTATION_FILES)) {
    const files = mapping[environmentName] ?? mapping.default ?? [];
    for (const file of files) {
      requiredFiles.add(file);
    }
  }
  return [...requiredFiles].sort();
}

export function buildRequiredManualArtifactDefinitions(definition) {
  if (definition == null || typeof definition !== 'object') {
    throw new TypeError('definition must be an object');
  }

  const combined = [];
  const seenArtifactIds = new Set();
  const registerRequirement = (requirement) => {
    if (!requirement || typeof requirement.artifact_id !== 'string') {
      return;
    }
    if (seenArtifactIds.has(requirement.artifact_id)) {
      return;
    }
    seenArtifactIds.add(requirement.artifact_id);
    combined.push(requirement);
  };

  for (const environmentName of definition.required_environments ?? []) {
    registerRequirement(NON_LOCAL_ENVIRONMENT_ARTIFACT_REQUIREMENTS[environmentName] ?? null);
  }
  for (const requirement of definition.required_manual_artifacts ?? []) {
    registerRequirement(requirement);
  }

  return combined;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

const RFC3339_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function isRfc3339UtcTimestamp(value) {
  return isNonEmptyString(value)
    && RFC3339_UTC_TIMESTAMP_RE.test(value)
    && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isRelativePathList(value) {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === 'string' && entry.length > 0 && !path.isAbsolute(entry));
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => isNonEmptyString(entry));
}

function sortUniqueStringArray(value) {
  return [...new Set(value.map((entry) => String(entry).trim()))].sort();
}

function buildExpectedCloudflareResources(environmentName, {
  includeArtifactBucket = true,
} = {}) {
  if (environmentName === 'prod') {
    return Object.freeze({
      workers: Object.freeze(EXPECTED_WORKER_BASE_NAMES.map((workerName) => `matrix-${workerName}-prod`).sort()),
      durable_objects: EXPECTED_DURABLE_OBJECT_NAMES,
      d1_databases: Object.freeze(['matrix-control-and-derived-prod']),
      r2_buckets: Object.freeze(sortUniqueStringArray([
        'matrix-media-prod',
        'matrix-archive-prod',
        ...(includeArtifactBucket ? ['matrix-evidence-prod'] : []),
      ])),
      kv_namespaces: Object.freeze(['matrix-edge-cache-prod']),
      ratelimit_namespaces: listProductionRateLimitNamespaces(),
      queues: Object.freeze(EXPECTED_CLOUDFLARE_QUEUE_BASE_NAMES.map((queueName) => `${queueName}-prod`).sort()),
    });
  }
  return Object.freeze({
    workers: Object.freeze(EXPECTED_WORKER_BASE_NAMES.map((workerName) => `matrix-${workerName}-${environmentName}`).sort()),
    durable_objects: EXPECTED_DURABLE_OBJECT_NAMES,
    d1_databases: Object.freeze([`matrix-control-and-derived-${environmentName}`]),
    r2_buckets: Object.freeze(sortUniqueStringArray([
      `matrix-media-${environmentName}`,
      `matrix-archive-${environmentName}`,
      ...(includeArtifactBucket ? [`matrix-evidence-${environmentName}`] : []),
    ])),
    kv_namespaces: Object.freeze([`matrix-edge-cache-${environmentName}`]),
    ratelimit_namespaces: listEnvironmentRateLimitNamespaces(environmentName),
    queues: Object.freeze(EXPECTED_CLOUDFLARE_QUEUE_BASE_NAMES.map((queueName) => `${queueName}-${environmentName}`).sort()),
  });
}

function validateExpectedCloudflareResources(payloadLabel, environmentName, resources, {
  includeArtifactBucket = true,
} = {}) {
  if (!isPlainObject(resources)) {
    return {
      valid: false,
      error: `${payloadLabel} must include cloudflare_resources`,
    };
  }
  for (const resourceName of CLOUDFLARE_RESOURCE_NAMES) {
    if (!isNonEmptyStringArray(resources[resourceName])) {
      return {
        valid: false,
        error: `${payloadLabel} cloudflare_resources.${resourceName} must be a non-empty string array`,
      };
    }
  }
  const expectedResources = buildExpectedCloudflareResources(environmentName, {
    includeArtifactBucket,
  });
  for (const resourceName of CLOUDFLARE_RESOURCE_NAMES) {
    const actual = sortUniqueStringArray(resources[resourceName]);
    const expected = expectedResources[resourceName];
    if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
      return {
        valid: false,
        error: `${payloadLabel} cloudflare_resources.${resourceName} must match expected ${environmentName} resources`,
      };
    }
  }
  return {
    valid: true,
    error: null,
  };
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function listReportCoverageFiles(payload) {
  const combined = [];
  for (const candidate of [payload?.test_files, payload?.expanded_test_files]) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    for (const entry of candidate) {
      if (typeof entry === 'string' && entry.length > 0) {
        combined.push(entry);
      }
    }
  }
  return [...new Set(combined)];
}

function reportCoversCanonicalTestPrefix(payload, prefix) {
  return listReportCoverageFiles(payload).some((candidate) => {
    const basename = path.basename(candidate).toLowerCase();
    return basename.startsWith(prefix) && basename.endsWith('.test.mjs');
  });
}

export function validateRolloutSkewProbeSemantics(reportLabel, normalized, {
  expectedEnvironmentName = 'pre-release',
  expectedProbeRunId = null,
  expectedDualVersionDeploymentId = null,
  expectedBaselineGatewayVersionId = null,
  expectedBaselineGatewayVersionTag = null,
  expectedCandidateGatewayVersionId = null,
  expectedCandidateGatewayVersionTag = null,
} = {}) {
  if (normalized.environment_name !== expectedEnvironmentName) {
    return {
      valid: false,
      error: `${reportLabel}.environment_name must be ${expectedEnvironmentName}`,
    };
  }
  if (expectedProbeRunId != null && normalized.probe_run_id !== expectedProbeRunId) {
    return {
      valid: false,
      error: `${reportLabel}.probe_run_id must match rollout state`,
    };
  }
  if (expectedDualVersionDeploymentId != null && normalized.dual_version_deployment_id !== expectedDualVersionDeploymentId) {
    return {
      valid: false,
      error: `${reportLabel}.dual_version_deployment_id must match rollout state`,
    };
  }
  if (expectedBaselineGatewayVersionId != null && normalized.baseline_gateway_version_id !== expectedBaselineGatewayVersionId) {
    return {
      valid: false,
      error: `${reportLabel}.baseline_gateway_version_id must match rollout state`,
    };
  }
  if (expectedBaselineGatewayVersionTag != null && normalized.baseline_gateway_version_tag !== expectedBaselineGatewayVersionTag) {
    return {
      valid: false,
      error: `${reportLabel}.baseline_gateway_version_tag must match rollout state`,
    };
  }
  if (expectedCandidateGatewayVersionId != null && normalized.candidate_gateway_version_id !== expectedCandidateGatewayVersionId) {
    return {
      valid: false,
      error: `${reportLabel}.candidate_gateway_version_id must match rollout state`,
    };
  }
  if (expectedCandidateGatewayVersionTag != null && normalized.candidate_gateway_version_tag !== expectedCandidateGatewayVersionTag) {
    return {
      valid: false,
      error: `${reportLabel}.candidate_gateway_version_tag must match rollout state`,
    };
  }
  const requiredObservations = [
    {
      probe_name: 'new-worker-old-authority',
      authority_kind: 'UserDO',
      expected_gateway_version_id: normalized.candidate_gateway_version_id,
      expected_gateway_version_tag: normalized.candidate_gateway_version_tag,
      expected_authority_version_id: normalized.baseline_gateway_version_id,
    },
    {
      probe_name: 'new-worker-old-authority',
      authority_kind: 'RoomDO',
      expected_gateway_version_id: normalized.candidate_gateway_version_id,
      expected_gateway_version_tag: normalized.candidate_gateway_version_tag,
      expected_authority_version_id: normalized.baseline_gateway_version_id,
    },
    {
      probe_name: 'old-worker-new-authority',
      authority_kind: 'UserDO',
      expected_gateway_version_id: normalized.baseline_gateway_version_id,
      expected_gateway_version_tag: normalized.baseline_gateway_version_tag,
      expected_authority_version_id: normalized.candidate_gateway_version_id,
    },
    {
      probe_name: 'old-worker-new-authority',
      authority_kind: 'RoomDO',
      expected_gateway_version_id: normalized.baseline_gateway_version_id,
      expected_gateway_version_tag: normalized.baseline_gateway_version_tag,
      expected_authority_version_id: normalized.candidate_gateway_version_id,
    },
  ];
  for (const requirement of requiredObservations) {
    const matchesObservedGatewayIdentity = (entry) => {
      if (entry.observed_gateway_version_id === requirement.expected_gateway_version_id) {
        return entry.observed_gateway_version_tag == null
          || entry.observed_gateway_version_tag === requirement.expected_gateway_version_tag;
      }
      return (
        entry.observed_gateway_version_id == null
        && entry.observed_gateway_version_tag === requirement.expected_gateway_version_tag
      );
    };
    const matched = normalized.observations.some((entry) => (
      entry.probe_name === requirement.probe_name
      && entry.authority_kind === requirement.authority_kind
      && entry.request_gateway_version_id === requirement.expected_gateway_version_id
      && entry.observed_authority_version_id === requirement.expected_authority_version_id
      && matchesObservedGatewayIdentity(entry)
    ));
    if (!matched) {
      return {
        valid: false,
        error: `${reportLabel} must include ${requirement.probe_name}/${requirement.authority_kind} observation`,
      };
    }
  }
  return {
    valid: true,
    error: null,
  };
}

function validatePreReleaseRolloutSkewProbe(reportLabel, value, expected = {}) {
  if (value == null) {
    return {
      valid: false,
      error: `${reportLabel} must include rollout_skew_probe`,
    };
  }
  let normalized;
  try {
    normalized = normalizeRolloutSkewProbeResponse(value);
  } catch (error) {
    return {
      valid: false,
      error: `${reportLabel} rollout_skew_probe is invalid: ${error.message}`,
    };
  }
  if (normalized.environment_name !== 'pre-release') {
    return {
      valid: false,
      error: `${reportLabel} rollout_skew_probe.environment_name must be pre-release`,
    };
  }
  if (normalized.assertions.new_worker_old_authority !== true || normalized.assertions.old_worker_new_authority !== true) {
    return {
      valid: false,
      error: `${reportLabel} rollout_skew_probe assertions must both be true`,
    };
  }
  const semanticValidation = validateRolloutSkewProbeSemantics(
    `${reportLabel} rollout_skew_probe`,
    normalized,
    expected,
  );
  if (!semanticValidation.valid) {
    return semanticValidation;
  }
  return {
    valid: true,
    error: null,
  };
}

function validatePreReleaseCostObservation(reportLabel, value, {
  expectedEnvironmentName = 'pre-release',
} = {}) {
  if (value == null) {
    return {
      valid: false,
      error: `${reportLabel} must include pre_release_cost_observation`,
    };
  }
  if (!isPlainObject(value)) {
    return {
      valid: false,
      error: `${reportLabel} pre_release_cost_observation must be an object`,
    };
  }
  if (!isNonEmptyString(value.observation_id)) {
    return {
      valid: false,
      error: `${reportLabel} pre_release_cost_observation.observation_id must be non-empty`,
    };
  }
  if (value.source_environment !== expectedEnvironmentName) {
    return {
      valid: false,
      error: `${reportLabel} pre_release_cost_observation.source_environment must be ${expectedEnvironmentName}`,
    };
  }
  if (!isRfc3339UtcTimestamp(value.captured_at)) {
    return {
      valid: false,
      error: `${reportLabel} pre_release_cost_observation.captured_at must be RFC 3339 UTC`,
    };
  }
  if (!isPlainObject(value.capture_window) || !isRfc3339UtcTimestamp(value.capture_window.start) || !isRfc3339UtcTimestamp(value.capture_window.end)) {
    return {
      valid: false,
      error: `${reportLabel} pre_release_cost_observation.capture_window must contain RFC 3339 UTC start/end`,
    };
  }
  if (Date.parse(value.capture_window.start) > Date.parse(value.capture_window.end)) {
    return {
      valid: false,
      error: `${reportLabel} pre_release_cost_observation.capture_window.start must be <= end`,
    };
  }
  if (value.capture_method !== 'cloudflare-official-metrics') {
    return {
      valid: false,
      error: `${reportLabel} pre_release_cost_observation.capture_method must be cloudflare-official-metrics`,
    };
  }
  if (!isNonEmptyStringArray(value.source_query_uris) || value.source_query_uris.some((entry) => !isOfficialCloudflareLocator(entry))) {
    return {
      valid: false,
      error: `${reportLabel} pre_release_cost_observation.source_query_uris must be official Cloudflare HTTPS locators`,
    };
  }
  if (!isNonEmptyString(value.topology_kind) || value.topology_kind === 'local') {
    return {
      valid: false,
      error: `${reportLabel} pre_release_cost_observation.topology_kind must be non-local`,
    };
  }
  const resourceValidation = validateExpectedCloudflareResources(
    `${reportLabel} pre_release_cost_observation`,
    expectedEnvironmentName,
    value.cloudflare_resources,
  );
  if (!resourceValidation.valid) {
    return resourceValidation;
  }
  if (!isPlainObject(value.cost_surfaces) || PRE_RELEASE_COST_SURFACES.some((surface) => !isPlainObject(value.cost_surfaces[surface]))) {
    return {
      valid: false,
      error: `${reportLabel} pre_release_cost_observation.cost_surfaces must include workers,durable_objects,d1,r2,kv,queues`,
    };
  }
  if (
    !isPlainObject(value.model_comparison)
    || !isNonEmptyString(value.model_comparison.status)
    || !isNonEmptyString(value.model_comparison.summary)
    || !isNonNegativeNumber(value.model_comparison.actual_total_usd)
    || !isNonNegativeNumber(value.model_comparison.modeled_total_usd)
    || typeof value.model_comparison.drift_ratio !== 'number'
    || !Number.isFinite(value.model_comparison.drift_ratio)
  ) {
    return {
      valid: false,
      error: `${reportLabel} pre_release_cost_observation.model_comparison is invalid`,
    };
  }
  return {
    valid: true,
    error: null,
  };
}

function isDisallowedLocalHostname(hostname) {
  if (!isNonEmptyString(hostname)) {
    return true;
  }
  const normalized = hostname.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const isPrivateOrLoopbackIpv4 = (value) => {
    if (isIP(value) !== 4) {
      return false;
    }
    const [firstOctet, secondOctet] = value.split('.').map(Number);
    return firstOctet === 0
      || firstOctet === 10
      || firstOctet === 127
      || (firstOctet === 169 && secondOctet === 254)
      || (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31)
      || (firstOctet === 192 && secondOctet === 168);
  };
  if (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === 'local'
    || normalized.endsWith('.local')
    || normalized === '0.0.0.0'
    || normalized === '::1'
  ) {
    return true;
  }
  if (isPrivateOrLoopbackIpv4(normalized)) {
    return true;
  }
  if (isIP(normalized) === 6) {
    if (normalized.startsWith('::ffff:') || normalized.startsWith('0:0:0:0:0:ffff:')) {
      return true;
    }
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb');
  }
  return false;
}

function isAbsoluteExternalUri(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    if (['about:', 'blob:', 'data:', 'file:', 'javascript:'].includes(parsed.protocol)) {
      return false;
    }
    if (parsed.protocol === 'urn:') {
      return WELL_FORMED_URN_RE.test(value);
    }
    return parsed.host.length > 0 && !isDisallowedLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function isOfficialCloudflareLocator(value) {
  if (!isAbsoluteExternalUri(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return (
      parsed.protocol === 'https:'
      && (hostname === 'cloudflare.com' || hostname.endsWith('.cloudflare.com'))
    );
  } catch {
    return false;
  }
}

function isGitHubActionsRunUri(value) {
  if (!isAbsoluteExternalUri(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
      return false;
    }
    return /^\/[^/]+\/[^/]+\/actions\/runs\/\d+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function extractGitHubActionsRunRepository(value) {
  if (!isGitHubActionsRunUri(value)) {
    return null;
  }
  try {
    const parsed = new URL(value);
    const [, owner, repository, actionsLiteral, runsLiteral, runId] = parsed.pathname.split('/');
    if (
      !isNonEmptyString(owner)
      || !isNonEmptyString(repository)
      || actionsLiteral !== 'actions'
      || runsLiteral !== 'runs'
      || !isNonEmptyString(runId)
    ) {
      return null;
    }
    return `${owner}/${repository}`;
  } catch {
    return null;
  }
}

function extractGitHubActionsRunId(value) {
  if (!isGitHubActionsRunUri(value)) {
    return null;
  }
  try {
    const parsed = new URL(value);
    const [, owner, repository, actionsLiteral, runsLiteral, runId] = parsed.pathname.split('/');
    if (
      !isNonEmptyString(owner)
      || !isNonEmptyString(repository)
      || actionsLiteral !== 'actions'
      || runsLiteral !== 'runs'
      || !isNonEmptyString(runId)
    ) {
      return null;
    }
    return runId;
  } catch {
    return null;
  }
}

function parseR2ObjectLocator(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'r2:'
      || parsed.host.length === 0
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.search.length > 0
      || parsed.hash.length > 0
    ) {
      return null;
    }
    const objectKey = parsed.pathname.startsWith('/')
      ? parsed.pathname.slice(1)
      : parsed.pathname;
    if (!isNonEmptyString(objectKey)) {
      return null;
    }
    return {
      bucket: parsed.host,
      objectKey,
    };
  } catch {
    return null;
  }
}

function parsePhase08ArtifactStoreKey(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }
  const segments = value.split('/');
  if (segments.length < 6 || segments[0] !== 'gha') {
    return null;
  }
  const [prefix, originRunId, originRunAttempt, sourceEnvironment, runTimestamp, ...artifactPath] = segments;
  if (
    prefix !== 'gha'
    || !/^\d+$/.test(originRunId)
    || !/^\d+$/.test(originRunAttempt)
    || !isNonEmptyString(sourceEnvironment)
    || !RUN_TIMESTAMP_RE.test(runTimestamp)
    || artifactPath.length === 0
    || artifactPath.some((segment) => !isNonEmptyString(segment))
  ) {
    return null;
  }
  return {
    originRunId,
    originRunAttempt: Number(originRunAttempt),
    sourceEnvironment,
    runTimestamp,
  };
}

function expectedTopologyKindForSourceEnvironment(sourceEnvironment) {
  return sourceEnvironment === 'prod'
    ? 'cloudflare-prod'
    : `cloudflare-${sourceEnvironment}`;
}

function objectHasRequiredNumericFields(value, fieldNames) {
  return isPlainObject(value) && fieldNames.every((fieldName) => isNonNegativeNumber(value[fieldName]));
}

function normalizeRepoRelativePath(value) {
  if (!isNonEmptyString(value) || path.isAbsolute(value)) {
    return null;
  }
  const normalized = path.posix.normalize(String(value).replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  return normalized;
}

function pathUsesPrefix(relativePath, prefix) {
  const normalizedRelativePath = normalizeRepoRelativePath(relativePath);
  const normalizedPrefix = normalizeRepoRelativePath(prefix);
  if (normalizedRelativePath == null || normalizedPrefix == null) {
    return false;
  }
  return normalizedRelativePath === normalizedPrefix || normalizedRelativePath.startsWith(`${normalizedPrefix}/`);
}

function pathIsWithinRoot(targetPath, rootPath) {
  const absoluteTargetPath = path.resolve(targetPath);
  const absoluteRootPath = path.resolve(rootPath);
  const relative = path.relative(absoluteRootPath, absoluteTargetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function describeRepoBoundaryEscapePath(candidatePath, repoRoot) {
  const absoluteCandidatePath = path.resolve(candidatePath);
  if (pathIsWithinRoot(absoluteCandidatePath, repoRoot)) {
    return normalizePathForMarkdown(path.relative(repoRoot, absoluteCandidatePath));
  }
  return normalizePathForMarkdown(absoluteCandidatePath);
}

function isIdentifierBoundaryCharacter(value) {
  return value == null || !/[A-Za-z0-9_$]/.test(value);
}

function hasKeywordAt(sourceText, index, keyword) {
  return sourceText.startsWith(keyword, index)
    && isIdentifierBoundaryCharacter(sourceText[index - 1])
    && isIdentifierBoundaryCharacter(sourceText[index + keyword.length]);
}

function skipLineComment(sourceText, index) {
  let cursor = index + 2;
  while (cursor < sourceText.length && sourceText[cursor] !== '\n') {
    cursor += 1;
  }
  return cursor;
}

function skipBlockComment(sourceText, index) {
  const endIndex = sourceText.indexOf('*/', index + 2);
  return endIndex === -1 ? sourceText.length : endIndex + 2;
}

function skipQuotedString(sourceText, index) {
  const quote = sourceText[index];
  let cursor = index + 1;
  while (cursor < sourceText.length) {
    const current = sourceText[cursor];
    if (current === '\\') {
      cursor += 2;
      continue;
    }
    if (current === quote) {
      return cursor + 1;
    }
    cursor += 1;
  }
  return sourceText.length;
}

function isIdentifierStartCharacter(value) {
  return value != null && /[A-Za-z_$]/.test(value);
}

function isIdentifierContinueCharacter(value) {
  return value != null && /[A-Za-z0-9_$]/.test(value);
}

function parseIdentifierEscape(sourceText, index) {
  if (sourceText[index] !== '\\' || sourceText[index + 1] !== 'u') {
    return null;
  }
  if (sourceText[index + 2] === '{') {
    const closingBraceIndex = sourceText.indexOf('}', index + 3);
    if (closingBraceIndex === -1) {
      return null;
    }
    const hexCodePoint = sourceText.slice(index + 3, closingBraceIndex);
    if (!/^[0-9A-Fa-f]+$/.test(hexCodePoint)) {
      return null;
    }
    try {
      return {
        value: String.fromCodePoint(Number.parseInt(hexCodePoint, 16)),
        end: closingBraceIndex + 1,
      };
    } catch {
      return null;
    }
  }
  const hexEscape = sourceText.slice(index + 2, index + 6);
  if (!/^[0-9A-Fa-f]{4}$/.test(hexEscape)) {
    return null;
  }
  return {
    value: String.fromCodePoint(Number.parseInt(hexEscape, 16)),
    end: index + 6,
  };
}

function parseIdentifierToken(sourceText, index) {
  let cursor = index;
  let value = '';

  const firstEscape = parseIdentifierEscape(sourceText, cursor);
  if (firstEscape != null) {
    if (!isIdentifierStartCharacter(firstEscape.value)) {
      return null;
    }
    value += firstEscape.value;
    cursor = firstEscape.end;
  } else {
    const firstCharacter = sourceText[cursor];
    if (!isIdentifierStartCharacter(firstCharacter)) {
      return null;
    }
    value += firstCharacter;
    cursor += 1;
  }

  while (cursor < sourceText.length) {
    const escapedCharacter = parseIdentifierEscape(sourceText, cursor);
    if (escapedCharacter != null) {
      if (!isIdentifierContinueCharacter(escapedCharacter.value)) {
        break;
      }
      value += escapedCharacter.value;
      cursor = escapedCharacter.end;
      continue;
    }
    const current = sourceText[cursor];
    if (!isIdentifierContinueCharacter(current)) {
      break;
    }
    value += current;
    cursor += 1;
  }

  return {
    value,
    end: cursor,
  };
}

function skipBalancedCode(sourceText, index, terminator) {
  let cursor = index;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  while (cursor < sourceText.length) {
    const current = sourceText[cursor];
    const next = sourceText[cursor + 1];

    if (current === '/' && next === '/') {
      cursor = skipLineComment(sourceText, cursor);
      continue;
    }
    if (current === '/' && next === '*') {
      cursor = skipBlockComment(sourceText, cursor);
      continue;
    }
    if (current === '\'' || current === '"') {
      cursor = skipQuotedString(sourceText, cursor);
      continue;
    }
    if (current === '`') {
      cursor = skipTemplateLiteral(sourceText, cursor);
      continue;
    }

    if (current === terminator && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      return cursor + 1;
    }
    if (current === '{') {
      braceDepth += 1;
      cursor += 1;
      continue;
    }
    if (current === '}') {
      if (braceDepth === 0 && terminator === '}') {
        return cursor + 1;
      }
      braceDepth = Math.max(braceDepth - 1, 0);
      cursor += 1;
      continue;
    }
    if (current === '[') {
      bracketDepth += 1;
      cursor += 1;
      continue;
    }
    if (current === ']') {
      bracketDepth = Math.max(bracketDepth - 1, 0);
      cursor += 1;
      continue;
    }
    if (current === '(') {
      parenDepth += 1;
      cursor += 1;
      continue;
    }
    if (current === ')') {
      if (parenDepth === 0 && terminator === ')') {
        return cursor + 1;
      }
      parenDepth = Math.max(parenDepth - 1, 0);
      cursor += 1;
      continue;
    }

    cursor += 1;
  }

  return sourceText.length;
}

function skipTemplateLiteral(sourceText, index) {
  let cursor = index + 1;
  while (cursor < sourceText.length) {
    const current = sourceText[cursor];
    const next = sourceText[cursor + 1];
    if (current === '\\') {
      cursor += 2;
      continue;
    }
    if (current === '`') {
      return cursor + 1;
    }
    if (current === '$' && next === '{') {
      cursor = skipBalancedCode(sourceText, cursor + 2, '}');
      continue;
    }
    cursor += 1;
  }
  return sourceText.length;
}

function skipTrivia(sourceText, index) {
  let cursor = index;
  while (cursor < sourceText.length) {
    const current = sourceText[cursor];
    const next = sourceText[cursor + 1];
    if (/\s/.test(current)) {
      cursor += 1;
      continue;
    }
    if (current === '/' && next === '/') {
      cursor = skipLineComment(sourceText, cursor);
      continue;
    }
    if (current === '/' && next === '*') {
      cursor = skipBlockComment(sourceText, cursor);
      continue;
    }
    break;
  }
  return cursor;
}

function parseQuotedStringLiteral(sourceText, index) {
  const quote = sourceText[index];
  if (quote !== '\'' && quote !== '"') {
    return null;
  }
  const endIndex = skipQuotedString(sourceText, index);
  const literalSource = sourceText.slice(index, endIndex);
  let decodedValue;
  try {
    decodedValue = Function(`"use strict"; return (${literalSource});`)();
  } catch {
    decodedValue = sourceText.slice(index + 1, Math.max(endIndex - 1, index + 1));
  }
  return {
    value: decodedValue,
    end: endIndex,
    hasEscapes: literalSource.includes('\\'),
  };
}

function parseSingleStringLiteralExpression(sourceText) {
  const startIndex = skipTrivia(sourceText, 0);
  const literal = parseQuotedStringLiteral(sourceText, startIndex);
  if (literal == null) {
    return null;
  }
  return skipTrivia(sourceText, literal.end) === sourceText.length
    ? literal.value
    : null;
}

function parseSingleIdentifierExpression(sourceText) {
  let expressionText = sourceText;

  while (true) {
    const startIndex = skipTrivia(expressionText, 0);
    const identifierToken = parseIdentifierToken(expressionText, startIndex);
    if (identifierToken != null && skipTrivia(expressionText, identifierToken.end) === expressionText.length) {
      return identifierToken.value;
    }

    if (expressionText[startIndex] !== '(') {
      return null;
    }
    const endIndex = skipBalancedCode(expressionText, startIndex + 1, ')');
    if (skipTrivia(expressionText, endIndex) !== expressionText.length) {
      return null;
    }

    expressionText = expressionText.slice(startIndex + 1, Math.max(endIndex - 1, startIndex + 1));
  }
}

function parseObjectLiteralExpression(sourceText) {
  let expressionText = sourceText;

  while (true) {
    const startIndex = skipTrivia(expressionText, 0);
    if (expressionText[startIndex] === '{') {
      const endIndex = skipBalancedCode(expressionText, startIndex + 1, '}');
      return skipTrivia(expressionText, endIndex) === expressionText.length
        ? expressionText.slice(startIndex, endIndex)
        : null;
    }

    if (expressionText[startIndex] !== '(') {
      return null;
    }
    const endIndex = skipBalancedCode(expressionText, startIndex + 1, ')');
    if (skipTrivia(expressionText, endIndex) !== expressionText.length) {
      return null;
    }

    expressionText = expressionText.slice(startIndex + 1, Math.max(endIndex - 1, startIndex + 1));
  }
}

function cloneAliasClassification(classification) {
  if (!isPlainObject(classification)) {
    return null;
  }
  return {
    nodeModuleNamespace: classification.nodeModuleNamespace === true,
    commonJsFactory: classification.commonJsFactory === true,
    commonJsLoader: classification.commonJsLoader === true,
    reflect: classification.reflect === true,
    unsafeConstructor: classification.unsafeConstructor === true,
    unsafeReflectMethod: classification.unsafeReflectMethod === true,
    opaqueCallable: classification.opaqueCallable === true,
  };
}

const UNKNOWN_OBJECT_SPREAD_PROPERTY = Symbol('matrix.testing.unknownObjectSpreadProperty');

function getObjectLiteralPropertyValue(propertyMap, propertyName) {
  if (!(propertyMap instanceof Map)) {
    return null;
  }
  return propertyMap.get(propertyName) ?? propertyMap.get(UNKNOWN_OBJECT_SPREAD_PROPERTY) ?? null;
}

function parseTemplateStringLiteral(sourceText, index) {
  if (sourceText[index] !== '`') {
    return null;
  }
  let cursor = index + 1;
  let value = '';
  let hasEscapes = false;
  while (cursor < sourceText.length) {
    const current = sourceText[cursor];
    const next = sourceText[cursor + 1];
    if (current === '\\') {
      hasEscapes = true;
      cursor += 2;
      continue;
    }
    if (current === '`') {
      const literalSource = sourceText.slice(index, cursor + 1);
      let decodedValue;
      try {
        decodedValue = Function(`"use strict"; return (${literalSource});`)();
      } catch {
        decodedValue = sourceText.slice(index + 1, cursor);
      }
      return {
        value: decodedValue,
        end: cursor + 1,
        hasEscapes,
        dynamic: false,
      };
    }
    if (current === '$' && next === '{') {
      return {
        value: null,
        end: skipTemplateLiteral(sourceText, index),
        hasEscapes,
        dynamic: true,
      };
    }
    value += current;
    cursor += 1;
  }
  return {
    value: null,
    end: sourceText.length,
    hasEscapes,
    dynamic: true,
  };
}

function parseStaticStringOperand(sourceText, index) {
  const quotedLiteral = parseQuotedStringLiteral(sourceText, index);
  if (quotedLiteral != null) {
    return {
      value: quotedLiteral.value,
      end: quotedLiteral.end,
      hasEscapes: quotedLiteral.hasEscapes,
      dynamic: false,
    };
  }
  if (sourceText[index] === '(') {
    const endIndex = skipBalancedCode(sourceText, index + 1, ')');
    const innerExpressionText = sourceText.slice(index + 1, Math.max(endIndex - 1, index + 1));
    const innerExpression = parseStaticStringExpression(innerExpressionText);
    return {
      value: innerExpression.complete ? innerExpression.value : null,
      end: endIndex,
      hasEscapes: innerExpression.hasEscapes,
      dynamic: !innerExpression.complete,
    };
  }
  return parseTemplateStringLiteral(sourceText, index);
}

function parseStaticStringExpression(sourceText) {
  let cursor = 0;
  let value = '';
  let containsStringLike = false;
  let hasEscapes = false;

  while (cursor < sourceText.length) {
    cursor = skipTrivia(sourceText, cursor);
    const operand = parseStaticStringOperand(sourceText, cursor);
    if (operand == null) {
      return {
        value: null,
        containsStringLike,
        hasEscapes,
        complete: false,
      };
    }
    containsStringLike = true;
    hasEscapes = hasEscapes || operand.hasEscapes;
    if (operand.dynamic) {
      return {
        value: null,
        containsStringLike,
        hasEscapes,
        complete: false,
      };
    }
    value += operand.value;
    cursor = skipTrivia(sourceText, operand.end);
    if (cursor >= sourceText.length) {
      return {
        value,
        containsStringLike,
        hasEscapes,
        complete: true,
      };
    }
    if (sourceText[cursor] !== '+') {
      return {
        value: null,
        containsStringLike,
        hasEscapes,
        complete: false,
      };
    }
    cursor += 1;
  }

  return {
    value: null,
    containsStringLike,
    hasEscapes,
    complete: false,
  };
}

function parseBracketPropertyExpression(sourceText, index) {
  if (sourceText[index] !== '[') {
    return null;
  }
  const bracketEndIndex = skipBalancedCode(sourceText, index + 1, ']');
  const expressionText = sourceText.slice(index + 1, Math.max(bracketEndIndex - 1, index + 1));
  const staticStringExpression = parseStaticStringExpression(expressionText);
  return {
    end: bracketEndIndex,
    expressionText,
    ...staticStringExpression,
  };
}

function isStringEvaluatorName(value) {
  return value === 'eval' || value === 'Function';
}

function isCommonJsLoaderName(value) {
  return value === 'require' || value === 'createRequire';
}

function isUnsafeConstructorContinuationName(value) {
  return value === 'constructor' || value === 'call' || value === 'apply' || value === 'bind';
}

function isCallableContinuationMethodName(value) {
  return value === 'call' || value === 'apply' || value === 'bind';
}

function isUnsafeReflectMethodName(value) {
  return value === 'get' || value === 'apply' || value === 'construct';
}

function readNextPropertyName(sourceText, index) {
  let cursor = skipTrivia(sourceText, index);
  const usesOptionalChain = sourceText[cursor] === '?' && sourceText[cursor + 1] === '.';
  if (usesOptionalChain) {
    cursor = skipTrivia(sourceText, cursor + 2);
  }
  if (sourceText[cursor] === '.') {
    const identifierToken = parseIdentifierToken(sourceText, skipTrivia(sourceText, cursor + 1));
    return identifierToken == null
      ? null
      : {
          name: identifierToken.value,
          end: identifierToken.end,
        };
  }
  if (sourceText[cursor] === '[') {
    const bracketProperty = parseBracketPropertyExpression(sourceText, cursor);
    const propertyName = getStaticBracketPropertyName(bracketProperty);
    return propertyName == null
      ? null
      : {
          name: propertyName,
          end: bracketProperty.end,
        };
  }
  if (usesOptionalChain) {
    const identifierToken = parseIdentifierToken(sourceText, cursor);
    return identifierToken == null
      ? null
      : {
          name: identifierToken.value,
          end: identifierToken.end,
        };
  }
  return null;
}

function readChainedPropertyName(sourceText, index) {
  let cursor = skipTrivia(sourceText, index);
  while (sourceText[cursor] === ')') {
    cursor = skipTrivia(sourceText, cursor + 1);
  }
  return readNextPropertyName(sourceText, cursor);
}

function skipWhitespaceBackward(sourceText, index) {
  let cursor = index;
  while (cursor >= 0 && /\s/.test(sourceText[cursor])) {
    cursor -= 1;
  }
  return cursor;
}

function findMatchingOpeningParen(sourceText, closingIndex) {
  const stack = [];
  let cursor = 0;

  while (cursor <= closingIndex && cursor < sourceText.length) {
    const current = sourceText[cursor];
    const next = sourceText[cursor + 1];

    if (current === '/' && next === '/') {
      cursor = skipLineComment(sourceText, cursor);
      continue;
    }
    if (current === '/' && next === '*') {
      cursor = skipBlockComment(sourceText, cursor);
      continue;
    }
    if (current === '\'' || current === '"') {
      cursor = skipQuotedString(sourceText, cursor);
      continue;
    }
    if (current === '`') {
      cursor = skipTemplateLiteral(sourceText, cursor);
      continue;
    }
    if (current === '(') {
      stack.push(cursor);
      cursor += 1;
      continue;
    }
    if (current === ')') {
      const openingIndex = stack.pop() ?? null;
      if (cursor === closingIndex) {
        return openingIndex;
      }
      cursor += 1;
      continue;
    }
    cursor += 1;
  }

  return null;
}

function getInlineObjectLiteralPropertyClassification(sourceText, memberStartIndex, propertyName, aliasState) {
  const receiverEndIndex = skipWhitespaceBackward(sourceText, memberStartIndex - 1);
  if (receiverEndIndex < 0 || sourceText[receiverEndIndex] !== ')') {
    return null;
  }
  const openingParenIndex = findMatchingOpeningParen(sourceText, receiverEndIndex);
  if (openingParenIndex == null) {
    return null;
  }
  const receiverExpressionText = sourceText.slice(openingParenIndex, receiverEndIndex + 1);
  const objectLiteralText = parseObjectLiteralExpression(receiverExpressionText);
  if (objectLiteralText == null) {
    return null;
  }
  const propertyMap = parseObjectLiteralPropertyMap(objectLiteralText, aliasState.objectPropertyAliases);
  const propertyValue = getObjectLiteralPropertyValue(propertyMap, propertyName);
  return resolveObjectLiteralPropertyClassification(propertyValue, aliasState);
}

function stripCommentsPreservingStrings(sourceText) {
  let cursor = 0;
  let normalizedSourceText = '';

  while (cursor < sourceText.length) {
    const current = sourceText[cursor];
    const next = sourceText[cursor + 1];

    if (current === '/' && next === '/') {
      const endIndex = skipLineComment(sourceText, cursor);
      normalizedSourceText += ' '.repeat(endIndex - cursor);
      cursor = endIndex;
      continue;
    }
    if (current === '/' && next === '*') {
      const endIndex = skipBlockComment(sourceText, cursor);
      normalizedSourceText += ' '.repeat(endIndex - cursor);
      cursor = endIndex;
      continue;
    }
    if (current === '\'' || current === '"') {
      const endIndex = skipQuotedString(sourceText, cursor);
      normalizedSourceText += sourceText.slice(cursor, endIndex);
      cursor = endIndex;
      continue;
    }
    if (current === '`') {
      const endIndex = skipTemplateLiteral(sourceText, cursor);
      normalizedSourceText += sourceText.slice(cursor, endIndex);
      cursor = endIndex;
      continue;
    }

    normalizedSourceText += current;
    cursor += 1;
  }

  return normalizedSourceText;
}

const IDENTIFIER_ESCAPE_PATTERN = String.raw`(?:\\u\{[0-9A-Fa-f]+\}|\\u[0-9A-Fa-f]{4})`;
const IDENTIFIER_TOKEN_PATTERN = String.raw`(?:${IDENTIFIER_ESCAPE_PATTERN}|[A-Za-z_$])(?:${IDENTIFIER_ESCAPE_PATTERN}|[A-Za-z0-9_$])*`;
const STRING_LITERAL_PATTERN = String.raw`(?:'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*")`;

const NAMED_ALIAS_ENTRY_RE = new RegExp(
  String.raw`^(${IDENTIFIER_TOKEN_PATTERN})(?:(?:\s+as\s+|\s*:\s*)(${IDENTIFIER_TOKEN_PATTERN}))?$`,
);
const DECLARED_CONSTRUCTOR_BRACKET_ALIAS_RE = new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n;]*\[\s*(${STRING_LITERAL_PATTERN})\s*\]\s*(?:[;,]|\n|$)`,
  'g',
);
const ASSIGNED_CONSTRUCTOR_BRACKET_ALIAS_RE = new RegExp(
  String.raw`(?:^|[;\n])\s*(?:\(\s*)*([A-Za-z_$][\w$]*)\s*=\s*[^\n;]*\[\s*(${STRING_LITERAL_PATTERN})\s*\]\s*(?:\s*\))*\s*(?:[;,]|\n|$)`,
  'gm',
);
const DECLARED_MEMBER_ALIAS_RE = new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(\s*)*([A-Za-z_$][\w$]*)(?:\s*\))*\s*(?:\?\.\s*|\.\s*)(${IDENTIFIER_TOKEN_PATTERN})`,
  'g',
);
const ASSIGNED_MEMBER_ALIAS_RE = new RegExp(
  String.raw`(?:^|[;\n])\s*(?:\(\s*)*([A-Za-z_$][\w$]*)\s*=\s*(?:\(\s*)*([A-Za-z_$][\w$]*)(?:\s*\))*\s*(?:\?\.\s*|\.\s*)(${IDENTIFIER_TOKEN_PATTERN})`,
  'gm',
);
const DECLARED_BRACKET_MEMBER_ALIAS_RE = new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(\s*)*([A-Za-z_$][\w$]*)(?:\s*\))*\s*(?:\?\.\s*)?\[\s*(${STRING_LITERAL_PATTERN})\s*\]`,
  'g',
);
const ASSIGNED_BRACKET_MEMBER_ALIAS_RE = new RegExp(
  String.raw`(?:^|[;\n])\s*(?:\(\s*)*([A-Za-z_$][\w$]*)\s*=\s*(?:\(\s*)*([A-Za-z_$][\w$]*)(?:\s*\))*\s*(?:\?\.\s*)?\[\s*(${STRING_LITERAL_PATTERN})\s*\]`,
  'gm',
);
const SIMPLE_MEMBER_ALIAS_RE = new RegExp(
  String.raw`^(?:\(\s*)*([A-Za-z_$][\w$]*)(?:\s*\))*\s*(?:\?\.\s*|\.\s*)(${IDENTIFIER_TOKEN_PATTERN})\s*$`,
);
const SIMPLE_BRACKET_MEMBER_ALIAS_RE = new RegExp(
  String.raw`^(?:\(\s*)*([A-Za-z_$][\w$]*)(?:\s*\))*\s*(?:\?\.\s*)?\[\s*(${STRING_LITERAL_PATTERN})\s*\]\s*$`,
);
const SIMPLE_IDENTIFIER_BRACKET_MEMBER_ALIAS_RE = new RegExp(
  String.raw`^(?:\(\s*)*([A-Za-z_$][\w$]*)(?:\s*\))*\s*(?:\?\.\s*)?\[\s*([A-Za-z_$][\w$]*)\s*\]\s*$`,
);
const TRAILING_BRACKET_PROPERTY_RE = new RegExp(
  String.raw`\[\s*(${STRING_LITERAL_PATTERN})\s*\]\s*$`,
);
const DESTRUCTURED_OBJECT_LITERAL_DECLARATION_RE = /\b(?:const|let|var)\s*\{/g;
const DESTRUCTURED_OBJECT_LITERAL_ASSIGNMENT_RE = /(?:^|[;\n])\s*(?:\(\s*)?\{/gm;
const OBJECT_LITERAL_DECLARATION_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(\s*)*\{/g;
const OBJECT_LITERAL_ASSIGNMENT_RE = /(?:^|[;\n])\s*(?:\(\s*)*([A-Za-z_$][\w$]*)\s*=\s*(?:\(\s*)*\{/gm;
const NAMED_EXPRESSION_DECLARATION_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
const NAMED_EXPRESSION_ASSIGNMENT_RE = /(?:^|[;\n])\s*(?:\(\s*)*([A-Za-z_$][\w$]*)\s*=\s*/gm;

function createAliasClassification() {
  return {
    nodeModuleNamespace: false,
    commonJsFactory: false,
    commonJsLoader: false,
    reflect: false,
    unsafeConstructor: false,
    unsafeReflectMethod: false,
    opaqueCallable: false,
  };
}

function createOpaqueCallableClassification() {
  const classification = createAliasClassification();
  classification.opaqueCallable = true;
  return classification;
}

function markUnknownObjectSpread(propertyMap) {
  if (!(propertyMap instanceof Map) || propertyMap.has(UNKNOWN_OBJECT_SPREAD_PROPERTY)) {
    return;
  }
  propertyMap.set(UNKNOWN_OBJECT_SPREAD_PROPERTY, createOpaqueCallableClassification());
}

function decodeAliasIdentifierToken(tokenText) {
  if (typeof tokenText !== 'string' || tokenText.length === 0) {
    return null;
  }
  const identifierToken = parseIdentifierToken(tokenText, 0);
  return identifierToken != null && skipTrivia(tokenText, identifierToken.end) === tokenText.length
    ? identifierToken.value
    : null;
}

function decodePropertyLiteralToken(tokenText) {
  if (typeof tokenText !== 'string' || tokenText.length === 0) {
    return null;
  }
  const propertyName = parseSingleStringLiteralExpression(tokenText);
  return typeof propertyName === 'string' ? propertyName : null;
}

function normalizeSimpleNumericPropertyName(expressionText) {
  if (!isSimpleNumericExpression(expressionText)) {
    return null;
  }
  const numericValue = Number(expressionText.trim());
  return !Number.isNaN(numericValue)
    ? String(numericValue)
    : null;
}

function getStaticBracketPropertyName(bracketProperty) {
  if (bracketProperty?.complete) {
    return bracketProperty.value;
  }
  return normalizeSimpleNumericPropertyName(bracketProperty?.expressionText ?? '');
}

function readTopLevelExpressionEnd(sourceText, index) {
  let cursor = index;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  while (cursor < sourceText.length) {
    const current = sourceText[cursor];
    const next = sourceText[cursor + 1];

    if (current === '/' && next === '/') {
      cursor = skipLineComment(sourceText, cursor);
      continue;
    }
    if (current === '/' && next === '*') {
      cursor = skipBlockComment(sourceText, cursor);
      continue;
    }
    if (current === '\'' || current === '"') {
      cursor = skipQuotedString(sourceText, cursor);
      continue;
    }
    if (current === '`') {
      cursor = skipTemplateLiteral(sourceText, cursor);
      continue;
    }
    if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0 && (current === ',' || current === '}')) {
      return cursor;
    }
    if (current === '{') {
      braceDepth += 1;
      cursor += 1;
      continue;
    }
    if (current === '}') {
      if (braceDepth > 0) {
        braceDepth -= 1;
        cursor += 1;
        continue;
      }
      return cursor;
    }
    if (current === '[') {
      bracketDepth += 1;
      cursor += 1;
      continue;
    }
    if (current === ']') {
      bracketDepth = Math.max(bracketDepth - 1, 0);
      cursor += 1;
      continue;
    }
    if (current === '(') {
      parenDepth += 1;
      cursor += 1;
      continue;
    }
    if (current === ')') {
      parenDepth = Math.max(parenDepth - 1, 0);
      cursor += 1;
      continue;
    }

    cursor += 1;
  }

  return cursor;
}

function readStatementExpressionEnd(sourceText, index) {
  let cursor = index;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  while (cursor < sourceText.length) {
    const current = sourceText[cursor];
    const next = sourceText[cursor + 1];

    if (current === '/' && next === '/') {
      cursor = skipLineComment(sourceText, cursor);
      continue;
    }
    if (current === '/' && next === '*') {
      cursor = skipBlockComment(sourceText, cursor);
      continue;
    }
    if (current === '\'' || current === '"') {
      cursor = skipQuotedString(sourceText, cursor);
      continue;
    }
    if (current === '`') {
      cursor = skipTemplateLiteral(sourceText, cursor);
      continue;
    }
    if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0 && (current === ',' || current === ';' || current === '\n')) {
      return cursor;
    }
    if (current === '{') {
      braceDepth += 1;
      cursor += 1;
      continue;
    }
    if (current === '}') {
      if (braceDepth > 0) {
        braceDepth -= 1;
        cursor += 1;
        continue;
      }
      return cursor;
    }
    if (current === '[') {
      bracketDepth += 1;
      cursor += 1;
      continue;
    }
    if (current === ']') {
      bracketDepth = Math.max(bracketDepth - 1, 0);
      cursor += 1;
      continue;
    }
    if (current === '(') {
      parenDepth += 1;
      cursor += 1;
      continue;
    }
    if (current === ')') {
      parenDepth = Math.max(parenDepth - 1, 0);
      cursor += 1;
      continue;
    }

    cursor += 1;
  }

  return cursor;
}

function parseObjectLiteralPropertyName(sourceText, index) {
  const cursor = skipTrivia(sourceText, index);
  const quotedProperty = parseQuotedStringLiteral(sourceText, cursor);
  if (quotedProperty != null) {
    return {
      name: quotedProperty.value,
      end: quotedProperty.end,
    };
  }
  const computedProperty = parseBracketPropertyExpression(sourceText, cursor);
  const computedPropertyName = getStaticBracketPropertyName(computedProperty);
  if (computedPropertyName != null) {
    return {
      name: computedPropertyName,
      end: computedProperty.end,
    };
  }
  const identifierToken = parseIdentifierToken(sourceText, cursor);
  return identifierToken == null
    ? null
    : {
        name: identifierToken.value,
        end: identifierToken.end,
      };
}

function findStaticTrailingMemberAccess(expressionText) {
  let cursor = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  while (cursor < expressionText.length) {
    const current = expressionText[cursor];
    const next = expressionText[cursor + 1];

    if (current === '/' && next === '/') {
      cursor = skipLineComment(expressionText, cursor);
      continue;
    }
    if (current === '/' && next === '*') {
      cursor = skipBlockComment(expressionText, cursor);
      continue;
    }
    if (current === '\'' || current === '"') {
      cursor = skipQuotedString(expressionText, cursor);
      continue;
    }
    if (current === '`') {
      cursor = skipTemplateLiteral(expressionText, cursor);
      continue;
    }

    if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      if (current === '.' || (current === '?' && next === '.')) {
        const property = readNextPropertyName(expressionText, cursor);
        if (property != null && skipTrivia(expressionText, property.end) === expressionText.length) {
          const receiverExpressionText = expressionText.slice(0, cursor).trimEnd();
          return receiverExpressionText.length === 0
            ? null
            : {
                receiverExpressionText,
                propertyName: property.name,
              };
        }
      }
      if (current === '[') {
        const bracketProperty = parseBracketPropertyExpression(expressionText, cursor);
        const propertyName = getStaticBracketPropertyName(bracketProperty);
        if (propertyName != null && skipTrivia(expressionText, bracketProperty.end) === expressionText.length) {
          let receiverEnd = cursor;
          const optionalChainCursor = skipWhitespaceBackward(expressionText, cursor - 1);
          if (expressionText[optionalChainCursor] === '.' && expressionText[optionalChainCursor - 1] === '?') {
            receiverEnd = optionalChainCursor - 1;
          }
          const receiverExpressionText = expressionText.slice(0, receiverEnd).trimEnd();
          return receiverExpressionText.length === 0
            ? null
            : {
                receiverExpressionText,
                propertyName,
              };
        }
        if (bracketProperty != null) {
          cursor = bracketProperty.end;
          continue;
        }
      }
    }

    if (current === '{') {
      braceDepth += 1;
      cursor += 1;
      continue;
    }
    if (current === '}') {
      braceDepth = Math.max(braceDepth - 1, 0);
      cursor += 1;
      continue;
    }
    if (current === '[') {
      bracketDepth += 1;
      cursor += 1;
      continue;
    }
    if (current === ']') {
      bracketDepth = Math.max(bracketDepth - 1, 0);
      cursor += 1;
      continue;
    }
    if (current === '(') {
      parenDepth += 1;
      cursor += 1;
      continue;
    }
    if (current === ')') {
      parenDepth = Math.max(parenDepth - 1, 0);
      cursor += 1;
      continue;
    }

    cursor += 1;
  }

  return null;
}

function parseObjectLiteralCallableMember(objectLiteralText, index) {
  let cursor = skipTrivia(objectLiteralText, index);
  let property = null;

  const prefixToken = parseIdentifierToken(objectLiteralText, cursor);
  if (prefixToken?.value === 'get' || prefixToken?.value === 'set') {
    const propertyCursor = skipTrivia(objectLiteralText, prefixToken.end);
    const accessorProperty = parseObjectLiteralPropertyName(objectLiteralText, propertyCursor);
    if (accessorProperty != null) {
      const afterProperty = skipTrivia(objectLiteralText, accessorProperty.end);
      if (objectLiteralText[afterProperty] === '(') {
        property = accessorProperty;
        cursor = afterProperty;
      }
    }
  } else {
    if (prefixToken?.value === 'async') {
      cursor = skipTrivia(objectLiteralText, prefixToken.end);
    }
    if (objectLiteralText[cursor] === '*') {
      cursor = skipTrivia(objectLiteralText, cursor + 1);
    }
    const methodProperty = parseObjectLiteralPropertyName(objectLiteralText, cursor);
    if (methodProperty != null) {
      const afterProperty = skipTrivia(objectLiteralText, methodProperty.end);
      if (objectLiteralText[afterProperty] === '(') {
        property = methodProperty;
        cursor = afterProperty;
      }
    }
  }

  if (property == null || objectLiteralText[cursor] !== '(') {
    return null;
  }

  const paramsEnd = skipBalancedCode(objectLiteralText, cursor + 1, ')');
  const bodyStart = skipTrivia(objectLiteralText, paramsEnd);
  if (objectLiteralText[bodyStart] !== '{') {
    return null;
  }
  const bodyEnd = skipBalancedCode(objectLiteralText, bodyStart + 1, '}');
  return {
    propertyName: property.name,
    propertyValue: createOpaqueCallableClassification(),
    end: bodyEnd,
  };
}

function parseObjectLiteralPropertyMap(objectLiteralText, objectPropertyAliases = null) {
  let cursor = skipTrivia(objectLiteralText, 0);
  if (objectLiteralText[cursor] !== '{') {
    return null;
  }
  cursor += 1;
  const propertyMap = new Map();

  while (cursor < objectLiteralText.length) {
    cursor = skipTrivia(objectLiteralText, cursor);
    if (objectLiteralText[cursor] === '}') {
      return propertyMap;
    }
    if (objectLiteralText.startsWith('...', cursor)) {
      const spreadStart = skipTrivia(objectLiteralText, cursor + 3);
      const spreadEnd = readTopLevelExpressionEnd(objectLiteralText, spreadStart);
      const spreadExpressionText = objectLiteralText.slice(spreadStart, spreadEnd).trim();
      let spreadProperties = null;
      if (spreadExpressionText.startsWith('{')) {
        spreadProperties = parseObjectLiteralPropertyMap(spreadExpressionText, objectPropertyAliases);
      } else if (objectPropertyAliases instanceof Map) {
        const spreadSourceName = parseSingleIdentifierExpression(spreadExpressionText);
        const sourceProperties = spreadSourceName == null ? null : objectPropertyAliases.get(spreadSourceName);
        if (sourceProperties instanceof Map) {
          spreadProperties = new Map();
          for (const [propertyName, classification] of sourceProperties.entries()) {
            spreadProperties.set(propertyName, cloneAliasClassification(classification));
          }
        }
      }
      if (spreadProperties != null) {
        for (const [propertyName, valueText] of spreadProperties) {
          propertyMap.set(propertyName, valueText);
        }
      } else {
        markUnknownObjectSpread(propertyMap);
      }
      cursor = skipTrivia(objectLiteralText, spreadEnd);
      if (objectLiteralText[cursor] === ',') {
        cursor += 1;
        continue;
      }
      if (objectLiteralText[cursor] === '}') {
        return propertyMap;
      }
      return null;
    }

    const callableMember = parseObjectLiteralCallableMember(objectLiteralText, cursor);
    if (callableMember != null) {
      propertyMap.set(callableMember.propertyName, callableMember.propertyValue);
      cursor = skipTrivia(objectLiteralText, callableMember.end);
      if (objectLiteralText[cursor] === ',') {
        cursor += 1;
        continue;
      }
      if (objectLiteralText[cursor] === '}') {
        return propertyMap;
      }
      return null;
    }

    const property = parseObjectLiteralPropertyName(objectLiteralText, cursor);
    if (property == null) {
      return null;
    }
    cursor = skipTrivia(objectLiteralText, property.end);

    let valueText;
    if (objectLiteralText[cursor] === ':') {
      const valueStart = skipTrivia(objectLiteralText, cursor + 1);
      const valueEnd = readTopLevelExpressionEnd(objectLiteralText, valueStart);
      valueText = objectLiteralText.slice(valueStart, valueEnd).trim();
      cursor = valueEnd;
    } else {
      valueText = property.name;
    }
    propertyMap.set(property.name, valueText);

    cursor = skipTrivia(objectLiteralText, cursor);
    if (objectLiteralText[cursor] === ',') {
      cursor += 1;
      continue;
    }
    if (objectLiteralText[cursor] === '}') {
      return propertyMap;
    }
    return null;
  }

  return null;
}

function resolveObjectLiteralPropertyClassification(propertyValue, aliasState) {
  if (typeof propertyValue === 'string') {
    return classifyAliasExpression(propertyValue, aliasState);
  }
  return cloneAliasClassification(propertyValue);
}

function collectDestructuredObjectLiteralAssignments(sourceText) {
  const assignments = [];
  const collectMatches = (pattern) => {
    for (const match of sourceText.matchAll(pattern)) {
      const bindingStartIndex = sourceText.indexOf('{', match.index);
      if (bindingStartIndex === -1) {
        continue;
      }
      const bindingEndIndex = skipBalancedCode(sourceText, bindingStartIndex + 1, '}');
      let cursor = skipTrivia(sourceText, bindingEndIndex);
      if (sourceText[cursor] !== '=') {
        continue;
      }
      cursor = skipTrivia(sourceText, cursor + 1);
      if (sourceText[cursor] !== '{') {
        continue;
      }
      const objectEndIndex = skipBalancedCode(sourceText, cursor + 1, '}');
      assignments.push({
        bindingText: sourceText.slice(bindingStartIndex + 1, Math.max(bindingEndIndex - 1, bindingStartIndex + 1)),
        objectLiteralText: sourceText.slice(cursor, objectEndIndex),
      });
    }
  };

  collectMatches(DESTRUCTURED_OBJECT_LITERAL_DECLARATION_RE);
  collectMatches(DESTRUCTURED_OBJECT_LITERAL_ASSIGNMENT_RE);
  return assignments;
}

function collectObjectLiteralAssignments(sourceText) {
  const assignments = [];
  const collectMatches = (pattern) => {
    for (const match of sourceText.matchAll(pattern)) {
      const objectStartIndex = match.index + match[0].lastIndexOf('{');
      const objectEndIndex = skipBalancedCode(sourceText, objectStartIndex + 1, '}');
      assignments.push({
        targetName: match[1],
        objectLiteralText: sourceText.slice(objectStartIndex, objectEndIndex),
      });
    }
  };

  collectMatches(OBJECT_LITERAL_DECLARATION_RE);
  collectMatches(OBJECT_LITERAL_ASSIGNMENT_RE);
  return assignments;
}

function collectNamedExpressionAssignments(sourceText) {
  const assignments = [];
  const collectMatches = (pattern) => {
    for (const match of sourceText.matchAll(pattern)) {
      const expressionStart = match.index + match[0].length;
      const expressionEnd = readStatementExpressionEnd(sourceText, expressionStart);
      assignments.push({
        index: match.index,
        targetName: match[1],
        expressionText: sourceText.slice(expressionStart, expressionEnd),
      });
    }
  };

  collectMatches(NAMED_EXPRESSION_DECLARATION_RE);
  collectMatches(NAMED_EXPRESSION_ASSIGNMENT_RE);
  assignments.sort((left, right) => left.index - right.index);
  return assignments;
}

function mergeAliasClassification(target, source) {
  let changed = false;
  for (const key of Object.keys(target)) {
    if (source[key] && !target[key]) {
      target[key] = true;
      changed = true;
    }
  }
  return changed;
}

function getObjectPropertyAliasClassification(objectPropertyAliases, objectName, propertyName) {
  return getObjectLiteralPropertyValue(objectPropertyAliases.get(objectName), propertyName);
}

function mergeReceiverPropertyAliasClassification(target, receiverExpressionText, propertyName, aliasState) {
  const receiverName = parseSingleIdentifierExpression(receiverExpressionText);
  if (receiverName != null) {
    target.commonJsFactory = target.commonJsFactory
      || (aliasState.nodeModuleNamespaceAliases.has(receiverName) && propertyName === 'createRequire');
    target.unsafeConstructor = target.unsafeConstructor
      || (aliasState.unsafeConstructorAliases.has(receiverName) && isUnsafeConstructorContinuationName(propertyName));
    target.unsafeReflectMethod = target.unsafeReflectMethod
      || (aliasState.reflectAliases.has(receiverName) && isUnsafeReflectMethodName(propertyName));
    const objectPropertyClassification = getObjectPropertyAliasClassification(
      aliasState.objectPropertyAliases,
      receiverName,
      propertyName,
    );
    if (objectPropertyClassification != null) {
      mergeAliasClassification(target, objectPropertyClassification);
    }
    return;
  }

  const objectLiteralText = parseObjectLiteralExpression(receiverExpressionText);
  if (objectLiteralText == null) {
    return;
  }
  const propertyMap = parseObjectLiteralPropertyMap(objectLiteralText, aliasState.objectPropertyAliases);
  if (propertyMap == null) {
    return;
  }
  const propertyValue = getObjectLiteralPropertyValue(propertyMap, propertyName);
  const propertyClassification = resolveObjectLiteralPropertyClassification(propertyValue, aliasState);
  if (propertyClassification != null) {
    mergeAliasClassification(target, propertyClassification);
  }
}

function recordObjectPropertyAlias(objectPropertyAliases, objectName, propertyName, classification) {
  if (!classification.nodeModuleNamespace
    && !classification.commonJsFactory
    && !classification.commonJsLoader
    && !classification.reflect
    && !classification.unsafeConstructor
    && !classification.unsafeReflectMethod
    && !classification.opaqueCallable) {
    return false;
  }
  let propertyMap = objectPropertyAliases.get(objectName);
  if (propertyMap == null) {
    propertyMap = new Map();
    objectPropertyAliases.set(objectName, propertyMap);
  }
  let propertyClassification = propertyMap.get(propertyName);
  if (propertyClassification == null) {
    propertyClassification = createAliasClassification();
    propertyMap.set(propertyName, propertyClassification);
  }
  return mergeAliasClassification(propertyClassification, classification);
}

function cloneObjectPropertyAliases(objectPropertyAliases, targetName, sourceName) {
  const sourceProperties = objectPropertyAliases.get(sourceName);
  if (sourceProperties == null) {
    return false;
  }
  let changed = false;
  for (const [propertyName, classification] of sourceProperties.entries()) {
    changed = recordObjectPropertyAlias(objectPropertyAliases, targetName, propertyName, classification) || changed;
  }
  return changed;
}

function classifyAliasExpression(expressionText, aliasState) {
  const classification = createAliasClassification();
  const trimmed = expressionText.trim();
  if (trimmed.length === 0) {
    return classification;
  }

  const identifierValue = decodeAliasIdentifierToken(trimmed);
  if (identifierValue != null) {
    classification.nodeModuleNamespace = aliasState.nodeModuleNamespaceAliases.has(identifierValue);
    classification.commonJsFactory = aliasState.commonJsFactoryAliases.has(identifierValue);
    classification.commonJsLoader = aliasState.commonJsLoaderAliases.has(identifierValue);
    classification.reflect = aliasState.reflectAliases.has(identifierValue);
    classification.unsafeConstructor = identifierValue === 'constructor'
      || aliasState.unsafeConstructorAliases.has(identifierValue);
    classification.unsafeReflectMethod = aliasState.unsafeReflectMethodAliases.has(identifierValue);
    classification.opaqueCallable = aliasState.opaqueCallableAliases.has(identifierValue);
  }

  if (/\.\s*constructor\s*$/.test(trimmed)) {
    classification.unsafeConstructor = true;
  }
  const trailingBracketProperty = TRAILING_BRACKET_PROPERTY_RE.exec(trimmed);
  if (decodePropertyLiteralToken(trailingBracketProperty?.[1]) === 'constructor') {
    classification.unsafeConstructor = true;
  }

  const memberAlias = SIMPLE_MEMBER_ALIAS_RE.exec(trimmed);
  if (memberAlias != null) {
    const [, receiverName, propertyToken] = memberAlias;
    const propertyName = decodeAliasIdentifierToken(propertyToken);
    if (propertyName != null) {
      classification.commonJsFactory = classification.commonJsFactory
        || (aliasState.nodeModuleNamespaceAliases.has(receiverName) && propertyName === 'createRequire');
      classification.unsafeConstructor = classification.unsafeConstructor
        || (aliasState.unsafeConstructorAliases.has(receiverName) && isUnsafeConstructorContinuationName(propertyName));
      classification.unsafeReflectMethod = classification.unsafeReflectMethod
        || (aliasState.reflectAliases.has(receiverName) && isUnsafeReflectMethodName(propertyName));
      const objectPropertyClassification = getObjectPropertyAliasClassification(
        aliasState.objectPropertyAliases,
        receiverName,
        propertyName,
      );
      if (objectPropertyClassification != null) {
        mergeAliasClassification(classification, objectPropertyClassification);
      }
    }
  }

  const bracketMemberAlias = SIMPLE_BRACKET_MEMBER_ALIAS_RE.exec(trimmed);
  if (bracketMemberAlias != null) {
    const [, receiverName, propertyLiteral] = bracketMemberAlias;
    const propertyName = decodePropertyLiteralToken(propertyLiteral);
    if (propertyName != null) {
      classification.commonJsFactory = classification.commonJsFactory
        || (aliasState.nodeModuleNamespaceAliases.has(receiverName) && propertyName === 'createRequire');
      classification.unsafeConstructor = classification.unsafeConstructor
        || (aliasState.unsafeConstructorAliases.has(receiverName) && isUnsafeConstructorContinuationName(propertyName));
      classification.unsafeReflectMethod = classification.unsafeReflectMethod
        || (aliasState.reflectAliases.has(receiverName) && isUnsafeReflectMethodName(propertyName));
      const objectPropertyClassification = getObjectPropertyAliasClassification(
        aliasState.objectPropertyAliases,
        receiverName,
        propertyName,
      );
      if (objectPropertyClassification != null) {
        mergeAliasClassification(classification, objectPropertyClassification);
      }
    }
  }

  const identifierBracketMemberAlias = SIMPLE_IDENTIFIER_BRACKET_MEMBER_ALIAS_RE.exec(trimmed);
  if (identifierBracketMemberAlias != null) {
    const [, receiverName, propertyIdentifier] = identifierBracketMemberAlias;
    const propertyName = aliasState.stringLiteralAliases?.get(propertyIdentifier) ?? null;
    if (propertyName != null) {
      classification.opaqueCallable = classification.opaqueCallable || isStringEvaluatorName(propertyName);
      classification.commonJsFactory = classification.commonJsFactory
        || (aliasState.nodeModuleNamespaceAliases.has(receiverName) && propertyName === 'createRequire');
      classification.unsafeConstructor = classification.unsafeConstructor
        || propertyName === 'constructor'
        || (aliasState.unsafeConstructorAliases.has(receiverName) && isUnsafeConstructorContinuationName(propertyName));
      classification.unsafeReflectMethod = classification.unsafeReflectMethod
        || (aliasState.reflectAliases.has(receiverName) && isUnsafeReflectMethodName(propertyName));
      const objectPropertyClassification = getObjectPropertyAliasClassification(
        aliasState.objectPropertyAliases,
        receiverName,
        propertyName,
      );
      if (objectPropertyClassification != null) {
        mergeAliasClassification(classification, objectPropertyClassification);
      }
    }
  }

  const trailingMemberAccess = findStaticTrailingMemberAccess(trimmed);
  if (trailingMemberAccess != null) {
    mergeReceiverPropertyAliasClassification(
      classification,
      trailingMemberAccess.receiverExpressionText,
      trailingMemberAccess.propertyName,
      aliasState,
    );
  }

  const callIdentifier = parseIdentifierToken(trimmed, 0);
  if (callIdentifier != null && isCallLikeExpressionAt(trimmed, callIdentifier.end)) {
    classification.commonJsLoader = classification.commonJsLoader
      || aliasState.commonJsFactoryAliases.has(callIdentifier.value);
  }

  return classification;
}

function parseNamedAliasEntries(bindingText) {
  return bindingText
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const aliasMatch = NAMED_ALIAS_ENTRY_RE.exec(entry);
      if (aliasMatch == null) {
        return null;
      }
      const sourceName = decodeAliasIdentifierToken(aliasMatch[1]);
      const localName = decodeAliasIdentifierToken(aliasMatch[2] ?? aliasMatch[1]);
      return sourceName == null || localName == null
        ? null
        : {
            sourceName,
            localName,
          };
    })
    .filter(Boolean);
}

function addAlias(targetSet, value) {
  if (typeof value !== 'string' || value.length === 0 || targetSet.has(value)) {
    return false;
  }
  targetSet.add(value);
  return true;
}

function applyClassificationToAliasSets(classification, localName, aliasSets) {
  let changed = false;
  if (classification.nodeModuleNamespace) {
    changed = addAlias(aliasSets.nodeModuleNamespaceAliases, localName) || changed;
  }
  if (classification.commonJsFactory) {
    changed = addAlias(aliasSets.commonJsFactoryAliases, localName) || changed;
  }
  if (classification.commonJsLoader) {
    changed = addAlias(aliasSets.commonJsLoaderAliases, localName) || changed;
  }
  if (classification.reflect) {
    changed = addAlias(aliasSets.reflectAliases, localName) || changed;
  }
  if (classification.unsafeConstructor) {
    changed = addAlias(aliasSets.unsafeConstructorAliases, localName) || changed;
  }
  if (classification.unsafeReflectMethod) {
    changed = addAlias(aliasSets.unsafeReflectMethodAliases, localName) || changed;
  }
  if (classification.opaqueCallable) {
    changed = addAlias(aliasSets.opaqueCallableAliases, localName) || changed;
  }
  return changed;
}

function collectAliasState(sourceText) {
  const normalizedSourceText = stripCommentsPreservingStrings(sourceText);
  const commonJsFactoryAliases = new Set(['createRequire']);
  const commonJsLoaderAliases = new Set(['require']);
  const reflectAliases = new Set(['Reflect']);
  const nodeModuleNamespaceAliases = new Set();
  const unsafeConstructorAliases = new Set();
  const unsafeReflectMethodAliases = new Set();
  const opaqueCallableAliases = new Set();
  const objectPropertyAliases = new Map();
  const stringLiteralAliases = new Map();

  for (const match of normalizedSourceText.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*(["'])node:module\2/g)) {
    for (const entry of parseNamedAliasEntries(match[1])) {
      if (entry.sourceName === 'createRequire') {
        addAlias(commonJsFactoryAliases, entry.localName);
      }
    }
  }
  for (const match of normalizedSourceText.matchAll(/\bimport\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*(["'])node:module\2/g)) {
    addAlias(nodeModuleNamespaceAliases, match[1]);
  }

  let changed = true;
  while (changed) {
    changed = false;

    for (const match of normalizedSourceText.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(\s*)*([A-Za-z_$][\w$]*)(?:\s*\))*\s*(?:[;,]|\n|$)/g)) {
      const [, localName, sourceName] = match;
      if (nodeModuleNamespaceAliases.has(sourceName)) {
        changed = addAlias(nodeModuleNamespaceAliases, localName) || changed;
      }
      if (commonJsFactoryAliases.has(sourceName)) {
        changed = addAlias(commonJsFactoryAliases, localName) || changed;
      }
      if (commonJsLoaderAliases.has(sourceName)) {
        changed = addAlias(commonJsLoaderAliases, localName) || changed;
      }
      if (reflectAliases.has(sourceName)) {
        changed = addAlias(reflectAliases, localName) || changed;
      }
      if (unsafeConstructorAliases.has(sourceName)) {
        changed = addAlias(unsafeConstructorAliases, localName) || changed;
      }
      if (unsafeReflectMethodAliases.has(sourceName)) {
        changed = addAlias(unsafeReflectMethodAliases, localName) || changed;
      }
      if (opaqueCallableAliases.has(sourceName)) {
        changed = addAlias(opaqueCallableAliases, localName) || changed;
      }
      changed = cloneObjectPropertyAliases(objectPropertyAliases, localName, sourceName) || changed;
    }

    for (const match of normalizedSourceText.matchAll(/(?:^|[;\n])\s*(?:\(\s*)*([A-Za-z_$][\w$]*)\s*=\s*(?:\(\s*)*([A-Za-z_$][\w$]*)(?:\s*\))*\s*(?:\s*\))*\s*(?:[;,]|\n|$)/gm)) {
      const [, localName, sourceName] = match;
      if (nodeModuleNamespaceAliases.has(sourceName)) {
        changed = addAlias(nodeModuleNamespaceAliases, localName) || changed;
      }
      if (commonJsFactoryAliases.has(sourceName)) {
        changed = addAlias(commonJsFactoryAliases, localName) || changed;
      }
      if (commonJsLoaderAliases.has(sourceName)) {
        changed = addAlias(commonJsLoaderAliases, localName) || changed;
      }
      if (reflectAliases.has(sourceName)) {
        changed = addAlias(reflectAliases, localName) || changed;
      }
      if (unsafeConstructorAliases.has(sourceName)) {
        changed = addAlias(unsafeConstructorAliases, localName) || changed;
      }
      if (unsafeReflectMethodAliases.has(sourceName)) {
        changed = addAlias(unsafeReflectMethodAliases, localName) || changed;
      }
      if (opaqueCallableAliases.has(sourceName)) {
        changed = addAlias(opaqueCallableAliases, localName) || changed;
      }
      changed = cloneObjectPropertyAliases(objectPropertyAliases, localName, sourceName) || changed;
    }

    for (const match of normalizedSourceText.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n;]*\.\s*constructor\b\s*(?:[;,]|\n|$)/g)) {
      const [, localName] = match;
      changed = addAlias(unsafeConstructorAliases, localName) || changed;
    }

    for (const match of normalizedSourceText.matchAll(DECLARED_CONSTRUCTOR_BRACKET_ALIAS_RE)) {
      const [, localName, propertyLiteral] = match;
      if (decodePropertyLiteralToken(propertyLiteral) === 'constructor') {
        changed = addAlias(unsafeConstructorAliases, localName) || changed;
      }
    }

    for (const match of normalizedSourceText.matchAll(/(?:^|[;\n])\s*(?:\(\s*)*([A-Za-z_$][\w$]*)\s*=\s*[^\n;]*\.\s*constructor\b\s*(?:\s*\))*\s*(?:[;,]|\n|$)/gm)) {
      const [, localName] = match;
      changed = addAlias(unsafeConstructorAliases, localName) || changed;
    }

    for (const match of normalizedSourceText.matchAll(ASSIGNED_CONSTRUCTOR_BRACKET_ALIAS_RE)) {
      const [, localName, propertyLiteral] = match;
      if (decodePropertyLiteralToken(propertyLiteral) === 'constructor') {
        changed = addAlias(unsafeConstructorAliases, localName) || changed;
      }
    }

    for (const match of normalizedSourceText.matchAll(DECLARED_MEMBER_ALIAS_RE)) {
      const [, localName, receiverName, propertyToken] = match;
      const propertyName = decodeAliasIdentifierToken(propertyToken);
      if (propertyName == null) {
        continue;
      }
      if (nodeModuleNamespaceAliases.has(receiverName) && propertyName === 'createRequire') {
        changed = addAlias(commonJsFactoryAliases, localName) || changed;
      }
      if (unsafeConstructorAliases.has(receiverName) && isUnsafeConstructorContinuationName(propertyName)) {
        changed = addAlias(unsafeConstructorAliases, localName) || changed;
      }
      if (reflectAliases.has(receiverName) && isUnsafeReflectMethodName(propertyName)) {
        changed = addAlias(unsafeReflectMethodAliases, localName) || changed;
      }
      const objectPropertyClassification = getObjectPropertyAliasClassification(objectPropertyAliases, receiverName, propertyName);
      if (objectPropertyClassification != null) {
        changed = applyClassificationToAliasSets(objectPropertyClassification, localName, {
          nodeModuleNamespaceAliases,
          commonJsFactoryAliases,
          commonJsLoaderAliases,
          reflectAliases,
          unsafeConstructorAliases,
          unsafeReflectMethodAliases,
          opaqueCallableAliases,
        }) || changed;
      }
    }

    for (const match of normalizedSourceText.matchAll(ASSIGNED_MEMBER_ALIAS_RE)) {
      const [, localName, receiverName, propertyToken] = match;
      const propertyName = decodeAliasIdentifierToken(propertyToken);
      if (propertyName == null) {
        continue;
      }
      if (nodeModuleNamespaceAliases.has(receiverName) && propertyName === 'createRequire') {
        changed = addAlias(commonJsFactoryAliases, localName) || changed;
      }
      if (unsafeConstructorAliases.has(receiverName) && isUnsafeConstructorContinuationName(propertyName)) {
        changed = addAlias(unsafeConstructorAliases, localName) || changed;
      }
      if (reflectAliases.has(receiverName) && isUnsafeReflectMethodName(propertyName)) {
        changed = addAlias(unsafeReflectMethodAliases, localName) || changed;
      }
      const objectPropertyClassification = getObjectPropertyAliasClassification(objectPropertyAliases, receiverName, propertyName);
      if (objectPropertyClassification != null) {
        changed = applyClassificationToAliasSets(objectPropertyClassification, localName, {
          nodeModuleNamespaceAliases,
          commonJsFactoryAliases,
          commonJsLoaderAliases,
          reflectAliases,
          unsafeConstructorAliases,
          unsafeReflectMethodAliases,
          opaqueCallableAliases,
        }) || changed;
      }
    }

    for (const match of normalizedSourceText.matchAll(DECLARED_BRACKET_MEMBER_ALIAS_RE)) {
      const [, localName, receiverName, propertyLiteral] = match;
      const propertyName = decodePropertyLiteralToken(propertyLiteral);
      if (propertyName == null) {
        continue;
      }
      if (nodeModuleNamespaceAliases.has(receiverName) && propertyName === 'createRequire') {
        changed = addAlias(commonJsFactoryAliases, localName) || changed;
      }
      if (unsafeConstructorAliases.has(receiverName) && isUnsafeConstructorContinuationName(propertyName)) {
        changed = addAlias(unsafeConstructorAliases, localName) || changed;
      }
      if (reflectAliases.has(receiverName) && isUnsafeReflectMethodName(propertyName)) {
        changed = addAlias(unsafeReflectMethodAliases, localName) || changed;
      }
      const objectPropertyClassification = getObjectPropertyAliasClassification(objectPropertyAliases, receiverName, propertyName);
      if (objectPropertyClassification != null) {
        changed = applyClassificationToAliasSets(objectPropertyClassification, localName, {
          nodeModuleNamespaceAliases,
          commonJsFactoryAliases,
          commonJsLoaderAliases,
          reflectAliases,
          unsafeConstructorAliases,
          unsafeReflectMethodAliases,
          opaqueCallableAliases,
        }) || changed;
      }
    }

    for (const match of normalizedSourceText.matchAll(ASSIGNED_BRACKET_MEMBER_ALIAS_RE)) {
      const [, localName, receiverName, propertyLiteral] = match;
      const propertyName = decodePropertyLiteralToken(propertyLiteral);
      if (propertyName == null) {
        continue;
      }
      if (nodeModuleNamespaceAliases.has(receiverName) && propertyName === 'createRequire') {
        changed = addAlias(commonJsFactoryAliases, localName) || changed;
      }
      if (unsafeConstructorAliases.has(receiverName) && isUnsafeConstructorContinuationName(propertyName)) {
        changed = addAlias(unsafeConstructorAliases, localName) || changed;
      }
      if (reflectAliases.has(receiverName) && isUnsafeReflectMethodName(propertyName)) {
        changed = addAlias(unsafeReflectMethodAliases, localName) || changed;
      }
      const objectPropertyClassification = getObjectPropertyAliasClassification(objectPropertyAliases, receiverName, propertyName);
      if (objectPropertyClassification != null) {
        changed = applyClassificationToAliasSets(objectPropertyClassification, localName, {
          nodeModuleNamespaceAliases,
          commonJsFactoryAliases,
          commonJsLoaderAliases,
          reflectAliases,
          unsafeConstructorAliases,
          unsafeReflectMethodAliases,
          opaqueCallableAliases,
        }) || changed;
      }
    }

    for (const match of normalizedSourceText.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
      const [, localName, calleeName] = match;
      if (commonJsFactoryAliases.has(calleeName)) {
        changed = addAlias(commonJsLoaderAliases, localName) || changed;
      }
    }

    for (const match of normalizedSourceText.matchAll(/(?:^|[;\n])\s*(?:\(\s*)*([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(/gm)) {
      const [, localName, calleeName] = match;
      if (commonJsFactoryAliases.has(calleeName)) {
        changed = addAlias(commonJsLoaderAliases, localName) || changed;
      }
    }

    for (const match of normalizedSourceText.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:\(\s*)*([A-Za-z_$][\w$]*)(?:\s*\))*/g)) {
      const [, bindingText, sourceName] = match;
      for (const entry of parseNamedAliasEntries(bindingText)) {
        if (nodeModuleNamespaceAliases.has(sourceName) && entry.sourceName === 'createRequire') {
          changed = addAlias(commonJsFactoryAliases, entry.localName) || changed;
        }
        if (unsafeConstructorAliases.has(sourceName) && isUnsafeConstructorContinuationName(entry.sourceName)) {
          changed = addAlias(unsafeConstructorAliases, entry.localName) || changed;
        }
        if (reflectAliases.has(sourceName) && isUnsafeReflectMethodName(entry.sourceName)) {
          changed = addAlias(unsafeReflectMethodAliases, entry.localName) || changed;
        }
        const objectPropertyClassification = getObjectPropertyAliasClassification(objectPropertyAliases, sourceName, entry.sourceName);
        if (objectPropertyClassification != null) {
          changed = applyClassificationToAliasSets(objectPropertyClassification, entry.localName, {
            nodeModuleNamespaceAliases,
            commonJsFactoryAliases,
            commonJsLoaderAliases,
            reflectAliases,
            unsafeConstructorAliases,
            unsafeReflectMethodAliases,
            opaqueCallableAliases,
          }) || changed;
        }
      }
    }

    for (const match of normalizedSourceText.matchAll(/(?:^|[;\n])\s*(?:\(\s*)?\{([^}]*)\}\s*=\s*(?:\(\s*)*([A-Za-z_$][\w$]*)(?:\s*\))*/gm)) {
      const [, bindingText, sourceName] = match;
      for (const entry of parseNamedAliasEntries(bindingText)) {
        if (nodeModuleNamespaceAliases.has(sourceName) && entry.sourceName === 'createRequire') {
          changed = addAlias(commonJsFactoryAliases, entry.localName) || changed;
        }
        if (unsafeConstructorAliases.has(sourceName) && isUnsafeConstructorContinuationName(entry.sourceName)) {
          changed = addAlias(unsafeConstructorAliases, entry.localName) || changed;
        }
        if (reflectAliases.has(sourceName) && isUnsafeReflectMethodName(entry.sourceName)) {
          changed = addAlias(unsafeReflectMethodAliases, entry.localName) || changed;
        }
        const objectPropertyClassification = getObjectPropertyAliasClassification(objectPropertyAliases, sourceName, entry.sourceName);
        if (objectPropertyClassification != null) {
          changed = applyClassificationToAliasSets(objectPropertyClassification, entry.localName, {
            nodeModuleNamespaceAliases,
            commonJsFactoryAliases,
            commonJsLoaderAliases,
            reflectAliases,
            unsafeConstructorAliases,
            unsafeReflectMethodAliases,
            opaqueCallableAliases,
          }) || changed;
        }
      }
    }

    for (const assignment of collectObjectLiteralAssignments(normalizedSourceText)) {
      const propertyMap = parseObjectLiteralPropertyMap(assignment.objectLiteralText, objectPropertyAliases);
      if (propertyMap == null) {
        continue;
      }
      for (const [propertyName, propertyValue] of propertyMap.entries()) {
        const classification = resolveObjectLiteralPropertyClassification(propertyValue, {
          nodeModuleNamespaceAliases,
          commonJsFactoryAliases,
          commonJsLoaderAliases,
          reflectAliases,
          unsafeConstructorAliases,
          unsafeReflectMethodAliases,
          opaqueCallableAliases,
          objectPropertyAliases,
        });
        if (classification == null) {
          continue;
        }
        changed = recordObjectPropertyAlias(objectPropertyAliases, assignment.targetName, propertyName, classification) || changed;
      }
    }

    for (const assignment of collectDestructuredObjectLiteralAssignments(normalizedSourceText)) {
      const propertyMap = parseObjectLiteralPropertyMap(assignment.objectLiteralText, objectPropertyAliases);
      if (propertyMap == null) {
        continue;
      }
      for (const entry of parseNamedAliasEntries(assignment.bindingText)) {
        const propertyValue = getObjectLiteralPropertyValue(propertyMap, entry.sourceName);
        const classification = resolveObjectLiteralPropertyClassification(propertyValue, {
          nodeModuleNamespaceAliases,
          commonJsFactoryAliases,
          commonJsLoaderAliases,
          reflectAliases,
          unsafeConstructorAliases,
          unsafeReflectMethodAliases,
          opaqueCallableAliases,
          objectPropertyAliases,
        });
        if (classification == null) {
          continue;
        }
        changed = applyClassificationToAliasSets(classification, entry.localName, {
          nodeModuleNamespaceAliases,
          commonJsFactoryAliases,
          commonJsLoaderAliases,
          reflectAliases,
          unsafeConstructorAliases,
          unsafeReflectMethodAliases,
          opaqueCallableAliases,
        }) || changed;
      }
    }

    for (const assignment of collectNamedExpressionAssignments(normalizedSourceText)) {
      const stringLiteralValue = parseSingleStringLiteralExpression(assignment.expressionText);
      if (typeof stringLiteralValue === 'string' && stringLiteralAliases.get(assignment.targetName) !== stringLiteralValue) {
        stringLiteralAliases.set(assignment.targetName, stringLiteralValue);
        changed = true;
      }
      const classification = classifyAliasExpression(assignment.expressionText, {
        nodeModuleNamespaceAliases,
        commonJsFactoryAliases,
        commonJsLoaderAliases,
        reflectAliases,
        unsafeConstructorAliases,
        unsafeReflectMethodAliases,
        opaqueCallableAliases,
        objectPropertyAliases,
        stringLiteralAliases,
      });
      changed = applyClassificationToAliasSets(classification, assignment.targetName, {
        nodeModuleNamespaceAliases,
        commonJsFactoryAliases,
        commonJsLoaderAliases,
        reflectAliases,
        unsafeConstructorAliases,
        unsafeReflectMethodAliases,
        opaqueCallableAliases,
      }) || changed;
    }
  }

  return {
    nodeModuleNamespaceAliases,
    commonJsFactoryAliases,
    commonJsLoaderAliases,
    reflectAliases,
    unsafeConstructorAliases,
    unsafeReflectMethodAliases,
    opaqueCallableAliases,
    objectPropertyAliases,
    stringLiteralAliases,
  };
}

function isSimpleNumericExpression(sourceText) {
  const trimmed = sourceText.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    return isSimpleNumericExpression(trimmed.slice(1, -1));
  }
  return /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(trimmed);
}

function isCallLikeExpressionAt(sourceText, index) {
  let cursor = skipTrivia(sourceText, index);
  while (sourceText[cursor] === ')') {
    cursor = skipTrivia(sourceText, cursor + 1);
  }
  if (sourceText[cursor] === '(') {
    return true;
  }
  if (sourceText[cursor] === '?' && sourceText[cursor + 1] === '.') {
    cursor = skipTrivia(sourceText, cursor + 2);
    while (sourceText[cursor] === ')') {
      cursor = skipTrivia(sourceText, cursor + 1);
    }
    return sourceText[cursor] === '(';
  }
  return false;
}

function readCallableContinuationInvocationProperty(sourceText, index) {
  const property = readChainedPropertyName(sourceText, index);
  if (property == null || !isCallableContinuationMethodName(property.name)) {
    return null;
  }
  return isCallLikeExpressionAt(sourceText, property.end)
    ? property
    : null;
}

function isFileUrlSpecifier(specifier) {
  return typeof specifier === 'string' && specifier.slice(0, 'file://'.length).toLowerCase() === 'file://';
}

function hasExplicitModuleScheme(specifier) {
  return typeof specifier === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier);
}

function isSafeBuiltinModuleSpecifier(specifier) {
  return typeof specifier === 'string' && specifier.startsWith('node:');
}

function isTrackedModuleSpecifier(specifier) {
  return typeof specifier === 'string'
    && (
      specifier.startsWith('.')
      || path.isAbsolute(specifier)
      || isFileUrlSpecifier(specifier)
    );
}

function isOpaqueStaticModuleSpecifier(specifier) {
  return typeof specifier === 'string'
    && !isTrackedModuleSpecifier(specifier)
    && !hasExplicitModuleScheme(specifier)
    && !isSafeBuiltinModuleSpecifier(specifier);
}

function findStaticModuleSpecifier(sourceText, startIndex) {
  let cursor = skipTrivia(sourceText, startIndex);
  const directLiteral = parseQuotedStringLiteral(sourceText, cursor);
  if (directLiteral != null) {
    return {
      specifier: directLiteral.value,
      nextIndex: directLiteral.end,
    };
  }

  while (cursor < sourceText.length) {
    const current = sourceText[cursor];
    const next = sourceText[cursor + 1];

    if (current === '/' && next === '/') {
      cursor = skipLineComment(sourceText, cursor);
      continue;
    }
    if (current === '/' && next === '*') {
      cursor = skipBlockComment(sourceText, cursor);
      continue;
    }
    if (current === '\'' || current === '"') {
      cursor = skipQuotedString(sourceText, cursor);
      continue;
    }
    if (current === '`') {
      cursor = skipTemplateLiteral(sourceText, cursor);
      continue;
    }
    if (current === ';') {
      return null;
    }
    if (hasKeywordAt(sourceText, cursor, 'from')) {
      const literalStartIndex = skipTrivia(sourceText, cursor + 4);
      const literal = parseQuotedStringLiteral(sourceText, literalStartIndex);
      if (literal != null) {
        return {
          specifier: literal.value,
          nextIndex: literal.end,
        };
      }
    }
    cursor += 1;
  }

  return null;
}

function scanTemplateLiteralDependencies(sourceText, index, aliasState) {
  const moduleSpecifiers = [];
  let hasUnresolvedDynamicImport = false;
  let cursor = index + 1;
  while (cursor < sourceText.length) {
    const current = sourceText[cursor];
    const next = sourceText[cursor + 1];
    if (current === '\\') {
      cursor += 2;
      continue;
    }
    if (current === '`') {
      return {
        moduleSpecifiers,
        hasUnresolvedDynamicImport,
        nextIndex: cursor + 1,
      };
    }
    if (current === '$' && next === '{') {
      const expressionStartIndex = cursor + 2;
      const expressionEndIndex = skipBalancedCode(sourceText, expressionStartIndex, '}');
      const expressionText = sourceText.slice(
        expressionStartIndex,
        Math.max(expressionEndIndex - 1, expressionStartIndex),
      );
      const nestedScan = collectRelativeModuleDependencies(expressionText, aliasState);
      moduleSpecifiers.push(...nestedScan.moduleSpecifiers);
      hasUnresolvedDynamicImport = hasUnresolvedDynamicImport || nestedScan.hasUnresolvedDynamicImport;
      cursor = expressionEndIndex;
      continue;
    }
    cursor += 1;
  }
  return {
    moduleSpecifiers,
    hasUnresolvedDynamicImport,
    nextIndex: sourceText.length,
  };
}

function collectRelativeModuleDependencies(sourceText, inheritedAliasState = null) {
  const moduleSpecifiers = [];
  let hasUnresolvedDynamicImport = false;
  let cursor = 0;
  const aliasState = inheritedAliasState ?? collectAliasState(sourceText);

  while (cursor < sourceText.length) {
    const current = sourceText[cursor];
    const next = sourceText[cursor + 1];

    if (/\s/.test(current)) {
      cursor += 1;
      continue;
    }
    if (current === '/' && next === '/') {
      cursor = skipLineComment(sourceText, cursor);
      continue;
    }
    if (current === '/' && next === '*') {
      cursor = skipBlockComment(sourceText, cursor);
      continue;
    }
    if (current === '\'' || current === '"') {
      cursor = skipQuotedString(sourceText, cursor);
      continue;
    }
    if (current === '`') {
      const templateLiteralScan = scanTemplateLiteralDependencies(sourceText, cursor, aliasState);
      moduleSpecifiers.push(...templateLiteralScan.moduleSpecifiers);
      hasUnresolvedDynamicImport = hasUnresolvedDynamicImport || templateLiteralScan.hasUnresolvedDynamicImport;
      cursor = templateLiteralScan.nextIndex;
      continue;
    }
    if (current === '.' || (current === '?' && next === '.')) {
      const property = readNextPropertyName(sourceText, cursor);
      if (property != null) {
        const propertyCallLike = isCallLikeExpressionAt(sourceText, property.end);
        const callableContinuation = readCallableContinuationInvocationProperty(sourceText, property.end);
        const inlineObjectPropertyClassification = getInlineObjectLiteralPropertyClassification(
          sourceText,
          cursor,
          property.name,
          aliasState,
        );
        const nextProperty = property.name === 'constructor'
          ? readChainedPropertyName(sourceText, property.end)
          : callableContinuation;
        if (
          isStringEvaluatorName(property.name)
          || (isCommonJsLoaderName(property.name) && (propertyCallLike || callableContinuation != null))
          || (
            inlineObjectPropertyClassification != null
            && (
              (
                (inlineObjectPropertyClassification.commonJsFactory || inlineObjectPropertyClassification.commonJsLoader)
                && (propertyCallLike || callableContinuation != null)
              )
              || (
                inlineObjectPropertyClassification.unsafeConstructor
                && (
                  propertyCallLike
                  || isUnsafeConstructorContinuationName(nextProperty?.name)
                )
              )
              || (inlineObjectPropertyClassification.opaqueCallable && (propertyCallLike || callableContinuation != null))
              || (inlineObjectPropertyClassification.unsafeReflectMethod && (propertyCallLike || callableContinuation != null))
            )
          )
          || (property.name === 'constructor' && (
            propertyCallLike
            || isUnsafeConstructorContinuationName(nextProperty?.name)
          ))
        ) {
          hasUnresolvedDynamicImport = true;
        }
        cursor = nextProperty?.end ?? property.end;
        continue;
      }
    }
    if (current === '[') {
      const bracketProperty = parseBracketPropertyExpression(sourceText, cursor);
      if (bracketProperty != null) {
        const staticBracketPropertyName = getStaticBracketPropertyName(bracketProperty);
        const bracketCallLike = isCallLikeExpressionAt(sourceText, bracketProperty.end);
        const chainedProperty = readNextPropertyName(sourceText, bracketProperty.end);
        const callableContinuation = readCallableContinuationInvocationProperty(sourceText, bracketProperty.end);
        const inlineObjectPropertyClassification = staticBracketPropertyName == null
          ? null
          : getInlineObjectLiteralPropertyClassification(
              sourceText,
              cursor,
              staticBracketPropertyName,
              aliasState,
            );
        const nextProperty = staticBracketPropertyName === 'constructor'
          ? readChainedPropertyName(sourceText, bracketProperty.end)
          : callableContinuation;
        if (
          (staticBracketPropertyName != null && isStringEvaluatorName(staticBracketPropertyName))
          || (staticBracketPropertyName != null && isCommonJsLoaderName(staticBracketPropertyName) && (
            bracketCallLike
            || callableContinuation != null
          ))
          || (
            inlineObjectPropertyClassification != null
            && (
              (
                (inlineObjectPropertyClassification.commonJsFactory || inlineObjectPropertyClassification.commonJsLoader)
                && (
                  bracketCallLike
                  || callableContinuation != null
                )
              )
              || (
                inlineObjectPropertyClassification.unsafeConstructor
                && (
                  bracketCallLike
                  || isUnsafeConstructorContinuationName(nextProperty?.name)
                )
              )
              || (inlineObjectPropertyClassification.opaqueCallable && (
                bracketCallLike
                || callableContinuation != null
              ))
              || (inlineObjectPropertyClassification.unsafeReflectMethod && (
                bracketCallLike
                || callableContinuation != null
              ))
            )
          )
          || (staticBracketPropertyName === 'constructor' && (
            bracketCallLike
            || isUnsafeConstructorContinuationName(nextProperty?.name)
          ))
          || (
            staticBracketPropertyName == null
            && !isSimpleNumericExpression(bracketProperty.expressionText)
            && (
              bracketCallLike
              || callableContinuation != null
              || chainedProperty != null
            )
          )
        ) {
          hasUnresolvedDynamicImport = true;
        }
        cursor = nextProperty?.end ?? bracketProperty.end;
        continue;
      }
    }
    if (current === '\'' || current === '"') {
      cursor = skipQuotedString(sourceText, cursor);
      continue;
    }
    if (current === '`') {
      cursor = skipTemplateLiteral(sourceText, cursor);
      continue;
    }
    const identifierToken = parseIdentifierToken(sourceText, cursor);
    if (identifierToken != null) {
      const identifierCallLike = isCallLikeExpressionAt(sourceText, identifierToken.end);
      const callableContinuation = readCallableContinuationInvocationProperty(sourceText, identifierToken.end);
      const isUnsafeConstructorAlias = identifierToken.value === 'constructor'
        || aliasState.unsafeConstructorAliases.has(identifierToken.value);
      const isCommonJsLikeIdentifier = isCommonJsLoaderName(identifierToken.value)
        || aliasState.commonJsFactoryAliases.has(identifierToken.value)
        || aliasState.commonJsLoaderAliases.has(identifierToken.value);
      const isReflectLikeIdentifier = aliasState.reflectAliases.has(identifierToken.value);
      const isOpaqueCallableAlias = aliasState.opaqueCallableAliases.has(identifierToken.value);
      const objectPropertyAliasMap = aliasState.objectPropertyAliases.get(identifierToken.value);
      const nextProperty = isUnsafeConstructorAlias || isCommonJsLikeIdentifier || isReflectLikeIdentifier || objectPropertyAliasMap != null
        ? readChainedPropertyName(sourceText, identifierToken.end)
        : null;
      const objectPropertyClassification = nextProperty == null
        ? null
        : getObjectPropertyAliasClassification(
            aliasState.objectPropertyAliases,
            identifierToken.value,
            nextProperty.name,
          );
      const nextObjectProperty = objectPropertyClassification?.unsafeConstructor
        ? readChainedPropertyName(sourceText, nextProperty.end)
        : null;
      const objectPropertyCallableContinuation = nextProperty == null
        ? null
        : readCallableContinuationInvocationProperty(sourceText, nextProperty.end);
      if (
        isStringEvaluatorName(identifierToken.value)
        || (
          isCommonJsLikeIdentifier
          && (
            identifierCallLike
            || callableContinuation != null
          )
        )
        || (
          isUnsafeConstructorAlias
          && (
            identifierCallLike
            || isUnsafeConstructorContinuationName(nextProperty?.name)
          )
        )
        || (aliasState.unsafeReflectMethodAliases.has(identifierToken.value) && identifierCallLike)
        || (
          isOpaqueCallableAlias
          && identifierCallLike
        )
        || (
          isReflectLikeIdentifier
          && isUnsafeReflectMethodName(nextProperty?.name)
          && isCallLikeExpressionAt(sourceText, nextProperty.end)
        )
        || (
          objectPropertyClassification != null
          && (
            (
              (objectPropertyClassification.commonJsFactory || objectPropertyClassification.commonJsLoader)
              && (
                isCallLikeExpressionAt(sourceText, nextProperty.end)
                || objectPropertyCallableContinuation != null
              )
            )
            || (
              objectPropertyClassification.unsafeConstructor
              && (
                isCallLikeExpressionAt(sourceText, nextProperty.end)
                || isUnsafeConstructorContinuationName(nextObjectProperty?.name)
              )
            )
            || (objectPropertyClassification.opaqueCallable && isCallLikeExpressionAt(sourceText, nextProperty.end))
            || (objectPropertyClassification.unsafeReflectMethod && isCallLikeExpressionAt(sourceText, nextProperty.end))
          )
        )
      ) {
        hasUnresolvedDynamicImport = true;
        cursor = objectPropertyCallableContinuation?.end ?? callableContinuation?.end ?? nextObjectProperty?.end ?? nextProperty?.end ?? identifierToken.end;
        continue;
      }
    }
    if (hasKeywordAt(sourceText, cursor, 'eval')) {
      hasUnresolvedDynamicImport = true;
      cursor += 'eval'.length;
      continue;
    }
    if (hasKeywordAt(sourceText, cursor, 'Function')) {
      hasUnresolvedDynamicImport = true;
      cursor += 'Function'.length;
      continue;
    }
    if (hasKeywordAt(sourceText, cursor, 'import')) {
      const expressionStartIndex = skipTrivia(sourceText, cursor + 'import'.length);
      if (sourceText[expressionStartIndex] === '(') {
        const expressionEndIndex = skipBalancedCode(sourceText, expressionStartIndex + 1, ')');
        const expressionText = sourceText.slice(expressionStartIndex + 1, Math.max(expressionEndIndex - 1, expressionStartIndex + 1));
        const literalSpecifier = parseSingleStringLiteralExpression(expressionText);
        if (literalSpecifier == null) {
          hasUnresolvedDynamicImport = true;
        } else if (isTrackedModuleSpecifier(literalSpecifier)) {
          moduleSpecifiers.push(literalSpecifier);
        } else if (isOpaqueStaticModuleSpecifier(literalSpecifier)) {
          hasUnresolvedDynamicImport = true;
        } else if (hasExplicitModuleScheme(literalSpecifier) && !isSafeBuiltinModuleSpecifier(literalSpecifier)) {
          hasUnresolvedDynamicImport = true;
        }
        cursor = expressionEndIndex;
        continue;
      }
      if (sourceText[expressionStartIndex] === '.') {
        cursor = expressionStartIndex + 1;
        continue;
      }
      const staticSpecifier = findStaticModuleSpecifier(sourceText, expressionStartIndex);
      if (staticSpecifier != null) {
        if (isTrackedModuleSpecifier(staticSpecifier.specifier)) {
          moduleSpecifiers.push(staticSpecifier.specifier);
        } else if (isOpaqueStaticModuleSpecifier(staticSpecifier.specifier)) {
          hasUnresolvedDynamicImport = true;
        } else if (
          hasExplicitModuleScheme(staticSpecifier.specifier)
          && !isSafeBuiltinModuleSpecifier(staticSpecifier.specifier)
        ) {
          hasUnresolvedDynamicImport = true;
        }
        cursor = staticSpecifier.nextIndex;
        continue;
      }
      cursor = expressionStartIndex;
      continue;
    }
    if (hasKeywordAt(sourceText, cursor, 'export')) {
      const staticSpecifier = findStaticModuleSpecifier(sourceText, skipTrivia(sourceText, cursor + 'export'.length));
      if (staticSpecifier != null) {
        if (isTrackedModuleSpecifier(staticSpecifier.specifier)) {
          moduleSpecifiers.push(staticSpecifier.specifier);
        } else if (isOpaqueStaticModuleSpecifier(staticSpecifier.specifier)) {
          hasUnresolvedDynamicImport = true;
        } else if (
          hasExplicitModuleScheme(staticSpecifier.specifier)
          && !isSafeBuiltinModuleSpecifier(staticSpecifier.specifier)
        ) {
          hasUnresolvedDynamicImport = true;
        }
        cursor = staticSpecifier.nextIndex;
        continue;
      }
      cursor += 'export'.length;
      continue;
    }

    cursor += 1;
  }

  return {
    moduleSpecifiers: [...new Set(moduleSpecifiers)],
    hasUnresolvedDynamicImport,
  };
}

async function resolveOwnedPath(candidatePath, repoRoot) {
  const absoluteCandidatePath = path.resolve(candidatePath);
  if (!pathIsWithinRoot(absoluteCandidatePath, repoRoot)) {
    return null;
  }
  try {
    const realCandidatePath = await fs.realpath(absoluteCandidatePath);
    return pathIsWithinRoot(realCandidatePath, repoRoot)
      ? realCandidatePath
      : null;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return absoluteCandidatePath;
    }
    throw error;
  }
}

async function resolveImportedModulePath(specifier, entryFile, repoRoot) {
  let basePath = null;
  if (specifier.startsWith('.')) {
    basePath = path.resolve(path.dirname(entryFile), specifier);
  } else if (path.isAbsolute(specifier)) {
    basePath = specifier;
  } else if (isFileUrlSpecifier(specifier)) {
    try {
      basePath = fileURLToPath(new URL(specifier));
    } catch {
      return null;
    }
  }
  if (basePath == null) {
    return null;
  }

  const candidatePaths = path.extname(basePath)
    ? [basePath]
    : [basePath, `${basePath}.mjs`];
  let sawRepoOwnedCandidate = false;
  for (const candidatePath of candidatePaths) {
    if (!pathIsWithinRoot(candidatePath, repoRoot)) {
      continue;
    }
    sawRepoOwnedCandidate = true;
    const ownedPath = await resolveOwnedPath(candidatePath, repoRoot);
    if (ownedPath == null) {
      continue;
    }
    try {
      const candidateStats = await fs.lstat(ownedPath);
      if (candidateStats.isFile()) {
        return {
          resolvedPath: ownedPath,
          resolution: 'ok',
        };
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return {
    resolvedPath: null,
    resolution: sawRepoOwnedCandidate ? 'missing' : 'outside',
  };
}

async function areSameFilesystemEntry(leftPath, rightPath) {
  try {
    const [leftStat, rightStat] = await Promise.all([
      fs.stat(leftPath),
      fs.stat(rightPath),
    ]);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function isAliasOfSharedRunArtifact(candidatePath, repoRoot) {
  const sharedRunRoot = path.join(repoRoot, L1_SHARED_TEST_RUN_ROOT);
  const visitedDirectories = new Set();

  async function walkDirectory(currentDirectory) {
    const normalizedDirectory = path.resolve(currentDirectory);
    if (visitedDirectories.has(normalizedDirectory)) {
      return false;
    }
    visitedDirectories.add(normalizedDirectory);

    let entries;
    try {
      entries = await fs.readdir(normalizedDirectory, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(normalizedDirectory, entry.name);
      if (entry.isDirectory()) {
        if (await walkDirectory(entryPath)) {
          return true;
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (await areSameFilesystemEntry(candidatePath, entryPath)) {
        return true;
      }
    }

    return false;
  }

  return walkDirectory(sharedRunRoot);
}

function resolveEnvironmentNameForArtifactId(artifactId) {
  for (const [environmentName, requirement] of Object.entries(NON_LOCAL_ENVIRONMENT_ARTIFACT_REQUIREMENTS)) {
    if (requirement.artifact_id === artifactId) {
      return environmentName;
    }
  }
  return null;
}

function requiresExternalManualArtifactEvidence(artifactId) {
  return resolveEnvironmentNameForArtifactId(artifactId) != null || artifactId === 'prod_cost_snapshot';
}

function listRequiredReadinessProbeStepNames(expectedEnvironmentName) {
  const requiredSteps = [
    'versions',
    'public_rooms',
    'register_challenge',
    'register_complete',
    'sync',
    'media_create',
  ];
  if (expectedEnvironmentName === 'staging' || expectedEnvironmentName === 'pre-release') {
    requiredSteps.push('ops_healthz', 'ops_rebuild_start');
  }
  return requiredSteps;
}

function validateEnvironmentRunReadinessProbe(reportLabel, readinessProbe, expectedEnvironmentName) {
  if (!isPlainObject(readinessProbe)) {
    return {
      valid: false,
      error: `${reportLabel} must include readiness_probe`,
    };
  }
  if (readinessProbe.environment_name !== expectedEnvironmentName) {
    return {
      valid: false,
      error: `${reportLabel} readiness_probe.environment_name must be ${expectedEnvironmentName}`,
    };
  }
  if (readinessProbe.ready !== true) {
    return {
      valid: false,
      error: `${reportLabel} readiness_probe.ready must be true`,
    };
  }
  if (!isRfc3339UtcTimestamp(readinessProbe.started_at) || !isRfc3339UtcTimestamp(readinessProbe.completed_at)) {
    return {
      valid: false,
      error: `${reportLabel} readiness_probe must include RFC 3339 UTC started_at and completed_at timestamps`,
    };
  }
  if (!isNonNegativeInteger(readinessProbe.duration_ms)) {
    return {
      valid: false,
      error: `${reportLabel} readiness_probe must include a non-negative duration_ms`,
    };
  }
  if (!isNonNegativeInteger(readinessProbe.attempt_count) || readinessProbe.attempt_count === 0) {
    return {
      valid: false,
      error: `${reportLabel} readiness_probe must include a positive attempt_count`,
    };
  }
  if (!Array.isArray(readinessProbe.attempts) || readinessProbe.attempts.length !== readinessProbe.attempt_count) {
    return {
      valid: false,
      error: `${reportLabel} readiness_probe must include attempts matching attempt_count`,
    };
  }
  const invalidAttempt = readinessProbe.attempts.find((attempt, index) => {
    if (!isPlainObject(attempt)) {
      return true;
    }
    if (attempt.attempt !== index + 1) {
      return true;
    }
    if (!isRfc3339UtcTimestamp(attempt.started_at) || !isRfc3339UtcTimestamp(attempt.completed_at)) {
      return true;
    }
    if (!isNonNegativeInteger(attempt.duration_ms)) {
      return true;
    }
    if (typeof attempt.ok !== 'boolean') {
      return true;
    }
    if (!Array.isArray(attempt.steps) || attempt.steps.length === 0) {
      return true;
    }
    if (attempt.steps.some((step) => !isPlainObject(step) || !isNonEmptyString(step.step) || typeof step.ok !== 'boolean' || !('detail' in step))) {
      return true;
    }
    if (attempt.delay_before_next_attempt_ms !== null && !isNonNegativeInteger(attempt.delay_before_next_attempt_ms)) {
      return true;
    }
    if (attempt.ok) {
      return attempt.failure !== null;
    }
    return !isPlainObject(attempt.failure) || !isNonEmptyString(attempt.failure.step_name) || !isPlainObject(attempt.failure.detail);
  });
  if (invalidAttempt) {
    return {
      valid: false,
      error: `${reportLabel} readiness_probe must include structured attempts and steps`,
    };
  }
  if (!readinessProbe.attempts.some((attempt) => attempt.ok === true) || readinessProbe.attempts.at(-1)?.ok !== true) {
    return {
      valid: false,
      error: `${reportLabel} readiness_probe must include a successful final attempt`,
    };
  }
  const finalAttempt = readinessProbe.attempts.at(-1);
  const successfulFinalStepNames = new Set(
    finalAttempt.steps
      .filter((step) => step.ok === true)
      .map((step) => step.step),
  );
  const missingRequiredSteps = listRequiredReadinessProbeStepNames(expectedEnvironmentName)
    .filter((stepName) => !successfulFinalStepNames.has(stepName));
  if (missingRequiredSteps.length > 0) {
    return {
      valid: false,
      error: `${reportLabel} readiness_probe final attempt must include successful steps: ${missingRequiredSteps.join(', ')}`,
    };
  }
  if (readinessProbe.last_error !== null) {
    return {
      valid: false,
      error: `${reportLabel} readiness_probe.last_error must be null for a passing report`,
    };
  }
  return {
    valid: true,
    error: null,
  };
}

export function validateManualArtifactPayload(artifactId, payload, {
  runTimestamp = null,
} = {}) {
  if (!isPlainObject(payload)) {
    return {
      valid: false,
      error: 'artifact payload must be a JSON object',
    };
  }

  const expectedEnvironmentName = resolveEnvironmentNameForArtifactId(artifactId);
  if (expectedEnvironmentName) {
    const environmentDefinition = getTestEnvironmentDefinition(expectedEnvironmentName);
    const normalizedTestFiles = Array.isArray(payload.test_files)
      ? payload.test_files.map((entry) => normalizeRepoRelativePath(entry))
      : null;
    const normalizedExpandedTestFiles = Array.isArray(payload.expanded_test_files)
      ? payload.expanded_test_files.map((entry) => normalizeRepoRelativePath(entry))
      : null;
    if (payload.environment_name !== expectedEnvironmentName) {
      return {
        valid: false,
        error: `environment_name must be ${expectedEnvironmentName}`,
      };
    }
    if (payload.status !== 'pass') {
      return {
        valid: false,
        error: 'environment run report must have status "pass"',
      };
    }
    if (payload.exit_code !== 0) {
      return {
        valid: false,
        error: 'environment run report must have exit_code 0',
      };
    }
    if (runTimestamp != null && payload.run_timestamp !== runTimestamp) {
      return {
        valid: false,
        error: `environment run report must have run_timestamp ${runTimestamp}`,
      };
    }
    if (!isNonEmptyString(payload.command)) {
      return {
        valid: false,
        error: 'environment run report must include a non-empty command',
      };
    }
    if (payload.test_directory !== environmentDefinition.directory) {
      return {
        valid: false,
        error: `environment run report must use test_directory ${environmentDefinition.directory}`,
      };
    }
    if (!isNonNegativeInteger(payload.test_file_count) || payload.test_file_count === 0) {
      return {
        valid: false,
        error: 'environment run report must have a positive test_file_count',
      };
    }
    if (!isRelativePathList(payload.test_files) || normalizedTestFiles == null || normalizedTestFiles.some((entry) => entry == null) || payload.test_files.length !== payload.test_file_count) {
      return {
        valid: false,
        error: 'environment run report must include test_files matching test_file_count',
      };
    }
    if (!normalizedTestFiles.every((file) => pathUsesPrefix(file, environmentDefinition.directory))) {
      return {
        valid: false,
        error: `environment run report test_files must stay within ${environmentDefinition.directory}`,
      };
    }
    if (!isNonNegativeInteger(payload.expanded_test_file_count) || payload.expanded_test_file_count === 0) {
      return {
        valid: false,
        error: 'environment run report must have a positive expanded_test_file_count',
      };
    }
    if (!isRelativePathList(payload.expanded_test_files) || normalizedExpandedTestFiles == null || normalizedExpandedTestFiles.some((entry) => entry == null) || payload.expanded_test_files.length !== payload.expanded_test_file_count) {
      return {
        valid: false,
        error: 'environment run report must include expanded_test_files matching expanded_test_file_count',
      };
    }
    if (normalizedExpandedTestFiles.some((file) => pathUsesPrefix(file, 'tests/local'))) {
      return {
        valid: false,
        error: 'environment run report must not expand local test implementations',
      };
    }
    if (!normalizedExpandedTestFiles.every((file) => pathUsesPrefix(file, environmentDefinition.directory))) {
      return {
        valid: false,
        error: `environment run report expanded_test_files must stay within ${environmentDefinition.directory}`,
      };
    }
    const genericExpandedEntrypoint = normalizedExpandedTestFiles.find((file) => {
      const basename = path.posix.basename(file);
      return basename === 'bootstrap.test.mjs' || basename === 'l1-mandatory.test.mjs';
    });
    if (genericExpandedEntrypoint != null) {
      return {
        valid: false,
        error: `environment run report expanded_test_files must not include generic entrypoint ${genericExpandedEntrypoint}`,
      };
    }
    if (!isRfc3339UtcTimestamp(payload.started_at) || !isRfc3339UtcTimestamp(payload.completed_at)) {
      return {
        valid: false,
        error: 'environment run report must include RFC 3339 UTC started_at and completed_at timestamps',
      };
    }
    if (!isNonNegativeInteger(payload.duration_ms)) {
      return {
        valid: false,
        error: 'environment run report must include a non-negative duration_ms',
      };
    }
    if (!isNonEmptyString(payload.output_sha256) || !SHA256_HEX_RE.test(payload.output_sha256)) {
      return {
        valid: false,
        error: 'environment run report must include a 64-character hex output_sha256',
      };
    }
    if (payload.error_message !== null) {
      return {
        valid: false,
        error: 'environment run report error_message must be null',
      };
    }
    if (!isAbsoluteExternalUri(payload.log_artifact)) {
      return {
        valid: false,
        error: 'environment run report must include an absolute external log_artifact',
      };
    }
    if (!isNonEmptyString(payload.executed_by)) {
      return {
        valid: false,
        error: 'environment run report must include executed_by',
      };
    }
    if (!isNonEmptyString(payload.reviewed_by)) {
      return {
        valid: false,
        error: 'environment run report must include reviewed_by',
      };
    }
    if (!isAbsoluteExternalUri(payload.source_run_uri)) {
      return {
        valid: false,
        error: 'environment run report must include an absolute external source_run_uri',
      };
    }
    if (!isNonEmptyString(payload.topology_kind) || payload.topology_kind === 'local') {
      return {
        valid: false,
        error: 'environment run report must include a non-local topology_kind',
      };
    }
    const resourceValidation = validateExpectedCloudflareResources(
      'environment run report',
      expectedEnvironmentName,
      payload.cloudflare_resources,
    );
    if (!resourceValidation.valid) {
      return resourceValidation;
    }
    const readinessProbeValidation = validateEnvironmentRunReadinessProbe(
      'environment run report',
      payload.readiness_probe,
      expectedEnvironmentName,
    );
    if (!readinessProbeValidation.valid) {
      return readinessProbeValidation;
    }
    const coversPreReleaseOps = expectedEnvironmentName === 'pre-release'
      && reportCoversCanonicalTestPrefix(payload, PRE_RELEASE_TEST_FILE_PREFIXES.ops);
    const coversPreReleaseCost = expectedEnvironmentName === 'pre-release'
      && reportCoversCanonicalTestPrefix(payload, PRE_RELEASE_TEST_FILE_PREFIXES.cost);
    if (expectedEnvironmentName === 'pre-release' && !coversPreReleaseOps && payload.rollout_skew_probe != null) {
      return {
        valid: false,
        error: 'environment run report rollout_skew_probe must be null unless TEST-OPS-001 is covered',
      };
    }
    if (expectedEnvironmentName === 'pre-release' && !coversPreReleaseCost && payload.pre_release_cost_observation != null) {
      return {
        valid: false,
        error: 'environment run report pre_release_cost_observation must be null unless TEST-COST-001 is covered',
      };
    }
    if (expectedEnvironmentName !== 'pre-release' && payload.rollout_skew_probe != null) {
      return {
        valid: false,
        error: 'environment run report rollout_skew_probe must be null outside pre-release',
      };
    }
    if (expectedEnvironmentName !== 'pre-release' && payload.pre_release_cost_observation != null) {
      return {
        valid: false,
        error: 'environment run report pre_release_cost_observation must be null outside pre-release',
      };
    }
    if (coversPreReleaseOps) {
      const rolloutValidation = validatePreReleaseRolloutSkewProbe(
        'environment run report',
        payload.rollout_skew_probe,
      );
      if (!rolloutValidation.valid) {
        return rolloutValidation;
      }
    }
    if (coversPreReleaseCost) {
      const costObservationValidation = validatePreReleaseCostObservation(
        'environment run report',
        payload.pre_release_cost_observation,
      );
      if (!costObservationValidation.valid) {
        return costObservationValidation;
      }
    }
    return {
      valid: true,
      error: null,
    };
  }

  if (artifactId === 'prod_cost_snapshot') {
    if (payload.artifact_id !== 'prod_cost_snapshot') {
      return {
        valid: false,
        error: 'prod_cost_snapshot artifact_id must be "prod_cost_snapshot"',
      };
    }
    if (payload.source_environment !== 'prod') {
      return {
        valid: false,
        error: 'prod_cost_snapshot source_environment must be "prod"',
      };
    }
    if (typeof payload.captured_at !== 'string' || payload.captured_at.trim().length === 0) {
      return {
        valid: false,
        error: 'prod_cost_snapshot captured_at must be a non-empty string',
      };
    }
    if (!isRfc3339UtcTimestamp(payload.captured_at)) {
      return {
        valid: false,
        error: 'prod_cost_snapshot captured_at must be an RFC 3339 UTC timestamp',
      };
    }
    if (runTimestamp != null && payload.run_timestamp !== runTimestamp) {
      return {
        valid: false,
        error: `prod_cost_snapshot must have run_timestamp ${runTimestamp}`,
      };
    }
    if (!isNonEmptyString(payload.captured_by)) {
      return {
        valid: false,
        error: 'prod_cost_snapshot must include captured_by',
      };
    }
    if (!isNonEmptyString(payload.reviewed_by)) {
      return {
        valid: false,
        error: 'prod_cost_snapshot must include reviewed_by',
      };
    }
    if (!isAbsoluteExternalUri(payload.source_dashboard_uri)) {
      return {
        valid: false,
        error: 'prod_cost_snapshot must include an absolute external source_dashboard_uri',
      };
    }
    if (!isNonEmptyString(payload.topology_kind) || payload.topology_kind === 'local') {
      return {
        valid: false,
        error: 'prod_cost_snapshot must include a non-local topology_kind',
      };
    }
    const resourceValidation = validateExpectedCloudflareResources(
      'prod_cost_snapshot',
      'prod',
      payload.cloudflare_resources,
    );
    if (!resourceValidation.valid) {
      return resourceValidation;
    }
    if (!isPlainObject(payload.billing_period)) {
      return {
        valid: false,
        error: 'prod_cost_snapshot must include billing_period',
      };
    }
    if (!isRfc3339UtcTimestamp(payload.billing_period.start) || !isRfc3339UtcTimestamp(payload.billing_period.end)) {
      return {
        valid: false,
        error: 'prod_cost_snapshot billing_period must include RFC 3339 UTC start and end timestamps',
      };
    }
    if (Date.parse(payload.billing_period.start) > Date.parse(payload.billing_period.end)) {
      return {
        valid: false,
        error: 'prod_cost_snapshot billing_period start must be earlier than end',
      };
    }
    if (!isPlainObject(payload.cost_surfaces)) {
      return {
        valid: false,
        error: 'prod_cost_snapshot must include cost_surfaces',
      };
    }
    const requiredCostSurfaceMetrics = {
      workers: ['request_count', 'cpu_ms', 'log_event_count'],
      durable_objects: ['request_count', 'duration_gb_s', 'sqlite_row_reads', 'sqlite_row_writes'],
      d1: ['read_rows', 'write_rows'],
      r2: ['storage_gb_month', 'class_a_ops', 'class_b_ops'],
      kv: ['read_ops', 'write_ops', 'delete_ops', 'list_ops'],
      queues: ['write_ops', 'read_ops', 'delete_ops'],
    };
    for (const [surfaceName, requiredFieldNames] of Object.entries(requiredCostSurfaceMetrics)) {
      if (!objectHasRequiredNumericFields(payload.cost_surfaces[surfaceName], requiredFieldNames)) {
        return {
          valid: false,
          error: `prod_cost_snapshot cost_surfaces.${surfaceName} must include ${requiredFieldNames.join(', ')}`,
        };
      }
    }
    if (payload.cost_surfaces.telemetry_export != null && !objectHasRequiredNumericFields(
      payload.cost_surfaces.telemetry_export,
      ['trace_span_count', 'exported_log_event_count'],
    )) {
      return {
        valid: false,
        error: 'prod_cost_snapshot cost_surfaces.telemetry_export must include trace_span_count and exported_log_event_count when present',
      };
    }
    if (payload.cost_surfaces.telemetry_export != null && typeof payload.cost_surfaces.telemetry_export.persist_enabled !== 'boolean') {
      return {
        valid: false,
        error: 'prod_cost_snapshot cost_surfaces.telemetry_export.persist_enabled must be boolean when telemetry_export is present',
      };
    }
    if (!isPlainObject(payload.model_comparison)) {
      return {
        valid: false,
        error: 'prod_cost_snapshot must include model_comparison',
      };
    }
    if (!isNonEmptyString(payload.model_comparison.status)) {
      return {
        valid: false,
        error: 'prod_cost_snapshot model_comparison.status must be a non-empty string',
      };
    }
    if (!isNonEmptyString(payload.model_comparison.summary)) {
      return {
        valid: false,
        error: 'prod_cost_snapshot model_comparison.summary must be a non-empty string',
      };
    }
    if (!isNonNegativeNumber(payload.model_comparison.actual_total_usd)) {
      return {
        valid: false,
        error: 'prod_cost_snapshot model_comparison.actual_total_usd must be a non-negative number',
      };
    }
    if (!isNonNegativeNumber(payload.model_comparison.modeled_total_usd)) {
      return {
        valid: false,
        error: 'prod_cost_snapshot model_comparison.modeled_total_usd must be a non-negative number',
      };
    }
    if (!isNonNegativeNumber(payload.model_comparison.drift_ratio)) {
      return {
        valid: false,
        error: 'prod_cost_snapshot model_comparison.drift_ratio must be a non-negative number',
      };
    }
  }

  return {
    valid: true,
    error: null,
  };
}

export function validateEvidenceAttestationBundle(artifactId, payload, {
  runTimestamp = null,
  expectedGitHubRepository = null,
} = {}) {
  if (!isPlainObject(payload)) {
    return {
      valid: false,
      error: 'attestation bundle must be a JSON object',
    };
  }

  const contract = MANUAL_ARTIFACT_ATTESTATION_REQUIREMENTS[artifactId];
  if (!contract) {
    return {
      valid: false,
      error: `unknown attestation contract for ${artifactId}`,
    };
  }

  if (payload.schema_version !== ATTESTATION_SCHEMA_VERSION) {
    return {
      valid: false,
      error: `attestation bundle schema_version must be ${ATTESTATION_SCHEMA_VERSION}`,
    };
  }
  if (payload.artifact_id !== artifactId) {
    return {
      valid: false,
      error: `attestation bundle artifact_id must be ${artifactId}`,
    };
  }
  if (payload.attestation_kind !== contract.attestation_kind) {
    return {
      valid: false,
      error: `attestation bundle attestation_kind must be ${contract.attestation_kind}`,
    };
  }
  if (payload.source_environment !== contract.source_environment) {
    return {
      valid: false,
      error: `attestation bundle source_environment must be ${contract.source_environment}`,
    };
  }
  if (runTimestamp != null && payload.run_timestamp !== runTimestamp) {
    return {
      valid: false,
      error: `attestation bundle must have run_timestamp ${runTimestamp}`,
    };
  }
  if (!isRfc3339UtcTimestamp(payload.attested_at)) {
    return {
      valid: false,
      error: 'attestation bundle must include RFC 3339 UTC attested_at',
    };
  }
  if (!isPlainObject(payload.provenance)) {
    return {
      valid: false,
      error: 'attestation bundle must include provenance',
    };
  }

  const provenance = payload.provenance;
  const expectedTopologyKind = expectedTopologyKindForSourceEnvironment(contract.source_environment);
  if (provenance.origin_system !== 'github-actions') {
    return {
      valid: false,
      error: 'attestation bundle provenance.origin_system must be github-actions',
    };
  }
  if (!isNonEmptyString(provenance.origin_run_id)) {
    return {
      valid: false,
      error: 'attestation bundle provenance.origin_run_id must be non-empty',
    };
  }
  if (!Number.isInteger(provenance.origin_run_attempt) || provenance.origin_run_attempt <= 0) {
    return {
      valid: false,
      error: 'attestation bundle provenance.origin_run_attempt must be a positive integer',
    };
  }
  if (!isNonEmptyString(provenance.origin_repository) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(provenance.origin_repository)) {
    return {
      valid: false,
      error: 'attestation bundle provenance.origin_repository must be a GitHub owner/repo slug',
    };
  }
  if (!isGitHubActionsRunUri(provenance.origin_run_uri)) {
    return {
      valid: false,
      error: 'attestation bundle provenance.origin_run_uri must be a GitHub Actions run URL',
    };
  }
  if (provenance.origin_repository !== extractGitHubActionsRunRepository(provenance.origin_run_uri)) {
    return {
      valid: false,
      error: 'attestation bundle provenance.origin_repository must match provenance.origin_run_uri',
    };
  }
  if (provenance.origin_run_id !== extractGitHubActionsRunId(provenance.origin_run_uri)) {
    return {
      valid: false,
      error: 'attestation bundle provenance.origin_run_id must match provenance.origin_run_uri',
    };
  }
  if (isNonEmptyString(expectedGitHubRepository) && provenance.origin_repository !== expectedGitHubRepository) {
    return {
      valid: false,
      error: 'attestation bundle provenance.origin_repository must match the current repository',
    };
  }
  const artifactStoreLocator = parseR2ObjectLocator(provenance.artifact_store_uri);
  if (artifactStoreLocator == null) {
    return {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_uri must be an immutable R2 object locator',
    };
  }
  if (!isNonEmptyString(provenance.artifact_store_key)) {
    return {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_key must be non-empty',
    };
  }
  if (artifactStoreLocator.objectKey !== provenance.artifact_store_key) {
    return {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_key must match provenance.artifact_store_uri',
    };
  }
  const phase08ArtifactStoreKey = parsePhase08ArtifactStoreKey(provenance.artifact_store_key);
  if (phase08ArtifactStoreKey == null) {
    return {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_key must use gha/<run_id>/<run_attempt>/<source_environment>/<run_timestamp>/... naming',
    };
  }
  if (phase08ArtifactStoreKey.originRunId !== provenance.origin_run_id) {
    return {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_key must encode provenance.origin_run_id',
    };
  }
  if (phase08ArtifactStoreKey.originRunAttempt !== provenance.origin_run_attempt) {
    return {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_key must encode provenance.origin_run_attempt',
    };
  }
  if (phase08ArtifactStoreKey.sourceEnvironment !== contract.source_environment) {
    return {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_key must encode source_environment',
    };
  }
  if (phase08ArtifactStoreKey.runTimestamp !== payload.run_timestamp) {
    return {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_key must encode run_timestamp',
    };
  }
  if (!isNonEmptyString(provenance.artifact_sha256) || !SHA256_HEX_RE.test(provenance.artifact_sha256)) {
    return {
      valid: false,
      error: 'attestation bundle provenance.artifact_sha256 must be a 64-character hex digest',
    };
  }
  if (!isAbsoluteExternalUri(provenance.review_record_uri)) {
    return {
      valid: false,
      error: 'attestation bundle provenance.review_record_uri must be an absolute external URI',
    };
  }
  if (provenance.topology_kind !== expectedTopologyKind) {
    return {
      valid: false,
      error: `attestation bundle provenance.topology_kind must be ${expectedTopologyKind}`,
    };
  }
  if (!isPlainObject(provenance.deployment_identity)) {
    return {
      valid: false,
      error: 'attestation bundle provenance.deployment_identity must be an object',
    };
  }
  if (!isNonEmptyString(provenance.deployment_identity.environment_id)) {
    return {
      valid: false,
      error: 'attestation bundle provenance.deployment_identity.environment_id must be non-empty',
    };
  }
  if (provenance.deployment_identity.environment_id !== contract.source_environment) {
    return {
      valid: false,
      error: 'attestation bundle provenance.deployment_identity.environment_id must equal source_environment',
    };
  }
  if (!isNonEmptyStringArray(provenance.deployment_identity.deployment_ids)) {
    return {
      valid: false,
      error: 'attestation bundle provenance.deployment_identity.deployment_ids must be a non-empty string array',
    };
  }
  if (!isNonEmptyStringArray(provenance.deployment_identity.worker_version_ids)) {
    return {
      valid: false,
      error: 'attestation bundle provenance.deployment_identity.worker_version_ids must be a non-empty string array',
    };
  }
  if (!isPlainObject(payload.payload)) {
    return {
      valid: false,
      error: `attestation bundle must include ${contract.payload_label} payload`,
    };
  }

  const payloadValidation = validateManualArtifactPayload(artifactId, payload.payload, {
    runTimestamp,
  });
  if (!payloadValidation.valid) {
    return {
      valid: false,
      error: `attested payload invalid: ${payloadValidation.error}`,
    };
  }
  if (payload.payload.run_timestamp !== payload.run_timestamp) {
    return {
      valid: false,
      error: 'attestation bundle payload.run_timestamp must equal attestation run_timestamp',
    };
  }
  if (payload.payload.topology_kind !== expectedTopologyKind) {
    return {
      valid: false,
      error: `attestation bundle payload topology_kind must be ${expectedTopologyKind}`,
    };
  }
  if (payload.payload.topology_kind !== provenance.topology_kind) {
    return {
      valid: false,
      error: 'attestation bundle payload topology_kind must equal provenance.topology_kind',
    };
  }
  if (
    contract.attestation_kind === 'environment_run'
    && payload.payload.source_run_uri !== provenance.origin_run_uri
  ) {
    return {
      valid: false,
      error: 'attestation bundle payload source_run_uri must equal provenance.origin_run_uri',
    };
  }

  return {
    valid: true,
    error: null,
  };
}

async function collectTransitiveTestFiles(entryFile, repoRoot, visited = new Set()) {
  const ownedEntryFile = await resolveOwnedPath(entryFile, repoRoot);
  if (ownedEntryFile == null) {
    return {
      files: [],
      missing_files: [],
      repo_boundary_escapes: [describeRepoBoundaryEscapePath(entryFile, repoRoot)],
      unresolved_dynamic_imports: [],
    };
  }

  const normalizedEntryFile = normalizePathForMarkdown(path.relative(repoRoot, ownedEntryFile));
  if (visited.has(normalizedEntryFile)) {
    return {
      files: [],
      missing_files: [],
      repo_boundary_escapes: [],
      unresolved_dynamic_imports: [],
    };
  }
  visited.add(normalizedEntryFile);

  let sourceText = '';
  try {
    sourceText = await fs.readFile(ownedEntryFile, 'utf8');
  } catch {
    return {
      files: [normalizedEntryFile],
      missing_files: [normalizedEntryFile],
      repo_boundary_escapes: [],
      unresolved_dynamic_imports: [],
    };
  }

  const transitiveFiles = new Set([normalizedEntryFile]);
  const missingFiles = [];
  const repoBoundaryEscapes = [];
  const unresolvedDynamicImports = [];
  const dependencyScan = collectRelativeModuleDependencies(sourceText);
  if (dependencyScan.hasUnresolvedDynamicImport) {
    unresolvedDynamicImports.push(normalizedEntryFile);
  }
  for (const specifier of dependencyScan.moduleSpecifiers) {
    const resolvedImport = await resolveImportedModulePath(specifier, entryFile, repoRoot);
    if (resolvedImport.resolvedPath == null) {
      if (resolvedImport.resolution === 'missing') {
        unresolvedDynamicImports.push(`${normalizedEntryFile} -> ${specifier}`);
        continue;
      }
      repoBoundaryEscapes.push(`${normalizedEntryFile} -> ${specifier}`);
      continue;
    }
    const nestedResult = await collectTransitiveTestFiles(resolvedImport.resolvedPath, repoRoot, visited);
    for (const nestedFile of nestedResult.files) {
      transitiveFiles.add(nestedFile);
    }
    for (const missingFile of nestedResult.missing_files) {
      missingFiles.push(missingFile);
    }
    for (const repoBoundaryEscape of nestedResult.repo_boundary_escapes) {
      repoBoundaryEscapes.push(repoBoundaryEscape);
    }
    for (const unresolvedImport of nestedResult.unresolved_dynamic_imports) {
      unresolvedDynamicImports.push(unresolvedImport);
    }
  }
  return {
    files: [...transitiveFiles].sort(),
    missing_files: [...new Set(missingFiles)].sort(),
    repo_boundary_escapes: [...new Set(repoBoundaryEscapes)].sort(),
    unresolved_dynamic_imports: [...new Set(unresolvedDynamicImports)].sort(),
  };
}

async function expandEnvironmentTestFiles(files, repoRoot) {
  const expanded = new Set();
  const missingFiles = new Set();
  const repoBoundaryEscapes = new Set();
  const unresolvedDynamicImports = new Set();
  for (const file of files) {
    const absoluteFile = path.isAbsolute(file)
      ? file
      : path.join(repoRoot, file);
    const expansionResult = await collectTransitiveTestFiles(absoluteFile, repoRoot);
    for (const expandedFile of expansionResult.files) {
      expanded.add(expandedFile);
    }
    for (const missingFile of expansionResult.missing_files) {
      missingFiles.add(missingFile);
    }
    for (const repoBoundaryEscape of expansionResult.repo_boundary_escapes) {
      repoBoundaryEscapes.add(repoBoundaryEscape);
    }
    for (const unresolvedImport of expansionResult.unresolved_dynamic_imports) {
      unresolvedDynamicImports.add(unresolvedImport);
    }
  }
  return {
    expanded_test_files: [...expanded].sort(),
    missing_files: [...missingFiles].sort(),
    repo_boundary_escapes: [...repoBoundaryEscapes].sort(),
    unresolved_dynamic_imports: [...unresolvedDynamicImports].sort(),
  };
}

async function validateNonLocalRequiredTestImplementationClosure(testId, environmentName, requiredFiles, repoRoot) {
  if (environmentName === 'local') {
    return null;
  }
  const environmentDirectory = normalizeRepoRelativePath(getTestEnvironmentDefinition(environmentName).directory);
  if (environmentDirectory == null) {
    return `Unknown non-local test environment directory for "${environmentName}"`;
  }
  const absoluteRequiredFiles = requiredFiles.map((file) => (path.isAbsolute(file) ? file : path.join(repoRoot, file)));
  const expansionResult = await expandEnvironmentTestFiles(absoluteRequiredFiles, repoRoot);
  if (expansionResult.missing_files.length > 0) {
    return `Non-local L1 test implementation mapping for "${testId}" in environment "${environmentName}" must reference existing repo-owned .test.mjs files`;
  }
  if (expansionResult.repo_boundary_escapes.length > 0) {
    return `Non-local L1 test implementation mapping for "${testId}" in environment "${environmentName}" escapes repo-owned dependencies`;
  }
  if (expansionResult.unresolved_dynamic_imports.length > 0) {
    return `Non-local L1 test implementation mapping for "${testId}" in environment "${environmentName}" contains unresolved or non-literal dynamic imports`;
  }
  const escapedDependency = expansionResult.expanded_test_files.find((file) => !pathUsesPrefix(file, environmentDirectory));
  if (escapedDependency != null) {
    return `Non-local L1 test implementation mapping for "${testId}" in environment "${environmentName}" must keep its repo-owned dependency closure within dedicated environment directory "${environmentDirectory}"`;
  }
  const genericDependency = expansionResult.expanded_test_files.find((file) => {
    const basename = path.posix.basename(file);
    return basename === 'bootstrap.test.mjs' || basename === 'l1-mandatory.test.mjs';
  });
  if (genericDependency != null) {
    return `Non-local L1 test implementation mapping for "${testId}" in environment "${environmentName}" cannot expand generic entrypoint "${genericDependency}"`;
  }
  return null;
}

function buildL1EvidenceOutputPaths(repoRoot, runTimestamp) {
  return [
    path.join(repoRoot, L1_SHARED_TEST_RUN_ROOT, runTimestamp),
    ...L1_EVIDENCE_DEFINITIONS.map((definition) => path.join(
      repoRoot,
      `evidence/${definition.scope}/${definition.id}/${runTimestamp}`,
    )),
  ];
}

export async function assessNonLocalEnvironmentHarnessReadiness(environmentName, repoRoot = process.cwd()) {
  let result;
  try {
    const testFiles = await getRequiredTestFiles(environmentName, repoRoot);
    const relativeTestFiles = testFiles.map((file) => normalizePathForMarkdown(path.relative(repoRoot, file)));
    const {
      expanded_test_files: expandedTestFiles,
      repo_boundary_escapes: repoBoundaryEscapes,
      unresolved_dynamic_imports: unresolvedDynamicImports,
    } = await expandEnvironmentTestFiles(testFiles, repoRoot);
    const localTestExpansions = expandedTestFiles.filter((file) => pathUsesPrefix(file, 'tests/local'));
    result = localTestExpansions.length === 0
      && unresolvedDynamicImports.length === 0
      && repoBoundaryEscapes.length === 0
      ? {
          ready: true,
          reason: null,
          test_files: relativeTestFiles,
          expanded_test_files: expandedTestFiles,
          local_test_expansions: [],
          repo_boundary_escapes: [],
          unresolved_dynamic_imports: [],
        }
      : localTestExpansions.length > 0
        ? {
          ready: false,
          reason: `${environmentName} harness still expands local test implementations`,
          test_files: relativeTestFiles,
          expanded_test_files: expandedTestFiles,
          local_test_expansions: localTestExpansions,
          repo_boundary_escapes: repoBoundaryEscapes,
          unresolved_dynamic_imports: unresolvedDynamicImports,
        }
        : repoBoundaryEscapes.length > 0
          ? {
              ready: false,
              reason: `${environmentName} harness escapes repo-owned test dependencies`,
              test_files: relativeTestFiles,
              expanded_test_files: expandedTestFiles,
              local_test_expansions: [],
              repo_boundary_escapes: repoBoundaryEscapes,
              unresolved_dynamic_imports: unresolvedDynamicImports,
            }
        : {
            ready: false,
            reason: `${environmentName} harness contains unresolved or non-literal dynamic imports or unsupported static module specifiers`,
            test_files: relativeTestFiles,
            expanded_test_files: expandedTestFiles,
            local_test_expansions: [],
            repo_boundary_escapes: repoBoundaryEscapes,
            unresolved_dynamic_imports: unresolvedDynamicImports,
          };
  } catch (error) {
    result = {
      ready: false,
      reason: error instanceof Error ? error.message : String(error),
      test_files: [],
      expanded_test_files: [],
      local_test_expansions: [],
      repo_boundary_escapes: [],
      unresolved_dynamic_imports: [],
    };
  }
  return result;
}

function slugifyTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePathForMarkdown(value) {
  return String(value).replaceAll(path.sep, '/');
}

function normalizeOptionalArtifactPath(repoRoot, artifactPath) {
  if (typeof artifactPath !== 'string' || artifactPath.trim().length === 0) {
    return null;
  }
  return path.isAbsolute(artifactPath)
    ? artifactPath
    : path.join(repoRoot, artifactPath.trim());
}

async function collectCodeVersionContext(repoRoot) {
  try {
    const [{ stdout: commitStdout }, { stdout: statusStdout }] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
      execFileAsync('git', ['status', '--short'], { cwd: repoRoot }),
    ]);
    return {
      git_commit: commitStdout.trim() || null,
      worktree_dirty: statusStdout.trim().length > 0,
    };
  } catch {
    return {
      git_commit: null,
      worktree_dirty: null,
    };
  }
}

function collectDataVersionContext(analysis) {
  const requirementRegisterJson = stableJson(analysis.requirementRegister);
  const traceabilityMatrixJson = stableJson(analysis.traceabilityMatrix);
  const expandedSourceIdsJson = stableJson(analysis.expandedSourceIds);
  const wildcardRouteExpansionJson = stableJson(analysis.wildcardRouteExpansion);
  const analysisSnapshotJson = stableJson({
    summary: analysis.summary,
    issues: analysis.issues,
    requirement_register: analysis.requirementRegister,
    traceability_matrix: analysis.traceabilityMatrix,
    expanded_source_ids: analysis.expandedSourceIds,
    wildcard_route_expansion: analysis.wildcardRouteExpansion,
  });
  return {
    analysis_sha256: sha256Hex(analysisSnapshotJson),
    requirement_register_sha256: sha256Hex(requirementRegisterJson),
    traceability_matrix_sha256: sha256Hex(traceabilityMatrixJson),
    expanded_source_ids_sha256: sha256Hex(expandedSourceIdsJson),
    wildcard_route_expansion_sha256: sha256Hex(wildcardRouteExpansionJson),
  };
}

function quoteCommand(argumentsList) {
  return argumentsList.map((argument) => (/\s/.test(argument) ? JSON.stringify(argument) : argument)).join(' ');
}

async function runEnvironmentSuite(environmentName, repoRoot, sharedRunRoot, runTimestamp, options = {}) {
  const startedAt = new Date().toISOString();
  let files;
  let errorMessage = null;
  try {
    const requestedFiles = Array.isArray(options.testFiles) ? options.testFiles : null;
    files = requestedFiles == null
      ? await getRequiredTestFiles(environmentName, repoRoot)
      : requestedFiles.map((file) => (path.isAbsolute(file) ? file : path.join(repoRoot, file)));
    if (files.length === 0) {
      throw new Error(`No ${environmentName} tests provided for evidence run`);
    }
  } catch (error) {
    files = [];
    errorMessage = error.message;
  }
  const expandedTestFiles = errorMessage == null
    ? options.skipTransitiveExpansion === true
      ? files.map((file) => normalizePathForMarkdown(path.relative(repoRoot, file)))
      : (await expandEnvironmentTestFiles(files, repoRoot)).expanded_test_files
    : [];

  const commandArgs = errorMessage
    ? []
    : ['--test', ...files];
  const combinedChunks = [];
  let exitCode = 1;
  const startedMs = Date.now();

  if (errorMessage == null) {
    exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, commandArgs, {
        cwd: repoRoot,
        env: {
          ...process.env,
          MATRIX_TEST_ENVIRONMENT: environmentName,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => {
        combinedChunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk) => {
        combinedChunks.push(Buffer.from(chunk));
      });
      child.on('error', (error) => {
        combinedChunks.push(Buffer.from(`${error.message}\n`, 'utf8'));
        resolve(1);
      });
      child.on('close', (code) => {
        resolve(code ?? 1);
      });
    });
  } else {
    combinedChunks.push(Buffer.from(`${errorMessage}\n`, 'utf8'));
  }

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startedMs;
  const logText = Buffer.concat(combinedChunks).toString('utf8');
  const logFile = path.join(sharedRunRoot, `${environmentName}.log`);
  const summaryFile = path.join(sharedRunRoot, `${environmentName}.json`);
  const record = {
    environment_name: environmentName,
    run_timestamp: runTimestamp,
    status: exitCode === 0 ? 'pass' : 'fail',
    exit_code: exitCode,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    command: errorMessage == null ? quoteCommand([process.execPath, ...commandArgs]) : null,
    test_directory: normalizePathForMarkdown(path.relative(repoRoot, getTestEnvironmentDirectory(environmentName, repoRoot))),
    test_file_count: files.length,
    test_files: files.map((file) => normalizePathForMarkdown(path.relative(repoRoot, file))),
    expanded_test_file_count: expandedTestFiles.length,
    expanded_test_files: expandedTestFiles,
    output_sha256: sha256Hex(logText),
    error_message: errorMessage,
    log_artifact: normalizePathForMarkdown(path.relative(repoRoot, logFile)),
  };

  await fs.mkdir(sharedRunRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(logFile, logText),
    fs.writeFile(summaryFile, stableJson(record)),
  ]);

  return {
    ...record,
    log_file: logFile,
    summary_file: summaryFile,
  };
}

function expandDeclaredSourceIds(declaredSourceIds, analysis) {
  const allIds = new Set(analysis.definitions.map((definition) => definition.id));
  const expanded = new Set();
  for (const sourceId of declaredSourceIds) {
    if (sourceId.endsWith('*')) {
      const prefix = sourceId.slice(0, -1);
      for (const candidateId of allIds) {
        if (candidateId.startsWith(prefix)) {
          expanded.add(candidateId);
        }
      }
      continue;
    }
    expanded.add(sourceId);
  }
  return [...expanded].sort();
}

function buildApplicableSourceIds(definition, expandedSourceIds) {
  const excluded = new Set(definition.l1_excluded_source_ids ?? []);
  return expandedSourceIds.filter((sourceId) => !excluded.has(sourceId));
}

export async function collectManualArtifactResults(definition, repoRoot, manualArtifacts = {}, runTimestamp, {
  expectedGitHubRepository = null,
} = {}) {
  const requiredManualArtifacts = buildRequiredManualArtifactDefinitions(definition);
  return Promise.all(requiredManualArtifacts.map(async (artifactRequirement) => {
    const resolvedPath = normalizeOptionalArtifactPath(repoRoot, manualArtifacts[artifactRequirement.artifact_id]);
    const providedPath = resolvedPath == null ? null : normalizePathForMarkdown(path.relative(repoRoot, resolvedPath));
    const expectedEnvironmentName = resolveEnvironmentNameForArtifactId(artifactRequirement.artifact_id);
    const requiresExternalEvidence = requiresExternalManualArtifactEvidence(artifactRequirement.artifact_id);
    const harnessReadiness = expectedEnvironmentName == null
      ? null
      : await assessNonLocalEnvironmentHarnessReadiness(expectedEnvironmentName, repoRoot);
    let exists = false;
    let sha256 = null;
    let valid = false;
    let validation_error = null;
    let resolvedRealPath = null;
    let sharedRunArtifactAlias = false;
    let attestation_kind = null;
    let attestation_origin_system = null;
    let attestation_origin_run_id = null;
    let attestation_origin_run_attempt = null;
    let attestation_origin_run_uri = null;
    let attestation_artifact_store_uri = null;
    let attestation_artifact_store_key = null;
    let attestation_artifact_sha256 = null;
    let attestation_review_record_uri = null;
    let attestation_topology_kind = null;
    let attestation_deployment_identity = null;
    let attestation_provenance = null;
    let attested_payload = null;
    if (resolvedPath) {
      try {
        const fileContents = await fs.readFile(resolvedPath);
        exists = true;
        sha256 = sha256Hex(fileContents);
        try {
          resolvedRealPath = await fs.realpath(resolvedPath);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') {
            throw error;
          }
        }
        let parsedPayload;
        try {
          parsedPayload = JSON.parse(fileContents.toString('utf8'));
        } catch {
          parsedPayload = null;
        }
        const validation = validateEvidenceAttestationBundle(artifactRequirement.artifact_id, parsedPayload, {
          runTimestamp,
          expectedGitHubRepository,
        });
        valid = validation.valid;
        validation_error = validation.error;
        if (valid) {
          attestation_kind = parsedPayload.attestation_kind ?? null;
          attestation_origin_system = parsedPayload.provenance?.origin_system ?? null;
          attestation_origin_run_id = parsedPayload.provenance?.origin_run_id ?? null;
          attestation_origin_run_attempt = parsedPayload.provenance?.origin_run_attempt ?? null;
          attestation_origin_run_uri = parsedPayload.provenance?.origin_run_uri ?? null;
          attestation_artifact_store_uri = parsedPayload.provenance?.artifact_store_uri ?? null;
          attestation_artifact_store_key = parsedPayload.provenance?.artifact_store_key ?? null;
          attestation_artifact_sha256 = parsedPayload.provenance?.artifact_sha256 ?? null;
          attestation_review_record_uri = parsedPayload.provenance?.review_record_uri ?? null;
          attestation_topology_kind = parsedPayload.provenance?.topology_kind ?? null;
          attestation_deployment_identity = parsedPayload.provenance?.deployment_identity ?? null;
        }
        attestation_provenance = isPlainObject(parsedPayload?.provenance)
          ? parsedPayload.provenance
          : null;
        attested_payload = valid && isPlainObject(parsedPayload?.payload)
          ? parsedPayload.payload
          : null;
        if (requiresExternalEvidence) {
          sharedRunArtifactAlias = await isAliasOfSharedRunArtifact(
            resolvedPath,
            repoRoot,
          );
        }
        if (
          valid
          && requiresExternalEvidence
          && (
            (providedPath != null && pathUsesPrefix(providedPath, L1_SHARED_TEST_RUN_ROOT))
            || (resolvedRealPath != null && pathIsWithinRoot(resolvedRealPath, path.join(repoRoot, L1_SHARED_TEST_RUN_ROOT)))
            || sharedRunArtifactAlias
          )
        ) {
          valid = false;
          validation_error = `${artifactRequirement.artifact_id} must come from external non-local evidence, not evidence/common/_test-runs`;
        }
        if (valid && expectedEnvironmentName != null && harnessReadiness?.ready === false) {
          valid = false;
          validation_error = `${expectedEnvironmentName} harness is not environment-backed: ${harnessReadiness.reason}`;
        }
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          exists = false;
        } else {
          exists = true;
          valid = false;
          validation_error = `failed to read ${artifactRequirement.artifact_id}: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    return {
      artifact_id: artifactRequirement.artifact_id,
      description: artifactRequirement.description,
      provided_path: providedPath,
      exists,
      valid,
      sha256,
      validation_error,
      attestation_kind,
      attestation_origin_system,
      attestation_origin_run_id,
      attestation_origin_run_attempt,
      attestation_origin_run_uri,
      attestation_artifact_store_uri,
      attestation_artifact_store_key,
      attestation_artifact_sha256,
      attestation_review_record_uri,
      attestation_topology_kind,
      attestation_deployment_identity,
      attestation_provenance,
      attested_payload,
      environment_harness_ready: harnessReadiness?.ready ?? null,
      environment_harness_reason: harnessReadiness?.reason ?? null,
    };
  }));
}

function buildAttestedEnvironmentRunSource(artifactResult) {
  const payload = artifactResult?.attested_payload;
  if (
    artifactResult?.valid !== true
    || artifactResult?.attestation_kind !== 'environment_run'
    || !isPlainObject(payload)
  ) {
    return null;
  }
  return {
    source_kind: 'attestation',
    environment_name: payload.environment_name,
    status: payload.status,
    exit_code: payload.exit_code,
    duration_ms: payload.duration_ms,
    command: payload.command,
    test_directory: payload.test_directory,
    test_file_count: payload.test_file_count,
    test_files: payload.test_files,
    expanded_test_file_count: payload.expanded_test_file_count,
    expanded_test_files: payload.expanded_test_files,
    started_at: payload.started_at,
    completed_at: payload.completed_at,
    log_artifact: payload.log_artifact,
    source_run_uri: payload.source_run_uri,
    topology_kind: payload.topology_kind,
    cloudflare_resources: payload.cloudflare_resources,
    readiness_probe: payload.readiness_probe,
    rollout_skew_probe: payload.rollout_skew_probe ?? null,
    pre_release_cost_observation: payload.pre_release_cost_observation ?? null,
    deployment_identity_validation: payload.deployment_identity_validation ?? null,
    attestation_path: artifactResult.provided_path,
    attestation_origin_run_id: artifactResult.attestation_origin_run_id,
    attestation_origin_run_attempt: artifactResult.attestation_origin_run_attempt,
    attestation_origin_run_uri: artifactResult.attestation_origin_run_uri,
    attestation_artifact_store_uri: artifactResult.attestation_artifact_store_uri,
    attestation_artifact_store_key: artifactResult.attestation_artifact_store_key,
    attestation_artifact_sha256: artifactResult.attestation_artifact_sha256,
    attestation_review_record_uri: artifactResult.attestation_review_record_uri,
    attestation_deployment_identity: artifactResult.attestation_deployment_identity,
  };
}

function buildLocalEnvironmentRunSource(environmentRun) {
  if (!environmentRun || typeof environmentRun !== 'object') {
    return null;
  }
  return {
    source_kind: 'local-execution',
    environment_name: environmentRun.environment_name,
    status: environmentRun.status,
    exit_code: environmentRun.exit_code,
    duration_ms: environmentRun.duration_ms,
    command: environmentRun.command,
    test_directory: environmentRun.test_directory,
    test_file_count: environmentRun.test_file_count,
    test_files: environmentRun.test_files,
    expanded_test_file_count: environmentRun.expanded_test_file_count,
    expanded_test_files: environmentRun.expanded_test_files,
    started_at: environmentRun.started_at,
    completed_at: environmentRun.completed_at,
    log_file: environmentRun.log_file,
    summary_file: environmentRun.summary_file,
    log_artifact: environmentRun.log_artifact,
  };
}

function resolveEnvironmentRunSource(environmentName, environmentRuns, manualArtifactResults) {
  if (environmentName === 'local') {
    return buildLocalEnvironmentRunSource(environmentRuns.local ?? null);
  }
  const artifact = manualArtifactResults.find((candidate) => candidate.attested_payload?.environment_name === environmentName)
    ?? manualArtifactResults.find((candidate) => resolveEnvironmentNameForArtifactId(candidate.artifact_id) === environmentName)
    ?? null;
  return buildAttestedEnvironmentRunSource(artifact);
}

export async function collectTestCoverageResults(definition, environmentRuns, repoRoot = process.cwd()) {
  const results = [];
  for (const environmentName of definition.required_environments) {
    const environmentRun = environmentRuns[environmentName] ?? null;
    const executedFiles = new Set(environmentRun?.expanded_test_files ?? []);
    for (const testId of definition.test_ids) {
      let requiredFiles;
      let mapping_error = null;
      try {
        requiredFiles = getRequiredTestImplementationFiles(testId, environmentName);
      } catch (error) {
        requiredFiles = [];
        mapping_error = error instanceof Error ? error.message : String(error);
      }
      if (mapping_error == null) {
        mapping_error = await validateNonLocalRequiredTestImplementationClosure(
          testId,
          environmentName,
          requiredFiles,
          repoRoot,
        );
      }
      const matchedFiles = requiredFiles.filter((file) => executedFiles.has(file));
      const missingFiles = requiredFiles.filter((file) => !executedFiles.has(file));
      results.push({
        environment_name: environmentName,
        test_id: testId,
        required_files: requiredFiles,
        matched_files: matchedFiles,
        missing_files: missingFiles,
        mapping_error,
        satisfied: mapping_error == null && missingFiles.length === 0,
      });
    }
  }
  return results;
}

function createMissingEnvironmentRunSource(environmentName, reason) {
  return {
    source_kind: 'missing-attestation',
    environment_name: environmentName,
    status: 'fail',
    exit_code: 1,
    duration_ms: null,
    command: null,
    test_directory: null,
    test_file_count: 0,
    test_files: [],
    expanded_test_file_count: 0,
    expanded_test_files: [],
    started_at: null,
    completed_at: null,
    log_artifact: null,
    missing_reason: reason,
  };
}

function serializeEnvironmentRunSource(environmentRun, evidenceRoot) {
  const baseRecord = {
    environment_name: environmentRun.environment_name,
    source_kind: environmentRun.source_kind,
    status: environmentRun.status,
    exit_code: environmentRun.exit_code,
    duration_ms: environmentRun.duration_ms,
    command: environmentRun.command,
    test_directory: environmentRun.test_directory,
    test_file_count: environmentRun.test_file_count,
    test_files: environmentRun.test_files,
    expanded_test_file_count: environmentRun.expanded_test_file_count,
    expanded_test_files: environmentRun.expanded_test_files,
    started_at: environmentRun.started_at,
    completed_at: environmentRun.completed_at,
  };
  if (environmentRun.source_kind === 'local-execution') {
    return {
      ...baseRecord,
      log_artifact: normalizePathForMarkdown(path.relative(evidenceRoot, environmentRun.log_file)),
      summary_artifact: normalizePathForMarkdown(path.relative(evidenceRoot, environmentRun.summary_file)),
    };
  }
  if (environmentRun.source_kind === 'attestation') {
    return {
      ...baseRecord,
      attestation_artifact: environmentRun.attestation_path,
      external_log_artifact: environmentRun.log_artifact,
      source_run_uri: environmentRun.source_run_uri,
      topology_kind: environmentRun.topology_kind,
      cloudflare_resources: environmentRun.cloudflare_resources,
      readiness_probe: environmentRun.readiness_probe ?? null,
      rollout_skew_probe: environmentRun.rollout_skew_probe ?? null,
      pre_release_cost_observation: environmentRun.pre_release_cost_observation ?? null,
      deployment_identity_validation: environmentRun.deployment_identity_validation ?? null,
      artifact_store_uri: environmentRun.attestation_artifact_store_uri,
      artifact_store_key: environmentRun.attestation_artifact_store_key,
      artifact_sha256: environmentRun.attestation_artifact_sha256,
      review_record_uri: environmentRun.attestation_review_record_uri,
      deployment_identity: environmentRun.attestation_deployment_identity,
    };
  }
  return {
    ...baseRecord,
    missing_reason: environmentRun.missing_reason ?? null,
  };
}

async function writeEvidenceBundle(repoRoot, {
  definition,
  analysis,
  codeVersion,
  dataVersion,
  generatedAt,
  runTimestamp,
  sharedRunRoot,
  environmentRuns,
  manualArtifacts,
  expectedGitHubRepository,
}) {
  const evidenceRoot = path.join(repoRoot, `evidence/${definition.scope}/${definition.id}/${runTimestamp}`);
  const artifactsDir = path.join(evidenceRoot, 'artifacts');
  const expandedSourceIds = expandDeclaredSourceIds(definition.declared_source_ids, analysis);
  const applicableSourceIds = buildApplicableSourceIds(definition, expandedSourceIds);
  const manualArtifactResults = await collectManualArtifactResults(definition, repoRoot, manualArtifacts, runTimestamp, {
    expectedGitHubRepository,
  });
  const coverageEnvironmentRuns = {};
  if (environmentRuns.local) {
    coverageEnvironmentRuns.local = buildLocalEnvironmentRunSource(environmentRuns.local);
  }
  const requiredEnvironments = definition.required_environments.map((environmentName) => {
    const source = resolveEnvironmentRunSource(environmentName, environmentRuns, manualArtifactResults)
      ?? createMissingEnvironmentRunSource(
        environmentName,
        `Missing valid ${environmentName} attestation for ${definition.id}`,
      );
    coverageEnvironmentRuns[environmentName] = source;
    return source;
  });
  const supportingEnvironments = coverageEnvironmentRuns.local != null
    && !definition.required_environments.includes('local')
    ? [coverageEnvironmentRuns.local]
    : [];
  const testCoverageResults = await collectTestCoverageResults(definition, coverageEnvironmentRuns, repoRoot);
  const localEnvironmentRun = coverageEnvironmentRuns.local ?? null;
  const status = analysis.valid
    && localEnvironmentRun?.exit_code === 0
    && requiredEnvironments.every((environmentRun) => environmentRun.exit_code === 0)
    && testCoverageResults.every((result) => result.satisfied)
    && manualArtifactResults.every((artifact) => artifact.valid)
    ? 'pass'
    : 'fail';

  const environmentResults = {
    required_environments: definition.required_environments,
    supporting_environments: supportingEnvironments.map((environmentRun) => environmentRun.environment_name),
    required_results: requiredEnvironments.map((environmentRun) => serializeEnvironmentRunSource(environmentRun, evidenceRoot)),
    supporting_results: supportingEnvironments.map((environmentRun) => serializeEnvironmentRunSource(environmentRun, evidenceRoot)),
    shared_run_root: normalizePathForMarkdown(path.relative(evidenceRoot, sharedRunRoot)),
    manual_requirements: manualArtifactResults,
  };

  const contextRecord = {
    evid_id: definition.id,
    target_profile: 'L1',
    generated_at: generatedAt,
    run_ts: runTimestamp,
    repo_root: normalizePathForMarkdown(repoRoot),
    code_version: codeVersion,
    data_version: dataVersion,
    governance_valid: analysis.valid,
    evidence_type: definition.evidence_type,
    generation_method: definition.generation_method,
    pass_criteria: definition.pass_criteria,
    test_ids: definition.test_ids,
  };

  const sourceIdsRecord = {
    declared_source_ids: definition.declared_source_ids,
    expanded_source_ids: expandedSourceIds,
    applicable_source_ids: applicableSourceIds,
  };

  await fs.mkdir(artifactsDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(artifactsDir, 'context.json'), stableJson(contextRecord)),
    fs.writeFile(path.join(artifactsDir, 'source-ids.json'), stableJson(sourceIdsRecord)),
    fs.writeFile(path.join(artifactsDir, 'environment-results.json'), stableJson(environmentResults)),
    fs.writeFile(path.join(artifactsDir, 'test-coverage.json'), stableJson(testCoverageResults)),
    fs.writeFile(path.join(artifactsDir, 'manual-artifacts.json'), stableJson(manualArtifactResults)),
  ]);

  const summaryLines = [
    `# ${definition.id} Summary`,
    '',
    `- status: ${status}`,
    `- generated_at: ${generatedAt}`,
    `- run_ts: ${runTimestamp}`,
    `- scope: ${definition.scope}`,
    '- target_profile: L1',
    `- evidence_type: ${definition.evidence_type}`,
    `- generation_method: ${definition.generation_method}`,
    `- repo_root: ${normalizePathForMarkdown(repoRoot)}`,
    '',
    '## Context',
    '',
    `- code_version.git_commit: ${codeVersion.git_commit == null ? '`unknown`' : `\`${codeVersion.git_commit}\``}`,
    `- code_version.worktree_dirty: ${codeVersion.worktree_dirty == null ? 'unknown' : String(codeVersion.worktree_dirty)}`,
    `- data_version.analysis_sha256: \`${dataVersion.analysis_sha256}\``,
    `- data_version.requirement_register_sha256: \`${dataVersion.requirement_register_sha256}\``,
    `- data_version.traceability_matrix_sha256: \`${dataVersion.traceability_matrix_sha256}\``,
    `- data_version.expanded_source_ids_sha256: \`${dataVersion.expanded_source_ids_sha256}\``,
    `- data_version.wildcard_route_expansion_sha256: \`${dataVersion.wildcard_route_expansion_sha256}\``,
    `- governance_valid: ${analysis.valid ? 'true' : 'false'}`,
    '',
    '## Source IDs',
    '',
    `- declared_source_ids: ${definition.declared_source_ids.map((sourceId) => `\`${sourceId}\``).join(', ')}`,
    `- expanded_source_ids: ${expandedSourceIds.map((sourceId) => `\`${sourceId}\``).join(', ')}`,
    `- applicable_source_ids: ${applicableSourceIds.map((sourceId) => `\`${sourceId}\``).join(', ')}`,
    '',
    '## Required Tests',
    '',
    definition.test_ids.map((testId) => `- \`${testId}\``).join('\n'),
    '',
    '## Environment Results',
    '',
  ];

  for (const environmentRun of requiredEnvironments) {
    summaryLines.push(`- required \`${environmentRun.environment_name}\`: ${environmentRun.status} (exit=${environmentRun.exit_code}, duration_ms=${environmentRun.duration_ms ?? 'n/a'}, source=${environmentRun.source_kind})`);
    if (environmentRun.source_kind === 'local-execution') {
      summaryLines.push(`  artifacts: \`${normalizePathForMarkdown(path.relative(evidenceRoot, environmentRun.log_file))}\`, \`${normalizePathForMarkdown(path.relative(evidenceRoot, environmentRun.summary_file))}\``);
    } else if (environmentRun.source_kind === 'attestation') {
      summaryLines.push(`  attestation: \`${environmentRun.attestation_path}\``);
      summaryLines.push(`  provenance: origin_run_uri=\`${environmentRun.attestation_origin_run_uri}\`, artifact_store_uri=\`${environmentRun.attestation_artifact_store_uri}\`, review_record_uri=\`${environmentRun.attestation_review_record_uri}\``);
      if (isPlainObject(environmentRun.readiness_probe)) {
        summaryLines.push(`  readiness: ready=${String(environmentRun.readiness_probe.ready)}, attempts=${environmentRun.readiness_probe.attempt_count}, completed_at=\`${environmentRun.readiness_probe.completed_at}\``);
      }
      if (isPlainObject(environmentRun.deployment_identity_validation)) {
        summaryLines.push(`  deployment_identity_validation: before_readiness=${environmentRun.deployment_identity_validation.before_readiness == null ? 'absent' : 'present'}, before_suite=${environmentRun.deployment_identity_validation.before_suite == null ? 'absent' : 'present'}`);
      }
    } else {
      summaryLines.push(`  reason: ${environmentRun.missing_reason ?? 'missing environment evidence'}`);
    }
  }
  for (const environmentRun of supportingEnvironments) {
    summaryLines.push(`- supporting \`${environmentRun.environment_name}\`: ${environmentRun.status} (exit=${environmentRun.exit_code}, duration_ms=${environmentRun.duration_ms ?? 'n/a'}, source=${environmentRun.source_kind})`);
    if (environmentRun.source_kind === 'local-execution') {
      summaryLines.push(`  artifacts: \`${normalizePathForMarkdown(path.relative(evidenceRoot, environmentRun.log_file))}\`, \`${normalizePathForMarkdown(path.relative(evidenceRoot, environmentRun.summary_file))}\``);
    }
  }

  summaryLines.push('');
  summaryLines.push('## Pass Criteria');
  summaryLines.push('');
  summaryLines.push(`- ${definition.pass_criteria}`);
  summaryLines.push('');
  summaryLines.push('## Test Coverage');
  summaryLines.push('');
  for (const coverageResult of testCoverageResults) {
    summaryLines.push(`- \`${coverageResult.environment_name}\` / \`${coverageResult.test_id}\`: ${coverageResult.satisfied ? 'covered' : 'missing'} via ${coverageResult.required_files.map((file) => `\`${file}\``).join(', ')}`);
    if (coverageResult.mapping_error != null) {
      summaryLines.push(`  mapping_error: ${coverageResult.mapping_error}`);
    }
  }
  if (manualArtifactResults.length > 0) {
    summaryLines.push('');
    summaryLines.push('## Manual Artifacts');
    summaryLines.push('');
    for (const artifact of manualArtifactResults) {
      const state = !artifact.exists
        ? 'missing'
        : (artifact.valid ? 'valid' : 'invalid');
      const reason = artifact.validation_error == null ? '' : `: ${artifact.validation_error}`;
      summaryLines.push(`- \`${artifact.artifact_id}\`: ${state}${artifact.provided_path == null ? '' : ` (\`${artifact.provided_path}\`)`}${reason}`);
      if (artifact.attestation_provenance != null) {
        summaryLines.push(`  provenance: origin_run_uri=\`${artifact.attestation_origin_run_uri}\`, artifact_store_uri=\`${artifact.attestation_artifact_store_uri}\`, review_record_uri=\`${artifact.attestation_review_record_uri}\``);
      }
    }
  }
  summaryLines.push('');
  summaryLines.push('## Artifacts');
  summaryLines.push('');
  summaryLines.push('- `artifacts/context.json`');
  summaryLines.push('- `artifacts/source-ids.json`');
  summaryLines.push('- `artifacts/environment-results.json`');
  summaryLines.push('- `artifacts/test-coverage.json`');
  if (manualArtifactResults.length > 0) {
    summaryLines.push('- `artifacts/manual-artifacts.json`');
  }

  await fs.writeFile(path.join(evidenceRoot, 'summary.md'), summaryLines.join('\n') + '\n');

  return {
    evid_id: definition.id,
    evidence_root: evidenceRoot,
    status,
  };
}

export async function writeL1Evidence(repoRoot = process.cwd(), options = {}) {
  const runTimestamp = resolveEvidenceRunTimestamp(options.timestamp ?? null);
  const analysis = await analyzeRepository(repoRoot);
  const generatedAt = new Date().toISOString();
  const sharedRunRoot = path.join(repoRoot, L1_SHARED_TEST_RUN_ROOT, runTimestamp);
  const codeVersion = await collectCodeVersionContext(repoRoot);
  const dataVersion = collectDataVersionContext(analysis);
  await reserveFreshOutputPaths(buildL1EvidenceOutputPaths(repoRoot, runTimestamp), {
    label: `L1 evidence output paths for run ${runTimestamp}`,
  });
  const governanceBundle = await writeGovernanceEvidence(repoRoot, { timestamp: runTimestamp });

  await fs.mkdir(sharedRunRoot, { recursive: true });

  const environmentRuns = {};
  environmentRuns.local = await runEnvironmentSuite('local', repoRoot, sharedRunRoot, runTimestamp, {
    testFiles: listL1EnvironmentImplementationFiles('local'),
    skipTransitiveExpansion: true,
  });

  const bundles = [];
  bundles.push({
    evid_id: 'EVID-GOV-001',
    evidence_root: governanceBundle.evidenceRoot,
    status: governanceBundle.analysis.valid ? 'pass' : 'fail',
  });
  for (const definition of L1_EVIDENCE_DEFINITIONS) {
    bundles.push(await writeEvidenceBundle(repoRoot, {
      definition,
      analysis,
      codeVersion,
      dataVersion,
      generatedAt,
      runTimestamp,
      sharedRunRoot,
      environmentRuns,
      manualArtifacts: options.manualArtifacts ?? {},
      expectedGitHubRepository: options.expectedGitHubRepository ?? null,
    }));
  }

  return {
    analysis,
    generated_at: generatedAt,
    run_timestamp: runTimestamp,
    shared_run_root: sharedRunRoot,
    governance_bundle: governanceBundle,
    code_version: codeVersion,
    data_version: dataVersion,
    environment_runs: environmentRuns,
    bundles,
    ok: analysis.valid
      && environmentRuns.local?.exit_code === 0
      && bundles.every((bundle) => bundle.status === 'pass'),
  };
}
