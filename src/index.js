/**
 * Entry point. Starts the database, the CRM client, WhatsApp, the pipeline, the
 * retry worker, and the admin panel — then shuts them down cleanly.
 *
 * Order matters: the admin panel comes up before WhatsApp connects, so the QR or
 * pairing code has somewhere to appear. WhatsApp failing must never stop the
 * panel — that is where you go to fix it.
 */
const { config, validate } = require('./config');
const logger = require('./logger');
const db = require('./db');
const repo = require('./db/repositories');
const { CrmClient } = require('./crm/client');
const { WhatsAppClient } = require('./whatsapp/client');
const { Orchestrator } = require('./pipeline/orchestrator');
const { RetryWorker } = require('./pipeline/worker');
const { DailyScheduler } = require('./pipeline/scheduler');
const { buildMorningMessage } = require('./pipeline/digest');
const { syncDmConversations } = require('./pipeline/dmSync');
const { createServer } = require('./api/server');

async function main() {
  const { fatal, warnings } = validate();

  for (const warning of warnings) logger.warn(warning);

  if (fatal.length) {
    for (const problem of fatal) logger.error(problem);
    logger.error('Refusing to start. Fix the above in .env and try again.');
    process.exit(1);
  }

  db.init();

  // Mirror logs into the database so the panel can show them after a restart.
  logger.subscribe(({ level, message }) => {
    try {
      repo.logs.record(level, message, config.logging.retainInDb);
    } catch {
      // Never let a logging failure break the thing being logged.
    }
  });

  const crm = new CrmClient();
  const whatsapp = new WhatsAppClient();
  const orchestrator = new Orchestrator({ crm, whatsapp });
  const worker = new RetryWorker({ orchestrator });

  /**
   * The scheduled reports, as named jobs.
   *
   * Declared here because the API server is created before they are defined, and
   * it holds a reference so the panel can send one on demand. Filled in below.
   */
  const jobs = {};

  if (crm.configured) {
    try {
      // Refuses to continue if the key resolves to a different company: the same
      // email exists in both tenants as different people, so a mis-set key would
      // assign leads to the wrong person entirely.
      const me = await crm.verifyTenant();
      await crm.loadUsers();
      logger.info(`CRM connected as ${me.email} — ${me.company_name} (${me.company_id})`);
    } catch (error) {
      if (/Wrong CRM tenant/.test(error.message)) {
        logger.error(error.message);
        logger.error('Refusing to start rather than write to the wrong company.');
        process.exit(1);
      }
      // Not fatal: leads are still captured and retried once the CRM returns.
      logger.error(`CRM unreachable at startup: ${error.message}`);
      logger.warn('Leads will be captured and retried until it is back.');
    }
  } else {
    logger.warn('CRM is not configured — leads will be captured but not sent.');
  }

  // Group messages go through the full lead pipeline. Direct messages (1-on-1
  // chats to the bot's own number) never carried a lead pipeline at all, so
  // they go to the AI assistant instead. The raw message is passed through so
  // replies can quote it.
  whatsapp.on('message', (message, raw) => {
    if (message.isGroup) return orchestrator.handle(message, raw);
    return orchestrator.handleDirect(message, raw);
  });

  // A reconnect means there was a window where WhatsApp may have pushed messages
  // to a connection that was no longer listening. It will not tell us what we
  // missed, so we ask the phone to replay from the last message we recorded.
  whatsapp.on('gap', async ({ seconds }) => {
    for (const group of repo.groups.active()) {
      if (!group.last_message_id) continue;
      await whatsapp.requestHistory({
        waGroupId: group.wa_group_id,
        lastMessageId: group.last_message_id,
        lastMessageTs: group.last_message_ts,
        lastFromMe: Boolean(group.last_message_from_me)
      }, seconds > 120 ? 100 : 30);
    }
  });

  whatsapp.on('ready', async () => {
    try {
      const groups = await whatsapp.listGroups();
      for (const group of groups) repo.groups.upsert(group.id, group.name);

      const active = repo.groups.active();
      logger.info(`In ${groups.length} group(s); monitoring ${active.length}`);
      for (const group of active) {
        logger.info(`  monitoring: ${group.name} (${group.purpose}, `
          + `sending ${group.send_enabled ? 'on' : 'off'})`);
      }
      if (active.length === 0) {
        // Not a warning: this deployment answers direct messages and monitors no
        // groups by design. It fired on every reconnect — hourly — which is how
        // a log stops being read. Turn a group on in the panel to change it.
        logger.info('No groups monitored — direct messages only.');
      }
    } catch (error) {
      logger.error(`Could not list groups: ${error.message}`);
    }
  });

  const server = createServer({ whatsapp, crm, orchestrator, jobs });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(`Port ${config.server.port} is already in use.`);
      logger.error('Another copy of the bot is probably running. Stop it first —');
      logger.error(`  lsof -ti:${config.server.port} | xargs kill`);
      logger.error('Two copies must never run against the same WhatsApp number.');
    } else {
      logger.error(`Server error: ${error.message}`);
    }
    process.exit(1);
  });

  server.listen(config.server.port, config.server.host, () => {
    logger.info(`Admin panel on http://${config.server.host}:${config.server.port}`);
  });

  worker.start();

  // Yesterday's summary, posted into each monitored group that has replies on.
  // Nothing is posted on a day with no leads — a summary reading "0" every
  // morning trains people to ignore the bot.
  // Exposed to the API as well as the scheduler: a report someone can only
  // receive at 9am is a report they cannot check.
  jobs['morning-summary'] = async () => {
      if (repo.settings.get('sending_paused') === 'true') {
        logger.info('Sending is paused — skipping the daily summary');
        return;
      }

      const summary = await buildMorningMessage(crm);
      if (!summary) {
        logger.info('Nothing to report this morning — no message posted');
        return;
      }

      let posted = 0;
      for (const group of repo.groups.active()) {
        if (!group.send_enabled || group.purpose !== 'inhouse') continue;
        await whatsapp.reply({ groupId: group.wa_group_id, text: summary.text });
        posted += 1;
      }

      const figures = `${summary.leads} lead(s), ${summary.untouched} untouched, `
        + `${summary.due} follow-up(s)`;

      // Counted rather than assumed. This used to report success whatever
      // happened, so on a DM-only deployment — no in-house group to post into —
      // the log said the summary had gone out every morning while nobody had
      // ever received one.
      if (posted) {
        logger.info(`Morning message posted to ${posted} group(s): ${figures}`);
      } else {
        logger.warn(`Morning summary built but not posted — no in-house group has `
          + `sending on. It said: ${figures}`);
      }

      return summary;
  };

  const digest = new DailyScheduler({
    name: 'daily-summary',
    at: process.env.DAILY_SUMMARY_AT || '09:00',
    run: jobs['morning-summary']
  });
  digest.start();

  // The month-to-date loan MIS is NOT scheduled here. It reports a loan
  // pipeline's counsellors against a PF target — the FundMyCampus bot's job, not
  // this one's. It was scheduled here once, and because its four configured
  // emails belong to that other tenant it resolved nobody and logged an error
  // every single evening. `buildLoanMis` remains in pipeline/digest.js for
  // whoever wants it; nothing in this service calls it.

  // Push the day's DM chatbot conversations into the CRM: one remark per
  // customer, carrying their name, phone, and the transcript since the last
  // sync — so the team can see what a chat covered without opening WhatsApp.
  // Exposed via jobs too, so the panel can trigger it on demand.
  jobs['dm-crm-sync'] = () => syncDmConversations(crm, { selfPhone: whatsapp.selfPhone });

  const dmSync = new DailyScheduler({
    name: 'dm-crm-sync',
    at: config.dmSync.at,
    run: jobs['dm-crm-sync']
  });
  dmSync.start();

  // WhatsApp last, and non-blocking: if it fails, the panel is still up to fix it.
  whatsapp.connect({ pairingPhone: process.env.WA_PAIRING_PHONE }).catch((error) => {
    logger.error(`WhatsApp failed to start: ${error.message}`);
    logger.warn('The admin panel is still running.');
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} — shutting down`);

    worker.stop();
    digest.stop();
    dmSync.stop();
    await whatsapp.disconnect().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A crash that takes the process down loses the WhatsApp connection, so log
  // loudly and keep running wherever it is safe to.
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason?.stack || reason}`);
  });
}

main().catch((error) => {
  logger.error(`Fatal: ${error.stack || error.message}`);
  process.exit(1);
});
