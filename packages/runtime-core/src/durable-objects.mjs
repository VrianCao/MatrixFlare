import { createInternalErrorEnvelope } from '../../contracts/src/index.mjs';
import {
  REMOTE_SERVER_DO_SCHEMA_VERSION,
  createRemoteServerDurableObjectPersistence,
} from './remote-server-persistence.mjs';
import {
  ROOM_DO_SCHEMA_VERSION,
  createRoomDurableObjectPersistence,
} from './room-persistence.mjs';
import { withSqliteTransaction } from './persistence-common.mjs';
import { createAsyncTaskContext, createRequestContext } from './structured-logging.mjs';
import { loadWorkerRuntimeConfig } from './runtime-manifest.mjs';
import {
  DEFAULT_ACCESS_TOKEN_TTL_MS,
  DEFAULT_REFRESH_TOKEN_TTL_MS,
  buildLocalUserId,
  extractLoginLocalpart,
  generateDeviceId,
  generateSessionId,
  getAccessTokenUserIdHint,
  getRefreshTokenUserIdHint,
  hashOpaqueToken,
  hashPassword,
  issueAccessToken,
  issueRefreshToken,
  normalizeLocalpart,
  normalizeLocalUserIdentifier,
  parseSessionRootKeyRing,
  verifyPassword,
} from './user-identity.mjs';
import {
  USER_DO_SCHEMA_VERSION,
  createUserDurableObjectPersistence,
} from './user-persistence.mjs';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function createMatrixError(status, errcode, error, extra = null) {
  return {
    ok: false,
    matrix_error: {
      status,
      body: {
        errcode,
        error,
        ...(extra ?? {}),
      },
    },
  };
}

function createSuccessResult(payload = {}) {
  return {
    ok: true,
    ...payload,
  };
}

function isoAfter(nowIso, ttlMs) {
  return new Date(Date.parse(nowIso) + ttlMs).toISOString();
}

function toMillisOrInfinity(value) {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function sessionRowToPutRecord(session, overrides = {}) {
  const next = {
    ...session,
    ...overrides,
  };
  return {
    session_id: next.session_id,
    access_token_hash: next.access_token_hash ?? null,
    refresh_token_hash: next.refresh_token_hash ?? null,
    device_id: next.device_id,
    auth_version: next.auth_version,
    session_epoch: next.session_epoch ?? 0,
    is_guest: next.is_guest ?? false,
    created_at: next.created_at,
    updated_at: next.updated_at,
    expires_at: next.expires_at ?? null,
    refresh_expires_at: next.refresh_expires_at ?? null,
    revoked_at: next.revoked_at ?? null,
    record_json: next.record ?? {},
  };
}

function deviceRowToPutRecord(device, overrides = {}) {
  const next = {
    ...device,
    ...overrides,
  };
  return {
    device_id: next.device_id,
    display_name: next.display_name ?? null,
    created_at: next.created_at,
    updated_at: next.updated_at,
    last_seen_at: next.last_seen_at ?? null,
    last_seen_ip: next.last_seen_ip ?? null,
    deleted_at: next.deleted_at ?? null,
    record_json: next.record ?? {},
  };
}

function principalRowToPutRecord(principal, overrides = {}) {
  const next = {
    ...principal,
    ...overrides,
  };
  return {
    user_id: next.user_id,
    localpart: next.localpart,
    user_type: next.user_type ?? null,
    password_hash_or_null: next.password_hash_or_null ?? null,
    password_login_enabled: next.password_login_enabled ?? true,
    created_at: next.created_at,
    deactivated_at_or_null: next.deactivated_at_or_null ?? null,
    erase_requested_flag: next.erase_requested_flag ?? false,
    auth_version: next.auth_version,
    registration_source: next.registration_source ?? null,
    record: next.record ?? {},
  };
}

function readPhase04Meta(principal) {
  const candidate = principal?.record?.phase04;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {};
  }
  return candidate;
}

function mergePhase04Meta(principal, patch) {
  const existing = readPhase04Meta(principal);
  return {
    ...(principal?.record ?? {}),
    phase04: {
      ...existing,
      ...patch,
    },
  };
}

