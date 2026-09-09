# Prompts for the CRM codebase's Claude Code

Two stages. **Send Prompt 1 first.** Only send Prompt 2 once we've read the answers
and know what's actually missing.

---

## Prompt 1 — Discovery (send this now)

> We are building a service that will create and update leads in this CRM
> automatically. It reads messages from a WhatsApp group, extracts the lead, and
> writes it here — assigned to a specific employee, at the "Created" stage. Later,
> when people reply in WhatsApp with more details, it updates that same lead's
> fields.
>
> **Do not write or change any code for this task.** Read the codebase and produce a
> report. I need to know what already exists before deciding what to build.
>
> Where something does not exist, say so plainly. Do not describe what could be
> built or what would be typical — I need the current reality, and a confident
> guess is worse than "this is missing".
>
> Please produce a markdown document covering:
>
> **1. Stack and API surface**
> - Language, framework, database
> - Is there an HTTP API? Base URL in dev and in production
> - How routes are organised, and where in the repo they live
>
> **2. The Lead model**
> - Every field: exact name as the API expects it, type, required or optional
> - For any dropdown / enum / fixed-choice field, list the exact allowed values
> - Which fields are computed or system-managed and should not be written directly
> - Any validation rules (formats, lengths, uniqueness constraints)
>
> **3. The User / employee model**
> - Fields, and specifically how a user is identified — internal ID, email, or both
> - Is there an endpoint that lists users? If so, its path and response shape
>
> **4. Existing lead endpoints**
> For each of create, read, update, search — if it exists:
> - Method and path
> - Request body, with a real example
> - Response body, with a real example
> - Error responses and status codes
>
> Be explicit about which of these do **not** exist today.
>
> **5. Authentication**
> - How the API authenticates. Is there a way to issue a long-lived credential for a
>   machine client (not a human login)?
>
> **6. Stages**
> - The field name that holds the stage
> - Every possible value
> - The exact value that means "Created"
>
> **7. Assignment**
> - How a lead is linked to the employee who owns it — field name and what
>   identifier it takes
> - Can assignment be set in the same request that creates the lead, or does it
>   need a second call?
>
> **8. Duplicates**
> - Is phone number unique on a lead? What happens if we create a lead with a phone
>   that already exists — rejected, allowed, merged?
> - Is there a way to look up a lead by phone number?
>
> **9. Notes / comments**
> - Is there a notes or comments field on a lead, or a separate related table?
> - Is it append-only, or does writing replace what was there?
> - If it's a related table, what does creating an entry look like?
>
> **10. Operational details**
> - Rate limits
> - Is there a staging environment, or can the CRM be run locally? We will be
>   creating throwaway test leads and would rather not put them in production data.
> - Does create support an idempotency key? (If we retry after a network timeout, we
>   must not create the lead twice.)
>
> **11. Gaps**
> Given what we're trying to do — create a lead assigned to a user at a fixed stage,
> then patch individual fields on it later, and append notes — list what is missing
> or would need changing. Do not build any of it yet.

---

## Prompt 2 — Build (ready to send)

*Written against the discovery report of 2026-08-05.*

