# WhatsApp Lead Bot — Project Brief

Living document. Update it when a decision is made or an assumption turns out wrong.

- **Owner:** Amit Sourav
- **Status:** v2 running **as an Iconiq Energy direct-message bot**. Way 1 and
  Way 2 are built and tested but monitor no groups in production — see
  "What is actually running" below.
- **Last updated:** 2026-09-19

---

## 0. What is actually running

This distinction matters before reading anything else, because most of this
document describes machinery that is deployed but idle.

**Live:** direct messages to the bot's number. A customer writes, the fixed
three-message enquiry script answers, a CRM lead is created within seconds, every
message reaches the CRM's conversation view, and the model reads the chat for
`full_name`, `email`, `city`, `organization` and the energy sizing fields.
Verified against production logs on 2026-09-19: leads created and fields captured
throughout the day, redelivery correctly ignored, the retry worker rescuing leads
the CRM was too slow to take first time.

**Idle by design:** the number is in 7 groups and monitors **0**. No group is
marked active in the panel, so Way 1 (in-house → CRM) and Way 2 (bank groups)
capture nothing here. Turning a group on in the panel is all that is needed; the
code is unchanged and its tests pass.

**Removed from this service:** the daily loan MIS. It reports loan counsellors
against a PF target and belongs to the FundMyCampus bot. Scheduled here by
inheritance, its four configured emails were from that other tenant, so it
resolved nobody and logged an error every evening from at least 12 Sep until it
was unscheduled on 2026-09-19. `buildLoanMis` is still in `pipeline/digest.js`,
still tested, and called by nothing here.

**Still owed:** inbound messages are occasionally lost to
`Failed to decrypt message with any known session`, several times a day. Those
never reach the pipeline, so there is no `dm_messages` row, no reply, and no
`skipped_messages` record — the one place where "nothing is ever dropped" does
not currently hold.

---

## 1. The problem

Leads arrive over WhatsApp and get typed into the CRM by hand. An admin posts a
lead in the in-house group and tags the employee it belongs to; that employee
retypes it. Everything discussed afterwards — a college name, a loan amount, which
bank it went to — is retyped too, or lost.

Separately, bank groups carry a constant stream of updates about leads we already
hold. Tracking that by hand across many groups does not scale.

The bot reads both and keeps the CRM current, so nobody retypes anything.

## 2. How it works, in one paragraph

A phone number that is a member of the groups is linked to the server as a WhatsApp
"linked device". The server runs Baileys, which speaks WhatsApp's multi-device
protocol directly, and receives every message that number receives. Messages from
monitored groups are routed by the group's `purpose`: an **in-house** group creates
and updates CRM leads; a **bank** group records what that lender said about a lead
we already have. Direct messages to the number are a third path entirely — a
chatbot conversation, synced into the CRM once a day.

---

## 3. Domain rules — these are fixed

### Identity

Phone number. Indian numbers normalise to `+91XXXXXXXXXX`, matching the CRM's own
`normalize_phone` so we can predict that they will deduplicate. Overseas numbers
are accepted only when written with an explicit `+` and country code, at an E.164
length of 8–15 digits — the `+` is what stops an account number becoming a lead.
One borrower = one CRM lead, and the bot never creates a second for a number that
already exists.

**A lead needs no name.** The CRM requires `full_name`, so when none is found the
phone number stands in as the name. It is honest, searchable, and obviously
provisional; a later reply carrying `Name: Priya Sharma` replaces it.

### Way 1 — the in-house group

A message is a **new lead** when it carries both a phone number and an employee
`@mention` (R8). A real mention carries the mentioned person's number as structured
data, so assignment is exact rather than guessed.

A **reply** to a lead message updates that lead. `Field: value` writes a structured
CRM field; anything else is appended to remarks; acknowledgements are filtered
(R9, R11). One message may set several fields, and one message may list several
leads under a single tag.

The bot replies in the group — confirmations, warnings, and held-lead prompts. The
full list is `docs/BOT-MESSAGES.md`, and it sends nothing else.

### Way 2 — bank groups

Each group maps to exactly one bank, so the bot never has to work out which lender
is being discussed. A phone number in a message means that lead has been shared
with this bank; the share is recorded against the lead, and further conversation is
kept against that lead-and-bank pair. A number matching nothing is reported to our
own team, in our own group.

