# CRM integration — confirmed facts and derived rules

Source: discovery report from the CRM codebase, 2026-08-05, with file:line citations.
Update this document whenever the CRM changes.

---

## Confirmed API behaviour

| Area | Reality |
|---|---|
| Create lead | Lands at stage `created` automatically. Stage cannot be set on create — and does not need to be, per R5 |
| Assignment | `assigned_agent_id` is on the create schema → assign in the same call, no second request |
| Update | `PUT /leads/{id}` uses `exclude_unset=True` — a genuine partial patch despite the verb |
| Notes | `POST /leads/{id}/remarks` — separate append-only table, validated 1–5000 chars |
| Phone dedup | Enforced at two layers, scoped per tenant |
| Stages | 29 values (not 23 as the code comment and ARCHITECTURE.md claim). We only ever use `created` |
| Tenancy | Multi-tenant — dedup and scoping are per tenant |

---

## Derived rules — these override earlier assumptions

**C1 — Notes means `POST /leads/{id}/remarks`. Never `lead.notes`.**

`lead.notes` is **destructive on write**, and the AI post-call pipeline appends to
that same column. Writing our WhatsApp notes there would silently destroy the voice
pipeline's data — damage outside this project, in a system nobody would think to
check.

R9 and R11.1–R11.6 all say "append to Notes". Every one of them means the
**remarks endpoint**. This is the single most important line in this document.

**C2 — Never write `custom_fields` or `tags` on update.**

Both are replace-not-merge on PUT (a plain `setattr` loop). Patching `custom_fields`
wipes every other key in it, including the `ai_last_call` block the voice pipeline
writes. If we ever genuinely need to write there, it must be read-modify-write —
but the default is: do not touch these.

**C3 — The bot never patches `phone`.**

`normalize_phone` runs on create but **not** on update, so patching a phone bypasses
normalisation and would leave an unnormalised value in the identity field. Phone is
the lead's identity; it is set once at create and never modified by us.

**C4 — Authenticate as a dedicated admin account, and always send
`assigned_agent_id`.**

There is an auto-own rule: if the caller is a manager and `assigned_agent_id` is
omitted, that manager silently becomes the counsellor. Two consequences:

- Use an **admin** account, not a manager account
- **Always** send `assigned_agent_id` explicitly, never rely on a default

Admin scope is also required for search, which is silently scoped down for
non-admin roles — as a non-admin we would get partial results with no error.

**C5 — Search is substring, not exact. Treat multiple results as ambiguous.**

Only `GET /leads/search?q=` exists — substring ILIKE. A full phone number is a
reasonably safe query, but the endpoint can still return several rows. Rule: if a
phone search returns more than one lead, do not guess — hold it for human review.

---

## Additional derived rules

**C6 — Authenticate with `X-API-Key`. The key resolves to a service-account
profile.**

Resolved inside `get_current_user`, so it works on every authenticated route and
routes added later inherit it — nothing to wire for Way 2. Scope follows the
profile's role; ours is admin, which gives the unscoped search C5 requires.

Attribution is automatic: `leads.created_by`, `lead_remarks.author_id` and
`lead_stage_logs.changed_by` are all FKs to `profiles.id`, so our writes are
identifiable as the integration's rather than a person's. Verified live — a test
remark came back authored by "WhatsApp Ingest Service".

The key **cannot delete**: `ApiKeyDeleteGuardMiddleware` rejects any DELETE carrying
the header before routing, before auth, before any DB work. Global, so future DELETE
routes are covered automatically. It also cannot mint or manage keys.

**C15 — A message id goes in a field, never inside the note text.**

`POST /leads/{id}/remarks` takes only `body`, so the originating WhatsApp message
id was once appended to the text as `[wa:3EB023…]`. That put machine bookkeeping
into something counsellors read all day, and truncation ran after stamping — so
the longest notes, the ones most worth tracing, were exactly the ones that lost
it.

We now send `wa_message_id` as a sibling field. Unknown keys are ignored (C10), so
it is inert until they add the column. `addBankMessage` already works this way and
that endpoint is idempotent on it — remarks should match. Requested in Prompt 6.

**C7 — Read `loan_amount`, never `loan_amount_lakh`.**

`loan_amount_lakh` is write-only: it stores correctly but is absent from `LeadOut`,
so it never comes back in a response. Reading it would always yield nothing.

**C8 — The test tenant is a sandbox for API shape, not a safety net.**