> Thanks — that report was exactly what we needed, and the `lead.notes` warning
> saved us from corrupting the voice pipeline's data. We'll use
> `POST /leads/{id}/remarks` throughout and leave `lead.notes` alone.
>
> Please implement the following, in this order, and nothing beyond it.
>
> **1. A machine credential (highest priority — blocks everything)**
>
> We need a service account with admin scope and a long-lived, revocable
> credential. A 24/7 integration cannot hold a human's password: it can't be
> revoked without locking out that person, and its writes would be
> indistinguishable from theirs in any audit trail.
>
> Whatever shape fits your codebase — a real API key, or extending
> `X-Internal-Secret` to the lead endpoints with proper scoping. Requirements:
> - Admin-equivalent scope (we need unscoped search — see item 3)
> - Revocable independently of any human account
> - Its writes identifiable as the integration's in any audit trail
>
> If this will take a while, tell us and we'll run on a dedicated admin user with
> token rotation in the meantime — but we'd like the real thing.
>
> **Please build the credential as a general mechanism, not wired to specific
> endpoints.** This is a first phase; a second WhatsApp capture path is being
> designed now and will likely need more of the API. We'd rather you build auth
> that works across the lead endpoints generally than have to revisit it. Note that
> `X-Internal-Secret` is currently attached to exactly two endpoints — that's the
> shape we're trying to avoid repeating.
>
> One thing we do **not** want, now or later: **delete**. The integration never
> deletes anything, and we'd like the credential to be unable to.
>
> **2. Return the existing lead's ID in the duplicate error**
>
> The smallest change with the biggest effect for us. Today a duplicate create
> returns `400 already exists` with no `id` in the body, so we can't pivot to
> updating that lead — we'd have to fall back to substring search, which is
> ambiguous.
>
> Please include the existing lead's `id` in the duplicate error response.
>
> If you'd rather solve it more thoroughly, either of these also works and we'd
> take it gladly:
> - An `Idempotency-Key` header on create
> - `GET /leads/by-phone?phone=` — exact match, not substring
>
> Any one of the three closes it. We only need one.
>
> **3. A test tenant**
>
> We'll create dozens of throwaway leads while building, and they must not land in
> live data. Since the CRM is already multi-tenant with per-tenant scoping, a
> dedicated test tenant would isolate us without waiting for real staging
> (backlog #14). Please create one and send us its credentials.
>
> **4. The Lead field list**
>
> Not code — just the reference. Every field on a lead: exact API name, type,
> required or optional, and for every enum the complete set of allowed values.
> We're mapping WhatsApp text onto these fields and need the exact strings the API
> accepts.
>
> **Please do not:**
> - Add any delete endpoint — this integration never deletes anything
> - Change `custom_fields` or `tags` semantics on our account. We know they're
>   replace-not-merge and we simply won't write to them
> - Change `lead.notes`. We're staying away from it entirely
>
> **One question:** `normalize_phone` runs on create but not on update. We don't
> intend to ever patch a phone number, so this doesn't affect us — but it looks
> like a latent bug for any other caller that does. Worth a look independently.

---

## Prompt 3 — Follow-up (send this now)

> That's a solid delivery — the `get_current_user` approach is exactly right, and
> resolving the key to a service-account profile so attribution comes for free is
> better than what we asked for. The delete guard sitting in middleware ahead of
> routing is the right place for it.
>
> Four actions, then three questions.
>
> **Actions**
>
> **1. Yes — please fix `update_lead`.** Normalise the phone and run the same
> duplicate pre-check that create uses, plus the test.
>
> This is not housekeeping for us. Our entire lead identity model is one lead per
> phone number. If a counsellor edits a phone in the UI to `07004428198` while
> `+917004428198` exists, you get two live leads for one person with no error —
> and our service then finds two leads for one phone and cannot tell which to
> update. A form your team uses daily silently breaks the assumption the whole
> integration rests on. Please fix it before we go live.
>
> **2. Please commit and deploy.** The migration is already applied to the FMC
> production database but the code isn't deployed, so `api_keys` exists in
> production while nothing reads it. The key won't authenticate against
> `be-crm-production.up.railway.app` until you deploy, which blocks us from
> integrating at all.
>
> **3. Please rotate the sandbox key.** It came through a chat channel, so treat it
> as exposed. Revoke and mint a fresh one — we'll take the new one through a
> private channel. Same for the two account passwords.
>
> **4. Please check CRM-UI for 403 handling.** Absent credentials now return 401
> instead of 403. The change is correct, but anything in the frontend branching on
> "403 means no token" will misbehave.
>
> **Questions**
>
> **5. Please paste the contents of `docs/LEAD_FIELD_REFERENCE.md`.** We have the
> path but not the file. We're mapping free text from WhatsApp onto your fields, so
> we need every field name, its type, and the complete set of allowed values for
> each enum. Without it we can't finish the mapping design.
>
> **6. Does a *successful* `POST /leads` return the new lead's `id` in the response
> body?** You confirmed the duplicate error now carries `existing_lead_id`, but the
> success path was never stated explicitly. We store that id to link the WhatsApp
> conversation to the CRM record — without it, follow-up replies can never update
> the right lead. Please confirm, with the actual success response shape.
>
> **7. Is there an endpoint that lists users/profiles** with name, email and id? We
> need to map each employee's WhatsApp number to their CRM user, and we'd rather
> read your user list than maintain a copy by hand that drifts out of date.
>
> Nothing else for now — a second WhatsApp capture path is still being designed and
> we'll come back once it's specified.

---

## Prompt 4 — Production key (send this now)

> The WhatsApp integration is working end to end against the sandbox. Leads posted
> in our internal WhatsApp group are being created in the CRM, assigned to the
> tagged employee, at stage `created`. Duplicate detection, remarks and partial
> updates all verified over the wire.
>
> We now need to point it at the **live FundMyCampus tenant**. Two things, please.
>
> **1. An API key for the live FMC company**
>
> Same shape as the sandbox key — a service account with admin scope, minted
> through `POST /api-keys`. Admin scope matters because search is silently scoped
> down for non-admin roles, and we need to look a lead up by phone reliably.
>
> Please send it through a private channel rather than chat, and give us the
> `company_id` it belongs to so we can confirm we are pointed at the right tenant
> before the first write.
>
> The delete guard, attribution and revocation you already built all carry over —
> nothing new needed there.
>
> **2. The five people below need to exist as CRM users in that tenant**
>
> Leads are assigned by tagging someone in WhatsApp, and we map each WhatsApp
> number to a CRM user. Please confirm each of these has an account, and send us
> their `profile_id`, or tell us which are missing:
>
> | Name | Email |
> |---|---|
> | Ankit Dubey | ankit@fundmycampus.com |
> | Deepak | deepak@admitverse.com |
> | Himanshu | hbhatia4216@gmail.com |
> | Rudra | fundmycampus@gmail.com |
> | Zaid | zaid@fundmycampus.com |
>
> **One question about Deepak.** His account is on Admitverse, which we understand
> is a separate tenant. If a lead in the FMC group is tagged to him, we cannot set
> `assigned_agent_id` to a user from another tenant — our client refuses it before
> sending rather than risking a foreign-key 500. What would you like us to do:
> does he have an FMC account too, should such leads be left unassigned, or should
> they be held for a human? We will hold them for review unless you say otherwise.
>
> **Two notes on what to expect once we switch over**
>
> Unlike the empty sandbox, the live tenant already contains most of these people,
> so **duplicates will be the common case, not the exception**. Our behaviour there
> is: do not create a second lead, do not change who it is assigned to, and attach
> the WhatsApp message as a remark on the existing lead. Tell us if you would
> rather we did something else.
>
> We will also be writing remarks at a steadier rate than before — one per shared
> lead, plus one per detail added in the group. All through
> `POST /leads/{id}/remarks`, never `lead.notes`.

---

## Prompt 5 — The bank-sharing grid (send when ready to start Way 2)

> We are extending the WhatsApp integration. Phase one is live and working: leads
> posted in our internal group are created in the CRM, assigned, and updated from
> replies.
>
> Phase two is about the **bank groups**. We are in a WhatsApp group for each
> lender. When our team shares a lead into one of those groups, that is us
> submitting the file to that bank — and today nothing records it. We want the CRM
> to hold that, and to show it as a grid.
>
> **What we need built**
>
> **1. A record of "this lead was shared with this bank"**
>
> One row per lead-per-bank, holding:
>
> | Field | Meaning |
> |---|---|
> | `lead_id` | the lead |
> | `bank_name` | from your existing locked list of 18 |
> | `shared_at` | when it was shared into that bank's group |
> | `shared_by` | `profile_id` of the person who shared it |
> | `source` | `whatsapp` for now |
> | `wa_group_id` | which WhatsApp group, for tracing |
>
> A lead can be shared with many banks; the same lead and bank should exist only
> once. If it is shared again, keep the original `shared_at` and record the repeat
> as a message (below) rather than creating a second row.
>
> **2. Messages attached to that lead-and-bank**
>
> After a lead is shared, people keep talking about it in that group — our team and
> the bank's staff both. We want that conversation kept against that specific
> lead-and-bank pair, not mixed into the lead's general remarks.
>
> | Field | Meaning |
> |---|---|
> | `body` | the message text |
> | `sender_phone` | WhatsApp number it came from |
> | `sender_name` | if we can resolve it |
> | `is_our_team` | true if the sender is one of our staff |
> | `wa_message_id` | WhatsApp's id, unique — so a redelivered message is a no-op |
> | `created_at` | |
>
> **3. Endpoints for the bot**
>
> - **Record a share.** Something like `POST /leads/{id}/bank-shares` taking
>   `bank_name`, `shared_by`, `shared_at`, `wa_group_id`. Idempotent on
>   (lead, bank) — a repeat must not create a second row or error.
> - **Append a message.** `POST /leads/{id}/bank-shares/{bank}/messages`, idempotent
>   on `wa_message_id`.
> - **Read the grid** — see below.
>
> Same `X-API-Key` auth as today. The bot only ever adds; it never deletes.
>
> **4. The grid page**
>
> One row per lead, one column per bank:
>
> ```
> Student name | Number | Counsellor | Stage | Loan amount | PNB | SBI | ICICI | Axis | …
> ```
>
> - A cell is **coloured** when that lead has been shared with that bank, blank
>   otherwise.
> - **Hovering a cell** shows: when it was shared, who shared it, and the messages
>   since — the conversation about that lead in that bank's group.
>
> So the grid answers, at a glance: which banks has this file gone to, and what has
> happened with each.
>
> An endpoint behind it needs to return leads with their bank shares in one call —
> a request per cell would not be usable.
>
> **Please check one thing before building**
>
> Your earlier report mentioned a `lead_banks` table, and `bank_name` / `bank_status`
> on the lead being system-managed "when lead_banks is used". If `lead_banks` already
> models a lead's relationship with a bank, **extend it rather than adding a parallel
> structure** — two places recording which bank a lead is with would drift apart, and
> we would rather fit into what exists.
>
> Tell us which way you have gone and what the final field names are.
>
> **What we are not asking for**
>
> - No changes to `bank_status`. This is about *shared with*, not the bank's decision.
> - No delete endpoints.
> - Nothing that writes `lead.notes` — we are still staying away from that column.


---

## Prompt 6 — `wa_message_id` on remarks (small)

> A small consistency request.
>
> `POST /leads/{id}/bank-shares/{bank}/messages` takes `wa_message_id` as a field
> and is idempotent on it — exactly right, and it means a retry after a timeout
> updates rather than appends.
>
> `POST /leads/{id}/remarks` has no equivalent. Because remarks are not
> idempotent either, we had been appending the id to the note text as
> `[wa:3EB023A5D59133FE445054]` so a duplicate could be identified. That is
> visible to every counsellor reading the note, so we have stopped.
>
> Please could you:
>
> 1. **Accept and store `wa_message_id` on a remark.** We are already sending it
>    as a field; it is currently ignored, so nothing breaks either way.
> 2. **Make the endpoint idempotent on it**, matching the bank-share message
>    endpoint — a repeat with the same id should not create a second remark.
>
> No response shape change needed, and nothing else about remarks should move.
