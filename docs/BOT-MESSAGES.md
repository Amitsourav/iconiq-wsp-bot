# Bot messages — draft for approval

Every message the bot posts into the in-house group. It sends **nothing else**, ever,
and never posts in any other group.

All replies are sent as a **quoted reply** to the message that triggered them, so it
is always obvious which lead is being discussed.

---

## When it speaks

| Situation | Speaks? |
|---|---|
| Lead created | ✅ Yes — confirmation |
| Lead already exists | ✅ Yes — warning |
| No `@mention` on a lead | ✅ Yes — asks for one |
| More than one `@mention` | ✅ Yes — asks for one |
| A reply set a CRM field | ✅ Yes — short confirmation |
| A reply had a label it could not use | ✅ Yes — explains why |
| A reply was plain text (went to notes) | ❌ Silent |
| A reply was "ok" / "done" / 👍 | ❌ Silent — ignored entirely |
| Anything in a bank group | ❌ Never posts there at all |

The reason field updates are confirmed: the labelled-format habit only sticks if
people get feedback. If someone types `Clg - DU` and it silently lands in notes
instead of the field, they never learn to type it correctly.

---

## 1. Lead created

```
✅ Lead created
Priya Sharma · +91 98765 43210
Assigned to @Rahul
```

## 2. Lead already exists

```
⚠️ Lead already exists
Priya Sharma · +91 98765 43210
Already with Rahul Kumar · added your message as a note
```

Assignment is deliberately **not** changed — silently moving someone else's lead to a
different person causes arguments. The message is recorded as a note so nothing is
lost, and a human can reassign if it is genuinely wrong.

## 3. No employee mentioned

```
⚠️ Please tag the employee for this lead
Priya Sharma · +91 98765 43210
Reply with @name and I'll create it
```

The lead is **held**, not discarded. Once someone replies with a mention, it is
created. It also appears in the admin panel so it cannot be forgotten.

## 4. More than one employee mentioned

```
⚠️ You tagged 2 people — Rahul and Priya
Please tag only one employee per lead
```

Held the same way as case 3. Nothing is created until it is unambiguous.

## 5. A reply updated a field

```
✅ University → Delhi University
```

Several at once:

```
✅ University → Delhi University
✅ Course → MBA
```

## 6. A reply had a label it could not use

```
⚠️ "Budget Range" isn't a field I know — saved as a note instead
```

For a value outside a locked list:

```
⚠️ "Some Random Bank" isn't in the bank list — saved as a note instead
Banks: Axis, PNB, SBI, Yes Bank, ICICI, IDFC, BOI, Kuhoo, Avanse, Credila,
Propelld, Tata Capital, Zolve, Nomad, UniCred, Auxilo, Incred, Edgro
```

## 7. Something went wrong on our side

```
⚠️ Couldn't save this to the CRM — retrying
Priya Sharma · +91 98765 43210
```

Sent only once per lead, never repeatedly, however many retries happen underneath.
If it eventually succeeds, message 1 follows.

---

## Safety rules on sending

**S1 — The bot ignores its own messages.** Without this, its own "please tag the
employee" reply — which contains no mention and no phone — could feed back into the
pipeline, and in the worst case it talks to itself.

**S2 — One reply per triggering message.** A message can never produce two bot
replies, however many things are wrong with it.

**S3 — Hard rate limit.** A cap per minute across the whole group. If it is hit,
the bot stops sending and logs loudly rather than flooding the group. Capture
continues regardless — a rate limit must never cost a lead.

**S4 — Kill switch.** Sending can be turned off from the admin panel while capture
keeps running. If the bot ever misbehaves in front of the team, that is the button.

**S5 — In-house group only.** Sending is enabled per group and off by default. Bank
groups are never eligible.

**S6 — Never send on a retry loop.** Message 7 fires once. Retries are silent.


---

## Amendment, 2026-08-05 — a lead needs no name

**Phone is the identity.** A lead shared as just a number is complete, and holding
it for a missing name was wrong: it turned an ordinary message into a chore.

The CRM requires `full_name`, so when no name is found the **phone number stands in
as the name**. It is honest, searchable, and obviously provisional. A later reply
carrying `Name: Priya Sharma` replaces it.

Message 3c ("I couldn't find the student's name") is therefore withdrawn. The bot
never asks for a name — only for an assignee it genuinely cannot determine.

Confirmation for an unnamed lead shows the number alone:

```
✅ Lead created
+91 82720 61608
Assigned to @Ankit
```


---

## Amendment, 2026-08-05 — a duplicate shows where the lead stands

Message 2 was a bare "already exists". In the live CRM, with 10,000 leads, that is
the common reply — and it left the team no wiser than before. It now reports the
lead's actual state, so nobody has to open the CRM to find out whether it is
already being worked, and by whom.

```
⚠️ Already in the CRM · #8871
Jaanvi Dixit · +91 75798 83047

Stage: Processing
Counsellor: Rudra Taneja
Pre-counsellor: Himanshu
University: GLA University, Mathura
Course: B.Tech
Loan: 7 Lakh
Added: 12 Mar 2026

Your message was saved as a note
```