It is a separate *tenant*, not a separate database — it lives inside the FMC
production Supabase project. Isolation rests entirely on `company_id` scoping, which
is applied consistently but has **zero dedicated tests** (their backlog item #7).

Consequences for how we test:
- Fine for validating request/response shape and integration logic
- **Not** protection against a bug in tenant scoping itself
- Never run bulk or destructive operations against it
- Every test lead we create should be obviously identifiable as test data

Real staging remains their backlog item #14.

---

## Blocker status

**B1 — machine credential: RESOLVED**, pending deploy. See C6.

**B2 — duplicate error: RESOLVED.** The 400 body now carries `existing_lead_id`,
`existing_lead_name`, `error_code` and `duplicate_field`. `detail` was deliberately
left byte-identical for the frontend. This is exactly the cheap fix we asked for and
it fully closes the retry problem: "already exists" now converts to "update that
lead" in one hop, with no ambiguous search.

```json
{
  "detail": "A lead with phone +919812345678 already exists (Rohit Verma).",
  "error_code": "duplicate_lead",
  "duplicate_field": "phone",
  "existing_lead_id": "c964c6c3-3df1-4774-b596-35e6965e25d6",
  "existing_lead_name": "Rohit Verma"
}
```

**B3 — staging: PARTIALLY RESOLVED.** Test tenant exists; see C8 for its limits.

---

## Open risks on the CRM side

**Not deployed.** The code is in their working tree, uncommitted. The migration
`g7b8c9d0e1f2` (additive `CREATE TABLE api_keys`) *was* applied to the FMC
production database, so the table exists in production while the code does not.
**The API key will not authenticate against the live URL until they deploy.**
Additive-only, so the split state is safe — but we cannot integrate until deploy.

**Phone normalisation and dedup are missing on update.** `normalize_phone` runs only
on create; `update_lead` is a plain `setattr` loop with no normalisation and no
duplicate check. Both failure paths are reachable from the existing CRM edit form:

- Editing a phone to `07004428198` when `+917004428198` exists stores it raw. No
  index collision, because the strings differ — **two live leads for the same
  person, and the dedup we rely on is silently defeated.**
- Editing it to an exact existing match raises an uncaught `IntegrityError` → 500,
  leaking `error_type`/`error_message` through the generic handler.

This matters to us directly: our entire identity model assumes one lead per phone.
A counsellor editing a phone in the UI can break that assumption without anyone
noticing. **Asked them to fix it** — two lines plus a test, per their estimate.

**401 replaces 403 for absent credentials.** Correct behaviour, but if anything in
CRM-UI branches on "403 means no token", it needs checking.

---

## Superseded blockers

### B1 — No machine credential *(blocking)*

Every lead endpoint requires a Supabase **user** JWT expiring in about an hour.
There is no API key, no service account, no client-credentials flow.
`X-Internal-Secret` exists but is wired to two endpoints, and the website one only
writes a review-queue row — it cannot create a lead, set a stage, or assign anyone.

*Our position:* a 24/7 service holding a human's password is the wrong shape — it
cannot be revoked without locking out a person, and its writes are indistinguishable
from that person's in any audit trail.

**Ask:** a service account with admin scope and a non-expiring, revocable
credential.

**Interim if that's slow:** a dedicated admin user created solely for this
integration — never used by a human — whose refresh token we rotate. Ugly but
workable, and it at least keeps the audit trail clean.

### B2 — No idempotency, and the duplicate error omits the lead ID *(blocking)*

If the network drops after the CRM commits but before we get the response, we retry:

- Lead has **neither phone nor email** → duplicate created
- Lead has **one of them** → `400 already exists`, but **the error body does not
  include the existing lead's `id`**

That second case is the real problem. We cannot pivot from "already exists" to
"update that lead" in one hop, because we are not told which lead it is. We would
have to fall back to substring search — which is ambiguous per C5.

**Ask, in order of preference:**

1. **Include the existing lead's `id` in the duplicate error body.** Cheapest
   possible fix, and it fully resolves this for us.
2. An `Idempotency-Key` header on create.
3. `GET /leads/by-phone?phone=` — exact lookup, not substring.

Any one of these closes it. The first is a few lines.

*Our own mitigation regardless:* record the outbound attempt locally **before**
calling the CRM, so a crash mid-request is recoverable and never silently retried
into a duplicate.

### B3 — No staging, no local database *(blocking for safe development)*

A single `supabase_db_url`, no docker-compose, no SQLite fallback — running locally
points at real Supabase. Both Railway deployments are production. Staging is item
#14 on the CRM's own backlog.

*We will be creating dozens of throwaway leads while building this.* Those must not
land in live data your team is working.

**Ask:** since the CRM is already multi-tenant with per-tenant scoping, **a
dedicated test tenant** would give us isolation without waiting for real staging.
Far cheaper than backlog item #14 and solves our actual problem.

---

## Field mapping — still outstanding

The report covers the API's shape. We still need the **Lead field list** — exact
names, types, and the allowed values for every enum — to implement R11.2 (label
aliases) and R11.5 (unknown labels to remarks). Without it we cannot decide which
labels map to which fields.

---

## Confirmed 2026-08-05 (second delivery)

**Create returns the lead ID — confirmed with a real response.** `POST /leads` →
201, body is the full `LeadOut` including `id` (UUID) and `serial_no` (per-tenant
human-readable number, useful when quoting a lead to staff). This was the one
structural requirement; it is satisfied.

**User list — `GET /api/v1/users`.** Bare JSON array, not paginated or wrapped,
scoped to our company, admin-only (our key has admin scope). Optional `?role=` and
`?is_active=` filters. `id` is what goes in `assigned_agent_id`.

**C9 — The employee map cannot be built from CRM data alone.** `users.phone` is
optional and frequently null in live data. So the map is: seed names and emails
from `GET /users`, then enter each employee's **WhatsApp number by hand** in our
panel. This answers Q4 — a hybrid, not a pure sync.

**C10 — A 201 is not proof the data landed.** Unknown keys are silently ignored on
create, so a typo'd field name returns success with the value dropped. Every
outgoing payload is validated against the accepted-field list before sending.

**C11 — `loan_amount` and `bank_name` are update-only.** Sent to create, they are
silently dropped. Capturing a loan amount from the first message therefore requires
`POST /leads` then `PUT /leads/{id}` — two calls, and a failure of the second must
be retried, not swallowed.

**C12 — Over-length input returns 500, not 422.** DB lengths are not mirrored in
Pydantic. Truncate client-side: `loan_amount` 50, `bank_name` 100.

**C13 — `assigned_agent_id` is not validated; a bad UUID 500s at the FK.** Always
resolve against the cached user list before sending.

**C14 — Phone normalisation covers Indian formats only.**
*(Amended 2026-09-02: we now send overseas numbers anyway — see below.)* `0091…`, `91…`, `0…` and
bare 10-digit all become `+91…`. Anything else is stored verbatim after a strip —
so non-Indian numbers, extensions, and text like "98765 43210 call after 6" will
not dedupe against their normalised form. Our extractor must therefore emit clean
digits, never raw message fragments.

**Remarks validation is clean:** 1–5000 chars, proper 422. Attributed to whoever
the credential is.

### Still not deployed

`git push` was blocked by a permission classifier on their side. Commit `342e7c9`
(18 files) exists locally but is not pushed, so Railway has not deployed and the
API key still does not authenticate against the production URL. Owner must either
grant the push permission or run `git push origin main`.

### Offered, not yet accepted

`create_lead`'s email check is exact-match while the index is `lower(email)`, so
creating `Foo@x.com` when `foo@x.com` exists returns 500. Same class of bug as the
update one they just fixed. One line. **Recommend accepting** — we may write emails
from WhatsApp messages, and a 500 is indistinguishable from a real outage to a
retry loop.


---

## Amendment, 2026-09-02 — C14 revisited

C14 said our extractor must emit clean Indian digits only, because the CRM stores
anything else verbatim and it would never dedupe against its normalised form.
That rule cost a real lead: a Kuwait number posted in the group twice, read as
"not a lead" both times, dropped in silence.

**We now send overseas numbers** when they carry an explicit `+` and country
code. The dedup caveat in C14 is still true and is accepted deliberately: an
overseas lead deduplicates against an identical string, but `+96569950748` and
`0096569950748` are two records to the CRM. Since the bot always writes the same
normalised `+<digits>` form, the exposure is to a human typing the number
differently in the CRM UI — the same class of risk their missing update-path
normalisation already creates for Indian numbers.

Worth asking the CRM team to extend `normalize_phone` beyond India. Until then
this is the better trade: a weaker dedup guarantee on overseas leads against
losing them entirely.
