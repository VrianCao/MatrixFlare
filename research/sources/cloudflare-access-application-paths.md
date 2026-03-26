# Cloudflare Access Application Paths Snapshot

Source URL: `https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/`
Observed date: `2026-03-26`

## Key facts captured

* Cloudflare Access application paths do not support port numbers in protected URLs.
* If a request URL includes a port number, Access strips that port and redirects the request to the default HTTP or HTTPS port.
* Query strings are not supported as Access application-path matching criteria.
* Access path matching is based on domain, subdomain, and path patterns, so application separation must not rely on URL ports.
