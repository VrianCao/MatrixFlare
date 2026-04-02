import { createHmac } from 'node:crypto';

import { createCanonicalFilterHash } from './fingerprints.mjs';
import { normalizeInteger, normalizeString } from './persistence-common.mjs';
import { observeMetric, setGaugeMetric } from './telemetry.mjs';
import { parseSessionRootKeyRing } from './user-identity.mjs';

const textEncoder = new TextEncoder();

export const SYNC_TOKEN_VERSION = 2;
export const DEFAULT_SYNC_TIMEOUT_MS = 0;
export const MAX_SYNC_TIMEOUT_MS = 30_000;
export const MAX_PROFILE_KEY_BYTES = 255;
export const MAX_PROFILE_DOCUMENT_BYTES = 64 * 1024;
export const MAX_PUSH_RULES_PER_USER = 256;
export const MAX_PUSH_RULE_CONDITIONS = 32;
export const MAX_PUSH_RULES_BYTES = 64 * 1024;

export const PROFILE_KEY_DISPLAYNAME = 'displayname';
export const PROFILE_KEY_AVATAR_URL = 'avatar_url';
export const PROFILE_KEY_TIMEZONE = 'm.tz';

export const PROFILE_BUILTIN_KEYS = Object.freeze([
  PROFILE_KEY_DISPLAYNAME,
  PROFILE_KEY_AVATAR_URL,
  PROFILE_KEY_TIMEZONE,
]);

export const PUSH_RULE_KINDS = Object.freeze([
  'override',
  'underride',
  'sender',
  'room',
  'content',
]);

const PUSH_RULE_KIND_SET = new Set(PUSH_RULE_KINDS);
const PROFILE_BUILTIN_KEY_SET = new Set(PROFILE_BUILTIN_KEYS);
const CUSTOM_PROFILE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/;
const MXC_URI_PATTERN = /^mxc:\/\/[^/]+\/.+$/;
const PUSH_RULE_ID_FORBIDDEN_PATTERN = /[\\/]/;
const EVENT_MATCH_PATTERN = /^((?:\*|[^*]+)(?:\*)?)$/;

