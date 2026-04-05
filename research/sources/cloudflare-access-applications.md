# Cloudflare Access Applications Snapshot

Source URL: `https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/`
Observed date: `2026-04-02`

## Key facts captured

* Publishing a self-hosted HTTP application with Cloudflare Access requires an active domain on Cloudflare.
* When adding a public hostname for an Access self-hosted application, the chosen domain must belong to an active zone in the current Cloudflare account.
* Cloudflare for SaaS custom hostnames are a separate input mode; otherwise the public hostname is selected from domains already active in the account.
* Access policies are deny-by-default and must be configured before end users or automation can reach the protected application.
* To protect the origin itself, the application token issued by Cloudflare Access must be validated at the origin or by Cloudflare Tunnel.
