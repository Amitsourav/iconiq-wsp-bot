# Deploying to Railway

The Iconiq Energy WhatsApp bot. Deployed once, on 10 Sep 2026; after that,
deploying is a single `git push`.

---

## The one thing that must not go wrong

Two things have to survive every deploy:

```
the WhatsApp session   the linked-device login
data/bot.db            conversations and leads not yet in the CRM
```

Railway containers get a **fresh filesystem on every deploy**. Without a volume,
both are wiped each time — the bot logs out of WhatsApp and needs the phone in
hand to link again, and any lead waiting to retry is lost.

So the volume is not optional. It is already attached; do not detach it.

---

## What is deployed, and where

| | |
|---|---|
| Railway project | `eloquent-tenderness` |
| Service | **`iconiq-wsp-bot`** |
| Repo | `Amitsourav/iconiq-wsp-bot`, branch `main` |
| Volume | `iconiq-wsp-bot-volume`, mounted at `/data` |
| Panel | https://iconiq-wsp-bot-production.up.railway.app |
| CRM | `iconiq-crm` — https://iconiq-crm-production.up.railway.app |

**There is a second bot in the same project.** `whatsappbot` is the FundMyCampus
loan bot: a different repo (`Amitsourav/whatsappbot`), a different CRM, a
different WhatsApp number. The two share nothing but a Railway project. Check the
service name before changing anything — a variable set on the wrong one points a
live bot at the wrong company.

---

## The environment variables

Set on the service, not shared at project level, so the two bots cannot read each
other's.

| Variable | Value |
|---|---|
| `DB_PATH` | `/data/bot.db` |
| `WA_SESSION_PATH` | `/data/wa-session` |
| `LOG_DIR` | `/data/logs` |
| `HOST` | `0.0.0.0` |
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |
| `TZ_DISPLAY` | `Asia/Kolkata` |
| `ADMIN_USER` | `admin` |
| `ADMIN_PASS` | a strong password — the panel is on the public internet |
| `JWT_SECRET` | `openssl rand -hex 32`, generated fresh for production |
| `CRM_BASE_URL` | `https://iconiq-crm-production.up.railway.app/api/v1` |
| `CRM_API_KEY` | the Iconiq CRM service key |
| `CRM_EXPECTED_COMPANY_ID` | `23b86075-10ca-4c76-8c2b-b9437bd90361` |
| `CRM_LEAD_SOURCE_ID` | `71e8a215-f83b-4d3f-8787-b4acd342925a` (the CRM's "WhatsApp" source) |
| `OPENROUTER_API_KEY` | for the AI replies |
| `OPENROUTER_MODEL` | `anthropic/claude-sonnet-4.5` |
| `AI_REPLY_ENABLED` | `true` |
| `AI_REPLY_IN_DMS` | `true` |
| `AI_REPLY_IN_GROUPS` | `false` |
| `AI_EXTRACT_FIELDS` | `true` |
| `DM_CRM_SYNC_AT` | `22:30` |

Do **not** set `PORT` — Railway provides it, and overriding it fails the health
check.

`CRM_EXPECTED_COMPANY_ID` is a safety catch: if the key ever resolves to a
different company, the bot refuses to start rather than writing leads into the
wrong tenant. It is what stops an Iconiq key and a FundMyCampus key being swapped
by accident.

`CRM_LEAD_SOURCE_ID` is mandatory — the CRM made a source required on 2026-09-07
and rejects every create without one. It lives in a variable so it can be
repointed if the source list is ever rebuilt.

`AI_EXTRACT_FIELDS` turns off the reading of load, backup, solar and DG out of a
conversation. Turning it off leaves the bot replying and the transcript still
reaching the CRM — only the structured fields stop being filled.

---

## Deploying a change

The service is connected to GitHub, so **a push is the deploy**:

```bash
git push origin main
```

The volume is untouched by a deploy, so WhatsApp stays linked.

A good start looks like:

```
Database ready at /data/bot.db
Loaded N CRM users
CRM connected as whatsapp-ingest@iconiqenergy.in — Iconiq Energy (23b86075-…)
Retry worker started (every 60s)
Admin panel on http://0.0.0.0:8080
```

If the session is gone it will say `No saved session — link the number to
continue` and show a QR in the panel. On a normal deploy it should **not** say
that. If it does, the volume is not mounted — stop and fix that before scanning,
or you will be scanning again on the next deploy.

---

## Linking the number (first time, or after a logout)

1. Open the panel and sign in
2. On the Iconiq phone: **WhatsApp → Settings → Linked Devices → Link a Device**
3. Scan the QR

The scan is one-time. The session survives restarts, reboots and redeploys. It
breaks only if the primary phone stays offline for ~14 days, the volume is lost,
the device is unlinked from the phone, or a WhatsApp change breaks the library.

---

## Only ever run one copy

Linking a second device does not unlink the first. Two copies on one number both
process every message and both reply, so customers see everything twice.

If a copy is running on the Mac:

```bash
lsof -ti:3001 | xargs kill
```

The local `.env` points at the same live Iconiq CRM, so a local run is not a
sandbox — it writes real leads.

---

## Things worth knowing

**The panel is on the public internet.** It is protected by the login and a JWT,
and the bot refuses to start on known default passwords — but `ADMIN_PASS` is the
only thing in front of it.

**The kill switch.** The panel can stop all sending while capture keeps running.
If the bot ever misbehaves in front of a customer, that is the button.

**Cost:** roughly $5/month plus a few cents for the volume, and OpenRouter usage
per conversation — one model call to reply, one to read details out of it.

**If the volume is ever lost**, the bot starts fresh: it will ask for a QR scan.
Nothing reaches the CRM twice, because leads deduplicate on phone number.