export const PUSH_RULE_BASELINE = Object.freeze({
  override: Object.freeze([
    Object.freeze({
      rule_id: '.m.rule.master',
      default: true,
      enabled: false,
      conditions: Object.freeze([]),
      actions: Object.freeze([]),
    }),
    Object.freeze({
      rule_id: '.m.rule.suppress_notices',
      default: true,
      enabled: true,
      conditions: Object.freeze([
        Object.freeze({ kind: 'event_match', key: 'content.msgtype', pattern: 'm.notice' }),
      ]),
      actions: Object.freeze([]),
    }),
    Object.freeze({
      rule_id: '.m.rule.invite_for_me',
      default: true,
      enabled: true,
      conditions: Object.freeze([
        Object.freeze({ kind: 'event_match', key: 'type', pattern: 'm.room.member' }),
        Object.freeze({ kind: 'event_match', key: 'content.membership', pattern: 'invite' }),
        Object.freeze({ kind: 'event_match', key: 'state_key', pattern: '$USER_ID' }),
      ]),
      actions: Object.freeze([
        'notify',
        Object.freeze({ set_tweak: 'sound', value: 'default' }),
      ]),
    }),
    Object.freeze({
      rule_id: '.m.rule.member_event',
      default: true,
      enabled: true,
      conditions: Object.freeze([
        Object.freeze({ kind: 'event_match', key: 'type', pattern: 'm.room.member' }),
      ]),
      actions: Object.freeze([]),
    }),
    Object.freeze({
      rule_id: '.m.rule.is_user_mention',
      default: true,
      enabled: true,
      conditions: Object.freeze([
        Object.freeze({ kind: 'event_property_contains', key: 'content.m.mentions.user_ids', value: '$USER_ID' }),
      ]),
      actions: Object.freeze([
        'notify',
        Object.freeze({ set_tweak: 'sound', value: 'default' }),
        Object.freeze({ set_tweak: 'highlight', value: true }),
      ]),
    }),
    Object.freeze({
      rule_id: '.m.rule.is_room_mention',
      default: true,
      enabled: true,
      conditions: Object.freeze([
        Object.freeze({ kind: 'event_property_is', key: 'content.m.mentions.room', value: true }),
        Object.freeze({ kind: 'sender_notification_permission', key: 'room' }),
      ]),
      actions: Object.freeze([
        'notify',
        Object.freeze({ set_tweak: 'highlight', value: true }),
      ]),
    }),
    Object.freeze({
      rule_id: '.m.rule.tombstone',
      default: true,
      enabled: true,
      conditions: Object.freeze([
        Object.freeze({ kind: 'event_match', key: 'type', pattern: 'm.room.tombstone' }),
        Object.freeze({ kind: 'event_match', key: 'state_key', pattern: '' }),
      ]),
      actions: Object.freeze([
        'notify',
        Object.freeze({ set_tweak: 'highlight', value: true }),
      ]),
    }),
    Object.freeze({
      rule_id: '.m.rule.reaction',
      default: true,
      enabled: true,
      conditions: Object.freeze([
        Object.freeze({ kind: 'event_match', key: 'type', pattern: 'm.reaction' }),
      ]),
      actions: Object.freeze([]),
    }),
    Object.freeze({
      rule_id: '.m.rule.room.server_acl',
      default: true,
      enabled: true,
      conditions: Object.freeze([
        Object.freeze({ kind: 'event_match', key: 'type', pattern: 'm.room.server_acl' }),
        Object.freeze({ kind: 'event_match', key: 'state_key', pattern: '' }),
      ]),
      actions: Object.freeze([]),
    }),
    Object.freeze({
      rule_id: '.m.rule.suppress_edits',
      default: true,
      enabled: true,
      conditions: Object.freeze([
        Object.freeze({ kind: 'event_property_is', key: 'content.m.relates_to.rel_type', value: 'm.replace' }),
      ]),
      actions: Object.freeze([]),
    }),
  ]),
  underride: Object.freeze([
    Object.freeze({
      rule_id: '.m.rule.call',
      default: true,
      enabled: true,
      conditions: Object.freeze([
        Object.freeze({ kind: 'event_match', key: 'type', pattern: 'm.call.invite' }),
      ]),
      actions: Object.freeze([
        'notify',
        Object.freeze({ set_tweak: 'sound', value: 'ring' }),
      ]),
    }),
    Object.freeze({
      rule_id: '.m.rule.encrypted_room_one_to_one',
      default: true,
      enabled: true,
      conditions: Object.freeze([
        Object.freeze({ kind: 'room_member_count', is: '2' }),
        Object.freeze({ kind: 'event_match', key: 'type', pattern: 'm.room.encrypted' }),
      ]),
      actions: Object.freeze([
        'notify',
        Object.freeze({ set_tweak: 'sound', value: 'default' }),
      ]),
    }),
    Object.freeze({
      rule_id: '.m.rule.room_one_to_one',
      default: true,
      enabled: true,
      conditions: Object.freeze([
        Object.freeze({ kind: 'room_member_count', is: '2' }),
        Object.freeze({ kind: 'event_match', key: 'type', pattern: 'm.room.message' }),
      ]),
      actions: Object.freeze([
        'notify',
        Object.freeze({ set_tweak: 'sound', value: 'default' }),
      ]),
    }),
    Object.freeze({
      rule_id: '.m.rule.message',
      default: true,
      enabled: true,
      conditions: Object.freeze([
        Object.freeze({ kind: 'event_match', key: 'type', pattern: 'm.room.message' }),
      ]),
      actions: Object.freeze([
        'notify',
      ]),
    }),
    Object.freeze({
      rule_id: '.m.rule.encrypted',
      default: true,
      enabled: true,
      conditions: Object.freeze([
        Object.freeze({ kind: 'event_match', key: 'type', pattern: 'm.room.encrypted' }),
      ]),
      actions: Object.freeze([
        'notify',
      ]),
    }),
  ]),
  sender: Object.freeze([]),
  room: Object.freeze([]),
  content: Object.freeze([]),
});

function cloneJson(value) {
  return value == null ? value : structuredClone(value);
}

function comparePushRuleOrder(left, right) {
  return left.priority_index - right.priority_index || left.rule_id.localeCompare(right.rule_id);
}

function substituteBaselineValue(value, userId) {
  if (value === '$USER_ID') {
    return userId;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteBaselineValue(item, userId));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, substituteBaselineValue(nestedValue, userId)]),
    );
  }
  return value;
}

function normalizePushRuleFromRow(row) {
  const rule = {
    rule_id: row.rule_id,
    default: row.record?.default_rule === true,
    enabled: row.enabled !== false,
  };
  if (Array.isArray(row.actions)) {
    rule.actions = cloneJson(row.actions);
  }
  if (Array.isArray(row.conditions) && row.conditions.length > 0) {
    rule.conditions = cloneJson(row.conditions);
  }
  if (row.record?.pattern != null) {
    rule.pattern = row.record.pattern;
  }
  return rule;
}

