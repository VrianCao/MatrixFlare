# Cloudflare Workers `workers.dev` Access Snapshot

Source URL: `https://developers.cloudflare.com/workers/configuration/routing/workers-dev/`
Observed date: `2026-04-02`

## Key facts captured

* Cloudflare Workers accounts include an account-owned `workers.dev` subdomain that can be used without onboarding a custom domain first.
* Cloudflare recommends production Workers use a route or custom domain instead of `workers.dev`, but `workers.dev` remains an officially supported deployment surface.
* The current `workers.dev` documentation explicitly says Cloudflare Access can be used to require visitors to authenticate before accessing `workers.dev` URLs and preview URLs.
* In the Workers dashboard, `workers.dev` exposes `Enable Cloudflare Access` and `Manage Cloudflare Access` controls.
* Disabling a Worker's `workers.dev` route does not disable preview URLs, which are managed separately.
