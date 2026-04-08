import path from 'node:path';

export const TEST_E2E_ID = 'TEST-E2E-001';
export const BROWSER_JOURNEY_COVERAGE_SCHEMA_VERSION = 1;
export const BROWSER_JOURNEY_MINIMUM_COVERAGE_RATIO = 0.8;
export const ELEMENT_WEB_RELEASE = Object.freeze({
  version: '1.12.13',
  source_uri: 'https://github.com/element-hq/element-web/releases/download/v1.12.13/element-v1.12.13.tar.gz',
  sha256: 'dc1e964b1212d89b449adfd8cde2be4badcc42566cc1dc3e01540a78af1d5411',
});

export const BROWSER_JOURNEY_MATRIX = Object.freeze([
  Object.freeze({
    journey_id: 'E2E-JRY-001',
    name: 'custom homeserver configure + register',
    priority: 'P0',
    required: true,
  }),
  Object.freeze({
    journey_id: 'E2E-JRY-002',
    name: 'custom homeserver configure + login existing account',
    priority: 'P0',
    required: true,
  }),
  Object.freeze({
    journey_id: 'E2E-JRY-003',
    name: 'session restore after browser refresh',
    priority: 'P0',
    required: true,
  }),
  Object.freeze({
    journey_id: 'E2E-JRY-004',
    name: 'logout then relogin and existing room history remains visible',
    priority: 'P0',
    required: true,
  }),
  Object.freeze({
    journey_id: 'E2E-JRY-005',
    name: 'new session or new device login sees existing recent room history',
    priority: 'P0',
    required: true,
  }),
  Object.freeze({
    journey_id: 'E2E-JRY-006',
    name: 'create private room + invite + second user joins',
    priority: 'P0',
    required: true,
  }),
  Object.freeze({
    journey_id: 'E2E-JRY-007',
    name: 'create DM + two-way text messaging',
    priority: 'P0',
    required: true,
  }),
  Object.freeze({
    journey_id: 'E2E-JRY-008',
    name: 'file upload + download',
    priority: 'P0',
    required: true,
  }),
  Object.freeze({
    journey_id: 'E2E-JRY-009',
    name: 'profile modification is observed by another live session',
    priority: 'P0',
    required: true,
  }),
  Object.freeze({
    journey_id: 'E2E-JRY-010',
    name: 'message edit + reaction',
    priority: 'P1',
    required: false,
  }),
  Object.freeze({
    journey_id: 'E2E-JRY-011',
    name: 'in-room search',
    priority: 'P1',
    required: false,
  }),
  Object.freeze({
    journey_id: 'E2E-JRY-012',
    name: 'space creation + add existing room + navigation',
    priority: 'P1',
    required: false,
  }),
  Object.freeze({
    journey_id: 'E2E-JRY-013',
    name: 'encrypted room or DM send/receive',
    priority: 'P0',
    required: true,
  }),
  Object.freeze({
    journey_id: 'E2E-JRY-014',
    name: 'Secure Backup and recovery key generation',
    priority: 'P0',
    required: true,
  }),
  Object.freeze({
    journey_id: 'E2E-JRY-015',
    name: 'new session device verification and decryption of earlier encrypted history',
    priority: 'P0',
    required: true,
  }),
]);

const JOURNEY_BY_ID = new Map(BROWSER_JOURNEY_MATRIX.map((entry) => [entry.journey_id, entry]));
const FLOAT_EPSILON = 1e-9;

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRfc3339UtcTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value);
}

