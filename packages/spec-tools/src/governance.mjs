import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CANONICAL_PREFIXES = [
  'REQ',
  'MX',
  'CF',
  'IF',
  'DATA',
  'FLOW',
  'STATE',
  'TEST',
  'EVID',
  'DEC',
  'OQ',
];

const MD_LINK_RE = /\[[^\]]+\]\(([^)]+)\)/g;
const TABLE_SEPARATOR_RE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;
const CANONICAL_TOKEN_PATTERNS = [
  /REQ-(?:[A-Z]+-\d+|[A-Z]+-\*|\*)/g,
  /MX-(?:[A-Z]+-\d+|[A-Z]+-\*|\*)/g,
  /CF-(?:[A-Z]+-\d+|[A-Z]+-\*|\*)/g,
  /IF-(?:[A-Z0-9-]+-\d+|[A-Z0-9-]+-\*|\*)/g,
  /DATA-(?:[A-Z0-9]+-\d+|[A-Z0-9]+-\*|\*)/g,
  /FLOW-(?:[A-Z0-9][A-Z0-9-]*|\*)/g,
  /STATE-(?:[A-Z0-9][A-Z0-9-]*|\*)/g,
  /TEST-(?:[A-Z]+-\d+|[A-Z]+-\*|\*)/g,
  /EVID-(?:[A-Z]+-\d+|[A-Z]+-\*|\*)/g,
  /DEC-(?:\d+|\*)/g,
  /OQ-(?:\d+|\*)/g,
];

const SPEC_DIRS = [
  'spec/framework',
  'spec/decisions',
  'spec/open-questions',
];

const REQUIREMENT_TRACEABILITY_SIDECAR = 'spec/framework/14-requirement-traceability-sidecar.json';

const MATRIX_SNAPSHOT_FILES = [
  'research/sources/matrix-v1.17-client-server-api.html',
  'research/sources/matrix-v1.17-server-server-api.html',
  'research/sources/matrix-v1.17-application-service-api.html',
];

const ROUTE_MARKER_RE =
  /<span class="http-api-method">([^<]+)<\/span>\s*<span class="(?:endpoint-path|endpoint(?: [^"]*)?)">([^<]+)<\/span>/g;

const DEFINITION_HEADERS = new Map([
  ['REQ-ID', 'REQ'],
  ['MX-ID', 'MX'],
  ['CF-ID', 'CF'],
  ['IF-ID', 'IF'],
  ['DATA-ID', 'DATA'],
  ['FLOW ID', 'FLOW'],
  ['STATE ID', 'STATE'],
  ['TEST-ID', 'TEST'],
  ['EVID-ID', 'EVID'],
]);

const FIELD_LINK_CONFIG = {
  MX: [
    { column: 'IF IDs', reason: 'implements', reverseReason: 'implemented_by' },
    { column: 'DATA IDs', reason: 'uses_data', reverseReason: 'used_by' },
    { column: 'FLOW/STATE IDs', reason: 'modeled_by', reverseReason: 'models' },
    { column: 'TEST IDs', reason: 'verified_by', reverseReason: 'verifies' },
    { column: 'EVID IDs', reason: 'evidenced_by', reverseReason: 'evidences' },
  ],
  IF: [
    { column: 'Primary DATA', reason: 'touches_data', reverseReason: 'touched_by' },
    { column: 'FLOW', reason: 'follows_flow', reverseReason: 'governs_interface' },
  ],
  EVID: [
    { column: 'Source IDs', reverse: true, reason: 'evidenced_by', reverseReason: 'evidences' },
  ],
  DEC: [
    { column: 'affected IDs', reason: 'changes', reverseReason: 'changed_by' },
    { column: 'resolved by', reason: 'resolved_by', reverseReason: 'resolves' },
  ],
  OQ: [
    { column: 'affected IDs', reason: 'questions', reverseReason: 'questioned_by' },
    { column: 'resolved by', reason: 'resolved_by', reverseReason: 'resolves' },
  ],
};

const REQ_PREFIX_OWNERS = new Map([
  ['REQ-GOV-', new Set(['10'])],
  ['REQ-ARCH-', new Set(['20'])],
  ['REQ-PLAT-', new Set(['21'])],
  ['REQ-CS-', new Set(['30'])],
  ['REQ-ROOM-', new Set(['31'])],
  ['REQ-FED-', new Set(['32'])],
  ['REQ-MEDIA-', new Set(['33'])],
  ['REQ-AS-', new Set(['34'])],
  ['REQ-SEC-', new Set(['40'])],
  ['REQ-OPS-', new Set(['41', '42'])],
  ['REQ-TEST-', new Set(['43'])],
]);

const SOURCE_ID_FIELDS = new Set(['Source IDs', 'affected IDs', 'resolved by']);
const ALLOWED_NONE_VALUES = new Set(['none', 'n/a', '']);

function normalizePath(value) {
  return value.replaceAll(path.sep, '/');
}

function sortIds(a, b) {
  return a.localeCompare(b, 'en', { numeric: true });
}

function getRepoRoot(fromDir = fileURLToPath(new URL('../../..', import.meta.url))) {
  return path.resolve(fromDir);
}

function rel(repoRoot, target) {
  return normalizePath(path.relative(repoRoot, target));
}

function cleanCell(cell) {
  return cell.trim().replace(/^`|`$/g, '');
}

function parseTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    return null;
  }
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function slugifyTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

export function resolveEvidenceRunTimestamp(candidate = null) {
  if (candidate == null) {
    return slugifyTimestamp();
  }
  if (typeof candidate !== 'string' || !/^\d{8}T\d{6}Z$/.test(candidate)) {
    throw new RangeError('timestamp must match ^\\d{8}T\\d{6}Z$');
  }
  return candidate;
}

export async function assertPathsDoNotExist(paths, {
  label = 'output paths',
} = {}) {
  const existingPaths = [];
  for (const candidatePath of paths) {
    try {
      await fs.lstat(candidatePath);
      existingPaths.push(candidatePath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  if (existingPaths.length > 0) {
    throw new Error(`${label} must be immutable; already exist: ${existingPaths.map((candidatePath) => normalizePath(candidatePath)).join(', ')}`);
  }
}

export async function reserveFreshOutputPaths(paths, options = {}) {
  const label = options.label ?? 'output paths';
  for (const candidatePath of paths) {
    await fs.mkdir(path.dirname(candidatePath), { recursive: true });
    try {
      await fs.mkdir(candidatePath);
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        throw new Error(`${label} must be immutable; already exist: ${normalizePath(candidatePath)}`);
      }
      throw error;
    }
  }
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function csvEscape(value) {
  const stringValue = String(value ?? '');
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }
  return stringValue;
}

function toCsv(rows, headers) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header] ?? '')).join(','));
  }
  return lines.join('\n') + '\n';
}