**The bot never posts in a bank group.** Enforced at the database level.

### What the bot never writes

`notes` (destructive, shared with the AI voice pipeline — C1) · `custom_fields` and
`tags` (replace-not-merge — C2) · `phone` on update (C3) · `current_stage` (R5 —
creation lands at `created` and the bot never advances a lead).

### Locked lists

`bank_name` — 18 values, `bank_status` — 7. Matched exactly or not written at all;
anything outside the list goes to remarks. Both live in `src/crm/fields.js`, which
is the executable form of `docs/FIELD-MAPPING.md`.

---

## 4. What we learned about WhatsApp itself

These constraints are not negotiable and shaped the design.

**There is no such thing as a bot account in a WhatsApp group.** Groups contain
phone numbers, nothing else. A "bot" is always: a real phone number that is a
member, plus software driving that number.

**The official Meta Cloud API cannot read group messages at all.** Group access is
not exposed to anyone. That locks us into a linked-device library — first
`whatsapp-web.js`, now Baileys — and is a fact about the platform, not a shortcut.

**The QR scan is one-time.** The session is written to disk and survives restarts,
reboots, and redeploys. It breaks only if: the primary phone stays offline for ~14
days, the folder is deleted, the device is logged out from the phone, or a WhatsApp
change breaks the library.

**Therefore the session folder is the single most fragile thing in the system.** Any
deploy that replaces it destroys the login and requires physical access to the
phone. On Railway it lives on a volume for exactly this reason — see `DEPLOY.md`.

**The bot only sees messages sent after its number joined a group.** No history is
backfilled. A connection can also go quiet while still reporting "open" — seen live
on 2026-08-06, eleven minutes connected and receiving nothing — so the socket is
probed by a watchdog rather than trusted, and a reconnect asks the phone to replay
from the last message we recorded.

---

## 5. Decisions

### Settled

| Decision | Choice | Why |
|----------|--------|-----|
| Platform | Linked device | Official API cannot read groups |
| Library | **Baileys** | ~100 MB against whatsapp-web.js's ~500 MB; speaks the protocol directly instead of driving headless Chrome |
| Rebuild vs patch | Full rebuild, v1 deleted | v1 had drifted from what it actually did |
| Destination | **The in-house CRM**, not a Google Sheet | We control it; a missing endpoint is a decision, not an obstacle |
| Version control | Git from commit one | v1 had none, which made the delete irreversible |
| Language | CommonJS, Node 22 | Boring and reliable on a server |
| Group identity | Permanent WhatsApp group ID | Names change; v1 broke silently when they did |
| Lead identity | Phone, normalised as the CRM does | Carried over from v1 — this part worked |
| Parsing | **Rules, not AI** | Deterministic, free, testable, and cannot corrupt a field. Structured fields are written only from explicit labels or closed vocabularies |
| Reply handling | Labelled → field, everything else → remarks | A missed lead is visible; corrupted data is not |
| Bot sending | Yes, but only in the in-house group | A lead held silently in a queue nobody checks is worthless |
| Reassignment | Allowed, but only from named numbers | It takes work off whoever had it |
| Hosting | Railway, with a volume | See `DEPLOY.md` |

### Open

**Way 2 — what a bank message *means*.** The bot records shares and conversation
today, but never sets `bank_status` and never moves a lead's stage. Interpreting
bank language is deliberately unbuilt until there are enough real messages to
design against. `docs/WAY-2-PLAN.md` carries the open questions: what happens when
the phone is unknown, whether a bank update should move the main stage, what to do
when two banks disagree, and where a rejection goes when `bank_status` has no value
for it.

**The AI assistant's scope — settled 2026-09-19.** `src/ai/` answers direct
messages using an **Iconiq Energy** product knowledge base, and that is now the
whole job of this deployment rather than a side path in a loan bot. The loan
pipeline the rest of this document describes belongs to the FundMyCampus bot, a
separate repository and a separate number; what remains of it here is deployed
but idle. Replies themselves are the fixed script (`DM_MODE=script`); the model
is used for reading fields out of a conversation.

---

## 6. What went wrong in v1 — and how v2 prevents it