function normalizePushRuleBody(kind, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('Push rule body must be a JSON object');
  }
  const normalized = {};
  if ('actions' in body) {
    if (!Array.isArray(body.actions)) {
      throw new TypeError('Push rule actions must be an array');
    }
    normalized.actions = cloneJson(body.actions);
  } else {
    normalized.actions = [];
  }
  if ('conditions' in body) {
    if (!Array.isArray(body.conditions)) {
      throw new TypeError('Push rule conditions must be an array');
    }
    if (body.conditions.length > MAX_PUSH_RULE_CONDITIONS) {
      throw new RangeError(`Push rule conditions may contain at most ${MAX_PUSH_RULE_CONDITIONS} entries`);
    }
    normalized.conditions = cloneJson(body.conditions);
  } else {
    normalized.conditions = [];
  }
  if ('pattern' in body) {
    if (typeof body.pattern !== 'string') {
      throw new TypeError('Push rule pattern must be a string');
    }
    normalized.pattern = body.pattern;
  } else if (kind === 'content') {
    throw new TypeError('Content push rules require a pattern');
  }
  return normalized;
}

function matchEventTypePattern(type, pattern) {
  if (pattern === '*') {
    return true;
  }
  if (pattern.endsWith('*')) {
    return type.startsWith(pattern.slice(0, -1));
  }
  return type === pattern;
}

export function isAllowedProfileKey(keyName) {
  if (typeof keyName !== 'string' || keyName.length === 0) {
    return false;
  }
  if (PROFILE_BUILTIN_KEY_SET.has(keyName)) {
    return true;
  }
  return CUSTOM_PROFILE_KEY_PATTERN.test(keyName);
}

export function validateProfileFieldValue(keyName, value) {
  const normalizedKeyName = normalizeString(keyName, 'keyName');
  const encodedKey = textEncoder.encode(normalizedKeyName);
  if (encodedKey.byteLength > MAX_PROFILE_KEY_BYTES) {
    return {
      ok: false,
      status: 400,
      errcode: 'M_KEY_TOO_LARGE',
      error: 'Profile key exceeds the maximum allowed length',
    };
  }
  if (!isAllowedProfileKey(normalizedKeyName)) {
    return {
      ok: false,
      status: 400,
      errcode: 'M_INVALID_PARAM',
      error: 'Unsupported profile key',
    };
  }
  if (!PROFILE_BUILTIN_KEY_SET.has(normalizedKeyName)) {
    return {
      ok: true,
      key_name: normalizedKeyName,
      value: cloneJson(value),
    };
  }
  if (normalizedKeyName === PROFILE_KEY_DISPLAYNAME) {
    if (typeof value !== 'string') {
      return {
        ok: false,
        status: 400,
        errcode: 'M_INVALID_PARAM',
        error: 'displayname must be a string',
      };
    }
    return {
      ok: true,
      key_name: normalizedKeyName,
      value,
    };
  }
  if (normalizedKeyName === PROFILE_KEY_AVATAR_URL) {
    if (typeof value !== 'string' || !MXC_URI_PATTERN.test(value)) {
      return {
        ok: false,
        status: 400,
        errcode: 'M_INVALID_PARAM',
        error: 'avatar_url must be an MXC URI',
      };
    }
    return {
      ok: true,
      key_name: normalizedKeyName,
      value,
    };
  }
  if (typeof value !== 'string') {
    return {
      ok: false,
      status: 400,
      errcode: 'M_INVALID_PARAM',
      error: 'm.tz must be an IANA time zone string',
    };
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
  } catch {
    return {
      ok: false,
      status: 400,
      errcode: 'M_INVALID_PARAM',
      error: 'm.tz must be a valid IANA time zone identifier',
    };
  }
  return {
    ok: true,
    key_name: normalizedKeyName,
    value,
  };
}

export function buildProfileCapabilities() {
  return {
    'm.change_password': { enabled: true },
    'm.3pid_changes': { enabled: false },
    'm.get_login_token': { enabled: false },
    'm.profile_fields': { enabled: true },
    'm.set_avatar_url': { enabled: true },
    'm.set_displayname': { enabled: true },
  };
}

export function serializeProfileDocument(rows) {
  const document = {};
  for (const row of rows) {
    document[row.key_name] = cloneJson(row.value);
  }
  return document;
}

export function assertProfileDocumentSize(profileDocument) {
  const payload = JSON.stringify(profileDocument ?? {});
  const byteLength = textEncoder.encode(payload).byteLength;
  if (byteLength >= MAX_PROFILE_DOCUMENT_BYTES) {
    return {
      ok: false,
      status: 400,
      errcode: 'M_PROFILE_TOO_LARGE',
      error: 'Profile document exceeds the maximum allowed size',
    };
  }
  return { ok: true, byte_length: byteLength };
}