function parseMarkdownTables(lines) {
  const tables = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseTableRow(lines[index]);
    if (!headerCells) {
      continue;
    }
    if (!TABLE_SEPARATOR_RE.test(lines[index + 1])) {
      continue;
    }
    const rows = [];
    let rowIndex = index + 2;
    while (rowIndex < lines.length) {
      const rowCells = parseTableRow(lines[rowIndex]);
      if (!rowCells) {
        break;
      }
      rows.push({
        line: rowIndex + 1,
        cells: rowCells,
      });
      rowIndex += 1;
    }
    tables.push({
      headerLine: index + 1,
      headers: headerCells,
      rows,
    });
    index = rowIndex - 1;
  }
  return tables;
}

function getFrameworkSpecNumber(filePath) {
  const baseName = path.basename(filePath);
  const match = /^(\d+)-/.exec(baseName);
  return match ? match[1] : null;
}

function parseDocumentStatus(lines) {
  for (const line of lines.slice(0, 6)) {
    const match = /^状态：(.+)$/.exec(line.trim());
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

function parseFrontMatterLike(lines) {
  const metadata = new Map();
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) {
      if (metadata.size > 0) {
        break;
      }
      continue;
    }
    if (line.startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z][A-Za-z /-]+?):\s*(.+)$/.exec(line);
    if (!match) {
      if (metadata.size > 0) {
        break;
      }
      continue;
    }
    metadata.set(match[1].trim(), {
      value: match[2].trim(),
      line: index + 1,
    });
  }
  return metadata;
}

function findCanonicalTokens(raw) {
  const ids = new Set();
  for (const pattern of CANONICAL_TOKEN_PATTERNS) {
    for (const match of raw.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const previousCharacter = start > 0 ? raw[start - 1] : '';
      const nextCharacter = end < raw.length ? raw[end] : '';
      const hasLeftBoundary = previousCharacter === '' || !/[A-Z0-9-]/.test(previousCharacter);
      const hasRightBoundary = nextCharacter === '' || !/[A-Z0-9-]/.test(nextCharacter);
      if (hasLeftBoundary && hasRightBoundary) {
        ids.add(match[0]);
      }
    }
  }
  return [...ids];
}

function isWildcardId(id) {
  return id.endsWith('*');
}

function canonicalTypeForId(id) {
  for (const prefix of CANONICAL_PREFIXES) {
    if (id.startsWith(`${prefix}-`)) {
      return prefix;
    }
  }
  return null;
}

function sourceTypeLabel(type) {
  switch (type) {
    case 'REQ':
      return 'requirement';
    case 'MX':
      return 'coverage';
    case 'CF':
      return 'constraint';
    case 'IF':
      return 'contract';
    case 'DATA':
      return 'data';
    case 'FLOW':
      return 'flow';
    case 'STATE':
      return 'state-machine';
    case 'TEST':
      return 'test';
    case 'EVID':
      return 'evidence';
    case 'DEC':
      return 'decision';
    case 'OQ':
      return 'open-question';
    default:
      return 'unknown';
  }
}