| v1 problem | v2 prevention |
|-----------|---------------|
| Groups matched by exact name; a rename stopped capture silently | Matched on permanent group ID |
| Regex parser failed on real messages, 9 of 11 tests failing | Rebuilt around closed vocabularies, with tests on real message text |
| Tests asserted an `email` field the parser no longer produced | Tests are part of the definition of done |
| `email` column dead everywhere but still written as `undefined` | Schema carries only fields that exist |
| `GOOGLE_SHEET_NAME` setting ignored, `Sheet1` hardcoded everywhere | All env access via `config.js` |
| Sync failure recorded once, never retried — lead lost | Status + attempt counter, retried by the worker with backoff |
| Replies matched by exact raw-text comparison, missed on whitespace | Matched on the quoted message's WhatsApp ID |
| Redelivered messages after reconnect became duplicate rows | `wa_message_id` UNIQUE — reprocessing is a no-op |
| Messages that failed to parse vanished with no record | `skipped_messages` table with reason, visible in the panel |
| 24h phone dedupe blocked legitimate updates | Dedupe is per message id, not per phone |
| `ADMIN_PASS=changeme123` shipped and ran in production | Boot refuses to start on known default passwords |
| No git — deletion was unrecoverable | Git from commit one |
| Setup guide described a different product than the code | This document, kept current |

---

## 7. What is built

### Foundation
- `config.js` with validation; refuses known default passwords and a missing JWT secret
- `logger.js` — console, file, subscribers, mirrored into the database for the panel
- Transactional migration runner; migrations 001–004

### Connection
- Baileys client: session handling, QR **and** 8-digit pairing code, reconnect with backoff
- Liveness watchdog — the socket is probed, not trusted
- Gap recovery: after a reconnect, history is replayed from each group's watermark
- Group discovery, so mapping is picked from a real list rather than typed
- Hard send rate limit, and own-message filtering

### Way 1 — in-house → CRM
- Phone normalisation mirroring the CRM's own, including overseas numbers
- Lead detection: mention + phone, name extraction that refuses to guess, batch
  messages listing several leads, amount/institution/course inference
- Label parsing with aliases and `:` `-` `=` separators; locked-list matching
- Noise filter, matched against the whole message only
- Reply handling: field updates with before/after preserved in remarks
- Held leads (no mention, several mentions, unknown employee) surfaced in the panel
- Duplicate handling that reports where the existing lead actually stands, and holds
  rather than appends when that lead is already finished
- Retry worker with exponential backoff, covering leads and updates

### Way 2 — bank groups
- Group → bank mapping, with sending forced off
- Share recording, unknown-number notices posted to our own group
- Bank conversation captured against the lead-and-bank pair
- Retry coverage for both
- **Not built:** interpreting status language, writing `bank_status`

### Reports and commands
- Daily scheduler — a clock, not an interval, recording the day it last ran
- Morning summary: yesterday's leads by person, the untouched ones, and follow-ups due
- Daily Loan MIS: month-to-date per counsellor against a monthly PF target
- `my leads` and `help`
- Reassignment, restricted to named numbers, announcing both sides of the move

### Direct messages
- Captured both directions, and synced into the CRM once a day as one remark per chat
- Optional AI replies via OpenRouter (off by default)

### Panel
- JWT auth; connection/QR, groups, employees, banks, leads, held leads, diagnostics
- Kill switch for sending; scheduled reports runnable on demand

### Deployment
- Railway, GitHub-connected, volume-backed. `DEPLOY.md` is current.

---

## 8. Environment

- **Production:** Railway, deployed from `main` on GitHub. Volume holds the WhatsApp
  session and the database — losing it means re-linking the number by hand.
- **Local:** this repository, macOS. `npm install` first; `node_modules` is not
  committed and six test suites fail without it.
- **Only ever run one copy.** Two processes on one WhatsApp number both process
  every message and both reply.

## 9. Open questions to resolve with the owner

1. Have the CRM credentials pasted into a chat channel been rotated?
2. What should happen to a direct message that never decrypts? Today it is lost
   silently, which is the one hole in "nothing is ever dropped".
3. Do the group pipelines have a future on this number, or should Way 1 and
   Way 2 move out of this repository entirely now that it is a DM bot?

Answered: the DM assistant is this service (§5). Bank-group mapping and whether a
bank update may move a lead's stage are questions for the FundMyCampus bot, which
is where that pipeline actually runs.
