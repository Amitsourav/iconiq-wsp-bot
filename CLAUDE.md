# CLAUDE.md

Working instructions for this repository. Read `PROJECT.md` for the full brief,
domain rules, decision log, and task list.

## What this is

A Node.js service that reads loan-lead messages from WhatsApp groups and keeps a
single Google Sheet up to date. Version 2 — a deliberate rebuild. Version 1 was
scrapped and deleted; do not look for it.

## Commands

```bash
npm start          # run the bot + admin panel
npm run dev        # run with auto-restart on file change
npm test           # node:test suite
npm run db:reset   # delete the local database (destroys local leads only)
```

## Layout

```
src/
  config.js       All env access. Nothing else reads process.env.
  logger.js       Logging. Subscribe for the panel's live stream.
  db/
    index.js      Connection + migration runner.
    schema.js     Ordered migrations. Append only.
  whatsapp/       Client, session, message routing.
  pipeline/       Message -> lead. Parsing, dedupe, orchestration.
  sheets/         Google Sheets read/write.
  api/            Express routes for the admin panel.
  realtime/       Socket.IO.
```

## Rules

**Never read `process.env` outside `src/config.js`.** Add the setting there with a
default and validation instead. v1 scattered env reads and ended up ignoring its
own `GOOGLE_SHEET_NAME` setting for a hardcoded `Sheet1`.

**Never edit or reorder an existing migration in `schema.js`.** Append a new one.
Deployed databases have already applied the old ones.

**Never touch `.wwebjs_auth/` in code, scripts, or deploy steps.** It is the
WhatsApp login. Deleting it means physically scanning a QR again from the phone
that owns the number. The old v1 troubleshooting guide told people to delete it
casually — that advice was wrong and is gone.

**Phone number is the unique identifier for a lead.** Match on the last 10 digits
so `+919876543210`, `919876543210`, and `9876543210` are one person. Never create
a second row for a phone that already exists.

**The bot sends only the messages in `docs/BOT-MESSAGES.md`, only in the in-house
group, only as a quoted reply.** It never reacts, never marks anything read, and
never posts in a bank group. Sending is off by default per group and has a kill
switch. If a feature seems to need any other kind of sending, stop and ask.

**The bot ignores its own messages.** Its own replies contain no mention and no
phone number; without this guard they can feed back into the pipeline.

**Columns D–J of the sheet are the user's.** The bot writes A, B, C, K, and the
bank columns from L onward. Never write to D–J, and never overwrite a non-empty
cell the user may have edited by hand.

**Remarks append, never overwrite.** Each entry is timestamped in IST.

## Style

- CommonJS (`require`), Node 20+. Not ESM — the WhatsApp library is CJS and this
  runs on a server where boring and reliable beats modern.
- `async`/`await` only. No callback style, no `.then()` chains.
- JSDoc on exported functions. Comments explain *why*, never *what*.
- Errors are logged with enough context to identify the message or lead involved.
  A failure must never crash the process — the bot staying connected matters more
  than any single lead.

## Before saying something works

Run it. This project talks to WhatsApp, Google, and SQLite; guessing does not
count as verification. If something could not be tested, say so explicitly.
