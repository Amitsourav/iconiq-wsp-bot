/**
 * The messages the bot posts into the in-house group.
 *
 * Executable form of docs/BOT-MESSAGES.md. Pure string building — sending, rate
 * limiting and the kill switch live elsewhere, so wording can be changed and
 * tested without touching any of that.
 */

/** Render +919876543210 as "+91 98765 43210". */
function prettyPhone(e164) {
  if (!e164) return '';
  const m = String(e164).match(/^\+91(\d{5})(\d{5})$/);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

/** "Priya Sharma · +91 98765 43210" */
function subject(name, phone) {
  return [name, prettyPhone(phone)].filter(Boolean).join(' · ');
}

/**
 * A mention only renders in WhatsApp if the text contains "@<digits>". The
 * matching JIDs must be passed alongside — see messages.toMentionJids.
 */
function tag(e164) {
  return e164 ? `@${String(e164).replace(/^\+/, '')}` : '';
}

const replies = {
  /** 1 — the lead reached the CRM. */
  leadCreated({ name, phone, employeePhone }) {
    // Without a name the number stands alone — it is the identity, not a gap.
    const head = name ? subject(name, phone) : prettyPhone(phone);
    return {
      text: `✅ Lead created\n${head}\nAssigned to ${tag(employeePhone)}`,
      mentions: [employeePhone].filter(Boolean)
    };
  },

  /**
   * 2 — the phone was already a lead (Q5).
   *
   * Shows where the lead actually stands, so nobody has to open the CRM to find
   * out whether it is already being worked and by whom. Assignment is deliberately
   * unchanged: silently moving someone else's lead causes arguments.
   *
   * @param {object} params
   * @param {object} [params.lead] - the existing lead as returned by the CRM
   * @param {(id: string) => string|null} [params.resolveUser] - id → display name
   */
  leadExists({ name, phone, existingName, lead, resolveUser }) {
    const lines = [`⚠️ Already in the CRM${lead?.serial_no ? ` · #${lead.serial_no}` : ''}`];
    lines.push(subject(existingName || lead?.full_name || name, phone));

    if (lead) {
      const detail = [
        ['Stage', STAGE_LABELS[lead.current_stage] || lead.current_stage],
        ['Counsellor', lead.assigned_agent_name
          || (resolveUser && resolveUser(lead.assigned_agent_id))],
        ['Pre-counsellor', lead.pre_counsellor_name
          || (resolveUser && resolveUser(lead.pre_counsellor_id))],
        ['University', lead.university],
        ['Course', lead.target_degree],
        ['Loan', lead.loan_amount],
        ['Bank', lead.bank_name],
        ['Added', shortDate(lead.created_at)]
      ].filter(([, value]) => value);

      if (detail.length) {
        lines.push('');
        // Only fields that actually hold something — an empty row is noise.
        for (const [label, value] of detail) lines.push(`${label}: ${value}`);
      }
    }

    lines.push('', 'Your message was saved as a note');
    return { text: lines.join('\n'), mentions: [] };
  },

  /** 3 — nobody was tagged (Q6). The lead is held, not discarded. */
  needsMention({ name, phone }) {
    return {
      text: `⚠️ Please tag the employee for this lead\n${subject(name, phone)}\n`
        + "Reply with @name and I'll create it",
      mentions: []
    };
  },

  /** 4 — more than one person tagged (Q9). */
  tooManyMentions({ employeeNames }) {
    const who = employeeNames.filter(Boolean).join(' and ');
    return {
      text: `⚠️ You tagged ${employeeNames.length} people${who ? ` — ${who}` : ''}\n`
        + 'Please tag only one employee per lead',
      mentions: []
    };
  },

  /**
   * 3b — the tagged number is not in the employee map.
   * Named separately from needsMention because the fix is different: someone must
   * add them to the map, not re-tag the message.
   */
  unknownEmployee({ name, phone, mentionedPhone }) {
    return {
      text: `⚠️ ${prettyPhone(mentionedPhone)} isn't set up as an employee yet\n`
        + `${subject(name, phone)}\nAdd them in the admin panel, or tag someone else`,
      mentions: []
    };
  },

  /**
   * 3c — no name could be found.
   * The CRM requires full_name and we never invent one, so this waits for a human.
   */
  needsName({ phone }) {
    return {
      text: `⚠️ I couldn't find the student's name\n${prettyPhone(phone)}\n`
        + 'Reply with  Name: <full name>',
      mentions: []
    };
  },

  /**
   * 8 — the number matches a lead that is already finished.
   * Appending to a closed record would bury a genuinely revived enquiry, so this
   * asks for a human instead.
   */
  revivedLead({ phone, existingName, stage }) {
    const STAGE = { disbursed: 'already disbursed', lost: 'marked lost', enrolled: 'enrolled' };
    return {
      text: `⚠️ This number is on a closed lead\n${subject(existingName, phone)}\n`
        + `That lead is ${STAGE[stage] || stage} — check before working it again`,
      mentions: []
    };
  },

  /**
   * 9 — a lead was moved to someone else.
   *
   * Names both sides and who did it. Someone losing a lead they were working
   * must see it happen, in the group, at the moment it happens.
   */
  leadReassigned({ name, phone, from, toPhone, by }) {
    return {
      text: `🔄 Lead moved\n${subject(name, phone)}\n`
        + `${from || 'Unassigned'} → ${tag(toPhone)}`
        + (by ? `   (by ${by})` : ''),
      mentions: [toPhone].filter(Boolean)
    };
  },

  /** 9b — the move could not be made, and why. */
  reassignRefused({ reason, name, phone, stage }) {
    const why = {
      closed: `That lead is ${STAGE_LABELS[stage] || stage} — reopen it in the CRM first`,
      unknown_employee: "I don't have that person in the employee list",
      no_mention: 'Tag the person to move it to — assign @name',
      multiple_mentions: 'Tag only one person',
      not_a_lead: 'Reply to the lead you want to move',
      same_person: 'That lead is already theirs',
      not_permitted: 'Only an admin can move a lead to someone else'
    }[reason] || 'I could not move that lead';

    const who = (name || phone) ? `\n${subject(name, phone)}` : '';
    return { text: `⚠️ ${why}${who}`, mentions: [] };
  },

  /**
   * 10 — several amounts, and no way to tell which is the loan.
   *
   * Asking beats guessing. A file written as tuition plus living expenses has no
   * single figure, and taking the first would understate it by half.
   */
  amountAmbiguous(amounts) {
    return {
      text: `⚠️ Which is the loan amount? ${amounts.join(' · ')}\n`
        + "Reply  Total: <amount>  and I'll set it",
      mentions: []
    };
  },

  /**
   * 11 — a message that listed several leads.
   *
   * One reply for the batch. Twenty lines of confirmation is not a confirmation,
   * it is a wall — so the created ones are counted and the ones needing
   * attention are named, because those are what someone must act on.
   *
   * @param {{created: object[], existing: object[], failed: object[]}} result
   * @param {string} [employeePhone]
   */
  batchCreated({ created, existing, failed }, employeePhone) {
    const parts = [];
    const total = created.length + existing.length + failed.length;

    const head = [`✅ ${created.length} of ${total} leads created`];
    if (employeePhone) head.push(`· assigned to ${tag(employeePhone)}`);
    parts.push(head.join(' '));

    if (created.length && created.length <= 5) {
      // A lead with no usable name is shown by its number — the same thing that
      // identifies it in the CRM.
      parts.push(created.map((l) => (l.name
        ? `  ${l.name} · ${prettyPhone(l.phone)}`
        : `  ${prettyPhone(l.phone)}`)).join('\n'));
    }

    if (existing.length) {
      parts.push('');
      parts.push(`⚠️ ${existing.length} already in the CRM`);
      for (const l of existing.slice(0, 5)) {
        parts.push(`  ${l.name ? `${l.name} · ` : ''}${prettyPhone(l.phone)}`
          + (l.owner ? ` · with ${l.owner}` : ''));
      }
      if (existing.length > 5) parts.push(`  …and ${existing.length - 5} more`);
    }

    if (failed.length) {
      parts.push('');
      parts.push(`❌ ${failed.length} couldn't be saved — retrying`);
    }

    return { text: parts.join('\n'), mentions: [employeePhone].filter(Boolean) };
  },

  /**
   * 5 — a reply set one or more CRM fields.
   *
   * A replacement is shown differently from a first value. Someone overwriting a
   * counsellor's entry should see that they did, in the group, immediately —
   * silently swapping it is how people stop trusting the bot.
   *
   * @param {{field: string, from: *, to: *}[]} changes
   */
  fieldsUpdated(changes) {
    return {
      text: changes.map(({ field, from, to }) => {
        const label = LABELS[field] || field;
        return from
          ? `✏️ ${label}: ${format(from)} → ${format(to)}`
          : `✅ ${label} → ${format(to)}`;
      }).join('\n'),
      mentions: []
    };
  },

  /**
   * 6 — labelled lines the bot could not use.
   *
   * Takes them all together. A message listing tuition, living expenses and a
   * total would otherwise produce three separate replies, and a bot that answers
   * four times to one message is one people mute.
   *
   * @param {{label: string, value: string, reason: string}[]} rejected
   */
  labelRejected(rejected) {
    const list = Array.isArray(rejected) ? rejected : [rejected];
    if (!list.length) return null;

    const unknown = list.filter((r) => r.reason !== 'not_in_locked_list');
    const notAllowed = list.filter((r) => r.reason === 'not_in_locked_list');

    const lines = [];

    if (unknown.length === 1) {
      lines.push(`⚠️ "${unknown[0].label}" isn't a field I know — saved as a note`);
    } else if (unknown.length > 1) {
      lines.push(`⚠️ Not fields I know — saved as notes: `
        + unknown.map((r) => `"${r.label}"`).join(', '));
    }

    for (const r of notAllowed) {
      lines.push(`⚠️ "${r.value}" isn't in the ${LABELS[r.label] || r.label} list `
        + '— saved as a note');
    }

    return { text: lines.join('\n'), mentions: [] };
  },

  /**
   * 12 — a tagged message carried a number that could not be read.
   *
   * Sent rather than swallowed because the alternative is what happened on
   * 2 Sep 2026: a lead was posted twice, dropped both times, and nobody knew
   * until someone noticed the missing confirmation.
   */
  unreadableNumber({ name, raw }) {
    return {
      text: `⚠️ I couldn't read that number${raw ? `: ${raw}` : ''}\n`
        + (name ? `${name}\n` : '')
        + 'For an overseas number include the country code, like +965 6995 0748',
      mentions: []
    };
  },

  /** 7 — the CRM could not be reached. Sent once per lead, never per retry (S6). */
  crmUnavailable({ name, phone }) {
    return {
      text: `⚠️ Couldn't save this to the CRM — retrying\n${subject(name, phone)}`,
      mentions: []
    };
  }
};

/** CRM stage values, as a person would say them. */
const STAGE_LABELS = {
  created: 'Created', contacted: 'Contacted', dnp: 'DNP', qualified: 'Qualified',
  processing: 'Processing', logged_in: 'Logged in', sanctioned: 'Sanctioned',
  pf_paid: 'PF paid', disbursed: 'Disbursed', opportunity: 'Opportunity',
  lost: 'Lost', enrolled: 'Enrolled', connected: 'Connected',
  docs_pending: 'Docs pending', docs_collected: 'Docs collected',
  partial_docs_collected: 'Partial docs', application_done: 'Application done',
  visa_applied: 'Visa applied', deposit_paid: 'Deposit paid'
};

/** "12 Mar 2026" — enough to judge whether a lead is stale. */
function shortDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB',
    { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

/** Field names as people would say them, for confirmations. */
const LABELS = {
  university: 'University',
  target_degree: 'Course',
  preferred_countries: 'Country',
  loan_amount: 'Loan',
  bank_name: 'Bank',
  full_name: 'Name',
  email: 'Email',
  city: 'City',
  state: 'State',
  date_of_birth: 'DOB',
  gender: 'Gender',
  pincode: 'Pincode',
  highest_qualification: 'Qualification',
  stream: 'Stream',
  percentage: 'Percentage',
  passing_year: 'Passing Year',
  target_intake: 'Intake',
  alternate_phone: 'Alt Phone'
};

function format(value) {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

module.exports = { replies, prettyPhone, subject, tag, LABELS, STAGE_LABELS, shortDate };