export function normalizeSyncTimeout(requestedTimeoutMs) {
  if (requestedTimeoutMs == null || requestedTimeoutMs === '') {
    return DEFAULT_SYNC_TIMEOUT_MS;
  }
  const numericValue = Number(requestedTimeoutMs);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_SYNC_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.trunc(numericValue), 0), MAX_SYNC_TIMEOUT_MS);
}

export function issueSyncToken({
  user_id,
  device_id,
  user_stream_pos,
  filter_hash = null,
  secret_value,
}) {
  const ring = parseSessionRootKeyRing(secret_value);
  const rootKeyVersion = ring.active_version;
  const payload = {
    version: SYNC_TOKEN_VERSION,
    user_id: normalizeString(user_id, 'user_id'),
    device_id: normalizeString(device_id, 'device_id'),
    user_stream_pos: normalizeInteger(user_stream_pos, 'user_stream_pos', { min: 0 }),
    filter_hash: filter_hash == null ? null : normalizeString(filter_hash, 'filter_hash'),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', ring.keys[rootKeyVersion])
    .update(`${SYNC_TOKEN_VERSION}.${rootKeyVersion}.${encodedPayload}`)
    .digest('base64url');
  return `s${SYNC_TOKEN_VERSION}.${rootKeyVersion}.${encodedPayload}.${signature}`;
}

export function parseSyncToken(token, {
  expected_user_id = null,
  expected_device_id = null,
  secret_value = null,
} = {}) {
  if (token == null || token === '') {
    return {
      ok: true,
      token: null,
      since_pos: 0,
      filter_hash: null,
    };
  }
  if (typeof token !== 'string') {
    return {
      ok: false,
      code: 'invalid_cursor',
      matrix_error: {
        status: 400,
        body: {
          errcode: 'M_INVALID_PARAM',
          error: 'Invalid sync token',
        },
      },
    };
  }
  const match = /^s(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) {
    return {
      ok: false,
      code: 'invalid_cursor',
      matrix_error: {
        status: 400,
        body: {
          errcode: 'M_INVALID_PARAM',
          error: 'Invalid sync token',
        },
      },
    };
  }
  const version = Number(match[1]);
  if (version !== SYNC_TOKEN_VERSION) {
    return {
      ok: false,
      code: 'invalid_cursor',
      matrix_error: {
        status: 400,
        body: {
          errcode: 'M_INVALID_PARAM',
          error: 'Unsupported sync token version',
        },
      },
    };
  }
  try {
    const ring = parseSessionRootKeyRing(secret_value);
    const rootKeyVersion = normalizeString(match[2], 'syncToken.rootKeyVersion');
    const secretBytes = ring.keys[rootKeyVersion];
    if (!secretBytes) {
      throw new RangeError('Sync token key version is not available');
    }
    const encodedPayload = normalizeString(match[3], 'syncToken.encodedPayload');
    const presentedSignature = normalizeString(match[4], 'syncToken.signature');
    const expectedSignature = createHmac('sha256', secretBytes)
      .update(`${version}.${rootKeyVersion}.${encodedPayload}`)
      .digest('base64url');
    if (expectedSignature !== presentedSignature) {
      throw new RangeError('Sync token signature is invalid');
    }
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    const userId = normalizeString(payload.user_id, 'payload.user_id');
    const deviceId = normalizeString(payload.device_id, 'payload.device_id');
    const sincePos = normalizeInteger(payload.user_stream_pos, 'payload.user_stream_pos', { min: 0 });
    if (expected_user_id && userId !== expected_user_id) {
      return {
        ok: false,
        code: 'invalid_cursor',
        matrix_error: {
          status: 400,
          body: {
            errcode: 'M_INVALID_PARAM',
            error: 'Sync token does not belong to this user',
          },
        },
      };
    }
    if (expected_device_id && deviceId !== expected_device_id) {
      return {
        ok: false,
        code: 'invalid_cursor',
        matrix_error: {
          status: 400,
          body: {
            errcode: 'M_INVALID_PARAM',
            error: 'Sync token does not belong to this device',
          },
        },
      };
    }
    return {
      ok: true,
      token,
      since_pos: sincePos,
      filter_hash: payload.filter_hash == null ? null : normalizeString(payload.filter_hash, 'payload.filter_hash'),
    };
  } catch {
    return {
      ok: false,
      code: 'invalid_cursor',
      matrix_error: {
        status: 400,
        body: {
          errcode: 'M_INVALID_PARAM',
          error: 'Invalid sync token',
        },
      },
    };
  }
}

export function normalizeStoredFilterId(filterHash) {
  return `f_${normalizeString(filterHash, 'filterHash')}`;
}

export function normalizeFilterDefinition(filterJson) {
  if (!filterJson || typeof filterJson !== 'object' || Array.isArray(filterJson)) {
    throw new TypeError('Filter definition must be a JSON object');
  }
  return cloneJson(filterJson);
}

export function createStoredFilterEnvelope(filterJson) {
  const definition = normalizeFilterDefinition(filterJson);
  const filterHash = createCanonicalFilterHash(definition);
  return {
    filter_id: normalizeStoredFilterId(filterHash),
    filter_hash: filterHash,
    filter_json: definition,
  };
}

export function filterEventList(events, filterSection = null) {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }
  if (!filterSection || typeof filterSection !== 'object' || Array.isArray(filterSection)) {
    return events.map((event) => cloneJson(event));
  }
  const types = Array.isArray(filterSection.types) ? filterSection.types.filter((value) => typeof value === 'string') : null;
  const notTypes = Array.isArray(filterSection.not_types) ? filterSection.not_types.filter((value) => typeof value === 'string') : null;
  return events
    .filter((event) => {
      const eventType = event?.type;
      if (typeof eventType !== 'string') {
        return true;
      }
      if (types && types.length > 0 && !types.some((pattern) => EVENT_MATCH_PATTERN.test(pattern) && matchEventTypePattern(eventType, pattern))) {
        return false;
      }
      if (notTypes && notTypes.some((pattern) => EVENT_MATCH_PATTERN.test(pattern) && matchEventTypePattern(eventType, pattern))) {
        return false;
      }
      return true;
    })
    .map((event) => cloneJson(event));
}

