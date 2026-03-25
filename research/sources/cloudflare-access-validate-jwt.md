# Cloudflare Access Validate JWT Snapshot

Source URL: `https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/`
Observed date: `2026-03-25`

## Key facts captured

* Access sends an application token in the `Cf-Access-Jwt-Assertion` request header.
* Browser requests may also carry `CF_Authorization`, but Cloudflare recommends validating the header because the cookie is not guaranteed to be passed.
* Access signing keys are published at `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs`.
* Signing keys rotate by default about every `6` weeks; previous keys remain valid for about `7` days.
* Validators should select the certificate by JWT `kid` from the full key set instead of pinning a single current certificate.
* Worker-side validation examples use the Access team domain as issuer and validate the application AUD.
