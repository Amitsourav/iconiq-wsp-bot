# Way 2 — bank groups

**Status: planning. Nothing built.**

---

## The difference from Way 1

Way 1 was easy to reason about because we controlled everything: our own group, our
own staff, a format we could ask people to follow, and real `@mentions` to identify
who a lead belongs to.

None of that is true here.

| | Way 1 — in-house | Way 2 — bank groups |
|---|---|---|
| Whose group | ours | **the bank's** |
| Who writes | our staff | **bank staff we cannot instruct** |
| Message format | can be mandated | **whatever they type** |
| Who a lead belongs to | a real `@mention` | nothing |
| The lead itself | usually new | **already in our CRM** |
| Bot posting | replies in the group | **never — see S5** |

The consequence: **Way 2 is not about creating leads. It is about listening to what
banks say about leads we already have, and keeping the CRM current.**

---

## Where the data would go

The CRM already has the right shape, which is fortunate — no new fields needed.

**`bank_name`** — a locked list of 18:
> Axis · PNB · SBI · Yes Bank · ICICI · IDFC · BOI · Kuhoo · Avanse · Credila ·
> Propelld · Tata Capital · Zolve · Nomad · UniCred · Auxilo · Incred · Edgro

**`bank_status`** — seven values:
> applied · docs_reviewed · under_review · loan_login · sanctioned · pf_paid ·
> disbursed

And v1's insight still holds and removes the hardest ambiguity: **each group maps to
exactly one bank.** A message in the ICICI group is about ICICI. The bot never has
to work out which bank is being discussed — only which lead, and what happened.

---

## The shape, as currently imagined

```
Bank rep posts in the ICICI group
   "9876543210 login done"
        │
        ├─ extract the phone number
        ├─ find that lead in the CRM
        ├─ read the status word  →  loan_login
        │
        ├─ set bank = ICICI, bank_status = loan_login
        ├─ record the message as a remark
        └─ say NOTHING in the group
```

Everything after "find that lead" is guesswork until we see real messages.

---

## Step 1 — collect real messages first  ← do this before designing further

The bot **already** records everything it sees in a group marked as `bank`, without
acting on it. That behaviour was built for exactly this moment: messages are stored
with the reason `bank_group_not_implemented` and nothing is created, updated, or
posted.

So the first step needs no code:

1. In the panel → **Groups**, switch on one bank group
2. Set its type to **Bank**
3. Leave it a few days

The bot will quietly collect real messages. Sending is forced off for bank groups at
the database level, so there is no possibility of it posting there.

Then we design against what banks actually write, rather than what we imagine they
write. This also removes the need to describe the format in words — the messages
describe themselves.

**Zero risk. Nothing reaches the CRM. Nothing is posted.**

---

## Open questions

Ordered by how much they change the design. Most become easy once we have real
messages.

**Q1 — Which groups, and which bank is each?**
A list: group name → bank name from the locked list above.

**Q2 — What does a bank message look like?**
Answered by Step 1.

**Q3 — What if the phone is not in our CRM?**
A bank mentions a number we never shared with them. Options: ignore it; record it
for review; create it as a new lead. Leaning **record for review** — it is
information, but a lead we never sent them is unexpected and worth a human look.

**Q4 — Should anything be announced in our own group?**
The bot never posts in a bank group. But `ICICI sanctioned Priya Sharma` posted in
the in-house group could be genuinely useful — that is news the team wants.

**Q5 — Does a bank update move the lead's main stage?**
If ICICI sanctions a file, does the lead become `sanctioned` overall, or does only
`bank_status` change? Today the bot never touches the main stage (R5), and changing
that is a significant widening of what it is allowed to do.

**Q6 — What if two banks disagree?**
A lead can be with several banks. ICICI rejects, SBI sanctions. `bank_status` is a
single field on the lead — so which one wins? The CRM mentions a `lead_banks` table,
which may hold per-bank rows; worth asking the CRM team before designing around the
single field.

**Q7 — Rejections.**
`bank_status` has no "rejected" value. If a bank says no, where does that go?

---

## Risks specific to Way 2

**We cannot ask bank reps to change how they write.** Every rule must work with what
they already do. This is the opposite of Way 1, where a habit could be taught.

**Wrong updates are worse here.** A bank status is used to decide what to chase. A
lead wrongly marked `sanctioned` stops being worked; one wrongly marked rejected
gets abandoned. Same principle as before — infer only from closed vocabularies,
send everything else to remarks.

**Volume is likely much higher.** Bank groups are busy and most messages will be
conversation. The noise filter matters more here than anywhere in Way 1.

**The bot must never post in a bank group.** Already enforced in the database:
setting a group's purpose to `bank` forces sending off, and it cannot be turned back
on while it stays a bank group.

---

## What is already built and waiting

- Groups can be marked `bank`, and sending is forced off for them
- Bank-group messages are already recorded rather than discarded
- `bank_name` and `bank_status` are already in the field map, with the locked lists
- Phone matching, duplicate detection and remark writing all work
- `findByPhone` already looks a lead up by number

Way 2 is mostly **new rules on existing machinery**, not new machinery.