function makeTokenResponse({
  userId,
  deviceId,
  accessToken,
  refreshToken,
}) {
  return {
    user_id: userId,
    access_token: accessToken,
    device_id: deviceId,
    refresh_token: refreshToken,
    expires_in_ms: DEFAULT_ACCESS_TOKEN_TTL_MS,
  };
}

function findSessionByHashedToken(persistence, fieldName, hashedToken) {
  return persistence.sessions.list().find((session) => session[fieldName] === hashedToken) ?? null;
}

function getSessionTokenRevision(session) {
  return Number.isInteger(session?.record?.token_revision) && session.record.token_revision >= 0
    ? session.record.token_revision
    : 0;
}

function getSessionTokenRootKeyVersion(session) {
  return typeof session?.record?.token_root_key_version === 'string' && session.record.token_root_key_version.length > 0
    ? session.record.token_root_key_version
    : null;
}

function issueSessionTokens(env, {
  userId,
  sessionId,
  tokenRevision,
  tokenRootKeyVersion = null,
}) {
  const resolvedTokenRootKeyVersion = tokenRootKeyVersion ?? parseSessionRootKeyRing(env.SESSION_ROOT_KEY_RING).active_version;
  return {
    accessToken: issueAccessToken(userId, {
      sessionId,
      tokenRevision,
      secretValue: env.SESSION_ROOT_KEY_RING,
      tokenRootKeyVersion: resolvedTokenRootKeyVersion,
    }),
    refreshToken: issueRefreshToken(userId, {
      sessionId,
      tokenRevision,
      secretValue: env.SESSION_ROOT_KEY_RING,
      tokenRootKeyVersion: resolvedTokenRootKeyVersion,
    }),
    tokenRootKeyVersion: resolvedTokenRootKeyVersion,
  };
}

function isSessionUsable({
  session,
  principal,
  runtimeState,
  device,
  nowIso,
}) {
  if (!session) {
    return {
      valid: false,
      error: createInternalErrorEnvelope({
        code: 'invalid_token',
        message: 'Session token does not exist',
        retryable: false,
      }),
    };
  }
  if (!principal) {
    return {
      valid: false,
      error: createInternalErrorEnvelope({
        code: 'unknown_session',
        message: 'User principal does not exist',
        retryable: false,
      }),
    };
  }
  if (principal.deactivated_at_or_null) {
    return {
      valid: false,
      error: createInternalErrorEnvelope({
        code: 'deactivated_account',
        message: 'The account has been deactivated',
        retryable: false,
      }),
    };
  }
  if (session.revoked_at) {
    return {
      valid: false,
      error: createInternalErrorEnvelope({
        code: 'invalid_token',
        message: 'The session has been revoked',
        retryable: false,
      }),
    };
  }
  if (toMillisOrInfinity(session.expires_at) <= Date.parse(nowIso)) {
    return {
      valid: false,
      error: createInternalErrorEnvelope({
        code: 'expired_session',
        message: 'The session has expired',
        retryable: false,
      }),
    };
  }
  if (session.auth_version !== principal.auth_version || session.session_epoch !== runtimeState.session_epoch) {
    return {
      valid: false,
      error: createInternalErrorEnvelope({
        code: 'expired_session',
        message: 'The session is behind the current authentication epoch',
        retryable: false,
      }),
    };
  }
  if (!device || device.deleted_at) {
    return {
      valid: false,
      error: createInternalErrorEnvelope({
        code: 'unknown_session',
        message: 'The session device no longer exists',
        retryable: false,
      }),
    };
  }
  return {
    valid: true,
  };
}

function resolvePasswordUserId({ sessionContext, localpart, serverName }) {
  if (sessionContext?.user_id) {
    return sessionContext.user_id;
  }
  return buildLocalUserId(localpart, serverName);
}

export class BaseDurableObject {
  constructor(ctx, env, options) {
    this.ctx = ctx;
    this.env = env;
    this.options = options;
  }

  get config() {
    return loadWorkerRuntimeConfig(this.options.owningWorkerName, this.env);
  }

  async ensureCurrentness() {
    const storage = this.ctx?.storage;
    if (storage?.sql?.exec) {
      storage.sql.exec('SELECT 1');
      return;
    }
    if (typeof storage?.get === 'function') {
      await storage.get('__currentness_probe__');
    }
  }

