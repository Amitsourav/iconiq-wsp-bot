# Bank-share grid — API contract

Everything below was called against the live CRM and the responses are real, not
inferred. Base URL: `{CRM}/api/v1`. Auth: the same session or API key as the rest
of the CRM.

---

## The grid

```
GET /leads/bank-share-grid?page=1&page_size=25
```

One call returns the whole page — leads and their shares together. Do **not** call
per cell.

```json
{
  "banks": ["Axis","PNB","SBI","Yes Bank","ICICI","IDFC","BOI","Kuhoo","Avanse",
            "Credila","Propelld","Tata Capital","Zolve","Nomad","UniCred",
            "Auxilo","Incred","Edgro"],
  "total": 10313,
  "page": 1,
  "page_size": 25,
  "total_pages": 413,
  "items": [
    {
      "lead_id": "10ac8868-6db4-493c-967d-b111d53a98be",
      "serial_no": 8881,
      "full_name": "Ajoy Dhar",
      "phone": "+917439312141",
      "counsellor_name": "Rudra Taneja",
      "current_stage": "created",
      "loan_amount": null,
      "shares": {
        "PNB": {
          "shared_at": "2026-08-06T09:41:32.018189Z",
          "shared_by_name": null,
          "source": "manual",
          "bank_status": "applied",
          "message_count": 0,
          "last_message_at": null,
          "last_message_preview": null
        }
      }
    }
  ]
}
```

**`banks`** is the column order — take it from the response rather than hardcoding,
so the grid follows the CRM if the list ever changes.

**`shares`** is keyed by bank name. A key present means shared; absent means not.
`Axis` missing from the example above is a blank cell, not an error.

---

## One cell's full history, for the hover

```
GET /leads/{lead_id}/bank-shares/{bank_name}
```

Called **only when a cell is hovered or clicked**, never for every rendered cell —
25 leads × 18 banks of message history would dwarf the page payload.

```json
{
  "id": "fd88e0e8-54ab-4543-9767-2393b9b4fa83",
  "lead_id": "10ac8868-6db4-493c-967d-b111d53a98be",
  "bank_name": "PNB",
  "bank_status": "applied",
  "shared_at": "2026-08-06T09:41:32.018189Z",
  "shared_by": null,
  "shared_by_name": null,
  "source": "manual",
  "wa_group_id": null,
  "message_count": 0,
  "last_message_at": null,
  "created_at": "...",
  "messages": []
}
```

`messages` carries the conversation about that lead in that bank's WhatsApp group —
both our team's messages and the bank's.

---

## Every bank for one lead

```
GET /leads/{lead_id}/bank-shares
```

Returns an array of share objects. Useful on a lead's own detail page; the grid does
not need it.

---

## What the page has to show

| | |
|---|---|
| Rows | one per lead |
| Frozen columns | name · number · counsellor · stage · loan amount |
| Bank columns | 18, from `banks` |
| Cell | coloured if that bank is a key in `shares`, blank otherwise |
| Hover | when shared · who shared it · the conversation since |

---

## Things worth knowing before building

**`shared_by_name` is often null.** The backfilled rows have no author — nobody
recorded who shared them originally. Show "—" rather than "null", and don't treat it
as an error.

**`source` distinguishes real from inferred.** `manual` means backfilled from an
existing `lead_banks` row; `whatsapp` means the bot recorded it from a real message.
Worth showing subtly in the hover — an inferred date is not the same as an observed
one.

**10,313 leads.** Pagination is not optional. Most rows have no shares at all, so a
filter for "has at least one share" would make the grid far more useful than page 1
of 413.

**`last_message_preview` is capped at 120 characters** — enough for a tooltip line,
not the full message. The full text comes from the per-cell call.

**Colour should mean something.** All-one-colour tells you only *whether* it was
shared. Shading by `bank_status` (applied → sanctioned → disbursed) would let
someone read progress across a row at a glance, which is the thing the grid is
really for.
