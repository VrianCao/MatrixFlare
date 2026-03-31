const MATRIX_UNRECOGNIZED_ERROR_BODY = Object.freeze({
  errcode: 'M_UNRECOGNIZED',
  error: 'Unrecognized or unsupported endpoint',
});

const MATRIX_UNKNOWN_TOKEN_ERROR_BODY = Object.freeze({
  errcode: 'M_UNKNOWN_TOKEN',
  error: 'Unknown or unsupported token',
});

const OPS_ERROR_CODES = new Set([
  'unauthorized',
  'forbidden',
  'not_found',
  'idempotency_conflict',
  'validation_failed',
  'precondition_failed',
  'rate_limited',
  'internal',
]);

const DEFAULT_OPS_HTTP_STATUS_BY_CODE = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  idempotency_conflict: 409,
  validation_failed: 422,
  precondition_failed: 409,
  rate_limited: 429,
  internal: 500,
});

const INTERNAL_ERROR_CODES = new Set([
  'invalid_token',
  'expired_session',
  'deactivated_account',
  'unknown_session',
  'invalid_cursor',
  'cursor_from_future',
  'filter_mismatch',
  'auth_forbidden',
  'state_conflict',
  'missing_prev',
  'soft_failed',
  'visibility_denied',
  'archive_missing',
  'invalid_range',
  'unsupported_algorithm',
  'already_claimed',
  'target_not_local',
  'duplicate_txn',
  'payload_mismatch',
  'retry_scheduled',
  'unsupported_schema_version',
  'backpressure',
  'job_conflict',
  'not_current',
  'quota_exceeded',
  'pending_upload_limit_exceeded',
  'upload_expired',
  'pending_upload_missing',
  'object_missing',
  'idempotency_conflict',
  'unsupported_room_version',
  'incompatible_room_version',
  'room_not_found',
  'event_not_found',
  'room_forbidden',
  'not_allowed',
  'bad_json',
  'invalid_event',
]);

function assertObjectLike(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function normalizeDetails(details) {
  if (details == null) {
    return null;
  }
  assertObjectLike(details, 'details');
  return details;
}

function cloneJsonObject(template) {
  return { ...template };
}

function parseJsonObject(jsonOrObject, label) {
  const value = typeof jsonOrObject === 'string' ? JSON.parse(jsonOrObject) : jsonOrObject;
  assertObjectLike(value, label);
  return value;
}

export function createMatrixUnrecognizedErrorBody() {
  return cloneJsonObject(MATRIX_UNRECOGNIZED_ERROR_BODY);
}

export function createMatrixUnknownTokenErrorBody() {
  return cloneJsonObject(MATRIX_UNKNOWN_TOKEN_ERROR_BODY);
}

export function createOpsErrorResponse({
  code,
  message,
  requestId,
  retryable = false,
  details = null,
}) {
  assertNonEmptyString(code, 'code');
  assertNonEmptyString(message, 'message');
  assertNonEmptyString(requestId, 'requestId');

  if (!OPS_ERROR_CODES.has(code)) {
    throw new RangeError(`Unsupported OpsErrorResponse.code: ${code}`);
  }

  return {
    code,
    message,
    request_id: requestId,
    retryable: Boolean(retryable),
    details: normalizeDetails(details),
  };
}

export function createInternalErrorEnvelope({
  code,
  message,
  retryable = false,
  details = null,
}) {
  assertNonEmptyString(code, 'code');
  assertNonEmptyString(message, 'message');

  if (!INTERNAL_ERROR_CODES.has(code)) {
    throw new RangeError(`Unsupported InternalErrorEnvelope.code: ${code}`);
  }

  return {
    code,
    message,
    retryable: Boolean(retryable),
    details: normalizeDetails(details),
  };
}

export function parseMatrixErrorBody(jsonOrObject) {
  const value = parseJsonObject(jsonOrObject, 'Matrix error body');
  assertNonEmptyString(value.errcode, 'errcode');
  assertNonEmptyString(value.error, 'error');
  return {
    errcode: value.errcode,
    error: value.error,
  };
}

export function parseOpsErrorResponse(jsonOrObject) {
  const value = parseJsonObject(jsonOrObject, 'OpsErrorResponse');
  const normalized = createOpsErrorResponse({
    code: value.code,
    message: value.message,
    requestId: value.request_id,
    retryable: value.retryable,
    details: value.details,
  });
  return normalized;
}

export function parseInternalErrorEnvelope(jsonOrObject) {
  const value = parseJsonObject(jsonOrObject, 'InternalErrorEnvelope');
  return createInternalErrorEnvelope({
    code: value.code,
    message: value.message,
    retryable: value.retryable,
    details: value.details,
  });
}

export function serializeJsonBody(body) {
  return JSON.stringify(body);
}

export function getOpsErrorHttpStatus(code, { retryable = false } = {}) {
  if (!OPS_ERROR_CODES.has(code)) {
    throw new RangeError(`Unsupported OpsErrorResponse.code: ${code}`);
  }
  if (code === 'internal' && retryable) {
    return 503;
  }
  return DEFAULT_OPS_HTTP_STATUS_BY_CODE[code];
}

export function listOpsErrorCodes() {
  return [...OPS_ERROR_CODES];
}

export function listInternalErrorCodes() {
  return [...INTERNAL_ERROR_CODES];
}
