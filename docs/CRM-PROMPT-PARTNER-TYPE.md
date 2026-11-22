# Prompt for the CRM's Claude Code: partner type field and the WhatsApp enquiry columns

Send this to the CRM backend first, then to the frontend (`ICONIQ-CRM`). Until it's
live, the bot saves the partner type as a remark ("Partner type: EPC partner").
Once it's live, the bot also writes the field.

---

> The Iconiq WhatsApp bot creates and updates leads in this CRM through the API.
> Customers on WhatsApp are answered by Meta's Business AI, which asks each
> customer whether they want to become a **Dealer / Channel Partner** or **place an
> order**, then asks for their details. The team wants these nine columns for
> every WhatsApp enquiry:
>
> | # | Column the team sees | Field | Status |
> |---|---|---|---|
> | 1 | Dealer / Distributor (Y/N) | `enquiry_type = channel_partner` | exists |
> | 2 | End User (Y/N) | `enquiry_type = personal_order` | exists |
> | 3 | Name | `full_name` | exists |
> | 4 | City | `city` | exists |
> | 5 | Company Name | `organization` | exists |
> | 6 | EPC or Distributor | `partner_type` | **new — add it** |
> | 7 | Brands working with | `current_brand` | exists |
> | 8 | Load Capacity (kW) | `load_capacity_kw` | exists |
> | 9 | Backup required (Hrs) | `backup_duration_hours` | exists |
>
> Columns 1 and 2 are the one `enquiry_type` field you added on 20 Nov. A lead is
> one or the other, never both, so don't add two separate Y/N columns for them.
>
> ## 1. One new lead field: `partner_type`
>
> | Field | Type | Values |
> |---|---|---|
> | `partner_type` | string enum, nullable | `epc`, `distributor`, `dealer` |
>
> - `epc`: an EPC company (engineering, procurement, construction), i.e. a solar
>   installer or contractor.
> - `distributor`: sells on to dealers.
> - `dealer`: a dealer or retailer selling to end customers.
>
> Requirements, the same as `enquiry_type`:
> - **Nullable, with no default.** `null` means "not asked or not answered". It is
>   never turned into `""`.
> - Accepted on **both** `POST /leads` and `PUT /leads/{id}`. `PUT` stays partial:
>   leaving the field out must not clear it.
> - Any other value returns a **422** in the usual shape. Never drop it silently,
>   or the bot would believe it saved something it didn't.
> - Returned in the single-lead response and in every list response.
> - Existing rows stay `null`. No backfill.
> - Don't use `custom_fields`, `tags` or `notes` for this. It has to be a real
>   column.
>
> ## 2. Filter
>
> - `GET /leads` accepts `partner_type=epc|distributor|dealer|none` (`none` = null).
>   It ANDs with the other filters, including `enquiry_type`, and works with
>   pagination, "select all matching" and the CSV download.
> - The Kanban / pipeline endpoint accepts the same filter, if it is a separate one.
>
> ## 3. Frontend (ICONIQ-CRM)
>
> - **Filter:** a "Partner type" filter next to "Enquiry type", with the options
>   All, EPC partner, Distributor, Dealer, Not set. It goes through
>   `buildLeadsEndpoint`.
> - **Labels:** `epc` → "EPC partner", `distributor` → "Distributor", `dealer` →
>   "Dealer". Always show the label, never the raw value.
> - **Lead detail:** a "WhatsApp enquiry" section showing all nine columns above, in
>   that order. Show columns 1 and 2 as "Dealer / Distributor: Yes / No" and "End
>   User: Yes / No", both read from `enquiry_type` (both blank when it is null).
>   Show Load and Backup with their units ("5 kW", "4 hrs").
> - **Lead form:** `partner_type` is editable, as a dropdown with the three options
>   plus blank, next to Enquiry type. The other eight are already editable; keep
>   them as they are.
> - **Leads table:** a small badge for the partner type ("EPC" / "Distributor" /
>   "Dealer") next to the existing enquiry-type badge.
> - **CSV download:** include all nine columns, in the order above, with those
>   headings. "Dealer / Distributor" and "End User" are Y / N (blank when
>   `enquiry_type` is null).
> - Add `partner_type` to the `Lead` type in `src/types/index.ts`.
>
> ## 4. Report back
>
> Run these against the real API before calling it done:
>
> 1. Create a lead with `partner_type: "epc"`, read it back, and show the response.
> 2. `PUT` a different field only, and show that `partner_type` is unchanged.
> 3. `PUT partner_type: "installer"`, and show the 422.
> 4. List with `partner_type=epc` and with `partner_type=none`, and show the counts.
> 5. Download the CSV for one lead and show the header row with all nine columns.
> 6. Delete the test lead.
>
> Then tell me the final field name, the exact values and the filter parameter.
> If anything differs from this spec, say so. The bot is coded against these
> exact names.