function isSha256Hex(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isBoolean(value) {
  return typeof value === 'boolean';
}

function isCoverageRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function ratiosEqual(left, right) {
  return Math.abs(left - right) <= FLOAT_EPSILON;
}

function isAbsoluteExternalUri(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function normalizeRelativeArtifactPath(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }
  const normalized = String(value).replaceAll(path.sep, '/').trim();
  if (
    normalized.startsWith('/')
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || normalized === '..'
  ) {
    return null;
  }
  return normalized;
}

function normalizeJourneyArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) {
    return [];
  }
  const normalized = [];
  for (const artifact of artifacts) {
    const normalizedArtifact = normalizeRelativeArtifactPath(artifact);
    if (normalizedArtifact == null) {
      continue;
    }
    if (!normalized.includes(normalizedArtifact)) {
      normalized.push(normalizedArtifact);
    }
  }
  return normalized;
}

export function listBrowserJourneyDefinitions() {
  return BROWSER_JOURNEY_MATRIX.map((entry) => ({ ...entry }));
}

export function getBrowserJourneyDefinition(journeyId) {
  const definition = JOURNEY_BY_ID.get(journeyId) ?? null;
  return definition == null ? null : { ...definition };
}

export function computeBrowserJourneyCoverageSummary(journeys) {
  const totalJourneys = journeys.length;
  const requiredJourneys = journeys.filter((journey) => journey.required === true).length;
  const passedJourneys = journeys.filter((journey) => journey.status === 'pass').length;
  const passedRequiredJourneys = journeys.filter(
    (journey) => journey.required === true && journey.status === 'pass',
  ).length;
  return Object.freeze({
    total_journeys: totalJourneys,
    required_journeys: requiredJourneys,
    passed_journeys: passedJourneys,
    passed_required_journeys: passedRequiredJourneys,
    coverage_ratio: totalJourneys === 0 ? 0 : passedJourneys / totalJourneys,
    required_pass_ratio: requiredJourneys === 0 ? 1 : passedRequiredJourneys / requiredJourneys,
    minimum_coverage_ratio: BROWSER_JOURNEY_MINIMUM_COVERAGE_RATIO,
  });
}

export function buildBrowserJourneyCoverageReport({
  environmentName = 'staging',
  capturedAt = new Date().toISOString(),
  journeys = [],
  playwright,
  elementWeb = ELEMENT_WEB_RELEASE,
} = {}) {
  const providedJourneyMap = new Map();
  for (const journey of Array.isArray(journeys) ? journeys : []) {
    if (!isPlainObject(journey) || !isNonEmptyString(journey.journey_id)) {
      continue;
    }
    providedJourneyMap.set(journey.journey_id, journey);
  }

  const normalizedJourneys = BROWSER_JOURNEY_MATRIX.map((definition) => {
    const provided = providedJourneyMap.get(definition.journey_id) ?? null;
    return Object.freeze({
      journey_id: definition.journey_id,
      name: definition.name,
      priority: definition.priority,
      required: definition.required,
      status: provided?.status === 'pass' ? 'pass' : 'fail',
      artifacts: normalizeJourneyArtifacts(provided?.artifacts),
      notes: isNonEmptyString(provided?.notes) ? provided.notes.trim() : null,
    });
  });

  return Object.freeze({
    schema_version: BROWSER_JOURNEY_COVERAGE_SCHEMA_VERSION,
    test_id: TEST_E2E_ID,
    environment_name: environmentName,
    captured_at: capturedAt,
    element_web: Object.freeze({
      version: elementWeb.version,
      source_uri: elementWeb.source_uri,
      sha256: elementWeb.sha256,
    }),
    playwright: Object.freeze({
      package_version: playwright?.package_version ?? null,
      browser_name: playwright?.browser_name ?? null,
      browser_version: playwright?.browser_version ?? null,
      headless: playwright?.headless ?? null,
    }),
    journeys: normalizedJourneys,
    coverage_summary: computeBrowserJourneyCoverageSummary(normalizedJourneys),
  });
}

