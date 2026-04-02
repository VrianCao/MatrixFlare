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

function parseJsonCell(value, fallback = null) {
  if (value == null || value === '') {
    return fallback;
  }
  return JSON.parse(value);
}

function serializeJsonCell(value) {
  return value == null ? null : JSON.stringify(value);
}

function normalizeScopeColumns(scope) {
  return {
    scope_kind: scope.scope_kind,
    scope_id: scope.scope_id,
    scope_token: `${scope.scope_kind}:${scope.scope_id ?? 'global'}`,
  };
}

async function statementRun(statement, ...bindings) {
  return statement.bind(...bindings).run();
}

async function statementFirst(statement, ...bindings) {
  return statement.bind(...bindings).first();
}

async function statementAll(statement, ...bindings) {
  const result = await statement.bind(...bindings).all();
  return result?.results ?? [];
}

function mapJobRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    scope: {
      scope_kind: row.scope_kind,
      scope_id: row.scope_id,
    },
    spec: parseJsonCell(row.spec_json, {}),
    checkpoint_state: parseJsonCell(row.checkpoint_state_json, null),
    last_error: parseJsonCell(row.last_error_json, null),
    result_summary: parseJsonCell(row.result_summary_json, null),
  };
}

function mapAppserviceRow(row) {
  if (!row) {
    return null;
  }
  return {
    appservice_id: row.appservice_id,
    descriptor: parseJsonCell(row.descriptor_json, null),
    created_at: row.created_at,
    updated_at: row.updated_at,
    disabled_at: row.disabled_at,
  };
}

function mapSnapshotRow(row) {
  if (!row) {
    return null;
  }
  return {
    registry_snapshot_id: row.registry_snapshot_id,
    export_epoch: row.export_epoch,
    scope: {
      scope_kind: row.scope_kind,
      scope_id: row.scope_id,
    },
    created_at: row.created_at,
    row_count: row.row_count,
    snapshot: parseJsonCell(row.snapshot_json, {}),
    snapshot_hash: row.snapshot_hash,
    signature: row.signature,
    signing_key_version: row.signing_key_version,
    r2_object_key: row.r2_object_key,
  };
}

const REQUIRED_CONTROL_PLANE_TABLES = Object.freeze([
  'operator_authz_policies',
  'audit_events',
  'request_dedupe_projection',
  'jobs',
  'job_checkpoints',
  'replay_manifests',
  'repair_decisions',
  'shard_registry',
  'registry_snapshots',
  'appservice_configs',
]);

const CONTROL_PLANE_SCHEMA_STATEMENTS = Object.freeze([
  `
  CREATE TABLE IF NOT EXISTS operator_authz_policies (
    principal_id TEXT PRIMARY KEY,
    principal_type TEXT NOT NULL,
    access_issuer TEXT NOT NULL,
    access_audience TEXT NOT NULL,
    access_subject_binding TEXT NOT NULL,
    access_subject_value TEXT NOT NULL,
    allowed_scopes TEXT NOT NULL,
    target_scope_constraints TEXT NOT NULL,
    expires_at TEXT,
    disabled_at TEXT,
    require_reason INTEGER NOT NULL DEFAULT 0,
    require_ticket INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_operator_authz_lookup
    ON operator_authz_policies (access_issuer, access_audience, access_subject_value)
  `,
  `
  CREATE TABLE IF NOT EXISTS audit_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    operator_principal_id TEXT NOT NULL,
    auth_mechanism TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT,
    scope_token TEXT NOT NULL,
    request_id TEXT,
    idempotency_key TEXT,
    request_fingerprint TEXT,
    job_id TEXT,
    causation_id TEXT,
    result_code TEXT NOT NULL,
    affected_objects TEXT NOT NULL,
    details_json TEXT
  )
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_audit_events_job_id
    ON audit_events (job_id, occurred_at)
  `,
  `
  CREATE TABLE IF NOT EXISTS request_dedupe_projection (
    operator_principal_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    scope_token TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    job_id TEXT,
    result_code TEXT NOT NULL,
    response_payload_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (operator_principal_id, idempotency_key, scope_token)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    internal_state TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT,
    scope_token TEXT NOT NULL,
    operator_principal_id TEXT NOT NULL,
    auth_mechanism TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    canceled_at TEXT,
    cancel_reason TEXT,
    spec_json TEXT NOT NULL,
    checkpoint_state_json TEXT,
    progress_completed_units INTEGER NOT NULL DEFAULT 0,
    progress_total_units INTEGER NOT NULL DEFAULT 0,
    progress_unit_name TEXT NOT NULL DEFAULT 'shard',
    last_error_json TEXT,
    registry_snapshot_id TEXT,
    export_epoch TEXT,
    result_summary_json TEXT
  )
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_jobs_filters
    ON jobs (job_type, internal_state, scope_token, created_at, job_id)
  `,
  `
  CREATE TABLE IF NOT EXISTS job_checkpoints (
    job_id TEXT NOT NULL,
    shard_type TEXT NOT NULL,
    shard_key TEXT NOT NULL,
    checkpoint_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (job_id, shard_type, shard_key)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS replay_manifests (
    job_id TEXT PRIMARY KEY,
    manifest_kind TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    export_epoch TEXT,
    registry_snapshot_id TEXT,
    r2_object_key TEXT
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS repair_decisions (
    decision_id TEXT PRIMARY KEY,
    repair_kind TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT,
    scope_token TEXT NOT NULL,
    dry_run INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    ticket_id TEXT,
    created_at TEXT NOT NULL,
    details_json TEXT
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS shard_registry (
    shard_type TEXT NOT NULL,
    shard_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    disabled_at TEXT,
    PRIMARY KEY (shard_type, shard_key)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS registry_snapshots (
    registry_snapshot_id TEXT PRIMARY KEY,
    export_epoch TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT,
    scope_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    signature TEXT,
    signing_key_version TEXT,
    r2_object_key TEXT
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS appservice_configs (
    appservice_id TEXT PRIMARY KEY,
    descriptor_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled_at TEXT
  )
  `,
].map((statement) => statement.trim()));

