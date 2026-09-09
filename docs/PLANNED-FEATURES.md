# Planned features

Agreed to build, not yet built. Each entry carries enough design to be picked up
without re-arguing the decisions.

Ordered by risk: the first three only read, the last one writes to someone's work.

---

## 1. Daily summary

**What.** A message posted into the group each morning showing yesterday's work.

```
📊 Yesterday — 14 leads

Ankit 5 · Zaid 4 · Rudra 3 · Himanshu 2

⚠️ 3 still untouched
+91 98718 48226 · Raghav · Ankit
+91 90075 70563 · Ganpati Podder · Zaid
+91 63634 29113 · ANR · Ankit
```

**Why.** Makes the day's work visible where the team already is, without anyone
opening the CRM. The untouched list is the valuable half — a lead nobody has
called is money already lost, and today nobody is watching for that.

**How.** Read-only. `GET /leads` filtered on `created_at`, grouped by
`assigned_agent_id`. "Untouched" means still at stage `created`.

**To decide**
- What time? 9am IST suggested — before the day starts.
- Only bot-created leads, or everything in the CRM? Everything is more useful but
  makes the bot look responsible for work it did not capture.
- Weekends: post anyway, or skip?
- Does Monday cover the weekend?

**Notes.** Needs a scheduler, which the bot does not have yet — the retry worker
is the closest thing. Must respect the sending kill switch (S4).

---

## 2. "My leads"

**What.** Anyone types `my leads` in the group and gets their own list back.

```
Zaid — 6 open leads

Created (2)
  +91 95159 24298 · Kiran
  +91 90075 70563 · Ganpati Podder
Processing (3)
  ...
```

**Why.** A counsellor can see their own pipeline without leaving WhatsApp.

**How.** Read-only. The sender's WhatsApp number resolves through the employee map
to a CRM profile, then `GET /leads` filtered on `assigned_agent_id`.

**To decide**
- Reply in the group, or direct message the person? A group reply is noisy but the
  bot messaging people privately is a bigger behavioural change.
- What counts as "open" — everything not `disbursed` or `lost`?
- Cap the list at, say, 15 with a count of the rest.
- Should a manager be able to ask for someone else's? (`leads @Zaid`)

**Notes.** First feature where the bot answers a *command* rather than reacting to
a lead. Worth deciding the general shape of commands here — a prefix, or plain
words? Plain words risk misfiring on ordinary conversation.

---

## 3. Follow-up reminders

**What.** Each morning, post what is due today, tagging the person who owns it.

```
🔔 Due today

@Zaid    +91 95159 24298 · Kiran · Processing
@Ankit   +91 98718 48226 · Raghav · Docs pending
```

**Why.** The CRM already holds `due_date` and nothing surfaces it where the team
works, so it is only seen by whoever opens the record.

**How.** Read-only. `GET /leads` filtered on `due_date` = today.

**To decide**
- One message tagging everyone, or one per person?
- Include overdue as well as due today? Overdue is the more useful half.
- Same schedule as the daily summary, or separate?

**Notes.** Depends on the team actually setting due dates. Worth checking how many
leads have one before building — if the field is mostly empty, this is an empty
feature.

---

## 4. Reassignment  ⚠️ writes to someone's work

**What.** Reply to a lead with a tag and it moves to that person.

**Why.** The current behaviour — never reassign — is right for the *accidental*
case, but wrong for the deliberate one. When a lead genuinely needs to move, the
team has to open the CRM to do it, which is the friction this bot exists to remove.

**The risk, stated plainly.** This takes a lead away from whoever had it. A stray
tag in a reply becomes a silent handover, and the person who lost it may not
notice. That is why it was excluded originally.

**How to make it safe**

- **Require an explicit word, never a bare tag.** `assign @Zaid` or `transfer
  @Zaid`. A tag alone is far too easy to trigger by accident — people tag each
  other in conversation constantly.
- **Announce it loudly, naming both sides.**
  ```
  🔄 Lead moved
  Kiran · +91 95159 24298
  Ankit → @Zaid   (by Deepak)
  ```
- **Record it as a remark**, so the CRM shows who moved it and when.
- **Never move a closed lead** — `disbursed` or `lost` should be refused, the same
  guard already used for duplicates.

**Decided.** Only named numbers may reassign — currently Deepak
(+91 78272 25354) alone. Set through `REASSIGN_ALLOWED` in Railway's variables,
comma-separated, so it changes without a deploy. Anyone else gets "Only an admin
can move a lead to someone else" and nothing moves.

**Still to decide**
- Should the person losing the lead be tagged too, so they see it?
- Is a confirmation step wanted, or is announcing it enough? Confirmation is safer
  but doubles the messages.

**Notes.** Build this last, and only once the read-only features have been in use
long enough to trust the bot's judgement in the group.

---

## Shared groundwork these need

**A scheduler.** Features 1 and 3 need to run at a fixed time. The retry worker is
an interval loop, not a clock — this needs a proper daily trigger, and one that
does not fire twice if the process restarts.

**Command parsing.** Feature 2, and 4 if built, mean the bot responds to
instructions as well as leads. That needs its own rule about what counts as a
command, or it will misfire on ordinary conversation — the same problem the noise
filter solved for replies.

**Sending discipline.** Every one of these posts to the group. All must respect the
kill switch and the rate limit, and none should add to the noise on a quiet day —
a summary saying "0 leads" every morning trains people to ignore the bot.
