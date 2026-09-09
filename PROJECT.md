# WhatsApp Lead Bot — Project Brief

Living document. Update it when a decision is made or an assumption turns out wrong.

- **Owner:** Amit Sourav — loan consultancy
- **Status:** v2 rebuild, foundation laid, direction not yet locked
- **Last updated:** 2026-08-05

---

## 1. The problem

Bank loan groups on WhatsApp carry a constant stream of lead updates — a name, a
phone number, and where that person stands with that bank ("login", "sanctioned",
"docs pending"). Tracking this by hand across many bank groups does not scale, and
the same borrower appears in several groups at once with a different status in each.

The bot reads those groups and keeps one Google Sheet current, so there is a single
view of every borrower and where they stand with every bank.

## 2. How it works, in one paragraph

A phone number that is a member of the bank groups is linked to the server as a
WhatsApp "linked device". The server runs headless Chrome against WhatsApp Web and
receives every message that number receives. Messages from monitored groups are
parsed into `{ name, phone, status, remark }`. The phone number identifies the
borrower; the group identifies which bank column to update. One row per borrower,
many bank columns.

---

## 3. Domain rules — these are fixed

### The sheet

One tab. Row 2 holds section labels, **row 3 holds headers, data begins at row 4.**

| Column | Contents | Written by |
|--------|----------|-----------|
| A | # (serial) | bot |
| B | Name | bot |
| C | **Phone — the unique key** | bot |
| D–J | Source, Institution, Overall Status, Loan Stage, Amount, Next Follow Up, Next Step | **user, by hand — bot must never write here** |
| K | Remarks / Notes | bot, append-only with IST timestamps |
| L onward | One column per bank | bot |

Banks currently in the sheet: PNB, SBI, Axis, ICICI, Credila, IDFC, Tata Capital,
Avanse, Zolve, Kuhoo, Auxilo, Poonawala, UniCred, Edgro, Incred.

The bank section ends where row 2 shows the next section label (e.g. "AUTO SCORES").
Bank columns are discovered by reading the sheet, never hardcoded.

### Valid bank statuses

Only these ten values may be written into a bank column:

`Shared` · `Docs Pending` · `Login` · `Under Process` · `Sanctioned` · `PF` ·
`Disbursed` · `Rejected` · `DNP` · `Not Doable`

### Identity

Phone number, matched on the **last 10 digits**, so `+91` prefixes and spacing
variations resolve to the same person. One borrower = one row, forever.

---

## 4. What we learned about WhatsApp itself

These constraints are not negotiable and shaped the design.

**There is no such thing as a bot account in a WhatsApp group.** Groups contain
phone numbers, nothing else. A "bot" is always: a real phone number that is a
member, plus software driving that number. Nothing gets "added" except a number.

**The official Meta Cloud API cannot read group messages at all.** Group access is
not exposed to anyone. This means `whatsapp-web.js` (unofficial, linked-device
based) is the only way to do this job. We are locked into it — that is a fact about
the platform, not a shortcut.

**The QR scan is one-time.** The session is written to `.wwebjs_auth/` and survives
restarts, reboots, and redeploys. It breaks only if: the primary phone stays offline
for ~14 days, the folder is deleted, the device is logged out from the phone, or a
WhatsApp Web change breaks the library.

**Therefore `.wwebjs_auth/` is the single most fragile thing in the system.** Any
deploy that replaces the project folder destroys the login and requires physical
access to the phone to recover.

**The bot only sees messages sent after its number joined a group.** No history
is ever backfilled.

---

## 5. Decisions

### Settled

| Decision | Choice | Why |
|----------|--------|-----|
| Platform | `whatsapp-web.js`, linked device | Official API cannot read groups |
| Rebuild vs patch | Full rebuild, v1 deleted | v1 had drifted from what it actually did |
| Version control | Git from commit one | v1 had none, which made the delete irreversible |
| Language | CommonJS, Node 20+ | Boring and reliable on a server |
| Group identity | Permanent WhatsApp group ID | Names change; v1 broke silently when they did |
| Sheet identity | Phone, last 10 digits | Carried over from v1 — this part worked |

### Open — blocking further feature work

**1. Which phone number runs it.**
Own number works today and is already inside bank groups. A second number keeps
personal WhatsApp separate but must be added to each group by an admin, which is
usually not possible in bank-run groups. *Leaning: own number for bank groups.*
Currently being set up on a phone.

**2. How messages get parsed.**
- *AI (Claude API)* — handles real bank-group language: Hinglish, typos, no labels,
  several leads in one message. Costs a few paise per message, needs an API key.
- *Rules/regex, rebuilt properly* — free, instant, predictable, but only catches
  formats anticipated in advance. v1's regex parser failed on ordinary messages.
- *Rules first, AI on fallback* — cheapest AI option, two code paths to maintain.