export const CONTROL_PLANE_SCHEMA_SQL = `${CONTROL_PLANE_SCHEMA_STATEMENTS.join(';\n\n')};\n`;

export function createD1ControlPlanePersistence(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('db must expose D1-compatible prepare() and exec() methods');
  }
  let schemaReady = false;
  let schemaReadyPromise = null;

  return Object.freeze({
    async ensureSchema() {
      if (schemaReady) {
        return;
      }
      if (!schemaReadyPromise) {
        schemaReadyPromise = (async () => {
          // D1 documents exec() as a maintenance-oriented raw SQL surface; request-path schema bootstrap
          // must execute complete prepared statements so multiline CREATE TABLE literals stay portable.
          for (const statementSql of CONTROL_PLANE_SCHEMA_STATEMENTS) {
            await statementRun(db.prepare(statementSql));
          }
          schemaReady = true;
        })().catch((error) => {
          schemaReadyPromise = null;
          throw error;
        });
      }
      await schemaReadyPromise;
    },
    async isSchemaReady() {
      const rows = await statementAll(
        db.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name IN (${REQUIRED_CONTROL_PLANE_TABLES.map(() => '?').join(', ')})
        `),
        ...REQUIRED_CONTROL_PLANE_TABLES,
      );
      return rows.length === REQUIRED_CONTROL_PLANE_TABLES.length;
    },
    async transaction(callback) {
      await db.exec('BEGIN IMMEDIATE;');
      try {
        const result = await callback(this);
        await db.exec('COMMIT;');
        return result;
      } catch (error) {
        await db.exec('ROLLBACK;');
        throw error;
      }
    },
    async upsertOperatorPolicy(record) {
      const now = normalizeString(record.updated_at, 'updated_at');
      const createdAt = normalizeString(record.created_at ?? now, 'created_at');
      await statementRun(
        db.prepare(`
          INSERT INTO operator_authz_policies (
            principal_id, principal_type, access_issuer, access_audience, access_subject_binding,
            access_subject_value, allowed_scopes, target_scope_constraints, expires_at, disabled_at,
            require_reason, require_ticket, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(principal_id) DO UPDATE SET
            principal_type = excluded.principal_type,
            access_issuer = excluded.access_issuer,
            access_audience = excluded.access_audience,
            access_subject_binding = excluded.access_subject_binding,
            access_subject_value = excluded.access_subject_value,
            allowed_scopes = excluded.allowed_scopes,
            target_scope_constraints = excluded.target_scope_constraints,
            expires_at = excluded.expires_at,
            disabled_at = excluded.disabled_at,
            require_reason = excluded.require_reason,
            require_ticket = excluded.require_ticket,
            updated_at = excluded.updated_at
        `),
        normalizeString(record.principal_id, 'principal_id'),
        normalizeString(record.principal_type, 'principal_type'),
        normalizeString(record.access_issuer, 'access_issuer'),
        normalizeString(record.access_audience, 'access_audience'),
        typeof record.access_subject_binding === 'string'
          ? record.access_subject_binding
          : JSON.stringify(record.access_subject_binding),
        normalizeString(record.access_subject_value, 'access_subject_value'),
        JSON.stringify(record.allowed_scopes ?? []),
        JSON.stringify(record.target_scope_constraints ?? {}),
        record.expires_at ?? null,
        record.disabled_at ?? null,
        record.require_reason ? 1 : 0,
        record.require_ticket ? 1 : 0,
        createdAt,
        now,
      );
    },
    async listActiveOperatorPolicies({ issuer, audience, now }) {
      const rows = await statementAll(
        db.prepare(`
          SELECT * FROM operator_authz_policies
          WHERE access_issuer = ?
            AND access_audience = ?
            AND (disabled_at IS NULL OR disabled_at > ?)
            AND (expires_at IS NULL OR expires_at > ?)
        `),
        normalizeString(issuer, 'issuer'),
        normalizeString(audience, 'audience'),
        normalizeString(now, 'now'),
        normalizeString(now, 'now'),
      );
      return rows.map((row) => ({
        ...row,
        access_subject_binding: parseJsonCell(row.access_subject_binding, {}),
        allowed_scopes: parseJsonCell(row.allowed_scopes, []),
        target_scope_constraints: parseJsonCell(row.target_scope_constraints, {}),
        require_reason: Boolean(row.require_reason),
        require_ticket: Boolean(row.require_ticket),
      }));
    },
    async insertAuditEvent(event) {
      const scopeColumns = normalizeScopeColumns(event.scope);
      await statementRun(
        db.prepare(`
          INSERT INTO audit_events (
            event_id, event_type, occurred_at, operator_principal_id, auth_mechanism,
            scope_kind, scope_id, scope_token, request_id, idempotency_key,
            request_fingerprint, job_id, causation_id, result_code, affected_objects, details_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        normalizeString(event.event_id, 'event_id'),
        normalizeString(event.event_type, 'event_type'),
        normalizeString(event.occurred_at, 'occurred_at'),
        normalizeString(event.operator_principal_id, 'operator_principal_id'),
        normalizeString(event.auth_mechanism, 'auth_mechanism'),
        scopeColumns.scope_kind,
        scopeColumns.scope_id,
        scopeColumns.scope_token,
        event.request_id ?? null,
        event.idempotency_key ?? null,
        event.request_fingerprint ?? null,
        event.job_id ?? null,
        event.causation_id ?? null,
        normalizeString(event.result_code, 'result_code'),
        JSON.stringify(event.affected_objects ?? []),
        serializeJsonCell(event.details ?? null),
      );
    },
    async getDedupeRecord({ operator_principal_id, idempotency_key, scope_token }) {
      const row = await statementFirst(
        db.prepare(`
          SELECT * FROM request_dedupe_projection
          WHERE operator_principal_id = ?
            AND idempotency_key = ?
            AND scope_token = ?
        `),
        normalizeString(operator_principal_id, 'operator_principal_id'),
        normalizeString(idempotency_key, 'idempotency_key'),
        normalizeString(scope_token, 'scope_token'),
      );
      if (!row) {
        return null;
      }
      return {
        ...row,
        response_payload: parseJsonCell(row.response_payload_json, null),
      };
    },
    async listAuditEvents({ job_id = null, event_type = null, limit = 100 } = {}) {
      const whereClauses = [];
      const bindings = [];
      if (job_id != null) {
        whereClauses.push('job_id = ?');
        bindings.push(normalizeString(job_id, 'job_id'));
      }
      if (event_type != null) {
        whereClauses.push('event_type = ?');
        bindings.push(normalizeString(event_type, 'event_type'));
      }
      const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const rows = await statementAll(
        db.prepare(`
          SELECT * FROM audit_events
          ${where}
          ORDER BY occurred_at ASC, event_id ASC
          LIMIT ?
        `),
        ...bindings,
        limit,
      );
      return rows.map((row) => ({
        ...row,
        affected_objects: parseJsonCell(row.affected_objects, []),
        details: parseJsonCell(row.details_json, null),
      }));
    },
    async insertDedupeRecord(record) {
      await statementRun(
        db.prepare(`
          INSERT INTO request_dedupe_projection (
            operator_principal_id, idempotency_key, scope_token, request_fingerprint, job_id,
            result_code, response_payload_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        normalizeString(record.operator_principal_id, 'operator_principal_id'),
        normalizeString(record.idempotency_key, 'idempotency_key'),
        normalizeString(record.scope_token, 'scope_token'),
        normalizeString(record.request_fingerprint, 'request_fingerprint'),
        record.job_id ?? null,
        normalizeString(record.result_code, 'result_code'),
        serializeJsonCell(record.response_payload ?? null),
        normalizeString(record.created_at, 'created_at'),
        normalizeString(record.updated_at, 'updated_at'),
      );
    },
    async updateDedupeRecord(record) {
      await statementRun(
        db.prepare(`
          UPDATE request_dedupe_projection
          SET result_code = ?, response_payload_json = ?, updated_at = ?
          WHERE operator_principal_id = ?
            AND idempotency_key = ?
            AND scope_token = ?
        `),
        normalizeString(record.result_code, 'result_code'),
        serializeJsonCell(record.response_payload ?? null),
        normalizeString(record.updated_at, 'updated_at'),
        normalizeString(record.operator_principal_id, 'operator_principal_id'),
        normalizeString(record.idempotency_key, 'idempotency_key'),
        normalizeString(record.scope_token, 'scope_token'),
      );
    },
    async createJob(record) {
      const scopeColumns = normalizeScopeColumns(record.scope);
      await statementRun(
        db.prepare(`
          INSERT INTO jobs (
            job_id, job_type, internal_state, scope_kind, scope_id, scope_token,
            operator_principal_id, auth_mechanism, idempotency_key, request_fingerprint,
            accepted_at, created_at, started_at, completed_at, canceled_at, cancel_reason,
            spec_json, checkpoint_state_json, progress_completed_units, progress_total_units,
            progress_unit_name, last_error_json, registry_snapshot_id, export_epoch, result_summary_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        normalizeString(record.job_id, 'job_id'),
        normalizeString(record.job_type, 'job_type'),
        normalizeString(record.internal_state, 'internal_state'),
        scopeColumns.scope_kind,
        scopeColumns.scope_id,
        scopeColumns.scope_token,
        normalizeString(record.operator_principal_id, 'operator_principal_id'),
        normalizeString(record.auth_mechanism, 'auth_mechanism'),
        normalizeString(record.idempotency_key, 'idempotency_key'),
        normalizeString(record.request_fingerprint, 'request_fingerprint'),
        normalizeString(record.accepted_at, 'accepted_at'),
        normalizeString(record.created_at, 'created_at'),
        record.started_at ?? null,
        record.completed_at ?? null,
        record.canceled_at ?? null,
        record.cancel_reason ?? null,
        JSON.stringify(record.spec ?? {}),
        serializeJsonCell(record.checkpoint_state ?? null),
        record.progress_completed_units ?? 0,
        record.progress_total_units ?? 0,
        record.progress_unit_name ?? 'shard',
        serializeJsonCell(record.last_error ?? null),
        record.registry_snapshot_id ?? null,
        record.export_epoch ?? null,
        serializeJsonCell(record.result_summary ?? null),
      );
    },
    async updateJob(record) {
      const scopeColumns = normalizeScopeColumns(record.scope);
      await statementRun(
        db.prepare(`
          UPDATE jobs
          SET internal_state = ?,
              scope_kind = ?,
              scope_id = ?,
              scope_token = ?,
              started_at = ?,
              completed_at = ?,
              canceled_at = ?,
              cancel_reason = ?,
              spec_json = ?,
              checkpoint_state_json = ?,
              progress_completed_units = ?,
              progress_total_units = ?,
              progress_unit_name = ?,
              last_error_json = ?,
              registry_snapshot_id = ?,
              export_epoch = ?,
              result_summary_json = ?
          WHERE job_id = ?
        `),
        normalizeString(record.internal_state, 'internal_state'),
        scopeColumns.scope_kind,
        scopeColumns.scope_id,
        scopeColumns.scope_token,
        record.started_at ?? null,
        record.completed_at ?? null,
        record.canceled_at ?? null,
        record.cancel_reason ?? null,
        JSON.stringify(record.spec ?? {}),
        serializeJsonCell(record.checkpoint_state ?? null),
        record.progress_completed_units ?? 0,
        record.progress_total_units ?? 0,
        record.progress_unit_name ?? 'shard',
        serializeJsonCell(record.last_error ?? null),
        record.registry_snapshot_id ?? null,
        record.export_epoch ?? null,
        serializeJsonCell(record.result_summary ?? null),
        normalizeString(record.job_id, 'job_id'),
      );
    },
    async getJob(jobId) {
      const row = await statementFirst(
        db.prepare('SELECT * FROM jobs WHERE job_id = ?'),
        normalizeString(jobId, 'jobId'),
      );
      return mapJobRow(row);
    },
    async listJobs({ job_type = null, internal_states = null, scope = null, limit = 25, cursor = null }) {
      const bindings = [];
      const whereClauses = [];
      if (job_type != null) {
        whereClauses.push('job_type = ?');
        bindings.push(job_type);
      }
      if (Array.isArray(internal_states) && internal_states.length > 0) {
        whereClauses.push(`internal_state IN (${internal_states.map(() => '?').join(',')})`);
        bindings.push(...internal_states);
      }
      if (scope != null) {
        whereClauses.push('scope_token = ?');
        bindings.push(`${scope.scope_kind}:${scope.scope_id ?? 'global'}`);
      }
      if (cursor != null) {
        whereClauses.push('(created_at < ? OR (created_at = ? AND job_id < ?))');
        bindings.push(cursor.created_at, cursor.created_at, cursor.job_id);
      }
      const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const rows = await statementAll(
        db.prepare(`
          SELECT * FROM jobs
          ${where}
          ORDER BY created_at DESC, job_id DESC
          LIMIT ?
        `),
        ...bindings,
        limit,
      );
      return rows.map(mapJobRow);
    },
    async upsertJobCheckpoint({ job_id, shard_type, shard_key, checkpoint, updated_at }) {
      await statementRun(
        db.prepare(`
          INSERT INTO job_checkpoints (
            job_id, shard_type, shard_key, checkpoint_json, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(job_id, shard_type, shard_key) DO UPDATE SET
            checkpoint_json = excluded.checkpoint_json,
            updated_at = excluded.updated_at
        `),
        normalizeString(job_id, 'job_id'),
        normalizeString(shard_type, 'shard_type'),
        normalizeString(shard_key, 'shard_key'),
        JSON.stringify(checkpoint ?? {}),
        normalizeString(updated_at, 'updated_at'),
      );
    },
    async listJobCheckpoints(jobId) {
      const rows = await statementAll(
        db.prepare('SELECT * FROM job_checkpoints WHERE job_id = ? ORDER BY shard_type, shard_key'),
        normalizeString(jobId, 'jobId'),
      );
      return rows.map((row) => ({
        job_id: row.job_id,
        shard_type: row.shard_type,
        shard_key: row.shard_key,
        checkpoint: parseJsonCell(row.checkpoint_json, {}),
        updated_at: row.updated_at,
      }));
    },
    async getJobCheckpoint({ job_id, shard_type, shard_key }) {
      const row = await statementFirst(
        db.prepare(`
          SELECT * FROM job_checkpoints
          WHERE job_id = ?
            AND shard_type = ?
            AND shard_key = ?
        `),
        normalizeString(job_id, 'job_id'),
        normalizeString(shard_type, 'shard_type'),
        normalizeString(shard_key, 'shard_key'),
      );
      if (!row) {
        return null;
      }
      return {
        job_id: row.job_id,
        shard_type: row.shard_type,
        shard_key: row.shard_key,
        checkpoint: parseJsonCell(row.checkpoint_json, {}),
        updated_at: row.updated_at,
      };
    },
    async upsertReplayManifest(record) {
      await statementRun(
        db.prepare(`
          INSERT INTO replay_manifests (
            job_id, manifest_kind, manifest_json, manifest_hash, created_at,
            export_epoch, registry_snapshot_id, r2_object_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(job_id) DO UPDATE SET
            manifest_kind = excluded.manifest_kind,
            manifest_json = excluded.manifest_json,
            manifest_hash = excluded.manifest_hash,
            export_epoch = excluded.export_epoch,
            registry_snapshot_id = excluded.registry_snapshot_id,
            r2_object_key = excluded.r2_object_key
        `),
        normalizeString(record.job_id, 'job_id'),
        normalizeString(record.manifest_kind, 'manifest_kind'),
        JSON.stringify(record.manifest),
        normalizeString(record.manifest_hash, 'manifest_hash'),
        normalizeString(record.created_at, 'created_at'),
        record.export_epoch ?? null,
        record.registry_snapshot_id ?? null,
        record.r2_object_key ?? null,
      );
    },
    async getReplayManifest(jobId) {
      const row = await statementFirst(
        db.prepare('SELECT * FROM replay_manifests WHERE job_id = ?'),
        normalizeString(jobId, 'jobId'),
      );
      if (!row) {
        return null;
      }
      return {
        job_id: row.job_id,
        manifest_kind: row.manifest_kind,
        manifest: parseJsonCell(row.manifest_json, {}),
        manifest_hash: row.manifest_hash,
        created_at: row.created_at,
        export_epoch: row.export_epoch,
        registry_snapshot_id: row.registry_snapshot_id,
        r2_object_key: row.r2_object_key,
      };
    },
    async insertRepairDecision(record) {
      const scopeColumns = normalizeScopeColumns(record.scope);
      await statementRun(
        db.prepare(`
          INSERT INTO repair_decisions (
            decision_id, repair_kind, scope_kind, scope_id, scope_token,
            dry_run, reason, ticket_id, created_at, details_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        normalizeString(record.decision_id, 'decision_id'),
        normalizeString(record.repair_kind, 'repair_kind'),
        scopeColumns.scope_kind,
        scopeColumns.scope_id,
        scopeColumns.scope_token,
        record.dry_run ? 1 : 0,
        normalizeString(record.reason, 'reason'),
        record.ticket_id ?? null,
        normalizeString(record.created_at, 'created_at'),
        serializeJsonCell(record.details ?? null),
      );
    },
    async upsertShardRegistry(record) {
      await statementRun(
        db.prepare(`
          INSERT INTO shard_registry (
            shard_type, shard_key, created_at, last_seen_at, schema_version, disabled_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(shard_type, shard_key) DO UPDATE SET
            last_seen_at = CASE
              WHEN shard_registry.last_seen_at > excluded.last_seen_at THEN shard_registry.last_seen_at
              ELSE excluded.last_seen_at
            END,
            schema_version = CASE
              WHEN shard_registry.schema_version > excluded.schema_version THEN shard_registry.schema_version
              ELSE excluded.schema_version
            END,
            disabled_at = CASE
              WHEN shard_registry.disabled_at IS NULL THEN excluded.disabled_at
              WHEN excluded.disabled_at IS NULL THEN shard_registry.disabled_at
              WHEN shard_registry.disabled_at > excluded.disabled_at THEN shard_registry.disabled_at
              ELSE excluded.disabled_at
            END
        `),
        normalizeString(record.shard_type, 'shard_type'),
        normalizeString(record.shard_key, 'shard_key'),
        normalizeString(record.created_at, 'created_at'),
        normalizeString(record.last_seen_at, 'last_seen_at'),
        record.schema_version,
        record.disabled_at ?? null,
      );
    },
    async listShardRegistry({ scope = null } = {}) {
      const rows = scope == null
        ? await statementAll(
          db.prepare('SELECT * FROM shard_registry ORDER BY shard_type, shard_key'),
        )
        : await statementAll(
          db.prepare(`
            SELECT * FROM shard_registry
            WHERE (? = 'global')
               OR (shard_type = ? AND shard_key = ?)
            ORDER BY shard_type, shard_key
          `),
          scope.scope_kind,
          scope.scope_kind === 'user_id' ? 'UserDO' : scope.scope_kind === 'room_id' ? 'RoomDO' : scope.scope_kind === 'server_name' ? 'RemoteServerDO' : scope.scope_kind === 'appservice_id' ? 'control-plane' : 'control-plane',
          scope.scope_id ?? 'global',
        );
      return rows.map((row) => ({
        shard_type: row.shard_type,
        shard_key: row.shard_key,
        created_at: row.created_at,
        last_seen_at: row.last_seen_at,
        schema_version: row.schema_version,
        disabled_at: row.disabled_at,
      }));
    },
    async insertRegistrySnapshot(record) {
      const scopeColumns = normalizeScopeColumns(record.scope);
      await statementRun(
        db.prepare(`
          INSERT INTO registry_snapshots (
            registry_snapshot_id, export_epoch, scope_kind, scope_id, scope_token,
            created_at, row_count, snapshot_json, snapshot_hash, signature,
            signing_key_version, r2_object_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        normalizeString(record.registry_snapshot_id, 'registry_snapshot_id'),
        normalizeString(record.export_epoch, 'export_epoch'),
        scopeColumns.scope_kind,
        scopeColumns.scope_id,
        scopeColumns.scope_token,
        normalizeString(record.created_at, 'created_at'),
        record.row_count,
        JSON.stringify(record.snapshot),
        normalizeString(record.snapshot_hash, 'snapshot_hash'),
        record.signature ?? null,
        record.signing_key_version ?? null,
        record.r2_object_key ?? null,
      );
    },
    async getRegistrySnapshot(snapshotId) {
      const row = await statementFirst(
        db.prepare('SELECT * FROM registry_snapshots WHERE registry_snapshot_id = ?'),
        normalizeString(snapshotId, 'snapshotId'),
      );
      return mapSnapshotRow(row);
    },
    async exportControlPlaneSnapshot() {
      const operatorRows = await statementAll(
        db.prepare('SELECT * FROM operator_authz_policies ORDER BY principal_id ASC'),
      );
      const auditRows = await statementAll(
        db.prepare('SELECT rowid AS audit_event_rowid, * FROM audit_events ORDER BY rowid ASC'),
      );
      const dedupeRows = await statementAll(
        db.prepare(`
          SELECT * FROM request_dedupe_projection
          ORDER BY created_at ASC, operator_principal_id ASC, idempotency_key ASC, scope_token ASC
        `),
      );
      const jobRows = await statementAll(
        db.prepare('SELECT * FROM jobs ORDER BY created_at ASC, job_id ASC'),
      );
      const checkpointRows = await statementAll(
        db.prepare('SELECT * FROM job_checkpoints ORDER BY job_id ASC, shard_type ASC, shard_key ASC'),
      );
      const replayManifestRows = await statementAll(
        db.prepare('SELECT * FROM replay_manifests ORDER BY created_at ASC, job_id ASC'),
      );
      const repairDecisionRows = await statementAll(
        db.prepare('SELECT * FROM repair_decisions ORDER BY created_at ASC, decision_id ASC'),
      );
      const shardRegistryRows = await statementAll(
        db.prepare('SELECT * FROM shard_registry ORDER BY shard_type ASC, shard_key ASC'),
      );
      const registrySnapshotRows = await statementAll(
        db.prepare('SELECT * FROM registry_snapshots ORDER BY created_at ASC, registry_snapshot_id ASC'),
      );
      const appserviceRows = await statementAll(
        db.prepare('SELECT * FROM appservice_configs ORDER BY updated_at ASC, appservice_id ASC'),
      );
      const watermarkRow = await statementFirst(
        db.prepare(`
          SELECT
            COALESCE(MIN(rowid), 0) AS min_rowid,
            COALESCE(MAX(rowid), 0) AS max_rowid,
            COUNT(*) AS audit_event_count
          FROM audit_events
        `),
      );

      const operatorPolicies = operatorRows.map((row) => ({
        ...row,
        access_subject_binding: parseJsonCell(row.access_subject_binding, {}),
        allowed_scopes: parseJsonCell(row.allowed_scopes, []),
        target_scope_constraints: parseJsonCell(row.target_scope_constraints, {}),
        require_reason: Boolean(row.require_reason),
        require_ticket: Boolean(row.require_ticket),
      }));
      const auditEvents = auditRows.map((row) => ({
        audit_event_rowid: row.audit_event_rowid,
        event_id: row.event_id,
        event_type: row.event_type,
        occurred_at: row.occurred_at,
        operator_principal_id: row.operator_principal_id,
        auth_mechanism: row.auth_mechanism,
        scope_kind: row.scope_kind,
        scope_id: row.scope_id,
        scope_token: row.scope_token,
        request_id: row.request_id,
        idempotency_key: row.idempotency_key,
        request_fingerprint: row.request_fingerprint,
        job_id: row.job_id,
        causation_id: row.causation_id,
        result_code: row.result_code,
        affected_objects: parseJsonCell(row.affected_objects, []),
        details: parseJsonCell(row.details_json, null),
      }));
      const dedupeProjection = dedupeRows.map((row) => ({
        ...row,
        response_payload: parseJsonCell(row.response_payload_json, null),
      }));
      const jobs = jobRows.map(mapJobRow);
      const jobCheckpoints = checkpointRows.map((row) => ({
        job_id: row.job_id,
        shard_type: row.shard_type,
        shard_key: row.shard_key,
        checkpoint: parseJsonCell(row.checkpoint_json, {}),
        updated_at: row.updated_at,
      }));
      const replayManifests = replayManifestRows.map((row) => ({
        job_id: row.job_id,
        manifest_kind: row.manifest_kind,
        manifest: parseJsonCell(row.manifest_json, {}),
        manifest_hash: row.manifest_hash,
        created_at: row.created_at,
        export_epoch: row.export_epoch,
        registry_snapshot_id: row.registry_snapshot_id,
        r2_object_key: row.r2_object_key,
      }));
      const repairDecisions = repairDecisionRows.map((row) => ({
        decision_id: row.decision_id,
        repair_kind: row.repair_kind,
        scope_kind: row.scope_kind,
        scope_id: row.scope_id,
        scope_token: row.scope_token,
        dry_run: Boolean(row.dry_run),
        reason: row.reason,
        ticket_id: row.ticket_id,
        created_at: row.created_at,
        details: parseJsonCell(row.details_json, null),
      }));
      const shardRegistry = shardRegistryRows.map((row) => ({
        shard_type: row.shard_type,
        shard_key: row.shard_key,
        created_at: row.created_at,
        last_seen_at: row.last_seen_at,
        schema_version: row.schema_version,
        disabled_at: row.disabled_at,
      }));
      const registrySnapshots = registrySnapshotRows.map(mapSnapshotRow);
      const appserviceConfigs = appserviceRows.map(mapAppserviceRow);

      return {
        range_start: Number(watermarkRow?.min_rowid ?? 0),
        range_end: Number(watermarkRow?.max_rowid ?? 0),
        watermark: {
          audit_event_rowid: Number(watermarkRow?.max_rowid ?? 0),
          audit_event_count: Number(watermarkRow?.audit_event_count ?? 0),
        },
        record_count:
          operatorPolicies.length
          + auditEvents.length
          + dedupeProjection.length
          + jobs.length
          + jobCheckpoints.length
          + replayManifests.length
          + repairDecisions.length
          + shardRegistry.length
          + registrySnapshots.length
          + appserviceConfigs.length,
        tables: {
          operator_authz_policies: operatorPolicies,
          audit_events: auditEvents,
          request_dedupe_projection: dedupeProjection,
          jobs,
          job_checkpoints: jobCheckpoints,
          replay_manifests: replayManifests,
          repair_decisions: repairDecisions,
          shard_registry: shardRegistry,
          registry_snapshots: registrySnapshots,
          appservice_configs: appserviceConfigs,
        },
      };
    },
    async upsertAppserviceConfig(record) {
      const descriptor = record.descriptor;
      const disabledAt = descriptor?.disabled_at ?? record.disabled_at ?? null;
      await statementRun(
        db.prepare(`
          INSERT INTO appservice_configs (
            appservice_id, descriptor_json, created_at, updated_at, disabled_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(appservice_id) DO UPDATE SET
            descriptor_json = excluded.descriptor_json,
            updated_at = excluded.updated_at,
            disabled_at = excluded.disabled_at
        `),
        normalizeString(record.appservice_id, 'appservice_id'),
        JSON.stringify(descriptor),
        normalizeString(record.created_at, 'created_at'),
        normalizeString(record.updated_at, 'updated_at'),
        disabledAt,
      );
    },
    async getAppserviceConfig(appserviceId) {
      const row = await statementFirst(
        db.prepare('SELECT * FROM appservice_configs WHERE appservice_id = ?'),
        normalizeString(appserviceId, 'appserviceId'),
      );
      return mapAppserviceRow(row);
    },
    async listAppserviceConfigs({ limit = 25, cursor = null } = {}) {
      const rows = cursor == null
        ? await statementAll(
          db.prepare(`
            SELECT * FROM appservice_configs
            ORDER BY updated_at DESC, appservice_id DESC
            LIMIT ?
          `),
          limit,
        )
        : await statementAll(
          db.prepare(`
            SELECT * FROM appservice_configs
            WHERE (updated_at < ? OR (updated_at = ? AND appservice_id < ?))
            ORDER BY updated_at DESC, appservice_id DESC
            LIMIT ?
          `),
          cursor.updated_at,
          cursor.updated_at,
          cursor.appservice_id,
          limit,
        );
      return rows.map(mapAppserviceRow);
    },
    async deleteAppserviceConfig(appserviceId) {
      await statementRun(
        db.prepare('DELETE FROM appservice_configs WHERE appservice_id = ?'),
        normalizeString(appserviceId, 'appserviceId'),
      );
    },
  });
}
