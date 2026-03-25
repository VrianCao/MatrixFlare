# Cloudflare Access Service Tokens Snapshot

Source URL: `https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/`
Observed date: `2026-03-25`

## Key facts captured

* Access service tokens consist of `Client ID` plus `Client Secret`.
* Automated callers send these credentials to the Access edge, typically using `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
* After a valid initial request, Access can mint a JWT scoped to the application as `CF_Authorization`.
* If the Access application has only `Service Auth` policies, callers must continue sending the service token on every subsequent request; a cached JWT alone is not sufficient.
* Applications can optionally read service token credentials from a single configured header, but this still authenticates to Access edge rather than directly to the origin application.
