# CLAUDE.md

Working instructions for this repository. Read `PROJECT.md` for the full brief,
domain rules, decision log, and what is built. `DISCUSSION.md` keeps the reasoning
behind settled decisions; `docs/` holds the specifications those decisions produced.

## What this is

A Node.js service that reads messages from WhatsApp groups and keeps an **in-house
CRM** up to date. Version 2 — a deliberate rebuild. Version 1 was scrapped and
deleted; do not look for it.

v1 wrote to a Google Sheet. v2 does not: the destination changed to the CRM early
in the rebuild, before anything was deployed. If you find a reference to Sheets,
columns D–J, or `GOOGLE_SHEET_ID` anywhere, it is dead weight — the sheet code was
never written.

## Commands

```bash
npm install        # required before anything — node_modules is not committed
npm start          # run the bot + admin panel
npm run dev        # run with auto-restart on file change
npm test           # node:test suite
npm run db:reset   # delete the local database (destroys local leads only)
```

Node 22 (`.nvmrc`, `engines`). The tests that touch `src/db/` need `better-sqlite3`
compiled, so a missing or stale `node_modules` shows up as six suites failing with
`Cannot find module 'better-sqlite3'` — that is an install problem, not a bug.

## Layout

```
src/
  config.js       All env access. Nothing else reads process.env.
  logger.js       Logging. Subscribe for the panel's log view.
  index.js        Boot order, scheduled jobs, shutdown.
  db/
    index.js      Connection + migration runner.
    schema.js     Ordered migrations. Append only.
    repositories.js  All SQL. Nothing else writes queries.
  whatsapp/       Baileys client, session, message normalising.
  pipeline/       Message -> CRM lead. Detection, parsing, orchestration.
  crm/            CRM HTTP client and the field map.
  api/            Express routes for the admin panel.
  ai/             OpenRouter assistant + its knowledge base.
web/index.html    The admin panel, one file.
```

## Rules

**Never read `process.env` outside `src/config.js`.** Add the setting there with a
default and validation instead. v1 scattered env reads and ended up ignoring its
own `GOOGLE_SHEET_NAME` setting for a hardcoded `Sheet1`.

**Never edit or reorder an existing migration in `schema.js`.** Append a new one.
Deployed databases have already applied the old ones. (001 was rewritten exactly
once, when the destination changed from the sheet to the CRM and nothing had
shipped. That was the last time.)

**Never touch the WhatsApp session directory in code, scripts, or deploy steps.**
`config.whatsapp.sessionPath` — `.wwebjs_auth/` locally, the Railway volume in
production. It is the WhatsApp login. Deleting it means physically scanning a QR
again from the phone that owns the number. The old v1 troubleshooting guide told
people to delete it casually — that advice was wrong and is gone.

There is exactly one exception, `WhatsAppClient.relink()`, and any change to it
must keep all three of its terms: it refuses unless the state is `logged_out`
(WhatsApp has already killed the credentials, so there is nothing left to
protect), it **archives** the folder rather than deleting it, and it runs only
when someone signed into the panel asks for it. It exists because the panel was
otherwise a dead end after a logout — it said "restart the bot to link again",
which needs the hosting dashboard, so the person holding the phone could not act
on it. Do not widen it into anything that runs automatically.

`WhatsAppClient.logout()` is its companion, not a second exception: it asks
WhatsApp to unlink the device and touches nothing on disk. It exists because a
session broke on 24 Sep 2026 while still logging in fine — every message failed
to decrypt, the state stayed `connected`, and `relink()` could never be reached.
It runs only while `connected`, only from the panel, only with an explicit
confirmation. Keep all three.

**Phone number is the identity of a lead.** Indian numbers normalise to
`+91XXXXXXXXXX`, matching the CRM's own `normalize_phone` so we can predict that
they will deduplicate. Overseas numbers are accepted only with an explicit `+` and
country code — the `+` is the safety catch that stops an account number becoming a
lead. All of this lives in `pipeline/phone.js`; do not reimplement it elsewhere.

**Record before acting.** Every message is written to our database *before* the CRM
is called, and `wa_message_id` is UNIQUE on every table that holds one. WhatsApp
redelivers after a reconnect, and a network failure mid-create leaves us unable to
tell whether the CRM committed. Recording first makes both recoverable instead of
duplicate-producing. Anything that calls the CRM must be safe to run twice — the
retry worker will.

**Notes always mean `POST /leads/{id}/remarks`.** Never `lead.notes` — that column
is destructive on write and the AI voice pipeline appends to it, so writing there
damages another system nobody would think to check (C1).

**Never write `custom_fields` or `tags`.** They are replace-not-merge on PUT, so
writing one key wipes the rest (C2). Never patch `phone` (C3). Never set
`current_stage` — the bot creates at `created` and never advances a lead (R5).
These are enforced in `crm/client.js`, not at call sites; keep it that way.

**Only write a structured field from an explicit label or a closed vocabulary.**
`College: DU` sets a field. Free text does not. Where the bot does infer without a
label — money, institutions, courses — it matches against fixed vocabularies in
`pipeline/detect.js`. Never widen this into guessing at prose: a missed lead is
visible, corrupted data is not.

**Nothing is ever dropped.** A message that produces no lead and no update goes to
`skipped_messages` with a reason. Noise is filtered from the CRM but still recorded
here, so the noise list can be corrected against real usage rather than argued
about (R11.1).

**The bot sends only the messages in `docs/BOT-MESSAGES.md`, only in an in-house
group, only as a quoted reply.** It never reacts and never marks anything read.
Sending is off by default per group, rate-limited, and has a kill switch in the
panel. If a feature seems to need any other kind of sending, stop and ask.

**The bot never posts in a bank group.** Enforced in SQL: a group with
`purpose = 'bank'` has `send_enabled` forced to 0 and cannot have it turned back on
(`repositories.js`, `groups.setSendEnabled` / `setPurpose`). An automated reply into
a lender's group risks the number being removed from it, which would take the whole
pipeline down with it.

**The bot ignores its own messages.** Its own replies contain no mention and no
phone number; without this guard they can feed back into the pipeline.

**A command must be the whole message.** "my leads" is a command; "let me check my
leads later" is conversation. Same rule as the noise filter. A substring match here
turns the bot into an interruption.

## Style

- CommonJS (`require`), Node 22. Not ESM — Baileys is CJS and this runs on a server
  where boring and reliable beats modern.
- `async`/`await` only. No callback style, no `.then()` chains.
- JSDoc on exported functions. Comments explain *why*, never *what*.
- Errors are logged with enough context to identify the message or lead involved.
  A failure must never crash the process — the bot staying connected matters more
  than any single lead.

## Before saying something works

Run it. This project talks to WhatsApp, an external CRM, and SQLite; guessing does
not count as verification. If something could not be tested, say so explicitly.