  createRequestContext(request, routeFamily = `${this.options.routeFamilyPrefix}.fetch`) {
    return createRequestContext({
      workerName: this.options.owningWorkerName,
      workerVersion: this.config.text.WORKER_VERSION_ID,
      request,
      routeFamily,
    });
  }

  createAsyncTaskContext(routeFamily) {
    return createAsyncTaskContext({
      workerName: this.options.owningWorkerName,
      workerVersion: this.config.text.WORKER_VERSION_ID,
      routeFamily,
    });
  }

  createNotImplementedEnvelope(methodName, details = null) {
    return createInternalErrorEnvelope({
      code: 'unsupported_schema_version',
      message: `${this.options.className}.${methodName} is a Phase 01 runtime skeleton placeholder`,
      retryable: false,
      details,
    });
  }

  async fetch(request) {
    await this.ensureCurrentness();
    const requestContext = this.createRequestContext(request);
    requestContext.logger.warn('durable_object.placeholder.fetch', {
      authority_kind: this.options.authorityKind,
      class_name: this.options.className,
      method: request.method,
      path: new URL(request.url).pathname,
      outcome: 'placeholder',
    });

    return jsonResponse(
      {
        error: `${this.options.className} runtime skeleton placeholder`,
        request_id: requestContext.requestId,
        authority_kind: this.options.authorityKind,
      },
      503,
    );
  }

  requireSqlStorage() {
    const sql = this.ctx?.storage?.sql;
    if (!sql || typeof sql.exec !== 'function') {
      throw new TypeError(`${this.options.className} requires SQLite-backed Durable Object storage`);
    }
    return sql;
  }
}

export class UserDO extends BaseDurableObject {
  static authorityKind = 'user';
  static schemaVersion = USER_DO_SCHEMA_VERSION;

  constructor(ctx, env) {
    super(ctx, env, {
      className: 'UserDO',
      authorityKind: UserDO.authorityKind,
      owningWorkerName: 'gateway-worker',
      routeFamilyPrefix: 'userdo',
    });
  }

  get persistence() {
    if (!this._persistence) {
      this._persistence = createUserDurableObjectPersistence(this.requireSqlStorage());
    }
    return this._persistence;
  }

  async ensureSchema() {
    await this.persistence.ensureSchema();
    return this.persistence.getRuntimeState();
  }

