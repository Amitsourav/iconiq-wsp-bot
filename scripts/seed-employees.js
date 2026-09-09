#!/usr/bin/env node
/**
 * Load the employee map: WhatsApp number -> CRM user.
 *
 * The CRM does not store WhatsApp numbers (C9), so this is the only place the two
 * are joined. The numbers here are permanent; the CRM profile ids are not — they
 * are tenant-specific, so this must be re-run against production once a key for
 * the real company exists.
 *
 *   node scripts/seed-employees.js            map onto the sandbox, for testing
 *   node scripts/seed-employees.js --live     match real CRM accounts by email
 */
const db = require('../src/db');
const repo = require('../src/db/repositories');
const { CrmClient } = require('../src/crm/client');
const phoneUtil = require('../src/pipeline/phone');

/** The team, as given by the owner. */
const TEAM = [
  { name: 'Ankit Dubey', email: 'ankit@fundmycampus.com',   phone: '+918130900708' },
  { name: 'Deepak',      email: 'deepak@admitverse.com',    phone: '+917827225354' },
  { name: 'Himanshu',    email: 'hbhatia4216@gmail.com',    phone: '+919311359236' },
  { name: 'Rudra',       email: 'fundmycampus@gmail.com',   phone: '+918766363359' },
  { name: 'Zaid',        email: 'zaid@fundmycampus.com',    phone: '+918796222415' }
];

async function main() {
  const live = process.argv.includes('--live');

  db.init();
  const crm = new CrmClient();
  const users = await crm.loadUsers();

  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
  const fallback = users.find((u) => u.email.includes('whatsapp-ingest')) || users[0];

  console.log(`\nCRM tenant: ${users[0]?.company_name || 'unknown'} — ${users.length} account(s)\n`);

  let matched = 0;
  const unmatched = [];

  for (const person of TEAM) {
    const normalised = phoneUtil.normalise(person.phone);
    if (!normalised.normalised) {
      console.log(`  SKIP  ${person.name} — "${person.phone}" is not a valid Indian mobile`);
      continue;
    }

    const crmUser = byEmail.get(person.email.toLowerCase());

    if (!crmUser && live) {
      // In live mode a missing account is an error, not something to paper over:
      // assigning a lead to the wrong person is worse than not assigning it.
      unmatched.push(person);
      console.log(`  MISS  ${person.name.padEnd(14)} ${normalised.e164}  no CRM account for ${person.email}`);
      continue;
    }

    const target = crmUser || fallback;
    repo.employees.upsert({
      waPhone: normalised.e164,
      crmProfileId: target.id,
      name: person.name,
      email: person.email
    });

    matched += crmUser ? 1 : 0;
    console.log(`  ${crmUser ? 'OK  ' : 'TEST'}  ${person.name.padEnd(14)} ${normalised.e164}`
      + `  -> ${crmUser ? crmUser.email : `${fallback.email} (placeholder)`}`);
  }

  console.log(`\n${repo.employees.all().length} employee(s) mapped, `
    + `${matched} to their real CRM account.`);

  if (unmatched.length) {
    console.log('\nThese have no CRM account in this tenant:');
    for (const p of unmatched) console.log(`  - ${p.name} <${p.email}>`);
    console.log('Create them in the CRM, or correct the email, then re-run.');
  }

  if (!live) {
    console.log('\nSandbox mode: everyone points at a placeholder account so the flow can be');
    console.log('tested. Re-run with --live against a production key before going live.');
  }

  db.close();
}

main().catch((error) => {
  console.error(`Failed: ${error.message}`);
  process.exit(1);
});
