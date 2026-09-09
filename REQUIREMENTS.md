# Requirements

What the bot must do. Written before implementation, one capture path at a time.

Leads arrive by **two paths**:

1. **In-house group** → creates and updates leads in the in-house CRM *(documented below)*
2. **Bank groups** → *(not yet discussed)*

---

# Way 1 — In-house group → CRM

## Who is in the group

All employees, plus admins.

## The flow today (manual)

1. Admin posts a lead in the in-house group and `@mentions` the employee it belongs to.
2. That employee reads it and types the lead into the CRM by hand.
3. Further details discussed in the group are typed into the CRM by hand as well.

## The flow we are building (automatic)

```
Admin posts lead in in-house group, @mentioning an employee
        │
        ▼
Bot reads the message
        │
        ├── extracts the lead details
        └── reads the @mention → the mentioned person's phone number
                │
                ▼
        Look up phone number in the employee map → CRM user (name + email)
                │
                ▼
        Create lead in CRM
          • assigned to that employee
          • stage = "Created"
                │
                ▼
        Remember: this WhatsApp message  ←→  this CRM lead
                                │
                                ▼
    Later, anyone replies to that message with more detail
    (e.g. a college name)
                                │
                                ▼
        Bot finds the linked CRM lead and updates the
        relevant field with the new information
```

## Confirmed rules

**R1 — Mentions are always real `@mentions`.**
Admins select the person from WhatsApp's mention list; they do not type names as
plain text. This matters technically: a real mention carries the mentioned person's
**phone number as structured data** on the message, so assignment is exact rather
than guessed. No name matching, no ambiguity between two people called Rahul.

*Implication:* if someone types a name instead of mentioning, the bot cannot
reliably determine the assignee. Decide the fallback — see Q6.

**R2 — Employees are mapped phone number → CRM user, and this mapping comes first.**
Built and maintained before anything else works. A message mentioning an unmapped
number cannot be assigned.

**R3 — The CRM is in-house.**
We control it, so if an API endpoint is missing it can be added rather than
worked around.

**R4 — Employees are identified in the CRM by name and email.**
So the employee map is: `WhatsApp phone number → { name, email }`.

**R5 — The bot only ever creates leads at stage "Created".**
It never advances a lead to a later stage. What happens after Created is a human
process and out of scope. *(Owner: later stages not needed for now.)*

**R6 — Replies update fields on the existing lead.**
When new information arrives as a reply, the bot writes it to the appropriate
field on the already-created lead. It does not create a second lead.

**R7 — The link between a WhatsApp message and a CRM lead must persist.**
Stored locally, keyed on the WhatsApp message ID, so a reply arriving days later
still finds the right lead.

**R8 — A lead message is identified by: a phone number AND an employee `@mention`.**
Both must be present. This is the test for "is this a new lead" versus ordinary
group chat.

**R9 — Replies are handled by a labelled-format rule, with Notes as the catch-all.**

*Chosen approach: labelled updates write to structured fields; everything else
goes to Notes. Rejected: letting the bot interpret free text into structured
fields — a wrong guess corrupts a CRM record silently, and silent corruption is
worse than a missed update.*

```
Reply arrives on a lead message
        │
        ├─ Matches "FieldName: value" and FieldName is a known CRM field
        │       └─→ update that structured field
        │
        └─ Anything else
                └─→ append to Notes, with timestamp and sender
```

Consequences of this rule, all deliberate:

- **A structured field is only ever written from an explicit label.** The bot never
  infers that "she needs 15 lakh" means the Amount field.
- **Nothing is ever lost.** Unrecognised text still lands in Notes, so information
  is preserved even when it isn't understood.
- **The team must learn one habit:** to set a real field, reply `College: Delhi
  University`. Anything else is still captured, just as a note.
- **No AI, no API cost, fully predictable.** The same input always produces the
  same result, which also makes it straightforwardly testable.

**R11 — Detailed reply rules.**

**R11.1 — Noise is filtered, not written to Notes.**
Acknowledgements and reactions never reach the CRM. A reply is noise only when the
**entire message** is trivial — an emoji-only message, or exactly one of a short
list such as ok / okay / k / done / thanks / yes / noted / got it.

The whole-message condition is essential. "done" alone is noise; "documents done"
is information and must be kept. The filter matches the complete message, never a
word inside a longer one.

*Safeguard:* filtered messages are still stored in our own database, so nothing is
truly lost and the noise list can be corrected later against real data.

**R11.2 — Field labels have aliases.**
`Clg:`, `College:` and `University:` all resolve to the College field. Matching is
case-insensitive and tolerant of surrounding spaces. Aliases matter because staff
will not remember one exact spelling.

**R11.3 — `:` `-` and `=` are all accepted as separators.**
`College: DU`, `College - DU` and `College = DU` are equivalent. Being strict here
only produces lost updates. *(Assumed; confirm.)*

**R11.4 — One reply may set several fields.**
`College: DU` and `Course: MBA` in a single message updates both.

**R11.5 — Unknown labels go to Notes, never dropped.**
`Budget: 20L` when the CRM has no Budget field is appended to Notes verbatim, so
the information survives even though no field matched.

**R11.6 — A new value overwrites, and the old value is preserved in Notes.**
If College holds "Delhi University" and a reply sets "Mumbai University", the field
becomes Mumbai University and Notes records the change with the previous value and
a timestamp. The CRM shows current truth; Notes carries the history.

**R10 — In-house and bank groups are different problems.**
In the in-house group we control the people, so a message format can be mandated —
which is what makes R9 workable. In bank groups we do not control who writes what,
so R9 cannot simply be reused there. Way 2 is decided separately.

## Open questions — Way 1

**Q1 — What are the CRM's lead fields?**
Needed for R6. "Update the right column" requires knowing the columns. A list of
field names and their types would unblock this. Which of them can the bot write?

**Q2 — How does the bot talk to the CRM?**
Is there an API today? If so: base URL, auth method, and the endpoints for
create-lead and update-lead. If not, one needs building — it is in-house, so this
is a decision, not an obstacle.

**Q3 — What does a lead message actually contain?**
Name and phone at minimum, presumably. What else is typically in the first
message? Real examples would settle this faster than description.

**Q4 — Where does the employee map come from?**
Entered by hand in the admin panel, or read from the CRM's user list?

**Q5 — What if the phone number already exists in the CRM?**
Create a duplicate, update the existing lead, reassign it to the newly mentioned
employee, or flag it for a human? This will happen.

**Q6 — What if a message has no `@mention`, or mentions an unmapped number?**
Skip it, create the lead unassigned, or hold it for review in the panel?

**Q7 — Who may update a lead by replying?**
Anyone in the group, only the assigned employee, or only admins?

**Q8 — How does the bot tell an update from ordinary chat?** ✅ *Answered — see R9
and R11.*

**Q9 — Can one message contain several leads?**
And if so, several different mentions?

---

# Way 2 — Bank groups

*Not yet discussed.*
