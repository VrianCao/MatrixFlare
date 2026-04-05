Source: https://developers.cloudflare.com/api/resources/billing/subresources/usage/
Observed: 2026-04-05

Relevant official facts captured for Phase 08 cost evidence:

* `GET /accounts/{account_id}/billing/usage/paygo` returns billable usage data for PayGo self-serve accounts.
* When no query parameters are provided, the endpoint returns usage for the current billing period.
* The endpoint is currently marked beta and access is restricted to select accounts.
* Date-range query parameters are `from` and `to`.

Implication for repo contracts:

* `prod-cost-monthly` must fail closed when the target account cannot use this endpoint.
* Successful production cost capture still requires an account with real PayGo usage API access.