export function getSyncFilterFlags(filterJson = null) {
  const room = filterJson?.room && typeof filterJson.room === 'object' && !Array.isArray(filterJson.room)
    ? filterJson.room
    : {};
  const state = room.state && typeof room.state === 'object' && !Array.isArray(room.state)
    ? room.state
    : {};
  const timeline = room.timeline && typeof room.timeline === 'object' && !Array.isArray(room.timeline)
    ? room.timeline
    : {};
  return {
    include_leave: room.include_leave === true,
    lazy_load_members: state.lazy_load_members === true,
    include_redundant_members: state.lazy_load_members === true && state.include_redundant_members === true,
    unread_thread_notifications: room.unread_thread_notifications === true,
    timeline_limit: Number.isInteger(timeline.limit) && timeline.limit >= 1
      ? timeline.limit
      : null,
  };
}

function buildDefaultPushRule(userId, rule) {
  return substituteBaselineValue(rule, userId);
}

function buildCustomPushRule(row) {
  const rule = normalizePushRuleFromRow(row);
  if (!Array.isArray(rule.actions)) {
    rule.actions = [];
  }
  if (['override', 'underride'].includes(row.kind)) {
    rule.conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  }
  if (row.kind === 'content' && typeof rule.pattern !== 'string') {
    rule.pattern = '';
  }
  return rule;
}

export function buildDefaultPushRules(userId) {
  const normalizedUserId = normalizeString(userId, 'userId');
  return Object.freeze(
    Object.fromEntries(
      PUSH_RULE_KINDS.map((kind) => [
        kind,
        Object.freeze(PUSH_RULE_BASELINE[kind].map((rule) => Object.freeze(buildDefaultPushRule(normalizedUserId, rule)))),
      ]),
    ),
  );
}

export function buildPushRulesView(userId, rows = []) {
  const baseline = buildDefaultPushRules(userId);
  const defaultOverrides = new Map();
  const customRowsByKind = new Map(PUSH_RULE_KINDS.map((kind) => [kind, []]));
  for (const row of rows) {
    if (!row || row.scope !== 'global' || !PUSH_RULE_KIND_SET.has(row.kind)) {
      continue;
    }
    if (row.record?.default_rule === true) {
      defaultOverrides.set(`${row.kind}|${row.rule_id}`, row);
      continue;
    }
    customRowsByKind.get(row.kind).push(row);
  }

  return Object.fromEntries(PUSH_RULE_KINDS.map((kind) => {
    const defaults = baseline[kind].map((rule) => {
      const overrideRow = defaultOverrides.get(`${kind}|${rule.rule_id}`);
      if (!overrideRow) {
        return cloneJson(rule);
      }
      return {
        ...cloneJson(rule),
        enabled: overrideRow.enabled !== false,
        actions: Array.isArray(overrideRow.actions) ? cloneJson(overrideRow.actions) : cloneJson(rule.actions),
      };
    });
    const customRules = customRowsByKind.get(kind)
      .slice()
      .sort(comparePushRuleOrder)
      .map((row) => buildCustomPushRule(row));
    if (kind === 'override') {
      const [masterRule, ...restDefaults] = defaults;
      return [kind, [
        cloneJson(masterRule),
        ...customRules,
        ...restDefaults.map((rule) => cloneJson(rule)),
      ]];
    }
    if (kind === 'underride') {
      return [kind, [
        ...customRules,
        ...defaults.map((rule) => cloneJson(rule)),
      ]];
    }
    return [kind, customRules];
  }));
}

