# Prompt for the CRM's Claude Code — enquiry type, dealer and brand fields

Send to the CRM backend first, then the frontend (`ICONIQ-CRM`). Once it is
live, the WhatsApp bot is wired to the new fields (see the end).

---

> The Iconiq WhatsApp bot creates and updates leads in this CRM through the API.
> Its welcome message now asks customers to choose one of two options:
>
> 1. **Channel Partner**: they want to become a Dealer / Distributor of our
>    hybrid solutions
> 2. **Personal / Commercial Order**: they want to buy for their own use
>
> Then it asks for details. Most answers already have a lead column (`full_name`,
> `city`, `organization`, `load_capacity_kw`, `backup_duration_hours`). Three
> don't, and I need them added so the bot can fill them automatically, and so the
> team can filter leads by enquiry type.
>
> ## 1. Three new lead fields
>
> | Field | Type | Values | Filled from |
> |---|---|---|---|
> | `enquiry_type` | string enum, nullable | `channel_partner`, `personal_order` | The option the customer picked (1 or 2) |
> | `is_existing_dealer` | boolean, nullable | `true` / `false` / `null` | "Are you currently a Dealer / Distributor of another Brand?" |
> | `current_brand` | string, nullable, max 100 | free text | "Please share the Brand name" |
>
> Requirements:
> - All three are **nullable with no default**. `null` means "not asked or not
>   answered". It must never be turned into `false` or `""`.
> - Accept all three on **both** `POST /leads` (`LeadCreate`) and
>   `PUT /leads/{id}` (`LeadUpdate`), the same way the energy fields
>   (`load_capacity_kw` etc.) already work. They must not be update-only.
> - `PUT` must stay partial. A request that leaves a field out must not clear it.
> - `enquiry_type` must reject any value other than the two above with a 422,
>   and must not silently drop it. If an unknown value were dropped while the API
>   still returned success, the bot would believe it had saved something it hadn't.
> - `current_brand` longer than 100 characters should return a 422, not a 500.
> - Return all three in the single-lead response and in every list response.
> - The backend is shared with other tenants, so the new columns must be
>   nullable, and existing rows keep `null`. Don't backfill anything; the bot
>   backfills existing Iconiq leads itself.
> - Don't touch `custom_fields`, `tags` or `notes` for this. The bot never writes
>   those, so the data has to live in real columns.
>
> ## 2. Filter on the leads list
>
> - `GET /leads` accepts `enquiry_type=channel_partner` or
>   `enquiry_type=personal_order`. It ANDs with the existing filters (stage,
>   owner, source, tags, search) and works with pagination and the "select all N
>   matching" flow.
> - Also accept `enquiry_type=none` for leads where it's `null`, so the team can
>   find leads that haven't chosen yet.
> - The pipeline/Kanban endpoint takes the same filter, if it uses a separate
>   endpoint.
>
> ## 3. Frontend (ICONIQ-CRM)
>
> - **Filter:** an "Enquiry type" filter on the Leads page and in the Kanban
>   filter sheet, next to the tag filter. Options: All, Channel Partner,
>   Personal / Commercial Order, Not chosen. It goes through the shared
>   `buildLeadsEndpoint` so the list, "select all matching" and the CSV download
>   all respect it.
> - **Labels:** `channel_partner` → "Channel Partner (Dealer / Distributor)",
>   `personal_order` → "Personal / Commercial Order". Show the label everywhere,
>   never the raw value.
> - **Lead detail:** show Enquiry type, "Existing dealer of another brand"
>   (Yes / No / blank) and "Current brand" alongside the other capture fields.
> - **Lead form:** all three are editable, so a counsellor can correct them.
>   Enquiry type is a dropdown with the two options plus blank.
> - **Leads table and pipeline card:** a small badge for the enquiry type
>   ("Partner" / "Order"), so the type is visible without opening the lead.
> - **CSV download:** add the three columns.
> - Add the fields to the `Lead` type in `src/types/index.ts`.
>
> ## 4. Report back
>
> Don't consider it done until you have run this against the real API:
>
> 1. Create a lead with all three fields set, read it back, and show the response.
> 2. `PUT` only `current_brand` on that lead, and show that `enquiry_type` and
>    `is_existing_dealer` are unchanged.
> 3. `PUT enquiry_type: "dealer"` and show the 422.
> 4. List with `enquiry_type=channel_partner` and with `enquiry_type=none`, and
>    show the counts.
> 5. Delete the test lead.
>
> Then tell me the final field names, the exact enum values, and the filter
> parameter. If anything differs from this spec, say so explicitly. The bot is
> coded against these exact names.

---

## Bot side — done 2026-11-20 (CRM fields confirmed live the same day)

- Add `enquiry_type`, `is_existing_dealer` and `current_brand` to `ENERGY_FIELDS`
  in `src/crm/fields.js`, and `current_brand` to `MAX_LENGTH` (100).
- `enquiry_type` is written straight from the menu choice (a closed vocabulary,
  never read out of prose) as soon as the lead exists. Keep the remark as well.
- Add `is_existing_dealer` and `current_brand` to `EXTRACTABLE` in
  `src/ai/extract.js`, since they come from the customer's typed answer. This
  needs a working OpenRouter key.
- Backfill: set `enquiry_type` on leads that already have an
  "Enquiry type: …" remark.
