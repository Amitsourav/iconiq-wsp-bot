# Prompt for the CRM's Claude Code: partner type field

Send this to the CRM backend first, then to the frontend (`ICONIQ-CRM`). Until it's
live, the bot saves the answer as a remark ("Partner type: EPC"). Once it's live,
the bot also writes the field.

---

> The Iconiq WhatsApp bot creates and updates leads in this CRM through the API.
> Customers on WhatsApp are now answered by Meta's Business AI. When someone wants
> to become a Channel Partner, it asks them:
>
> *"Are you an EPC partner or a Distributor?"*
>
> I need a field for the answer, so the team can see and filter partner leads by
> type. It works the same way as `enquiry_type`, which you added on 20 Nov.
>
> ## 1. One new lead field
>
> | Field | Type | Values |
> |---|---|---|
> | `partner_type` | string enum, nullable | `epc`, `distributor`, `dealer` |
>
> - `epc`: an EPC company (engineering, procurement, construction), i.e. an
>   installer or solar contractor.
> - `distributor`: sells on to dealers.
> - `dealer`: a retailer or dealer selling to end customers.
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
>   All, EPC, Distributor, Dealer, Not set. It goes through `buildLeadsEndpoint`.
> - **Labels:** `epc` → "EPC partner", `distributor` → "Distributor", `dealer` →
>   "Dealer". Always show the label, never the raw value.
> - **Lead detail and lead form:** show the field and let it be edited, as a
>   dropdown with the three options plus blank, next to Enquiry type.
> - **CSV download:** add the column.
> - Add the field to the `Lead` type in `src/types/index.ts`.
>
> ## 4. Report back
>
> Run these against the real API before calling it done:
>
> 1. Create a lead with `partner_type: "epc"`, read it back, and show the response.
> 2. `PUT` a different field only, and show that `partner_type` is unchanged.
> 3. `PUT partner_type: "installer"`, and show the 422.
> 4. List with `partner_type=epc` and with `partner_type=none`, and show the counts.
> 5. Delete the test lead.
>
> Then tell me the final field name, the exact values and the filter parameter.
> If anything differs from this spec, say so. The bot is coded against these
> exact names.