export function buildPushRulesAccountDataEvent(userId, rows = []) {
  return {
    type: 'm.push_rules',
    content: {
      global: buildPushRulesView(userId, rows),
    },
  };
}

function readNestedJsonValue(value, dottedKey) {
  if (typeof dottedKey !== 'string' || dottedKey.length === 0) {
    return undefined;
  }
  let current = value;
  const segments = dottedKey.split('.');
  let index = 0;
  while (index < segments.length) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    let matched = false;
    for (let end = segments.length; end > index; end -= 1) {
      const candidateKey = segments.slice(index, end).join('.');
      if (!Object.hasOwn(current, candidateKey)) {
        continue;
      }
      current = current[candidateKey];
      index = end;
      matched = true;
      break;
    }
    if (!matched) {
      return undefined;
    }
  }
  return current;
}

function jsonValueEquals(left, right) {
  if (left === right) {
    return true;
  }
  if (typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((entry, index) => jsonValueEquals(entry, right[index]));
  }
  if (left && typeof left === 'object' && right && typeof right === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every((key) => Object.hasOwn(right, key) && jsonValueEquals(left[key], right[key]));
  }
  return false;
}

function matchPushRulePattern(value, pattern) {
  if (typeof value !== 'string' || typeof pattern !== 'string') {
    return false;
  }
  if (pattern === '*') {
    return true;
  }
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return value === pattern;
}

function matchPushRuleContentPattern(body, pattern) {
  if (typeof body !== 'string' || typeof pattern !== 'string' || pattern.length === 0) {
    return false;
  }
  if (pattern === '*') {
    return true;
  }
  if (pattern.startsWith('*') && pattern.endsWith('*') && pattern.length > 2) {
    return body.includes(pattern.slice(1, -1));
  }
  if (pattern.startsWith('*')) {
    return body.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith('*')) {
    return body.startsWith(pattern.slice(0, -1));
  }
  return body.includes(pattern);
}

function matchPushRuleCondition(condition, event, context) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    return false;
  }
  switch (condition.kind) {
    case 'event_match': {
      const value = readNestedJsonValue(event, condition.key);
      return matchPushRulePattern(value, condition.pattern);
    }
    case 'event_property_contains': {
      const value = readNestedJsonValue(event, condition.key);
      return Array.isArray(value) && value.some((entry) => jsonValueEquals(entry, condition.value));
    }
    case 'event_property_is': {
      return jsonValueEquals(readNestedJsonValue(event, condition.key), condition.value);
    }
    case 'room_member_count': {
      return String(context?.room_member_count ?? '') === String(condition.is ?? '');
    }
    case 'sender_notification_permission': {
      if (condition.key === 'room') {
        return context?.sender_notification_permission_room === true;
      }
      return false;
    }
    default:
      return false;
  }
}

function matchPushRuleByKind(kind, rule, event, context) {
  if (kind === 'content') {
    return matchPushRuleContentPattern(readNestedJsonValue(event, 'content.body'), rule.pattern);
  }
  if (kind === 'room') {
    return typeof context?.room_id === 'string' && context.room_id === rule.rule_id;
  }
  if (kind === 'sender') {
    return typeof event?.sender === 'string' && event.sender === rule.rule_id;
  }
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  if (conditions.length === 0) {
    return true;
  }
  return conditions.every((condition) => matchPushRuleCondition(condition, event, context));
}

