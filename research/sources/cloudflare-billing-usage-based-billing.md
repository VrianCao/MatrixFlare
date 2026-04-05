Source: https://developers.cloudflare.com/billing/usage-based-billing/
Observed: 2026-04-05

Relevant official facts captured for Phase 08 cost evidence:

* Usage-based billing is charged for the previous billing period, not necessarily the previous calendar month.
* Cloudflare's example states that if the billing date is March 15, the April 15 invoice covers usage between March 16 and April 15.
* The page explicitly says the monthly invoice is the most reliable source for billing information.

Implication for repo contracts:

* `prod-cost-monthly` cannot assume the previous calendar month is the truthful closed production billing window.
* Any automated monthly snapshot must first resolve the account's actual closed billing period.