  async resolveSession() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const accessToken = request?.access_token ?? null;
    const now = request?.now ?? new Date().toISOString();
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return {
        ok: false,
        error: createInternalErrorEnvelope({
          code: 'invalid_token',
          message: 'access_token must be present',
          retryable: false,
        }),
      };
    }

    let hintedUserId;
    try {
      hintedUserId = getAccessTokenUserIdHint(accessToken);
    } catch {
      return {
        ok: false,
        error: createInternalErrorEnvelope({
          code: 'invalid_token',
          message: 'access token format is invalid',
          retryable: false,
        }),
      };
    }

    const runtimeState = this.persistence.getRuntimeState();
    const principal = this.persistence.userPrincipal.get();
    if (!runtimeState.user_id && principal?.user_id) {
      this.persistence.setRuntimeIdentity({ user_id: principal.user_id, updated_at: now });
    }
    const refreshedRuntimeState = this.persistence.getRuntimeState();
    if (refreshedRuntimeState.user_id && refreshedRuntimeState.user_id !== hintedUserId) {
      return {
        ok: false,
        error: createInternalErrorEnvelope({
          code: 'invalid_token',
          message: 'access token does not belong to this user shard',
          retryable: false,
        }),
      };
    }

    const hashedToken = hashOpaqueToken(accessToken);
    const session = findSessionByHashedToken(this.persistence, 'access_token_hash', hashedToken);
    const device = session?.device_id ? this.persistence.devices.get(session.device_id) : null;
    const usability = isSessionUsable({
      session,
      principal,
      runtimeState: refreshedRuntimeState,
      device,
      nowIso: now,
    });
    if (!usability.valid) {
      return {
        ok: false,
        error: usability.error,
      };
    }

    return createSuccessResult({
      session: {
        user_id: principal.user_id,
        device_id: session.device_id,
        session_id: session.session_id,
        expires_at: session.expires_at,
        is_guest: session.is_guest,
        auth_version: session.auth_version,
        session_epoch: session.session_epoch,
      },
    });
  }

  async collectSince() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return this.createNotImplementedEnvelope('collectSince', {
      schema_version: UserDO.schemaVersion,
    });
  }

  async enqueueToDevice() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return this.createNotImplementedEnvelope('enqueueToDevice', {
      schema_version: UserDO.schemaVersion,
    });
  }

  async checkRegistrationAvailability() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const now = request?.now ?? new Date().toISOString();
    let localpart;
    try {
      localpart = normalizeLocalpart(request?.localpart);
    } catch {
      return createMatrixError(400, 'M_INVALID_USERNAME', 'The requested username is not valid');
    }
    const userId = buildLocalUserId(localpart, this.config.text.MATRIX_SERVER_NAME);
    const principal = this.persistence.userPrincipal.get();
    if (!this.persistence.getRuntimeState().user_id && principal?.user_id) {
      this.persistence.setRuntimeIdentity({ user_id: principal.user_id, updated_at: now });
    }
    if (principal?.user_id === userId) {
      return createMatrixError(400, 'M_USER_IN_USE', 'The requested username is already in use');
    }
    return createSuccessResult({ available: true });
  }

  async register() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const now = request?.now ?? new Date().toISOString();
    let localpart;
    try {
      localpart = normalizeLocalpart(request?.localpart);
    } catch {
      return createMatrixError(400, 'M_INVALID_USERNAME', 'The requested username is not valid');
    }

    const userId = buildLocalUserId(localpart, this.config.text.MATRIX_SERVER_NAME);
    const requestFingerprint = request?.request_fingerprint ?? null;
    const uiaNonce = request?.uia_nonce ?? null;
    const password = request?.password;
    if (typeof password !== 'string' || password.trim().length === 0) {
      return createMatrixError(400, 'M_MISSING_PARAM', 'password must be present');
    }

    if (!this.persistence.getRuntimeState().user_id) {
      this.persistence.setRuntimeIdentity({ user_id: userId, updated_at: now });
    }

    const sql = this.requireSqlStorage();
    return withSqliteTransaction(sql, () => {
      const principal = this.persistence.userPrincipal.get();
      const phase04 = readPhase04Meta(principal);
      const isIdempotentRetry = Boolean(
        principal
        && phase04.registration?.uia_nonce === uiaNonce
        && phase04.registration?.request_fingerprint === requestFingerprint,
      );

      if (principal && !isIdempotentRetry) {
        return createMatrixError(400, 'M_USER_IN_USE', 'The requested username is already in use');
      }

      if (principal && isIdempotentRetry) {
        const existingRegistration = phase04.registration ?? null;
        const existingSession = existingRegistration?.session_id
          ? this.persistence.sessions.get(existingRegistration.session_id)
          : null;
        if (!existingSession || existingSession.revoked_at) {
          return createMatrixError(409, 'M_CONFLICT', 'Registration was already completed for this UIA session');
        }
        const tokenRevision = getSessionTokenRevision(existingSession);
        const tokenRootKeyVersion = getSessionTokenRootKeyVersion(existingSession);
        const { accessToken, refreshToken } = issueSessionTokens(this.env, {
          userId,
          sessionId: existingSession.session_id,
          tokenRevision,
          tokenRootKeyVersion,
        });
        return createSuccessResult({
          response: makeTokenResponse({
            userId,
            deviceId: existingRegistration?.device_id ?? existingSession.device_id,
            accessToken,
            refreshToken,
          }),
        });
      }

      if (!principal) {
        this.persistence.userPrincipal.put({
          user_id: userId,
          localpart,
          user_type: 'human',
          password_hash_or_null: hashPassword(password),
          password_login_enabled: true,
          created_at: now,
          deactivated_at_or_null: null,
          erase_requested_flag: false,
          auth_version: 1,
          registration_source: 'self-service',
          record: mergePhase04Meta(null, {
            registration: {
              uia_nonce: uiaNonce,
              request_fingerprint: requestFingerprint,
              completed_at: now,
            },
          }),
        });
      }

      const currentPrincipal = this.persistence.userPrincipal.get();
      const deviceId = typeof request?.device_id === 'string' && request.device_id.trim().length > 0
        ? request.device_id.trim()
        : generateDeviceId();
      const existingDevice = this.persistence.devices.get(deviceId);
      this.persistence.devices.put(deviceRowToPutRecord(existingDevice ?? {
        device_id: deviceId,
        display_name: request?.initial_device_display_name ?? null,
        created_at: now,
        updated_at: now,
        last_seen_at: now,
        last_seen_ip: null,
        deleted_at: null,
        record: {},
      }, {
        display_name: request?.initial_device_display_name ?? existingDevice?.display_name ?? null,
        updated_at: now,
        last_seen_at: now,
        deleted_at: null,
      }));

      const sessionId = generateSessionId();
      const tokenRevision = 0;
      const { accessToken, refreshToken, tokenRootKeyVersion } = issueSessionTokens(this.env, {
        userId,
        sessionId,
        tokenRevision,
      });
      const runtimeState = this.persistence.getRuntimeState();
      const sessionRecord = {
        session_id: sessionId,
        access_token_hash: hashOpaqueToken(accessToken),
        refresh_token_hash: hashOpaqueToken(refreshToken),
        device_id: deviceId,
        auth_version: currentPrincipal.auth_version,
        session_epoch: runtimeState.session_epoch,
        is_guest: false,
        created_at: now,
        updated_at: now,
        expires_at: isoAfter(now, DEFAULT_ACCESS_TOKEN_TTL_MS),
        refresh_expires_at: isoAfter(now, DEFAULT_REFRESH_TOKEN_TTL_MS),
        revoked_at: null,
        record: {
          route: 'register',
          token_revision: tokenRevision,
          token_root_key_version: tokenRootKeyVersion,
        },
      };
      this.persistence.sessions.put(sessionRowToPutRecord(sessionRecord));
      this.persistence.userPrincipal.put(principalRowToPutRecord(currentPrincipal, {
        record: mergePhase04Meta(currentPrincipal, {
          registration: {
            uia_nonce: uiaNonce,
            request_fingerprint: requestFingerprint,
            completed_at: now,
            session_id: sessionId,
            device_id: deviceId,
            token_revision: tokenRevision,
            token_root_key_version: tokenRootKeyVersion,
          },
        }),
      }));
      return createSuccessResult({
        response: makeTokenResponse({
          userId,
          deviceId,
          accessToken,
          refreshToken,
        }),
      });
    });
  }

  async verifyPasswordAuth() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const localpart = normalizeLocalpart(request?.localpart);
    const userId = buildLocalUserId(localpart, this.config.text.MATRIX_SERVER_NAME);
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Invalid username or password');
    }
    if (principal.deactivated_at_or_null) {
      return createMatrixError(403, 'M_USER_DEACTIVATED', 'The user has been deactivated');
    }
    if (!principal.password_login_enabled || !verifyPassword(request?.password ?? '', principal.password_hash_or_null)) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Invalid username or password');
    }
    return createSuccessResult({
      user_id: principal.user_id,
      localpart: principal.localpart,
    });
  }

  async login() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const now = request?.now ?? new Date().toISOString();
    let localpart;
    try {
      localpart = normalizeLocalpart(request?.localpart);
    } catch {
      return createMatrixError(403, 'M_FORBIDDEN', 'Invalid username or password');
    }
    const passwordResult = await this.verifyPasswordAuth({
      localpart,
      password: request?.password ?? '',
    });
    if (!passwordResult.ok) {
      return passwordResult;
    }

    const userId = passwordResult.user_id;
    if (!this.persistence.getRuntimeState().user_id) {
      this.persistence.setRuntimeIdentity({ user_id: userId, updated_at: now });
    }

    const sql = this.requireSqlStorage();
    return withSqliteTransaction(sql, () => {
      const principal = this.persistence.userPrincipal.get();
      const deviceId = typeof request?.device_id === 'string' && request.device_id.trim().length > 0
        ? request.device_id.trim()
        : generateDeviceId();
      const existingDevice = this.persistence.devices.get(deviceId);
      this.persistence.devices.put(deviceRowToPutRecord(existingDevice ?? {
        device_id: deviceId,
        display_name: request?.initial_device_display_name ?? null,
        created_at: now,
        updated_at: now,
        last_seen_at: now,
        last_seen_ip: null,
        deleted_at: null,
        record: {},
      }, {
        display_name: request?.initial_device_display_name ?? existingDevice?.display_name ?? null,
        updated_at: now,
        last_seen_at: now,
        deleted_at: null,
      }));

      const sessionId = generateSessionId();
      const tokenRevision = 0;
      const { accessToken, refreshToken, tokenRootKeyVersion } = issueSessionTokens(this.env, {
        userId,
        sessionId,
        tokenRevision,
      });
      const runtimeState = this.persistence.getRuntimeState();
      this.persistence.sessions.put(sessionRowToPutRecord({
        session_id: sessionId,
        access_token_hash: hashOpaqueToken(accessToken),
        refresh_token_hash: hashOpaqueToken(refreshToken),
        device_id: deviceId,
        auth_version: principal.auth_version,
        session_epoch: runtimeState.session_epoch,
        is_guest: false,
        created_at: now,
        updated_at: now,
        expires_at: isoAfter(now, DEFAULT_ACCESS_TOKEN_TTL_MS),
        refresh_expires_at: isoAfter(now, DEFAULT_REFRESH_TOKEN_TTL_MS),
        revoked_at: null,
        record: {
          route: 'login',
          token_revision: tokenRevision,
          token_root_key_version: tokenRootKeyVersion,
        },
      }));
      return createSuccessResult({
        response: makeTokenResponse({
          userId,
          deviceId,
          accessToken,
          refreshToken,
        }),
      });
    });
  }

  async refreshSession() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const refreshToken = request?.refresh_token ?? null;
    const now = request?.now ?? new Date().toISOString();
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      return createMatrixError(401, 'M_UNKNOWN_TOKEN', 'Unknown refresh token');
    }

    let hintedUserId;
    try {
      hintedUserId = getRefreshTokenUserIdHint(refreshToken);
    } catch {
      return createMatrixError(401, 'M_UNKNOWN_TOKEN', 'Unknown refresh token');
    }

    const principal = this.persistence.userPrincipal.get();
    const runtimeState = this.persistence.getRuntimeState();
    if (
      !principal
      || principal.user_id !== hintedUserId
      || principal.deactivated_at_or_null
    ) {
      return createMatrixError(401, 'M_UNKNOWN_TOKEN', 'Unknown refresh token');
    }

    const session = findSessionByHashedToken(this.persistence, 'refresh_token_hash', hashOpaqueToken(refreshToken));
    if (
      !session
      || session.revoked_at
      || toMillisOrInfinity(session.refresh_expires_at) <= Date.parse(now)
      || session.auth_version !== principal.auth_version
      || session.session_epoch !== runtimeState.session_epoch
    ) {
      return createMatrixError(401, 'M_UNKNOWN_TOKEN', 'Unknown refresh token');
    }

    const sql = this.requireSqlStorage();
    return withSqliteTransaction(sql, () => {
      const nextTokenRevision = getSessionTokenRevision(session) + 1;
      const { accessToken: nextAccessToken, refreshToken: nextRefreshToken, tokenRootKeyVersion } = issueSessionTokens(this.env, {
        userId: principal.user_id,
        sessionId: session.session_id,
        tokenRevision: nextTokenRevision,
      });
      this.persistence.sessions.put(sessionRowToPutRecord(session, {
        access_token_hash: hashOpaqueToken(nextAccessToken),
        refresh_token_hash: hashOpaqueToken(nextRefreshToken),
        updated_at: now,
        expires_at: isoAfter(now, DEFAULT_ACCESS_TOKEN_TTL_MS),
        refresh_expires_at: isoAfter(now, DEFAULT_REFRESH_TOKEN_TTL_MS),
        record: {
          ...(session.record ?? {}),
          refreshed_at: now,
          token_revision: nextTokenRevision,
          token_root_key_version: tokenRootKeyVersion,
        },
      }));
      return createSuccessResult({
        response: {
          access_token: nextAccessToken,
          expires_in_ms: DEFAULT_ACCESS_TOKEN_TTL_MS,
          refresh_token: nextRefreshToken,
        },
      });
    });
  }

  async logoutSession() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const sessionId = request?.session_id ?? null;
    const now = request?.now ?? new Date().toISOString();
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'session_id must be present');
    }
    const session = this.persistence.sessions.get(sessionId);
    if (!session) {
      return createSuccessResult({ response: {} });
    }
    this.persistence.sessions.put(sessionRowToPutRecord(session, {
      revoked_at: now,
      updated_at: now,
    }));
    return createSuccessResult({ response: {} });
  }

  async logoutAllSessions() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const now = request?.now ?? new Date().toISOString();
    const sql = this.requireSqlStorage();
    return withSqliteTransaction(sql, () => {
      for (const session of this.persistence.sessions.list()) {
        if (!session.revoked_at) {
          this.persistence.sessions.put(sessionRowToPutRecord(session, {
            revoked_at: now,
            updated_at: now,
          }));
        }
      }
      return createSuccessResult({ response: {} });
    });
  }

  async changePassword() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = request?.user_id ?? null;
    const now = request?.now ?? new Date().toISOString();
    const newPassword = request?.new_password ?? null;
    const requestFingerprint = request?.request_fingerprint ?? null;
    const uiaNonce = request?.uia_nonce ?? null;
    if (typeof userId !== 'string' || userId.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'user_id must be present');
    }
    if (typeof newPassword !== 'string' || newPassword.trim().length === 0) {
      return createMatrixError(400, 'M_MISSING_PARAM', 'new_password must be present');
    }

    const sql = this.requireSqlStorage();
    return withSqliteTransaction(sql, () => {
      const principal = this.persistence.userPrincipal.get();
      if (!principal || principal.user_id !== userId) {
        return createMatrixError(403, 'M_FORBIDDEN', 'Password change is not allowed');
      }
      if (principal.deactivated_at_or_null) {
        return createMatrixError(403, 'M_USER_DEACTIVATED', 'The user has been deactivated');
      }

      const phase04 = readPhase04Meta(principal);
      const previousPasswordChange = phase04.password_change ?? null;
      const nextPasswordHash = hashPassword(newPassword);
      if (previousPasswordChange?.uia_nonce === uiaNonce) {
        if (previousPasswordChange.request_fingerprint === requestFingerprint) {
          return createSuccessResult({ response: {} });
        }
        return createMatrixError(409, 'M_CONFLICT', 'This UIA session was already used for a different password change');
      }

      const nextAuthVersion = principal.auth_version + 1;
      this.persistence.userPrincipal.put(principalRowToPutRecord(principal, {
        password_hash_or_null: nextPasswordHash,
        password_login_enabled: true,
        auth_version: nextAuthVersion,
        record: mergePhase04Meta(principal, {
          password_change: {
            uia_nonce: uiaNonce,
            request_fingerprint: requestFingerprint,
            completed_at: now,
          },
        }),
      }));

      const keepSessionId = request?.current_session_id ?? null;
      const logoutDevices = request?.logout_devices !== false;
      for (const session of this.persistence.sessions.list()) {
        if (session.revoked_at) {
          continue;
        }
        const shouldKeep = keepSessionId && session.session_id === keepSessionId;
        this.persistence.sessions.put(sessionRowToPutRecord(session, {
          auth_version: nextAuthVersion,
          updated_at: now,
          revoked_at: logoutDevices && !shouldKeep ? now : session.revoked_at ?? null,
        }));
      }

      return createSuccessResult({ response: {} });
    });
  }

  async deactivateAccount() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = request?.user_id ?? null;
    const now = request?.now ?? new Date().toISOString();
    const requestFingerprint = request?.request_fingerprint ?? null;
    const uiaNonce = request?.uia_nonce ?? null;
    const erase = request?.erase === true;
    if (typeof userId !== 'string' || userId.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'user_id must be present');
    }

    const sql = this.requireSqlStorage();
    return withSqliteTransaction(sql, () => {
      const principal = this.persistence.userPrincipal.get();
      if (!principal || principal.user_id !== userId) {
        return createMatrixError(403, 'M_FORBIDDEN', 'Account deactivation is not allowed');
      }

      const phase04 = readPhase04Meta(principal);
      const previousDeactivate = phase04.deactivate ?? null;
      if (previousDeactivate?.uia_nonce === uiaNonce) {
        if (previousDeactivate.request_fingerprint === requestFingerprint) {
          return createSuccessResult({
            response: {
              id_server_unbind_result: 'success',
            },
          });
        }
        return createMatrixError(409, 'M_CONFLICT', 'This UIA session was already used for a different deactivation request');
      }

      const nextAuthVersion = principal.auth_version + 1;
      this.persistence.userPrincipal.put(principalRowToPutRecord(principal, {
        password_hash_or_null: null,
        password_login_enabled: false,
        deactivated_at_or_null: now,
        erase_requested_flag: erase,
        auth_version: nextAuthVersion,
        record: mergePhase04Meta(principal, {
          deactivate: {
            uia_nonce: uiaNonce,
            request_fingerprint: requestFingerprint,
            completed_at: now,
            erase,
          },
        }),
      }));

      for (const session of this.persistence.sessions.list()) {
        if (!session.revoked_at) {
          this.persistence.sessions.put(sessionRowToPutRecord(session, {
            revoked_at: now,
            updated_at: now,
            auth_version: nextAuthVersion,
          }));
        }
      }

      if (erase) {
        for (const row of this.persistence.globalAccountData.list()) {
          this.persistence.globalAccountData.delete(row.type);
        }
        for (const row of this.persistence.roomAccountData.list()) {
          this.persistence.roomAccountData.delete({
            room_id: row.room_id,
            type: row.type,
          });
        }
        for (const row of this.persistence.presence.list()) {
          this.persistence.presence.delete(row.user_id);
        }
        for (const row of this.persistence.profileDocument.list()) {
          this.persistence.profileDocument.delete({ key_name: row.key_name });
        }
        for (const row of this.persistence.pushRules.list()) {
          this.persistence.pushRules.delete({
            scope: row.scope,
            kind: row.kind,
            rule_id: row.rule_id,
          });
        }
      }

      return createSuccessResult({
        response: {
          id_server_unbind_result: 'success',
        },
      });
    });
  }
}

