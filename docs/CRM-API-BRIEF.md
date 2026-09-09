# Brief for the CRM team

*Send this as-is. It explains what we're building and lists exactly what we need.*

---

## What we're building

We're automating lead entry from WhatsApp. Today, an admin posts a lead in our
in-house WhatsApp group and tags an employee, and that employee types the lead into
the CRM by hand.

We're replacing the typing. A service will read the WhatsApp message and create the
lead in the CRM directly — assigned to the tagged employee, at the **Created** stage.
When people later reply in WhatsApp with more detail about that lead, the service
will update the same CRM record.

The service only ever **creates leads and updates fields**. It never deletes
anything, never moves a lead to a later stage, and never touches records it did not
create.

---

## What we need from you

### 1. Access

- Is there an API on the CRM today? If yes, the **base URL**.
- **How do we authenticate?** API key, bearer token, OAuth — whichever it is, and
  how we get credentials.
- **A test or staging environment**, please. We'll be creating throwaway leads while
  building this, and we don't want that landing in the live CRM. If there's no
  staging, tell us and we'll work around it.

### 2. Create a lead

- **Endpoint and method** (e.g. `POST /api/leads`)
- **Request body** — the exact JSON you expect
- **Which fields are required** and which are optional
- **What comes back on success.** We specifically need the **new lead's ID** in the
  response. Without it we cannot link the WhatsApp conversation to the CRM record,
  and follow-up updates become impossible.
- **What comes back on failure** — status codes and the error format

### 3. Update a lead

- **Endpoint and method** (e.g. `PATCH /api/leads/{id}`)
- **Can we send just the fields that changed?** We'd prefer a partial update. If the
  API requires the full record on every update, say so — we'll have to read the lead
  first, and we need a get-lead endpoint for that.

### 4. The lead fields

- **A list of every field on a lead**: the exact field name the API expects, its
  type, and whether it's required.
- **For any dropdown or fixed-choice field, the exact allowed values.** We'll be
  writing information that came from a WhatsApp message, so we need to know the
  precise strings the API accepts rather than guessing.
- **Which fields should the automation be allowed to write to?** If some are
  calculated, or reserved for humans, tell us and we'll leave them alone.

### 5. Assigning to an employee

This one matters most to us.

- **How do we assign a lead to a specific user in the create call?** What's the
  field name, and what identifier does it take — a user ID, an email address,
  something else?
- **Is there an endpoint that lists CRM users** with their names, emails and IDs?
  We need to map each employee's WhatsApp number to their CRM user, and we'd rather
  read your user list than maintain a copy by hand.

### 6. The stage field

- **What is the field called, and what is the exact value for "Created"?**
  Every lead we create goes in at that stage and stays there until a human moves it.

### 7. Duplicate handling

The same person will sometimes be shared in WhatsApp more than once.

- **Does the CRM reject or merge a lead whose phone number already exists?**
- **Is there a way to look up a lead by phone number** before we create one? If so,
  the endpoint.
- **What would you like us to do on a duplicate** — skip it, update the existing
  lead, or create it anyway and let a human sort it out?

### 8. Practical limits

- **Any rate limits** we should respect?
- **Do you support an idempotency key** on create? If the network drops after you
  process our request but before we get the response, we'll retry — and without an
  idempotency key that produces a duplicate lead. If you don't support one, we'll
  handle it on our side; we just need to know.

---

## Summary — the minimum to unblock us

If the full list is too much at once, these five get us moving:

1. Base URL and how to authenticate
2. Create-lead endpoint, and **the response must include the new lead's ID**
3. Update-lead endpoint
4. The list of lead fields, with allowed values for any dropdowns
5. How to assign a lead to a user, and how users are identified

---

## One request

If any of this doesn't exist yet — no API, no update endpoint, no way to assign on
create — that's fine, just tell us plainly. The CRM is in-house, so we can build
what's missing. What we can't work with is finding out later that an endpoint
behaves differently from how it was described.