Only fields that hold a value are shown — a blank row is noise. Agent names are
resolved from the cached user list, because the single-lead response does not
always populate them.

Assignment is still never changed, and the message is still saved as a remark.


---

## Amendment, 2026-08-24 — the Daily Loan MIS

A second evening message, posted alongside the Login & PF report. Where that one
counts what moved **today**, this one tracks the **month to date** against a
target — because a PF target is monthly, and a single day's figure says nothing
about whether it will be met.

```
*Daily Loan MIS*

📅 24 Aug 2026

👤 Ankit Dubey
Leads: 31 | Login: 15 | Sanction: 7 | PF: 1
🎯 PF Target: 10 | Achievement: 10%
📈 Login→PF: 7% | Required: 9 PF

👤 Himanshu
Leads: 31 | Login: 10 | Sanction: 3 | PF: 1
🎯 PF Target: 10 | Achievement: 10%
📈 Login→PF: 10% | Required: 9 PF

━━━━━━━━━━━━━━━━━━
👥 TEAM MTD

Leads: 103
Login: 37
Sanction: 13
PF: 3/40
🎯 Achievement: 8%
📈 Login→PF: 8%
```

**Where the numbers come from.** `GET /reports/daily/range?user_id=&days=N`, one
call per counsellor, summed on our side. `days` is set to the day of the month, so
the range is the 1st to today — but the returned rows are filtered by date anyway,
because that boundary is undocumented and a range quietly reaching into last month
would inflate every figure in the report.

**Leads is a count of leads created. Login, Sanction and PF are stage
transitions** during the month. A lead that moved login → sanction → PF in one
month appears in all three. That is how a funnel MIS is meant to read.

**A dash, not a zero, where a percentage would mislead.** Login→PF with no logins
is `—`, not `0%`. Zero percent reads as failure; the honest answer is that there is
nothing to convert yet.

**Unreachable is not zero.** If the CRM call for one person fails, that row says
`(no data)` and they are left out of the team target — reporting a failed lookup as
"did nothing" is a lie about someone's month.

**Targets are not in the CRM.** `target_call_count` exists on the daily report but
is a *call* target and is null in live data. `PF_TARGET` is therefore a Railway
variable: one monthly number per person, and the team target is that number times
the counsellors actually reported.

Posted only in the in-house group, and skipped entirely when the kill switch (S4)
is on — same rules as every other message here.


---

## Amendment, 2026-08-25 — the Login & PF report is retired

The same-day login-and-PF message is gone. The MIS shows the same two stages with
sanction, leads and targets alongside them, so the older report was a subset
arriving as a second message every evening — and two posts a night is how a bot
becomes something people scroll past.

Two faults died with it, both visible in the last one it sent:

```
Ankit_Dubey  1 login
Himanshu     —
```

The underscore came straight from the CRM, and WhatsApp reads a matched pair as
italics. The columns were padded with `padEnd`, which assumes a monospace font
WhatsApp does not use, so they never lined up on a phone. The MIS avoids both:
it strips underscores, and it puts each figure on its own labelled line rather
than trying to build a table out of spaces.

`scheduler:stage-report:lastRun` is left behind in the settings table. It is inert
— nothing reads it — and deleting rows from a live database to tidy up is not
worth the risk.


---

## Amendment, 2026-09-02 — overseas numbers, and never failing in silence

**A lead was posted twice and dropped both times.** `Ajaj Shaikh · +96569950748 ·
@Zaid` — a Kuwait number. Phone extraction accepted Indian mobiles only, so the
bot found no number, concluded the message was not a lead, and said nothing. The
sender had no way to know except by noticing the missing confirmation.

Two changes.

**Overseas numbers are now accepted** when written with an explicit `+` and
country code, at an E.164 length of 8–15 digits. The `+` is the safety catch: a
bare eleven-digit run could be an account number or two numbers that ran
together, and inventing a lead from one puts a record in the CRM nobody can act
on. Someone who writes `+965…` has stated a country.

This knowingly weakens one guarantee. The CRM normalises Indian numbers only and
stores everything else verbatim (C14), so an overseas number deduplicates against
an identical string but not against the same number written another way. That is
a smaller cost than losing the lead outright.

A number claiming to be Indian still has to be a real mobile — `+911234567890`
is rejected rather than falling through to the overseas branch, which would
create a lead under a number nobody can call.

**Message 12 — a number that still cannot be read.**

```
⚠️ I couldn't read that number: 0096569950748
Ajaj Shaikh
For an overseas number include the country code, like +965 6995 0748
```

Sent only when the message carries something number-shaped that failed. Ordinary
tagged chatter — "apne apne cases update kro", "updated in sheet @sir", which is
40 of the 42 `no_phone` skips in live data — draws no reply, because a bot that
answers every tagged message is an interruption. Mention placeholders are
stripped first: WhatsApp renders a mention in the body as a fifteen-digit LID
that would otherwise read as a mangled phone number.

Recorded as `unreadable_number` so the panel shows it apart from ordinary
non-leads, and sent once per message even if WhatsApp redelivers it (S2).
