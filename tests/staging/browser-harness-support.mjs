import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

import {
  ELEMENT_WEB_RELEASE,
} from './browser-e2e-support.mjs';

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizePathForPosix(value) {
  return String(value).replaceAll(path.sep, '/');
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true });
  return directoryPath;
}

async function extractTarball(options) {
  let tarModule;
  try {
    tarModule = await import('tar');
  } catch (error) {
    const missingDependencyError = new Error(
      'ensureElementWebBundle requires the optional devDependency "tar" when bundle extraction is needed',
    );
    missingDependencyError.cause = error;
    throw missingDependencyError;
  }
  await tarModule.x(options);
}

async function downloadElementWebTarball(tarballPath) {
  const response = await fetch(ELEMENT_WEB_RELEASE.source_uri);
  if (!response.ok) {
    throw new Error(`Unable to download Element Web bundle: ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256Hex(bytes);
  if (digest !== ELEMENT_WEB_RELEASE.sha256) {
    throw new Error(`Element Web bundle sha256 mismatch: expected ${ELEMENT_WEB_RELEASE.sha256}, received ${digest}`);
  }
  await fs.writeFile(tarballPath, bytes);
  return {
    tarball_path: tarballPath,
    sha256: digest,
    byte_length: bytes.length,
  };
}

async function readBundleManifest(manifestPath) {
  try {
    return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

async function findElementWebRoot(extractionRoot) {
  const directIndex = path.join(extractionRoot, 'index.html');
  if (await pathExists(directIndex)) {
    return extractionRoot;
  }
  const entries = await fs.readdir(extractionRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(extractionRoot, entry.name);
    if (await pathExists(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }
  throw new Error(`Unable to locate extracted Element Web root under ${extractionRoot}`);
}

export async function ensureElementWebBundle(cacheRoot = path.join(process.cwd(), '.tmp/element-web-cache')) {
  const normalizedCacheRoot = path.resolve(cacheRoot);
  const bundleRoot = path.join(normalizedCacheRoot, `element-web-${ELEMENT_WEB_RELEASE.version}`);
  const tarballPath = path.join(bundleRoot, path.basename(ELEMENT_WEB_RELEASE.source_uri));
  const extractionRoot = path.join(bundleRoot, 'extracted');
  const manifestPath = path.join(bundleRoot, 'bundle-manifest.json');

  await ensureDirectory(bundleRoot);
  const existingManifest = await readBundleManifest(manifestPath);
  let tarballValid = false;
  if (await pathExists(tarballPath)) {
    const tarballBytes = await fs.readFile(tarballPath);
    tarballValid = sha256Hex(tarballBytes) === ELEMENT_WEB_RELEASE.sha256;
  }
  if (!tarballValid) {
    await downloadElementWebTarball(tarballPath);
  }

  let extractedManifestMatches = false;
  if (existingManifest?.version === ELEMENT_WEB_RELEASE.version && existingManifest?.sha256 === ELEMENT_WEB_RELEASE.sha256) {
    const existingWebRoot = isNonEmptyString(existingManifest.web_root)
      ? path.resolve(bundleRoot, existingManifest.web_root)
      : null;
    extractedManifestMatches = existingWebRoot != null && await pathExists(path.join(existingWebRoot, 'index.html'));
  }

  if (!extractedManifestMatches) {
    await fs.rm(extractionRoot, { recursive: true, force: true });
    await ensureDirectory(extractionRoot);
    await extractTarball({
      file: tarballPath,
      cwd: extractionRoot,
      preservePaths: false,
      strict: true,
    });
    const webRoot = await findElementWebRoot(extractionRoot);
    const manifest = {
      version: ELEMENT_WEB_RELEASE.version,
      source_uri: ELEMENT_WEB_RELEASE.source_uri,
      sha256: ELEMENT_WEB_RELEASE.sha256,
      web_root: normalizePathForPosix(path.relative(bundleRoot, webRoot)),
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }

  const manifest = await readBundleManifest(manifestPath);
  const webRoot = path.resolve(bundleRoot, manifest.web_root);
  return Object.freeze({
    cache_root: normalizedCacheRoot,
    bundle_root: bundleRoot,
    tarball_path: tarballPath,
    extraction_root: extractionRoot,
    web_root: webRoot,
    version: ELEMENT_WEB_RELEASE.version,
    source_uri: ELEMENT_WEB_RELEASE.source_uri,
    sha256: ELEMENT_WEB_RELEASE.sha256,
  });
}

export function buildElementWebConfig({
  homeserverBaseUrl,
  serverName,
  brand = 'MatrixFlare Browser E2E',
  forceVerification = true,
} = {}) {
  if (!isNonEmptyString(homeserverBaseUrl) || !isNonEmptyString(serverName)) {
    throw new TypeError('buildElementWebConfig requires homeserverBaseUrl and serverName');
  }
  return Object.freeze({
    default_server_config: {
      'm.homeserver': {
        base_url: homeserverBaseUrl,
        server_name: serverName,
      },
    },
    disable_custom_urls: false,
    disable_guests: true,
    disable_3pid_login: true,
    force_verification: forceVerification,
    brand,
    default_country_code: 'US',
    default_theme: 'light',
    default_federate: false,
    room_directory: {
      servers: [serverName],
    },
    enable_presence_by_hs_url: {
      [homeserverBaseUrl]: false,
    },
    features: {},
    setting_defaults: {
      breadcrumbs: true,
      blacklistUnverifiedDevices: false,
    },
  });
}

function resolveContentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function sanitizeRequestPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const normalized = path.posix.normalize(decoded);
  if (normalized.startsWith('../') || normalized.includes('/../')) {
    return null;
  }
  return normalized === '/' ? '/index.html' : normalized;
}

async function readStaticResponse(webRoot, pathname) {
  const sanitized = sanitizeRequestPath(pathname);
  if (sanitized == null) {
    return {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from('Forbidden', 'utf8'),
    };
  }
  let candidatePath = path.join(webRoot, sanitized);
  try {
    const stat = await fs.stat(candidatePath);
    if (stat.isDirectory()) {
      candidatePath = path.join(candidatePath, 'index.html');
    }
    return {
      status: 200,
      headers: { 'content-type': resolveContentType(candidatePath) },
      body: await fs.readFile(candidatePath),
    };
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
      throw error;
    }
  }
  const spaIndexPath = path.join(webRoot, 'index.html');
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: await fs.readFile(spaIndexPath),
  };
}

export async function startElementWebServer({
  webRoot,
  config,
  host = '127.0.0.1',
  port = 0,
} = {}) {
  if (!isNonEmptyString(webRoot)) {
    throw new TypeError('startElementWebServer requires webRoot');
  }
  const serializedConfig = Buffer.from(JSON.stringify(config, null, 2) + '\n', 'utf8');
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Method Not Allowed');
        return;
      }
      if (requestUrl.pathname === '/config.json') {
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8',
        });
        response.end(request.method === 'HEAD' ? undefined : serializedConfig);
        return;
      }
      const staticResponse = await readStaticResponse(webRoot, requestUrl.pathname);
      response.writeHead(staticResponse.status, staticResponse.headers);
      response.end(request.method === 'HEAD' ? undefined : staticResponse.body);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Unable to resolve Element Web server address');
  }
  const baseUrl = `http://${host}:${address.port}`;
  return Object.freeze({
    base_url: baseUrl,
    host,
    port: address.port,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  });
}