export function evaluatePushRuleNotification(userId, rows = [], event, context = {}) {
  const normalizedUserId = normalizeString(userId, 'userId');
  if (!event || typeof event !== 'object' || Array.isArray(event) || event.sender === normalizedUserId) {
    return {
      matched: false,
      rule_id: null,
      notify: false,
      highlight: false,
    };
  }
  const view = buildPushRulesView(normalizedUserId, rows);
  for (const [kind, rules] of [
    ['override', view.override],
    ['content', view.content],
    ['room', view.room],
    ['sender', view.sender],
    ['underride', view.underride],
  ]) {
    for (const rule of rules) {
      if (rule?.enabled === false || !matchPushRuleByKind(kind, rule, event, context)) {
        continue;
      }
      const actions = Array.isArray(rule.actions) ? rule.actions : [];
      const highlightAction = actions.find((action) => (
        action && typeof action === 'object' && !Array.isArray(action) && action.set_tweak === 'highlight'
      )) ?? null;
      return {
        matched: true,
        rule_id: rule.rule_id,
        notify: actions.includes('notify'),
        highlight: highlightAction != null && highlightAction.value !== false,
      };
    }
  }
  return {
    matched: false,
    rule_id: null,
    notify: false,
    highlight: false,
  };
}

export function validatePushRuleKind(kind) {
  if (!PUSH_RULE_KIND_SET.has(kind)) {
    throw new RangeError('Unsupported push rule kind');
  }
  return kind;
}

export function validatePushRuleId(ruleId, { allow_default = false } = {}) {
  const normalizedRuleId = normalizeString(ruleId, 'ruleId');
  if (allow_default && normalizedRuleId.startsWith('.')) {
    return normalizedRuleId;
  }
  if (normalizedRuleId.startsWith('.')) {
    throw new RangeError('User-defined push rule IDs must not start with "."');
  }
  if (PUSH_RULE_ID_FORBIDDEN_PATTERN.test(normalizedRuleId)) {
    throw new RangeError('Push rule IDs must not contain "/" or "\\"');
  }
  return normalizedRuleId;
}

export function buildPushRuleWriteRecord({
  scope = 'global',
  kind,
  rule_id,
  body,
  priority_index,
  updated_at,
}) {
  const normalizedKind = validatePushRuleKind(kind);
  const normalizedRuleId = validatePushRuleId(rule_id);
  const normalizedBody = normalizePushRuleBody(normalizedKind, body);
  return {
    scope,
    kind: normalizedKind,
    rule_id: normalizedRuleId,
    enabled: true,
    priority_class: 'user',
    priority_index: normalizeInteger(priority_index, 'priority_index', { min: 0 }),
    updated_at: normalizeString(updated_at, 'updated_at'),
    actions_json: normalizedBody.actions,
    conditions_json: normalizedBody.conditions,
    record_json: {
      rule_kind: normalizedKind,
      pattern: normalizedBody.pattern ?? null,
      default_rule: false,
    },
  };
}

export function getNextPushRulePriorityIndex(rows, kind) {
  const matchingRows = rows.filter((row) => row.scope === 'global' && row.kind === kind && row.record?.default_rule !== true);
  if (matchingRows.length === 0) {
    return 0;
  }
  return Math.max(...matchingRows.map((row) => row.priority_index)) + 1;
}

export function computePushRulePriorityIndex(rows, kind, {
  before = null,
  after = null,
  rule_id = null,
} = {}) {
  const customRows = rows
    .filter((row) => row.scope === 'global' && row.kind === kind && row.record?.default_rule !== true && row.rule_id !== rule_id)
    .slice()
    .sort(comparePushRuleOrder);
  if (customRows.length === 0) {
    return 0;
  }
  const prioritizedAgainst = before ?? after ?? null;
  if (!prioritizedAgainst) {
    return customRows[0].priority_index - 1;
  }
  const match = customRows.find((row) => row.rule_id === prioritizedAgainst);
  if (!match) {
    throw new RangeError('Referenced push rule was not found');
  }
  return before ? match.priority_index - 1 : match.priority_index + 1;
}

export function reindexPushRuleRows(rows, kind) {
  const matchingRows = rows
    .filter((row) => row.scope === 'global' && row.kind === kind && row.record?.default_rule !== true)
    .slice()
    .sort(comparePushRuleOrder);
  return matchingRows.map((row, index) => ({
    ...row,
    priority_index: index,
  }));
}

export function assertPushRulesStorageLimits(rows) {
  const customRows = rows.filter((row) => row.scope === 'global' && row.record?.default_rule !== true);
  const overrideRows = rows.filter((row) => row.scope === 'global');
  if (customRows.length > MAX_PUSH_RULES_PER_USER) {
    return {
      ok: false,
      status: 400,
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Push rule limit exceeded',
    };
  }
  const payload = JSON.stringify(overrideRows.map((row) => ({
    scope: row.scope,
    kind: row.kind,
    rule_id: row.rule_id,
    enabled: row.enabled,
    priority_index: row.priority_index,
    actions: row.actions,
    conditions: row.conditions,
    record: row.record,
  })));
  const byteLength = textEncoder.encode(payload).byteLength;
  if (byteLength >= MAX_PUSH_RULES_BYTES) {
    return {
      ok: false,
      status: 400,
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Push rule storage limit exceeded',
    };
  }
  return { ok: true, byte_length: byteLength };
}

