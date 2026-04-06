export const CLIENT_DISCOVERY_VERSIONS = Object.freeze([
  'r0.6.1',
  'v1.1',
  'v1.2',
  'v1.3',
  'v1.4',
  'v1.5',
  'v1.6',
  'v1.7',
  'v1.8',
  'v1.9',
  'v1.10',
  'v1.11',
  'v1.12',
  'v1.13',
  'v1.14',
  'v1.15',
  'v1.16',
  'v1.17',
]);

export const CLIENT_DISCOVERY_VERSION_COUNT = CLIENT_DISCOVERY_VERSIONS.length;
export const CLIENT_DISCOVERY_BROWSER_ORIGIN = 'https://app.element.io';

export function matchesClientDiscoveryVersionLadder(versions) {
  return Array.isArray(versions)
    && versions.length === CLIENT_DISCOVERY_VERSIONS.length
    && versions.every((value, index) => value === CLIENT_DISCOVERY_VERSIONS[index]);
}

export function hasClientDiscoveryBrowserCors(response, expectedOrigin = CLIENT_DISCOVERY_BROWSER_ORIGIN) {
  const allowOrigin = response?.headers?.get?.('access-control-allow-origin') ?? null;
  const vary = response?.headers?.get?.('vary') ?? '';
  return allowOrigin === expectedOrigin && /\bOrigin\b/iu.test(vary);
}

export function summarizeClientDiscoveryVersionPayload(payload) {
  return {
    versions_count: Array.isArray(payload?.versions) ? payload.versions.length : 0,
    browser_compatible_version_ladder: matchesClientDiscoveryVersionLadder(payload?.versions),
  };
}
