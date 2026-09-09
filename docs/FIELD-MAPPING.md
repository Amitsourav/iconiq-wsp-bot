# WhatsApp label → CRM field mapping

**Status: SETTLED.** All mapping decisions made 2026-08-05.

Source of truth for CRM fields: their `docs/LEAD_FIELD_REFERENCE.md`, received
2026-08-05. This document is what R11.2 (aliases) and R11.5 (unknown labels) are
implemented against.

---

## Rules this mapping must respect

**M1 — Unknown keys are silently ignored on create.** A typo'd field name returns
201 with the value quietly dropped. We therefore validate every outgoing payload
against the accepted-field list *before* sending. A 201 is not proof the data
landed.

**M2 — Create and update accept different fields.** Notably `loan_amount` and
`bank_name` are **update-only** — sent to create, they are silently dropped. If a
WhatsApp lead message contains a loan amount, capturing it requires
`POST /leads` followed by `PUT /leads/{id}`. Two calls, and the second must not be
skipped on failure.

**M3 — Over-length input returns 500, not 422.** DB lengths are not mirrored in
Pydantic. Truncate client-side: `loan_amount` 50, `bank_name` 100.

**M4 — `assigned_agent_id` is not validated.** A UUID that does not exist 500s at
the foreign key. Always resolve against the cached user list before sending.

**M5 — Most target fields are free text.** `gender`, `state`, `country`, `stream`,
`highest_qualification`, `target_degree`, `target_intake`, `tags` have zero
validation, so whatever the WhatsApp message says can be written verbatim. No
translation table needed for these.

**M6 — Locked lists must be matched exactly or not written at all.**
`bank_name` (18 values), `bank_status` (7), `lost_reason` (21, case-sensitive,
one has a trailing period), `submitted_docs` keys. Anything outside the list is
either a 400 or silently dropped. If a WhatsApp value does not match a list entry
exactly, it goes to remarks instead — never a guess.

---

## Confirmed mapping

| WhatsApp label (and aliases) | CRM field | Notes |
|---|---|---|
| `Email` | `email` | Unique per tenant. Not format-validated |
| `Alt Phone`, `Alternate Phone` | `alternate_phone` | Not normalised, not deduped |
| `City` | `city` | Free text |
| `State` | `state` | Free text |
| `DOB`, `Date of Birth` | `date_of_birth` | Must convert to `YYYY-MM-DD` |
| `Gender` | `gender` | Free text |
| `Pincode`, `PIN` | `pincode` | No format check |
| `Qualification` | `highest_qualification` | Free text |
| `Stream` | `stream` | Free text |
| `Percentage`, `%` | `percentage` | Numeric, max 999.99 |
| `Passing Year` | `passing_year` | Integer |
| `Intake` | `target_intake` | Free text, e.g. "Sep-2026" |
| `College`, `Clg`, `University`, `Univ` | `university` | **D1** — single field, `college_name` never written |
| `Course`, `Degree` | `target_degree` | **D2** — free text, written verbatim |
| `Country` | `preferred_countries` | **D3** — array. `country` never written |
| `Loan`, `Loan Amount`, `Amount` | `loan_amount` | **Update-only (M2).** Free text, truncate to 50 |
| `Bank` | `bank_name` | **Update-only (M2). Locked list (M6)** |

## Decisions — settled 2026-08-05

**D1 — `university`, not `college_name`.** All college/university labels resolve to
the single field `university`. `College`, `Clg`, `University`, `Univ` → `university`.
`college_name` is never written.

*This corrects an error in the first draft of R11.2, which folded University into a
College field — that would have put university names in the wrong column.*

**D2 — `Course` → `target_degree`.** The CRM has no `course` field. `target_degree`
is free text, so the value is written verbatim.

**D3 — `Country` → `preferred_countries`.** Means where the student wants to study.
The `country` field (residence, defaults to "India") is never written.

**D4 — Withdrawn.** Supporting every label costs nothing in code, so there is no
decision to make. All labels are supported; the team gets a short cheat sheet of the
ones they will realistically use.

## Never written by the bot

`notes` (C1 — destroys the AI call pipeline's history; use the remarks endpoint) ·
`custom_fields` and `tags` (C2 — replace-not-merge) · `phone` on update (C3 — it is
the lead's identity) · `current_stage` (R5 — creation lands at `created`
automatically and we never advance it) · every field in their system-managed list.

## Read, never write

`loan_amount_lakh` is write-only and absent from responses — read `loan_amount`
instead (C7).
