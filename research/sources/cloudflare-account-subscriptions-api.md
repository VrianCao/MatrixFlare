Source: https://developers.cloudflare.com/api/terraform/resources/accounts/subresources/subscriptions/
Observed: 2026-04-05

Relevant official facts captured for Phase 08 cost evidence:

* `GET /accounts/{account_id}/subscriptions` is an official Cloudflare API surface.
* Subscription objects expose `current_period_end`, described as the end of the current period and the next time billing is due.

Implication for repo contracts:

* When `GET /accounts/{account_id}/billing/profile` does not return `next_bill_date`, `prod-cost-monthly` can still use a unique `current_period_end` from account subscriptions as an official billing-cycle anchor.
* If subscriptions return multiple distinct `current_period_end` values or no valid anchor, production cost automation must still fail closed.