export class RoomDO extends BaseDurableObject {
  static authorityKind = 'room';
  static schemaVersion = ROOM_DO_SCHEMA_VERSION;

  constructor(ctx, env) {
    super(ctx, env, {
      className: 'RoomDO',
      authorityKind: RoomDO.authorityKind,
      owningWorkerName: 'gateway-worker',
      routeFamilyPrefix: 'roomdo',
    });
  }

  get persistence() {
    if (!this._persistence) {
      this._persistence = createRoomDurableObjectPersistence(this.requireSqlStorage());
    }
    return this._persistence;
  }

  async ensureSchema() {
    await this.persistence.ensureSchema();
    return this.persistence.getRuntimeState();
  }

  async admitEvent() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return this.createNotImplementedEnvelope('admitEvent', {
      schema_version: RoomDO.schemaVersion,
    });
  }

  async projectForSync() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return this.createNotImplementedEnvelope('projectForSync', {
      schema_version: RoomDO.schemaVersion,
    });
  }

  async queryRoom() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return this.createNotImplementedEnvelope('queryRoom', {
      schema_version: RoomDO.schemaVersion,
    });
  }
}

export class RemoteServerDO extends BaseDurableObject {
  static authorityKind = 'remote-server';
  static schemaVersion = REMOTE_SERVER_DO_SCHEMA_VERSION;

  constructor(ctx, env) {
    super(ctx, env, {
      className: 'RemoteServerDO',
      authorityKind: RemoteServerDO.authorityKind,
      owningWorkerName: 'gateway-worker',
      routeFamilyPrefix: 'remoteserverdo',
    });
  }

  get persistence() {
    if (!this._persistence) {
      this._persistence = createRemoteServerDurableObjectPersistence(this.requireSqlStorage());
    }
    return this._persistence;
  }

  async ensureSchema() {
    await this.persistence.ensureSchema();
    return this.persistence.getRuntimeState();
  }

  async enqueueOutbound() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return this.createNotImplementedEnvelope('enqueueOutbound', {
      schema_version: RemoteServerDO.schemaVersion,
    });
  }

  async recordInboundTxn() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return this.createNotImplementedEnvelope('recordInboundTxn', {
      schema_version: RemoteServerDO.schemaVersion,
    });
  }
}