function parseCanonicalIdList(rawValue) {
  const raw = rawValue.trim();
  const normalized = raw.replaceAll('`', '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
  if (ALLOWED_NONE_VALUES.has(normalized.toLowerCase())) {
    return { ids: [], errors: [] };
  }
  const errors = [];
  if (hasUnsupportedIdRangeOrShorthand(normalized)) {
    errors.push(`unsupported ID range or shorthand: ${raw}`);
  }
  const ids = findCanonicalTokens(normalized);
  if (ids.length === 0) {
    errors.push(`expected canonical IDs but found: ${raw}`);
  }
  return {
    ids,
    errors,
  };
}

function parseSpecNumberList(rawValue) {
  return rawValue
    .replaceAll('`', '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseRuntimeOwners(rawValue) {
  return rawValue
    .replaceAll('`', '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part.toLowerCase() !== 'none');
}

function toPseudoSpecId(specNumber) {
  return `SPEC-${specNumber}`;
}

function toPseudoRuntimeId(runtimeName) {
  return `RT-${runtimeName}`;
}

function compareDefinitions(a, b) {
  if (a.id !== b.id) {
    return sortIds(a.id, b.id);
  }
  if (a.file !== b.file) {
    return a.file.localeCompare(b.file);
  }
  return a.line - b.line;
}

function hasUnsupportedIdRangeOrShorthand(value) {
  if (/[~–—]/.test(value)) {
    return true;
  }
  const prefixGroup = '(?:REQ|MX|CF|IF|DATA|FLOW|STATE|TEST|EVID|DEC|OQ)';
  const canonicalNumericId = `(?:${prefixGroup}(?:-[A-Z0-9]+)*-\\d+)`;
  const fullRangePattern = new RegExp(
    `(?:^|[^A-Z0-9-])${canonicalNumericId}\\s*-\\s*${canonicalNumericId}(?=$|[^A-Z0-9-])`,
  );
  const numericTailRangePattern = new RegExp(
    `(?:^|[^A-Z0-9-])${canonicalNumericId}\\s*-\\s*\\d+\\b`,
  );
  const suffixShorthandPattern = new RegExp(
    `(?:^|[^A-Z0-9-])${canonicalNumericId}\\s*,\\s*-\\d+\\b`,
  );
  return (
    fullRangePattern.test(value) ||
    numericTailRangePattern.test(value) ||
    suffixShorthandPattern.test(value)
  );
}

function registerDefinition(definitions, duplicateDefinitions, definition) {
  definitions.push(definition);
  if (!duplicateDefinitions.has(definition.id)) {
    duplicateDefinitions.set(definition.id, []);
  }
  duplicateDefinitions.get(definition.id).push(definition);
}

async function readMarkdownFile(repoRoot, relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const text = await fs.readFile(absolutePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const tables = parseMarkdownTables(lines);
  const metadata = parseFrontMatterLike(lines);
  const links = [];
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(MD_LINK_RE)) {
      links.push({
        target: match[1],
        line: index + 1,
      });
    }
  }
  return {
    relativePath,
    absolutePath,
    text,
    lines,
    tables,
    metadata,
    links,
    documentStatus: parseDocumentStatus(lines),
    specNumber: getFrameworkSpecNumber(relativePath),
  };
}

function buildDefinitions(files) {
  const definitions = [];
  const duplicateDefinitions = new Map();

  for (const file of files) {
    for (const table of file.tables) {
      const idHeader = table.headers[0];
      const type = DEFINITION_HEADERS.get(idHeader);
      if (!type) {
        continue;
      }
      for (const row of table.rows) {
        const rowMap = Object.fromEntries(
          table.headers.map((header, index) => [header, row.cells[index] ?? '']),
        );
        const id = cleanCell(row.cells[0] ?? '');
        if (!id) {
          continue;
        }
        const definition = {
          id,
          type,
          file: file.relativePath,
          line: row.line,
          specNumber: file.specNumber,
          documentStatus: file.documentStatus,
          columns: rowMap,
        };
        registerDefinition(definitions, duplicateDefinitions, definition);
      }
    }

    if (file.relativePath.startsWith('spec/decisions/')) {
      const heading = file.lines.find((line) => /^#\s+DEC-\d+/.test(line.trim()));
      if (heading) {
        registerDefinition(definitions, duplicateDefinitions, {
          id: heading.trim().slice(2).trim(),
          type: 'DEC',
          file: file.relativePath,
          line: file.lines.findIndex((line) => line === heading) + 1,
          specNumber: null,
          documentStatus: file.metadata.get('status')?.value ?? null,
          columns: Object.fromEntries([...file.metadata.entries()].map(([key, value]) => [key, value.value])),
        });
      }
    }

    if (file.relativePath.startsWith('spec/open-questions/')) {
      const heading = file.lines.find((line) => /^#\s+OQ-\d+/.test(line.trim()));
      if (heading) {
        registerDefinition(definitions, duplicateDefinitions, {
          id: heading.trim().slice(2).trim(),
          type: 'OQ',
          file: file.relativePath,
          line: file.lines.findIndex((line) => line === heading) + 1,
          specNumber: null,
          documentStatus: file.metadata.get('status')?.value ?? null,
          columns: Object.fromEntries([...file.metadata.entries()].map(([key, value]) => [key, value.value])),
        });
      }
    }
  }

  definitions.sort(compareDefinitions);
  return { definitions, duplicateDefinitions };
}

function buildRequirementRegister(definitions) {
  return definitions
    .filter((definition) => definition.type === 'REQ')
    .map((definition) => {
      const headers = Object.keys(definition.columns);
      const titleHeader = headers[1] ?? 'Title';
      return {
        req_id: definition.id,
        owning_spec: definition.specNumber,
        title: definition.columns[titleHeader] ?? '',
        normative_statement: definition.columns['Normative Statement'] ?? '',
        source_file: definition.file,
        source_line: definition.line,
        status: 'active',
      };
    })
    .sort((a, b) => sortIds(a.req_id, b.req_id));
}

function buildRequirementRegisterMap(requirementRegister) {
  const registerMap = new Map();
  for (const row of requirementRegister) {
    registerMap.set(row.req_id, row);
  }
  return registerMap;
}

function expandCanonicalReference(id, definitionsById, requirementRegisterMap) {
  if (!isWildcardId(id)) {
    if (id.startsWith('REQ-')) {
      return requirementRegisterMap.has(id) ? [id] : [];
    }
    return definitionsById.has(id) ? [id] : [];
  }
  const prefix = id.slice(0, -1);
  const sourceIds = prefix.startsWith('REQ-') || id === 'REQ-*'
    ? [...requirementRegisterMap.keys()]
    : [...definitionsById.keys()];
  return sourceIds.filter((candidate) => candidate.startsWith(prefix)).sort(sortIds);
}

function buildFieldReferenceInventory(definitions, issues, definitionsById, requirementRegisterMap) {
  const inventory = [];

  for (const definition of definitions) {
    const linkConfig = FIELD_LINK_CONFIG[definition.type] ?? [];
    for (const config of linkConfig) {
      const rawValue = definition.columns[config.column];
      if (!rawValue) {
        continue;
      }
      const { ids, errors } = parseCanonicalIdList(rawValue);
      for (const error of errors) {
        issues.push({
          severity: 'error',
          code: 'invalid_id_list',
          file: definition.file,
          line: definition.line,
          message: `${definition.id} ${config.column}: ${error}`,
        });
      }
      for (const id of ids) {
        const expandedIds = expandCanonicalReference(id, definitionsById, requirementRegisterMap);
        if (expandedIds.length === 0) {
          issues.push({
            severity: 'error',
            code: 'unregistered_reference',
            file: definition.file,
            line: definition.line,
            message: `${definition.id} ${config.column} references unknown ID or empty wildcard ${id}`,
          });
        }
        inventory.push({
          ownerId: definition.id,
          ownerType: definition.type,
          field: config.column,
          rawId: id,
          targetIds: expandedIds,
          reason: config.reason,
          reverseReason: config.reverseReason,
          reverse: config.reverse ?? false,
          file: definition.file,
          line: definition.line,
        });
      }
    }
  }

  return inventory;
}

function buildRawReferenceInventory(files) {
  const references = [];
  for (const file of files) {
    for (const [index, line] of file.lines.entries()) {
      const matches = findCanonicalTokens(line);
      if (matches.length === 0) {
        continue;
      }
      for (const id of matches) {
        references.push({
          id,
          file: file.relativePath,
          line: index + 1,
        });
      }
    }
  }
  return references;
}

async function loadRequirementTraceabilitySidecar(repoRoot, issues) {
  const relativePath = REQUIREMENT_TRACEABILITY_SIDECAR;
  const absolutePath = path.join(repoRoot, relativePath);
  let rawText;
  try {
    rawText = await fs.readFile(absolutePath, 'utf8');
  } catch {
    issues.push({
      severity: 'error',
      code: 'missing_requirement_traceability_sidecar',
      file: relativePath,
      line: 1,
      message: `${relativePath} is missing`,
    });
    return {
      relativePath,
      version: null,
      requirements: {},
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    issues.push({
      severity: 'error',
      code: 'invalid_requirement_traceability_sidecar',
      file: relativePath,
      line: 1,
      message: `${relativePath} contains invalid JSON: ${error.message}`,
    });
    return {
      relativePath,
      version: null,
      requirements: {},
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    issues.push({
      severity: 'error',
      code: 'invalid_requirement_traceability_sidecar',
      file: relativePath,
      line: 1,
      message: `${relativePath} must be a JSON object`,
    });
    return {
      relativePath,
      version: null,
      requirements: {},
    };
  }

  if (!parsed.requirements || typeof parsed.requirements !== 'object' || Array.isArray(parsed.requirements)) {
    issues.push({
      severity: 'error',
      code: 'invalid_requirement_traceability_sidecar',
      file: relativePath,
      line: 1,
      message: `${relativePath} must contain a requirements object`,
    });
    return {
      relativePath,
      version: parsed.version ?? null,
      requirements: {},
    };
  }

  return {
    relativePath,
    version: parsed.version ?? null,
    requirements: parsed.requirements,
  };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  return [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    .sort(sortIds);
}

function normalizeRequirementTraceabilityIdList({
  reqId,
  fieldName,
  rawValue,
  required,
  expectedTypes,
  definitionsById,
  issues,
  file,
}) {
  const values = normalizeStringArray(rawValue);
  if (!values) {
    issues.push({
      severity: 'error',
      code: 'invalid_requirement_traceability_entry',
      file,
      line: 1,
      message: `${reqId} ${fieldName} must be an array of strings`,
    });
    return [];
  }
  if (required && values.length === 0) {
    issues.push({
      severity: 'error',
      code: 'missing_requirement_traceability_link',
      file,
      line: 1,
      message: `${reqId} is missing required ${fieldName}`,
    });
  }
  for (const id of values) {
    const actualType = canonicalTypeForId(id);
    if (!actualType || !expectedTypes.has(actualType) || !definitionsById.has(id)) {
      issues.push({
        severity: 'error',
        code: 'invalid_requirement_traceability_link',
        file,
        line: 1,
        message: `${reqId} ${fieldName} references unknown or invalid ID ${id}`,
      });
    }
  }
  return values;
}

function validateRequirementTraceabilityEntries(sidecar, requirementRegister, definitionsById, issues) {
  const entries = new Map();
  const file = sidecar.relativePath;
  const knownRequirementIds = new Set(requirementRegister.map((row) => row.req_id));

  for (const reqId of Object.keys(sidecar.requirements).sort(sortIds)) {
    if (!knownRequirementIds.has(reqId)) {
      issues.push({
        severity: 'error',
        code: 'unknown_requirement_traceability_entry',
        file,
        line: 1,
        message: `${reqId} exists in ${file} but not in the requirement register`,
      });
    }
  }

  for (const row of requirementRegister) {
    const entry = sidecar.requirements[row.req_id];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({
        severity: 'error',
        code: 'missing_requirement_traceability_entry',
        file,
        line: 1,
        message: `${row.req_id} is missing a traceability entry in ${file}`,
      });
      continue;
    }

    const runtimeOwners = normalizeStringArray(entry.runtime_owners);
    if (!runtimeOwners) {
      issues.push({
        severity: 'error',
        code: 'invalid_requirement_traceability_entry',
        file,
        line: 1,
        message: `${row.req_id} runtime_owners must be an array of strings`,
      });
    } else if (runtimeOwners.length === 0) {
      issues.push({
        severity: 'error',
        code: 'missing_requirement_traceability_link',
        file,
        line: 1,
        message: `${row.req_id} is missing required runtime_owners`,
      });
    }

    entries.set(row.req_id, {
      runtimeOwners: runtimeOwners ?? [],
      ifIds: normalizeRequirementTraceabilityIdList({
        reqId: row.req_id,
        fieldName: 'if_ids',
        rawValue: entry.if_ids,
        required: true,
        expectedTypes: new Set(['IF']),
        definitionsById,
        issues,
        file,
      }),
      dataIds: normalizeRequirementTraceabilityIdList({
        reqId: row.req_id,
        fieldName: 'data_ids',
        rawValue: entry.data_ids,
        required: true,
        expectedTypes: new Set(['DATA']),
        definitionsById,
        issues,
        file,
      }),
      flowStateIds: normalizeRequirementTraceabilityIdList({
        reqId: row.req_id,
        fieldName: 'flow_state_ids',
        rawValue: entry.flow_state_ids ?? [],
        required: false,
        expectedTypes: new Set(['FLOW', 'STATE']),
        definitionsById,
        issues,
        file,
      }),
      testIds: normalizeRequirementTraceabilityIdList({
        reqId: row.req_id,
        fieldName: 'test_ids',
        rawValue: entry.test_ids,
        required: true,
        expectedTypes: new Set(['TEST']),
        definitionsById,
        issues,
        file,
      }),
      evidIds: normalizeRequirementTraceabilityIdList({
        reqId: row.req_id,
        fieldName: 'evid_ids',
        rawValue: entry.evid_ids,
        required: true,
        expectedTypes: new Set(['EVID']),
        definitionsById,
        issues,
        file,
      }),
    });
  }

  return entries;
}

function buildTraceabilityMatrix(definitions, definitionsById, fieldInventory, requirementTraceabilityEntries) {
  const edges = [];
  const edgeKeys = new Set();

  function addEdge(sourceId, targetId, linkReason, sourceFile, sourceLine) {
    const sourceType = definitionsById.has(sourceId)
      ? sourceTypeLabel(definitionsById.get(sourceId).type)
      : sourceId.startsWith('SPEC-')
        ? 'spec'
        : 'runtime';
    const targetType = definitionsById.has(targetId)
      ? sourceTypeLabel(definitionsById.get(targetId).type)
      : targetId.startsWith('SPEC-')
        ? 'spec'
        : 'runtime';
    const owningSpec = definitionsById.get(sourceId)?.specNumber ?? definitionsById.get(targetId)?.specNumber ?? '';
    const key = [sourceId, targetId, linkReason].join('|');
    if (edgeKeys.has(key)) {
      return;
    }
    edgeKeys.add(key);
    edges.push({
      source_id: sourceId,
      source_type: sourceType,
      target_id: targetId,
      target_type: targetType,
      link_reason: linkReason,
      owning_spec: owningSpec,
      status: 'active',
      source_file: sourceFile,
      source_line: sourceLine,
    });
  }

  for (const definition of definitions) {
    if (definition.type === 'REQ' && definition.specNumber) {
      addEdge(definition.id, toPseudoSpecId(definition.specNumber), 'owned_by_spec', definition.file, definition.line);
      addEdge(toPseudoSpecId(definition.specNumber), definition.id, 'owns_requirement', definition.file, definition.line);
    }
    if (definition.columns['Owning Spec']) {
      for (const specNumber of parseSpecNumberList(definition.columns['Owning Spec'])) {
        addEdge(definition.id, toPseudoSpecId(specNumber), 'owned_by_spec', definition.file, definition.line);
        addEdge(toPseudoSpecId(specNumber), definition.id, 'owns_artifact', definition.file, definition.line);
      }
    }
    if (definition.columns['Runtime Owner']) {
      for (const runtimeOwner of parseRuntimeOwners(definition.columns['Runtime Owner'])) {
        addEdge(definition.id, toPseudoRuntimeId(runtimeOwner), 'owned_by_runtime', definition.file, definition.line);
        addEdge(toPseudoRuntimeId(runtimeOwner), definition.id, 'owns_artifact', definition.file, definition.line);
      }
    }
  }

  for (const item of fieldInventory) {
    for (const targetId of item.targetIds) {
      if (item.reverse) {
        addEdge(targetId, item.ownerId, item.reason, item.file, item.line);
        addEdge(item.ownerId, targetId, item.reverseReason, item.file, item.line);
      } else {
        addEdge(item.ownerId, targetId, item.reason, item.file, item.line);
        addEdge(targetId, item.ownerId, item.reverseReason, item.file, item.line);
      }
    }
  }

  for (const definition of definitions.filter((item) => item.type === 'REQ')) {
    const entry = requirementTraceabilityEntries.get(definition.id);
    if (!entry) {
      continue;
    }
    for (const runtimeOwner of entry.runtimeOwners) {
      addEdge(definition.id, toPseudoRuntimeId(runtimeOwner), 'owned_by_runtime', definition.file, definition.line);
      addEdge(toPseudoRuntimeId(runtimeOwner), definition.id, 'owns_requirement', definition.file, definition.line);
    }
    for (const ifId of entry.ifIds) {
      addEdge(definition.id, ifId, 'implemented_by', definition.file, definition.line);
      addEdge(ifId, definition.id, 'implements_requirement', definition.file, definition.line);
    }
    for (const dataId of entry.dataIds) {
      addEdge(definition.id, dataId, 'realized_by_data', definition.file, definition.line);
      addEdge(dataId, definition.id, 'supports_requirement', definition.file, definition.line);
    }
    for (const flowStateId of entry.flowStateIds) {
      addEdge(definition.id, flowStateId, 'modeled_by', definition.file, definition.line);
      addEdge(flowStateId, definition.id, 'models_requirement', definition.file, definition.line);
    }
    for (const testId of entry.testIds) {
      addEdge(definition.id, testId, 'verified_by', definition.file, definition.line);
      addEdge(testId, definition.id, 'verifies_requirement', definition.file, definition.line);
    }
    for (const evidId of entry.evidIds) {
      addEdge(definition.id, evidId, 'evidenced_by', definition.file, definition.line);
      addEdge(evidId, definition.id, 'evidences_requirement', definition.file, definition.line);
    }
  }

  edges.sort((a, b) => {
    if (a.source_id !== b.source_id) {
      return sortIds(a.source_id, b.source_id);
    }
    if (a.target_id !== b.target_id) {
      return sortIds(a.target_id, b.target_id);
    }
    return a.link_reason.localeCompare(b.link_reason);
  });

  return edges;
}

async function extractMatrixRouteCatalog(repoRoot) {
  const catalogByPath = new Map();
  for (const relativePath of MATRIX_SNAPSHOT_FILES) {
    const text = await fs.readFile(path.join(repoRoot, relativePath), 'utf8');
    const family =
      relativePath.includes('client-server')
        ? 'client'
        : relativePath.includes('server-server')
          ? 'federation'
          : 'appservice';
    for (const match of text.matchAll(ROUTE_MARKER_RE)) {
      const method = match[1].trim();
      const routePath = match[2].trim();
      if (!routePath.startsWith('/_matrix/')) {
        continue;
      }
      if (!catalogByPath.has(routePath)) {
        catalogByPath.set(routePath, {
          family,
          methods: new Set(),
          snapshots: new Set(),
          path: routePath,
        });
      }
      catalogByPath.get(routePath).methods.add(method);
      catalogByPath.get(routePath).snapshots.add(relativePath);
    }
  }
  return [...catalogByPath.values()]
    .map((entry) => ({
      ...entry,
      methods: [...entry.methods].sort(),
      snapshots: [...entry.snapshots].sort(),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function routePatternToRegex(routePath) {
  const escaped = routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^${escaped.replaceAll('\\*', '[^/]+').replaceAll(/\\\{[^}]+\\\}/g, '[^/]+')}$`,
  );
}

function isValidMatrixWildcardRoutePattern(routePath) {
  const segments = routePath.split('/');
  const wildcardSegments = segments.filter((segment) => segment.includes('*'));
  return (
    routePath.startsWith('/_matrix/')
    && wildcardSegments.length === 1
    && segments[3] === '*'
    && wildcardSegments[0] === '*'
  );
}

function parseRouteCell(rawValue) {
  return rawValue
    .replaceAll('`', '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = /^([A-Z/]+)\s+(.+)$/.exec(item);
      if (!match) {
        return null;
      }
      return {
        methods: match[1].split('/'),
        path: match[2].trim(),
        raw: item,
      };
    })
    .filter(Boolean);
}

function buildWildcardRouteExpansion(definitions, matrixRouteCatalog, issues) {
  const expansions = [];
  for (const definition of definitions.filter((item) => item.type === 'IF')) {
    const routeCell = definition.columns['Route / Family'];
    if (!routeCell || !routeCell.includes('*')) {
      continue;
    }
    const routeEntries = parseRouteCell(routeCell);
    for (const routeEntry of routeEntries) {
      if (!routeEntry.path.includes('*') || !routeEntry.path.startsWith('/_matrix/')) {
        continue;
      }
      if (!isValidMatrixWildcardRoutePattern(routeEntry.path)) {
        issues.push({
          severity: 'error',
          code: 'wildcard_route_invalid_pattern',
          file: definition.file,
          line: definition.line,
          message: `${definition.id} route pattern ${routeEntry.path} uses "*" outside the Matrix API version segment`,
        });
        continue;
      }
      const matcher = routePatternToRegex(routeEntry.path);
      const matchedPaths = matrixRouteCatalog
        .filter((candidate) => matcher.test(candidate.path))
        .map((candidate) => candidate.path)
        .sort(sortIds);
      if (matchedPaths.length === 0) {
        issues.push({
          severity: 'error',
          code: 'wildcard_route_unresolved',
          file: definition.file,
          line: definition.line,
          message: `${definition.id} route pattern ${routeEntry.path} did not resolve against pinned Matrix v1.17 snapshots`,
        });
      }
      expansions.push({
        if_id: definition.id,
        source_file: definition.file,
        source_line: definition.line,
        route_pattern: routeEntry.path,
        methods: routeEntry.methods.join(','),
        expanded_paths: matchedPaths,
        expanded_routes: routeEntry.methods.flatMap((method) =>
          matchedPaths.map((resolvedPath) => `${method} ${resolvedPath}`),
        ),
      });
    }
  }
  expansions.sort((a, b) => {
    if (a.if_id !== b.if_id) {
      return sortIds(a.if_id, b.if_id);
    }
    return a.route_pattern.localeCompare(b.route_pattern);
  });
  return expansions;
}

async function validateCloudflareSnapshots(repoRoot, definitions, issues) {
  for (const definition of definitions.filter((item) => item.type === 'CF')) {
    const rawValue = definition.columns['Official Source'];
    if (!rawValue) {
      issues.push({
        severity: 'error',
        code: 'cf_missing_source',
        file: definition.file,
        line: definition.line,
        message: `${definition.id} is missing Official Source`,
      });
      continue;
    }
    const sourceKeys = rawValue
      .replaceAll('`', '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    for (const sourceKey of sourceKeys) {
      const mdPath = path.join(repoRoot, 'research/sources', `cloudflare-${sourceKey}.md`);
      const htmlPath = path.join(repoRoot, 'research/sources', `cloudflare-${sourceKey}.html`);
      const exists = await Promise.all([
        fs.access(mdPath).then(() => true).catch(() => false),
        fs.access(htmlPath).then(() => true).catch(() => false),
      ]);
      if (!exists.some(Boolean)) {
        issues.push({
          severity: 'error',
          code: 'cf_missing_snapshot',
          file: definition.file,
          line: definition.line,
          message: `${definition.id} references missing pinned Cloudflare snapshot cloudflare-${sourceKey}.{md,html}`,
        });
      }
    }
  }
}

async function validateSourceObservationRegister(repoRoot, files, issues) {
  const register = files.find((file) => file.relativePath === 'spec/framework/15-source-observation-register.md');
  if (!register) {
    issues.push({
      severity: 'error',
      code: 'missing_source_observation_register',
      file: 'spec/framework/15-source-observation-register.md',
      line: 1,
      message: '15-source-observation-register.md is missing',
    });
    return;
  }

  const observationTable = register.tables.find((table) => table.headers[0] === 'Source Family');
  if (!observationTable) {
    issues.push({
      severity: 'error',
      code: 'invalid_source_observation_register',
      file: register.relativePath,
      line: 1,
      message: 'source observation register table is missing',
    });
    return;
  }

  for (const row of observationTable.rows) {
    const columns = Object.fromEntries(observationTable.headers.map((header, index) => [header, row.cells[index] ?? '']));
    const observationDate = columns['Observation Date']?.replaceAll('`', '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(observationDate ?? '')) {
      issues.push({
        severity: 'error',
        code: 'invalid_observation_date',
        file: register.relativePath,
        line: row.line,
        message: `invalid Observation Date ${columns['Observation Date']}`,
      });
    }
    const delta = columns['Delta Summary']?.replaceAll('`', '').trim();
    const actionRequired = columns['Action Required']?.replaceAll('`', '').trim();
    if (delta && delta !== 'none' && actionRequired === 'no-op') {
      issues.push({
        severity: 'error',
        code: 'invalid_delta_action_pair',
        file: register.relativePath,
        line: row.line,
        message: `${columns['Source Family']} has delta ${delta} but Action Required is no-op`,
      });
    }
    const snapshotMatches = [...(columns['Pinned Baseline']?.matchAll(/research\/sources\/([A-Za-z0-9._-]+\.(?:md|html))/g) ?? [])];
    for (const match of snapshotMatches) {
      const snapshotPath = path.join(repoRoot, 'research/sources', match[1]);
      try {
        await fs.access(snapshotPath);
      } catch {
        issues.push({
          severity: 'error',
          code: 'missing_observation_snapshot',
          file: register.relativePath,
          line: row.line,
          message: `${columns['Source Family']} references missing snapshot research/sources/${match[1]}`,
        });
      }
    }
  }
}

function validateReqPrefixOwnership(requirementRegister, issues) {
  for (const row of requirementRegister) {
    const ownerEntry = [...REQ_PREFIX_OWNERS.entries()].find(([prefix]) => row.req_id.startsWith(prefix));
    if (!ownerEntry) {
      issues.push({
        severity: 'error',
        code: 'unknown_req_prefix',
        file: row.source_file,
        line: row.source_line,
        message: `${row.req_id} does not match any registered REQ prefix`,
      });
      continue;
    }
    const [, allowedOwners] = ownerEntry;
    if (!allowedOwners.has(row.owning_spec)) {
      issues.push({
        severity: 'error',
        code: 'req_wrong_owner',
        file: row.source_file,
        line: row.source_line,
        message: `${row.req_id} is defined in spec ${row.owning_spec}, expected one of ${[...allowedOwners].join(', ')}`,
      });
    }
  }
}

function validateDuplicateDefinitions(duplicateDefinitions, issues) {
  for (const [id, definitions] of duplicateDefinitions.entries()) {
    if (definitions.length > 1) {
      const locations = definitions.map((definition) => `${definition.file}:${definition.line}`).join(', ');
      issues.push({
        severity: 'error',
        code: 'duplicate_definition',
        file: definitions[0].file,
        line: definitions[0].line,
        message: `${id} is defined multiple times: ${locations}`,
      });
    }
  }
}

function validateRawReferences(rawReferences, definitionsById, requirementRegisterMap, issues) {
  for (const reference of rawReferences) {
    const matches = expandCanonicalReference(reference.id, definitionsById, requirementRegisterMap);
    if (
      matches.length === 0 &&
      reference.file === 'spec/framework/11-spec-authority-and-version-policy.md' &&
      reference.id.startsWith('REQ-') &&
      reference.id.endsWith('*')
    ) {
      continue;
    }
    if (matches.length === 0) {
      issues.push({
        severity: 'error',
        code: 'unregistered_reference',
        file: reference.file,
        line: reference.line,
        message: `reference to unknown ID or empty wildcard ${reference.id}`,
      });
    }
  }
}

function validateProhibitedAuthorityLinks(files, issues) {
  const allowedCompatRefs = new Set([
    'spec/framework/README.md',
    'spec/framework/11-spec-authority-and-version-policy.md',
    'spec/framework/90-open-questions.md',
    'spec/framework/91-decision-log.md',
  ]);

  for (const file of files) {
    for (const link of file.links) {
      const target = link.target;
      const normalizedTarget = target.replace(/^\.\/+/, '');
      if (
        (normalizedTarget.includes('90-open-questions.md') || normalizedTarget.includes('91-decision-log.md')) &&
        !allowedCompatRefs.has(file.relativePath)
      ) {
        issues.push({
          severity: 'error',
          code: 'compatibility_page_authority_ref',
          file: file.relativePath,
          line: link.line,
          message: `compatibility page link ${target} is not allowed as an authority reference`,
        });
      }
      if (/92-appendices\.md#2[1-8]/.test(normalizedTarget)) {
        issues.push({
          severity: 'error',
          code: 'appendix_placeholder_authority_ref',
          file: file.relativePath,
          line: link.line,
          message: `placeholder appendix section ${target} cannot be used as authority`,
        });
      }
    }
  }
}

function validateClosedOpenQuestions(definitions, issues, definitionsById) {
  for (const definition of definitions.filter((item) => item.type === 'OQ')) {
    const status = definition.columns.status?.trim();
    if (status !== 'closed') {
      continue;
    }
    const resolvedBy = definition.columns['resolved by'];
    if (!resolvedBy) {
      issues.push({
        severity: 'error',
        code: 'closed_oq_without_resolution',
        file: definition.file,
        line: definition.line,
        message: `${definition.id} is closed but has no resolved by field`,
      });
      continue;
    }
    const { ids } = parseCanonicalIdList(resolvedBy);
    const hasDecision = ids.some((id) => id.startsWith('DEC-') && definitionsById.has(id));
    if (!hasDecision) {
      issues.push({
        severity: 'error',
        code: 'closed_oq_without_decision',
        file: definition.file,
        line: definition.line,
        message: `${definition.id} is closed but does not resolve to a canonical DEC`,
      });
    }
  }
}

function validateReverseEdges(traceabilityMatrix, issues) {
  const index = new Set(traceabilityMatrix.map((edge) => `${edge.source_id}|${edge.target_id}`));
  for (const edge of traceabilityMatrix) {
    if (edge.target_id.startsWith('SPEC-') || edge.target_id.startsWith('RT-')) {
      continue;
    }
    if (!index.has(`${edge.target_id}|${edge.source_id}`)) {
      issues.push({
        severity: 'error',
        code: 'missing_reverse_edge',
        file: edge.source_file,
        line: edge.source_line,
        message: `traceability edge ${edge.source_id} -> ${edge.target_id} is missing reverse edge`,
      });
    }
  }
}

function collectExpandedSourceIds(fieldInventory, ownerId) {
  const relevantEntries = fieldInventory.filter(
    (entry) => entry.ownerId === ownerId && entry.field === 'Source IDs',
  );
  return {
    declaredSourceIds: [...new Set(relevantEntries.map((entry) => entry.rawId))].sort(sortIds),
    expandedSourceIds: [...new Set(relevantEntries.flatMap((entry) => entry.targetIds))].sort(sortIds),
    expansions: relevantEntries.map((entry) => ({
      field: entry.field,
      declared_id: entry.rawId,
      expanded_ids: entry.targetIds,
    })),
  };
}

export async function analyzeRepository(repoRoot = getRepoRoot()) {
  const markdownFiles = [];
  for (const directory of SPEC_DIRS) {
    const absoluteDirectory = path.join(repoRoot, directory);
    const entries = await fs.readdir(absoluteDirectory);
    for (const entry of entries.filter((fileName) => fileName.endsWith('.md')).sort()) {
      markdownFiles.push(await readMarkdownFile(repoRoot, path.join(directory, entry)));
    }
  }

  const { definitions, duplicateDefinitions } = buildDefinitions(markdownFiles);
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
  const issues = [];

  const requirementRegister = buildRequirementRegister(definitions);
  const requirementRegisterMap = buildRequirementRegisterMap(requirementRegister);
  const requirementTraceabilitySidecar = await loadRequirementTraceabilitySidecar(repoRoot, issues);

  validateDuplicateDefinitions(duplicateDefinitions, issues);
  validateReqPrefixOwnership(requirementRegister, issues);

  const rawReferences = buildRawReferenceInventory(markdownFiles);
  validateRawReferences(rawReferences, definitionsById, requirementRegisterMap, issues);
  validateProhibitedAuthorityLinks(markdownFiles, issues);
  validateClosedOpenQuestions(definitions, issues, definitionsById);

  const requirementTraceabilityEntries = validateRequirementTraceabilityEntries(
    requirementTraceabilitySidecar,
    requirementRegister,
    definitionsById,
    issues,
  );

  const fieldInventory = buildFieldReferenceInventory(
    definitions,
    issues,
    definitionsById,
    requirementRegisterMap,
  );
  const traceabilityMatrix = buildTraceabilityMatrix(
    definitions,
    definitionsById,
    fieldInventory,
    requirementTraceabilityEntries,
  );
  validateReverseEdges(traceabilityMatrix, issues);

  let matrixRouteCatalog = [];
  try {
    matrixRouteCatalog = await extractMatrixRouteCatalog(repoRoot);
  } catch (error) {
    issues.push({
      severity: 'error',
      code: 'matrix_route_catalog_unavailable',
      file: 'research/sources',
      line: 1,
      message: `Pinned Matrix v1.17 route catalog could not be loaded: ${error.message}`,
    });
  }
  const wildcardRouteExpansion = buildWildcardRouteExpansion(definitions, matrixRouteCatalog, issues);
  const expandedSourceIds = collectExpandedSourceIds(fieldInventory, 'EVID-GOV-001');

  await validateCloudflareSnapshots(repoRoot, definitions, issues);
  await validateSourceObservationRegister(repoRoot, markdownFiles, issues);

  const summary = {
    repo_root: repoRoot,
    definition_counts: Object.fromEntries(
      CANONICAL_PREFIXES.map((prefix) => [
        prefix,
        definitions.filter((definition) => definition.type === prefix).length,
      ]),
    ),
    requirement_register_count: requirementRegister.length,
    traceability_edge_count: traceabilityMatrix.length,
    wildcard_route_family_count: wildcardRouteExpansion.length,
    expanded_source_ids_count: expandedSourceIds.expandedSourceIds.length,
    issue_count: issues.length,
  };

  return {
    repoRoot,
    files: markdownFiles.map((file) => ({
      relativePath: file.relativePath,
      documentStatus: file.documentStatus,
      specNumber: file.specNumber,
    })),
    definitions,
    definitionsById,
    rawReferences,
    fieldInventory,
    requirementRegister,
    requirementRegisterMap,
    requirementTraceabilitySidecar,
    requirementTraceabilityEntries,
    traceabilityMatrix,
    wildcardRouteExpansion,
    matrixRouteCatalog,
    expandedSourceIds,
    issues: issues.sort((a, b) => {
      if (a.file !== b.file) {
        return a.file.localeCompare(b.file);
      }
      return a.line - b.line;
    }),
    valid: issues.length === 0,
    summary,
  };
}

function stringifyIssue(issue) {
  return `${issue.file}:${issue.line} [${issue.code}] ${issue.message}`;
}

export function formatCheckReport(analysis) {
  const lines = [
    `Governance check: ${analysis.valid ? 'PASS' : 'FAIL'}`,
    `Definitions: ${JSON.stringify(analysis.summary.definition_counts)}`,
    `Requirement register rows: ${analysis.summary.requirement_register_count}`,
    `Traceability edges: ${analysis.summary.traceability_edge_count}`,
    `Expanded source IDs: ${analysis.summary.expanded_source_ids_count}`,
    `Wildcard route families: ${analysis.summary.wildcard_route_family_count}`,
    `Issues: ${analysis.summary.issue_count}`,
  ];
  if (analysis.issues.length > 0) {
    lines.push('');
    lines.push('Issues:');
    for (const issue of analysis.issues) {
      lines.push(`- ${stringifyIssue(issue)}`);
    }
  }
  return lines.join('\n');
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

export async function writeGovernanceEvidence(repoRoot = getRepoRoot(), options = {}) {
  const analysis = await analyzeRepository(repoRoot);
  const runTimestamp = resolveEvidenceRunTimestamp(options.timestamp ?? null);
  const evidenceRoot = path.join(repoRoot, 'evidence/common/EVID-GOV-001', runTimestamp);
  const artifactsDir = path.join(evidenceRoot, 'artifacts');
  const generatedAt = new Date().toISOString();
  const codeVersion = await collectCodeVersionContext(repoRoot);
  const dataVersion = collectDataVersionContext(analysis);

  await reserveFreshOutputPaths([evidenceRoot], {
    label: `Governance evidence output paths for run ${runTimestamp}`,
  });
  await fs.mkdir(artifactsDir, { recursive: true });

  const requirementRegisterCsvRows = analysis.requirementRegister.map((row) => ({
    ...row,
    source_line: String(row.source_line),
  }));
  const traceabilityCsvRows = analysis.traceabilityMatrix.map((row) => ({
    ...row,
    source_line: String(row.source_line),
  }));
  const wildcardCsvRows = analysis.wildcardRouteExpansion.map((row) => ({
    if_id: row.if_id,
    source_file: row.source_file,
    source_line: String(row.source_line),
    route_pattern: row.route_pattern,
    methods: row.methods,
    expanded_paths: row.expanded_paths.join(' | '),
    expanded_routes: row.expanded_routes.join(' | '),
  }));

  await Promise.all([
    fs.writeFile(
      path.join(artifactsDir, 'requirement-register.json'),
      stableJson({
        generated_at: generatedAt,
        row_count: analysis.requirementRegister.length,
        rows: analysis.requirementRegister,
      }),
    ),
    fs.writeFile(
      path.join(artifactsDir, 'requirement-register.csv'),
      toCsv(requirementRegisterCsvRows, [
        'req_id',
        'owning_spec',
        'title',
        'normative_statement',
        'source_file',
        'source_line',
        'status',
      ]),
    ),
    fs.writeFile(
      path.join(artifactsDir, 'traceability-matrix.json'),
      stableJson({
        generated_at: generatedAt,
        row_count: analysis.traceabilityMatrix.length,
        rows: analysis.traceabilityMatrix,
      }),
    ),
    fs.writeFile(
      path.join(artifactsDir, 'traceability-matrix.csv'),
      toCsv(traceabilityCsvRows, [
        'source_id',
        'source_type',
        'target_id',
        'target_type',
        'link_reason',
        'owning_spec',
        'status',
        'source_file',
        'source_line',
      ]),
    ),
    fs.writeFile(
      path.join(artifactsDir, 'expanded-source-ids.json'),
      stableJson({
        generated_at: generatedAt,
        declared_source_ids: analysis.expandedSourceIds.declaredSourceIds,
        expanded_source_ids: analysis.expandedSourceIds.expandedSourceIds,
        expansions: analysis.expandedSourceIds.expansions,
      }),
    ),
    fs.writeFile(
      path.join(artifactsDir, 'wildcard-route-expansion.json'),
      stableJson({
        generated_at: generatedAt,
        row_count: analysis.wildcardRouteExpansion.length,
        rows: analysis.wildcardRouteExpansion,
      }),
    ),
    fs.writeFile(
      path.join(artifactsDir, 'wildcard-route-expansion.csv'),
      toCsv(wildcardCsvRows, [
        'if_id',
        'source_file',
        'source_line',
        'route_pattern',
        'methods',
        'expanded_paths',
        'expanded_routes',
      ]),
    ),
    fs.writeFile(
      path.join(artifactsDir, 'governance-summary.json'),
      stableJson({
        generated_at: generatedAt,
        valid: analysis.valid,
        code_version: codeVersion,
        data_version: dataVersion,
        summary: analysis.summary,
        expanded_source_ids: analysis.expandedSourceIds,
        issues: analysis.issues,
      }),
    ),
  ]);

  const summaryLines = [
    '# EVID-GOV-001 Summary',
    '',
    `- status: ${analysis.valid ? 'pass' : 'fail'}`,
    `- generated_at: ${generatedAt}`,
    `- run_ts: ${runTimestamp}`,
    `- repo_root: ${normalizePath(repoRoot)}`,
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
    '',
    '## Scope',
    '',
    `- declared_source_ids: ${analysis.expandedSourceIds.declaredSourceIds.map((id) => `\`${id}\``).join(',')}`,
    `- expanded_source_ids_count: ${analysis.expandedSourceIds.expandedSourceIds.length}`,
    '- expanded_source_ids_artifact: `artifacts/expanded-source-ids.json`',
    '',
    '## Artifacts',
    '',
    '- `artifacts/requirement-register.csv`',
    '- `artifacts/requirement-register.json`',
    '- `artifacts/traceability-matrix.csv`',
    '- `artifacts/traceability-matrix.json`',
    '- `artifacts/expanded-source-ids.json`',
    '- `artifacts/wildcard-route-expansion.csv`',
    '- `artifacts/wildcard-route-expansion.json`',
    '- `artifacts/governance-summary.json`',
    '',
    '## Summary',
    '',
    `- definition_counts: ${JSON.stringify(analysis.summary.definition_counts)}`,
    `- requirement_register_count: ${analysis.summary.requirement_register_count}`,
    `- traceability_edge_count: ${analysis.summary.traceability_edge_count}`,
    `- expanded_source_ids_count: ${analysis.summary.expanded_source_ids_count}`,
    `- wildcard_route_family_count: ${analysis.summary.wildcard_route_family_count}`,
    `- issue_count: ${analysis.summary.issue_count}`,
  ];

  summaryLines.push('');
  summaryLines.push('## Expanded Source IDs');
  summaryLines.push('');
  summaryLines.push(
    analysis.expandedSourceIds.expandedSourceIds.map((id) => `- \`${id}\``).join('\n'),
  );

  if (analysis.issues.length > 0) {
    summaryLines.push('');
    summaryLines.push('## Issues');
    summaryLines.push('');
    for (const issue of analysis.issues) {
      summaryLines.push(`- ${stringifyIssue(issue)}`);
    }
  }

  await fs.writeFile(path.join(evidenceRoot, 'summary.md'), summaryLines.join('\n') + '\n');

  return {
    analysis,
    runTimestamp,
    evidenceRoot,
    artifactsDir,
  };
}

export async function ensureParentDirectories(repoRoot = getRepoRoot()) {
  const directories = [
    'apps/gateway-worker',
    'apps/jobs-worker',
    'apps/ops-worker',
    'packages/runtime-core',
    'packages/contracts',
    'packages/testing',
    'tests/local/spec-tools',
    'tests/integration',
    'tests/staging',
    'ops',
    'evidence/common/EVID-GOV-001',
  ];
  await Promise.all(directories.map((directory) => fs.mkdir(path.join(repoRoot, directory), { recursive: true })));
}