**3. Which admin panel screens are actually wanted.**
QR/connection and group→bank mapping are effectively mandatory. Live logs, the
dashboard charts, the leads table, and CSV export are open — the Google Sheet is
already the real view of the leads.

**4. Whether CRM sync stays.**
It was disabled in v1 and pointed at a placeholder URL.

---

## 6. What went wrong in v1 — and how v2 prevents it

| v1 problem | v2 prevention |
|-----------|---------------|
| Groups matched by exact name; a rename stopped capture silently | Matched on permanent group ID |
| Regex parser failed on real messages, 9 of 11 tests failing | Parser approach being reconsidered (decision 2) |
| Tests asserted an `email` field the parser no longer produced | Tests are part of the definition of done |
| `email` column dead everywhere but still written as `undefined` | Schema carries only fields that exist |
| `GOOGLE_SHEET_NAME` setting ignored, `Sheet1` hardcoded everywhere | All env access via `config.js`, tab name honoured |
| Sheet sync failure recorded once, never retried — lead lost | `sheet_status` + attempt counter, retried by worker |
| Replies matched by exact raw-text comparison, missed on whitespace | Matched on the quoted message's WhatsApp ID |
| Redelivered messages after reconnect became duplicate rows | `wa_message_id` UNIQUE — reprocessing is a no-op |
| Messages that failed to parse vanished with no record | `skipped_messages` table with reason, visible in panel |
| 24h phone dedupe blocked legitimate updates from other bank groups | Dedupe is per message content, short window, not per phone |
| `ADMIN_PASS=changeme123` shipped and ran in production | Boot refuses to start on known default passwords |
| No git — deletion was unrecoverable | Git from commit one |
| Setup guide described a different product than the code | This document, kept current |

---

## 7. Task list

### Phase 0 — Foundation ✅ done
- [x] Project skeleton, git, `.gitignore` covering secrets and session
- [x] `config.js` with validation; refuses known default passwords
- [x] `logger.js` — console, daily file, subscribers
- [x] Database: transactional migration runner, schema 001
- [x] `CLAUDE.md` and this brief

### Phase 1 — Decisions 🔴 blocking
- [ ] Decide the phone number (own vs dedicated) — setup in progress
- [ ] Decide the parsing approach
- [ ] Decide which panel screens are wanted
- [ ] Decide CRM in or out
- [ ] Recover `GOOGLE_SHEET_ID` and `google-credentials.json` (from the VM, or
      regenerate in Google Cloud and re-share the sheet)

### Phase 2 — Connection
- [ ] WhatsApp client: session handling, QR, reconnect with backoff
- [ ] Group discovery — list real groups so mapping is picked, never typed
- [ ] Message routing: monitored groups only, ignore own status broadcasts
- [ ] Verify session survives a simulated redeploy

### Phase 3 — Pipeline
- [ ] Phone normalisation + the last-10-digit matcher, with tests
- [ ] Parser behind a swappable interface (so decision 2 is reversible)
- [ ] Status vocabulary validation against the ten allowed values
- [ ] Dedupe
- [ ] Record non-leads into `skipped_messages` with a reason
- [ ] Reply handling via quoted message ID → append remark

### Phase 4 — Sheet
- [ ] Auth + bank column discovery from rows 2–3
- [ ] Find-by-phone across the phone column
- [ ] Insert new row / update existing row, never touching D–J
- [ ] Append-only timestamped remarks
- [ ] Retry worker for `pending` and `failed` rows
- [ ] Guard: never write a status outside the ten allowed values

### Phase 5 — Admin panel
- [ ] Auth
- [ ] Connection + QR screen
- [ ] Groups screen with bank mapping, driven by real group list
- [ ] Whatever else survives decision 3

### Phase 6 — Deployment
- [ ] Confirm how the VM deploy treats `.wwebjs_auth/` and `data/` — **do this
      before any deploy**, it is the one mistake that costs physical phone access
- [ ] PM2 config, restart-on-boot
- [ ] Lock down port 3001 — check whether the panel is currently reachable publicly
- [ ] Cutover plan from the running v1 on the VM

---

## 8. Environment

- **Production:** GCP VM `34.131.106.13`, PM2. v1 is still running there and still
  capturing leads. Untouched by this rebuild until cutover.
- **Local:** this repository, macOS.
- **Google Sheet:** live, with real lead data. The sheet itself was never at risk
  during the v1 deletion — it lives in Google's cloud.

## 9. Open questions to resolve with the owner

1. Are the target groups ones you control, or bank-run? (Decides the number choice.)
2. Roughly how many messages a day across all monitored groups? (Decides whether
   AI parsing costs pennies or something worth optimising.)
3. Do you want to see leads in the panel at all, or is the sheet the only view
   you actually use?
4. Is port 3001 on the VM currently open to the internet?
