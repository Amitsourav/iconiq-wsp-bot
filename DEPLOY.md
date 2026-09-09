# Deploying to Railway

Follow this once. After that, deploying is a single command.

---

## The one thing that must not go wrong

Two folders have to survive every deploy:

```
.wwebjs_auth/   the WhatsApp login
data/bot.db     leads captured but not yet sent to the CRM
```

Railway containers get a **fresh filesystem on every deploy**. Without a volume,
both are wiped each time — the bot logs out of WhatsApp and needs the phone in hand
to link again, and any lead waiting to retry is lost.

So **step 3 below is not optional.** Everything else is convenience.

---

## 1. Install the Railway CLI and log in

```bash
npm install -g @railway/cli
railway login
```

## 2. Create the service

From the project folder:

```bash
cd "whatsapp-lead-bot"
railway init          # choose "Create new project", name it whatsapp-lead-bot
```

If you would rather it sit alongside the CRM, run `railway link` and pick that
project instead — the bot then becomes a second service inside it.

## 3. Attach a volume — do this BEFORE the first deploy

In the Railway dashboard: the service → **Variables / Settings → Volumes → New
Volume**.

```
Mount path:  /data
Size:        1 GB      (plenty — the database is a few MB)
```

Then set the two paths below so the bot writes inside the volume rather than the
container's temporary disk.

## 4. Set the environment variables

Service → **Variables**. Copy the values from your local `.env`.

| Variable | Value |
|---|---|
| `DB_PATH` | `/data/bot.db` |
| `WA_SESSION_PATH` | `/data/wa-session` |
| `LOG_DIR` | `/data/logs` |
| `HOST` | `0.0.0.0` |
| `ADMIN_USER` | from `.env` |
| `ADMIN_PASS` | from `.env` |
| `JWT_SECRET` | from `.env` |
| `CRM_BASE_URL` | `https://be-crm-production.up.railway.app/api/v1` |
| `CRM_API_KEY` | the **live** key from `.env` |
| `CRM_COMPANY_ID` | `bfa8b4fc-bdfa-4dcb-addd-6b5a1f20aa38` |
| `CRM_EXPECTED_COMPANY_ID` | `bfa8b4fc-bdfa-4dcb-addd-6b5a1f20aa38` |
| `CRM_SERVICE_PROFILE_ID` | `06f48ea0-4844-4601-8331-6c33e8528a2f` |
| `TZ_DISPLAY` | `Asia/Kolkata` |
| `LOG_LEVEL` | `info` |
| `PF_TARGET` | monthly PF target per counsellor, e.g. `10` |
| `MIS_REPORT_AT` | `18:58` — when the Daily Loan MIS posts |

Do **not** set `PORT` — Railway provides it.

`PF_TARGET` is the **monthly** PF target for one counsellor. The team target in
the MIS is this number times the counsellors reported, so changing it changes both.
It lives here rather than in the CRM because the CRM has no PF target field, and
because a target is a management decision that moves — a Railway variable changes
without a deploy.

`CRM_EXPECTED_COMPANY_ID` is a safety catch: if the key ever points at a different
company, the bot refuses to start rather than writing leads into the wrong place.

## 5. Deploy

The service is connected to the GitHub repo `Amitsourav/whatsappbot`, branch
`main`, so **a push is the deploy**:

```bash
git push origin main
```

`railway up` uploads the local folder instead, and is only the right command
before the GitHub connection exists. Once connected, using it puts code on the
server that is not in the repo — which is how a deploy stops being reproducible.

Watch the logs. A good start looks like:

```
Database ready at /data/bot.db
CRM connected as whatsapp-bot@fundmycampus.com — FundMyCampus
Admin panel on http://0.0.0.0:8080
No saved session — link the number to continue
```

## 6. Open the panel and link WhatsApp

Service → **Settings → Networking → Generate Domain**. That gives a public URL.

Open it, sign in with `ADMIN_USER` / `ADMIN_PASS`, and scan the QR from the bot's
phone: **WhatsApp → Settings → Linked Devices → Link a Device**.

## 7. Stop the copy running on the Mac

**Important.** Linking a second device does not unlink the first, so both would read
the same group and both would reply. The CRM would refuse the duplicate lead, but
your team would see two messages for everything.

```bash
lsof -ti:3001 | xargs kill
```

## 8. Check it

- Post a test lead in the group; confirm it appears in the CRM
- In the panel, confirm the group is still being watched and the employee list is
  intact *(these live in the database, so they arrive with the volume — but check)*

---

## Afterwards

**Deploying a change:** `railway up`. The volume is untouched, so WhatsApp stays
linked.

**Watching it:** `railway logs`, or the Logs tab.

**If it restarts:** Railway restarts on failure automatically, up to ten times. The
saved session means it reconnects to WhatsApp on its own.

---

## Things worth knowing

**The panel will be on the public internet.** It is protected by the login and a
JWT, but the password is now the only thing standing in front of it. Make sure
`ADMIN_PASS` is strong — the bot refuses to start on known defaults, but "strong
enough for localhost" is not the same as "strong enough for the internet".

**Only ever run one copy.** Two processes on one WhatsApp number fight: WhatsApp
allows the linked devices, but both would process every message and reply twice.

**Cost:** roughly $5/month, plus a few cents for the volume.

**If the volume is ever lost**, the bot starts fresh: it will ask for a QR scan, and
the group and employee settings need re-entering. Nothing reaches the CRM twice,
because the CRM deduplicates on phone number.
