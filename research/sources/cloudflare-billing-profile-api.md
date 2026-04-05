Source: https://developers.cloudflare.com/api/resources/billing/subresources/profiles/methods/get/
Observed: 2026-04-05

Relevant official facts captured for Phase 08 cost evidence:

* `GET /accounts/{account_id}/billing/profile` is an official Cloudflare API surface.
* The response includes `next_bill_date`.

Implication for repo contracts:

* `prod-cost-monthly` can use `next_bill_date` to derive the latest closed billing-period window instead of guessing the previous calendar month.
* This endpoint helps resolve billing-cycle timing only; it does not replace the PayGo usage endpoint for service-line cost records.