export function validateBrowserJourneyCoverageReport(report, {
  expectedEnvironmentName = 'staging',
  requirePass = true,
} = {}) {
  if (!isPlainObject(report)) {
    return {
      valid: false,
      error: 'browser journey coverage report must be an object',
    };
  }
  if (report.schema_version !== BROWSER_JOURNEY_COVERAGE_SCHEMA_VERSION) {
    return {
      valid: false,
      error: `browser journey coverage report schema_version must be ${BROWSER_JOURNEY_COVERAGE_SCHEMA_VERSION}`,
    };
  }
  if (report.test_id !== TEST_E2E_ID) {
    return {
      valid: false,
      error: `browser journey coverage report test_id must be ${TEST_E2E_ID}`,
    };
  }
  if (report.environment_name !== expectedEnvironmentName) {
    return {
      valid: false,
      error: `browser journey coverage report environment_name must be ${expectedEnvironmentName}`,
    };
  }
  if (!isRfc3339UtcTimestamp(report.captured_at)) {
    return {
      valid: false,
      error: 'browser journey coverage report captured_at must be RFC 3339 UTC',
    };
  }
  if (!isPlainObject(report.element_web)) {
    return {
      valid: false,
      error: 'browser journey coverage report element_web must be an object',
    };
  }
  if (!isNonEmptyString(report.element_web.version)) {
    return {
      valid: false,
      error: 'browser journey coverage report element_web.version must be non-empty',
    };
  }
  if (!isAbsoluteExternalUri(report.element_web.source_uri)) {
    return {
      valid: false,
      error: 'browser journey coverage report element_web.source_uri must be an absolute external URI',
    };
  }
  if (!isSha256Hex(report.element_web.sha256)) {
    return {
      valid: false,
      error: 'browser journey coverage report element_web.sha256 must be a 64-character lowercase hex digest',
    };
  }
  if (!isPlainObject(report.playwright)) {
    return {
      valid: false,
      error: 'browser journey coverage report playwright must be an object',
    };
  }
  if (!isNonEmptyString(report.playwright.package_version)) {
    return {
      valid: false,
      error: 'browser journey coverage report playwright.package_version must be non-empty',
    };
  }
  if (report.playwright.browser_name !== 'chromium') {
    return {
      valid: false,
      error: 'browser journey coverage report playwright.browser_name must be chromium',
    };
  }
  if (!isNonEmptyString(report.playwright.browser_version)) {
    return {
      valid: false,
      error: 'browser journey coverage report playwright.browser_version must be non-empty',
    };
  }
  if (!isBoolean(report.playwright.headless)) {
    return {
      valid: false,
      error: 'browser journey coverage report playwright.headless must be boolean',
    };
  }
  if (!Array.isArray(report.journeys)) {
    return {
      valid: false,
      error: 'browser journey coverage report journeys must be an array',
    };
  }
  if (report.journeys.length !== BROWSER_JOURNEY_MATRIX.length) {
    return {
      valid: false,
      error: 'browser journey coverage report journeys must cover the full canonical journey matrix',
    };
  }
  const seenJourneyIds = new Set();
  for (const journey of report.journeys) {
    if (!isPlainObject(journey)) {
      return {
        valid: false,
        error: 'browser journey coverage report journey entries must be objects',
      };
    }
    if (!isNonEmptyString(journey.journey_id)) {
      return {
        valid: false,
        error: 'browser journey coverage report journey_id must be non-empty',
      };
    }
    if (seenJourneyIds.has(journey.journey_id)) {
      return {
        valid: false,
        error: `browser journey coverage report must not repeat journey_id ${journey.journey_id}`,
      };
    }
    seenJourneyIds.add(journey.journey_id);
    const definition = JOURNEY_BY_ID.get(journey.journey_id) ?? null;
    if (definition == null) {
      return {
        valid: false,
        error: `browser journey coverage report contains unknown journey_id ${journey.journey_id}`,
      };
    }
    if (journey.name !== definition.name) {
      return {
        valid: false,
        error: `browser journey coverage report ${journey.journey_id}.name must match canonical matrix`,
      };
    }
    if (journey.priority !== definition.priority) {
      return {
        valid: false,
        error: `browser journey coverage report ${journey.journey_id}.priority must match canonical matrix`,
      };
    }
    if (journey.required !== definition.required) {
      return {
        valid: false,
        error: `browser journey coverage report ${journey.journey_id}.required must match canonical matrix`,
      };
    }
    if (journey.status !== 'pass' && journey.status !== 'fail') {
      return {
        valid: false,
        error: `browser journey coverage report ${journey.journey_id}.status must be pass or fail`,
      };
    }
    if (!Array.isArray(journey.artifacts)) {
      return {
        valid: false,
        error: `browser journey coverage report ${journey.journey_id}.artifacts must be an array`,
      };
    }
    for (const artifact of journey.artifacts) {
      if (normalizeRelativeArtifactPath(artifact) == null) {
        return {
          valid: false,
          error: `browser journey coverage report ${journey.journey_id}.artifacts must contain only relative artifact paths`,
        };
      }
    }
    if (journey.notes != null && !isNonEmptyString(journey.notes)) {
      return {
        valid: false,
        error: `browser journey coverage report ${journey.journey_id}.notes must be null or non-empty`,
      };
    }
  }

  const expectedSummary = computeBrowserJourneyCoverageSummary(report.journeys);
  if (!isPlainObject(report.coverage_summary)) {
    return {
      valid: false,
      error: 'browser journey coverage report coverage_summary must be an object',
    };
  }
  const summary = report.coverage_summary;
  if (summary.total_journeys !== expectedSummary.total_journeys) {
    return {
      valid: false,
      error: 'browser journey coverage report coverage_summary.total_journeys must match journeys length',
    };
  }
  if (summary.required_journeys !== expectedSummary.required_journeys) {
    return {
      valid: false,
      error: 'browser journey coverage report coverage_summary.required_journeys must match canonical required journey count',
    };
  }
  if (summary.passed_journeys !== expectedSummary.passed_journeys) {
    return {
      valid: false,
      error: 'browser journey coverage report coverage_summary.passed_journeys must match journey statuses',
    };
  }
  if (summary.passed_required_journeys !== expectedSummary.passed_required_journeys) {
    return {
      valid: false,
      error: 'browser journey coverage report coverage_summary.passed_required_journeys must match required journey statuses',
    };
  }
  if (!isCoverageRatio(summary.coverage_ratio) || !ratiosEqual(summary.coverage_ratio, expectedSummary.coverage_ratio)) {
    return {
      valid: false,
      error: 'browser journey coverage report coverage_summary.coverage_ratio must equal passed_journeys / total_journeys',
    };
  }
  if (!isCoverageRatio(summary.required_pass_ratio) || !ratiosEqual(summary.required_pass_ratio, expectedSummary.required_pass_ratio)) {
    return {
      valid: false,
      error: 'browser journey coverage report coverage_summary.required_pass_ratio must equal passed_required_journeys / required_journeys',
    };
  }
  if (!isCoverageRatio(summary.minimum_coverage_ratio) || !ratiosEqual(summary.minimum_coverage_ratio, BROWSER_JOURNEY_MINIMUM_COVERAGE_RATIO)) {
    return {
      valid: false,
      error: `browser journey coverage report coverage_summary.minimum_coverage_ratio must be ${BROWSER_JOURNEY_MINIMUM_COVERAGE_RATIO}`,
    };
  }
  if (requirePass) {
    if (summary.coverage_ratio + FLOAT_EPSILON < BROWSER_JOURNEY_MINIMUM_COVERAGE_RATIO) {
      return {
        valid: false,
        error: 'browser journey coverage report coverage_summary.coverage_ratio must satisfy the minimum coverage threshold',
      };
    }
    if (!ratiosEqual(summary.required_pass_ratio, 1)) {
      return {
        valid: false,
        error: 'browser journey coverage report coverage_summary.required_pass_ratio must be 1',
      };
    }
  }
  return {
    valid: true,
    error: null,
  };
}