export function ensureSyncWaiterHub(env) {
  if (!env.__matrix_sync_waiter_hub) {
    env.__matrix_sync_waiter_hub = {
      waiters_by_user: new Map(),
      waiter_key_by_session: new Map(),
    };
  }
  return env.__matrix_sync_waiter_hub;
}

function updateSyncWaiterMetrics(env, hub) {
  const activeWaiters = [...hub.waiters_by_user.values()].reduce((total, userWaiters) => total + userWaiters.size, 0);
  setGaugeMetric(env, 'sync.waiter.active', activeWaiters, {
    environment: typeof env?.ENVIRONMENT_NAME === 'string' ? env.ENVIRONMENT_NAME : 'unknown',
  });
}

export function registerSyncWaiter(env, {
  user_id,
  session_id,
  waiter_key,
  timeout_ms,
}) {
  const hub = ensureSyncWaiterHub(env);
  const normalizedUserId = normalizeString(user_id, 'user_id');
  const normalizedSessionId = normalizeString(session_id, 'session_id');
  const normalizedWaiterKey = normalizeString(waiter_key, 'waiter_key');
  const normalizedTimeoutMs = normalizeInteger(timeout_ms, 'timeout_ms', { min: 0 });
  const sessionKey = `${normalizedUserId}|${normalizedSessionId}`;
  const existingWaiterKey = hub.waiter_key_by_session.get(sessionKey);
  if (!hub.waiters_by_user.has(normalizedUserId)) {
    hub.waiters_by_user.set(normalizedUserId, new Map());
  }
  const userWaiters = hub.waiters_by_user.get(normalizedUserId);
  if (existingWaiterKey && userWaiters.has(existingWaiterKey)) {
    const existingWaiter = userWaiters.get(existingWaiterKey);
    existingWaiter.resolve({ reason: 'superseded' });
  }
  let waiterRef = null;
  const promise = new Promise((resolve) => {
    const waiter = {
      timer: null,
      session_key: sessionKey,
      settled: false,
      resolve: (payload) => {
        if (waiter.settled) {
          return;
        }
        waiter.settled = true;
        if (userWaiters.get(normalizedWaiterKey) === waiter) {
          userWaiters.delete(normalizedWaiterKey);
        }
        if (hub.waiter_key_by_session.get(sessionKey) === normalizedWaiterKey) {
          hub.waiter_key_by_session.delete(sessionKey);
        }
        clearTimeout(waiter.timer);
        if (payload?.reason === 'wake') {
          observeMetric(env, 'sync.wake.latency_ms', Date.now() - waiter.created_at_ms, {
            environment: typeof env?.ENVIRONMENT_NAME === 'string' ? env.ENVIRONMENT_NAME : 'unknown',
            reason: payload.reason,
          });
        }
        updateSyncWaiterMetrics(env, hub);
        resolve(payload);
      },
    };
    waiter.created_at_ms = Date.now();
    waiterRef = waiter;
    waiter.timer = setTimeout(() => {
      waiter.resolve({ reason: 'timeout' });
    }, normalizedTimeoutMs);
    userWaiters.set(normalizedWaiterKey, waiter);
    hub.waiter_key_by_session.set(sessionKey, normalizedWaiterKey);
    updateSyncWaiterMetrics(env, hub);
  });
  return Object.freeze({
    promise,
    cancel() {
      waiterRef?.resolve({ reason: 'cancelled' });
    },
  });
}

export function wakeSyncWaiters(env, {
  user_id,
  user_stream_pos,
}) {
  const hub = ensureSyncWaiterHub(env);
  const userWaiters = hub.waiters_by_user.get(user_id);
  if (!userWaiters || userWaiters.size === 0) {
    return 0;
  }
  let wakeCount = 0;
  for (const [waiterKey, waiter] of userWaiters.entries()) {
    userWaiters.delete(waiterKey);
    if (hub.waiter_key_by_session.get(waiter.session_key) === waiterKey) {
      hub.waiter_key_by_session.delete(waiter.session_key);
    }
    clearTimeout(waiter.timer);
    waiter.resolve({
      reason: 'wake',
      user_stream_pos,
    });
    wakeCount += 1;
  }
  updateSyncWaiterMetrics(env, hub);
  return wakeCount;
}
