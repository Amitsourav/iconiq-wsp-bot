/**
 * Admin panel HTTP API.
 *
 * Everything except /api/auth/login and the static files requires a JWT.
 */
const http = require('http');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const { config } = require('../config');
const logger = require('../logger');
const repo = require('../db/repositories');
const phoneUtil = require('../pipeline/phone');

/** Verify the bearer token. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    req.user = jwt.verify(header.slice(7), config.auth.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired' });
  }
}

/** Wrap an async handler so a rejection becomes a 500 rather than a hang. */
const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((error) => {
    logger.error(`API ${req.method} ${req.path}: ${error.message}`);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  });
};

/**
 * @param {{ whatsapp: object, crm: object, orchestrator: object }} deps
 * @returns {import('http').Server}
 */
function createServer({ whatsapp, crm, orchestrator, jobs = {} }) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // ---- health -------------------------------------------------------------
  // Unauthenticated, for the platform's deploy check. Deliberately says nothing
  // about the CRM, the number, or the data.
  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      whatsapp: whatsapp.state,
      uptime: Math.floor(process.uptime())
    });
  });

  // ---- auth ---------------------------------------------------------------
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username !== config.auth.user || password !== config.auth.pass) {
      // Deliberately vague: do not reveal which half was wrong.
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = jwt.sign({ username }, config.auth.jwtSecret, {
      expiresIn: config.auth.tokenTtl
    });
    res.json({ token, username });
  });

  const api = express.Router();
  api.use(requireAuth);

  // ---- connection ---------------------------------------------------------
  api.get('/status', (req, res) => {
    res.json({
      whatsapp: whatsapp.status(),
      crm: { configured: crm.configured, users: crm.users?.size || 0 },
      sendingPaused: repo.settings.get('sending_paused') === 'true',
      counts: {
        held: repo.leads.held().length,
        pending: repo.leads.pending(999).length,
        // Chats we are answering but cannot identify, so no lead exists for them.
        unidentified: repo.dmThreads.unidentified(999).length
      }
    });
  });

  /**
   * Link a different number after WhatsApp ended the session.
   *
   * Only reachable once the state is `logged_out` — the client refuses
   * otherwise, so this can never discard a session that still works.
   */
  api.post('/whatsapp/relink', wrap(async (req, res) => {
    try {
      const { archivedTo } = await whatsapp.relink();
      logger.warn(`Relink requested from the admin panel by ${req.user?.username}`);
      res.json({ ok: true, archivedTo, whatsapp: whatsapp.status() });
    } catch (error) {
      // A refusal here is the guard doing its job, not a server fault.
      res.status(409).json({ error: error.message });
    }
  }));

  /**
   * Unlink the bot's device from WhatsApp, so it can be linked again.
   *
   * For a session that is broken but still logged in — "connected", yet
   * delivering nothing. Needs an explicit confirmation in the body, because it
   * ends with a QR that someone has to scan from the phone.
   */
  api.post('/whatsapp/logout', wrap(async (req, res) => {
    if (req.body?.confirm !== 'LOGOUT') {
      return res.status(400).json({ error: 'Send {"confirm":"LOGOUT"} to log the bot out' });
    }
    try {
      await whatsapp.logout();
      logger.warn(`WhatsApp logged out from the admin panel by ${req.user?.username}`);
      res.json({ ok: true, whatsapp: whatsapp.status() });
    } catch (error) {
      res.status(409).json({ error: error.message });
    }
  }));

  /** Kill switch (S4) — silences replies, never capture. */
  api.post('/sending/:action', (req, res) => {
    const paused = req.params.action === 'pause';
    repo.settings.set('sending_paused', paused ? 'true' : 'false');
    logger.warn(`Sending ${paused ? 'PAUSED' : 'resumed'} from the admin panel`);
    res.json({ sendingPaused: paused });
  });

  /**
   * Send a scheduled report now.
   *
   * The same job the scheduler runs, so what you see is exactly what the group
   * will get at 9am — not a preview that might differ. It does not touch the
   * scheduler's record of the day, so the scheduled run still happens.
   */
  api.post('/reports/:name/run', wrap(async (req, res) => {
    const job = jobs[req.params.name];
    if (!job) {
      return res.status(404).json({
        error: `Unknown report. Available: ${Object.keys(jobs).join(', ')}`
      });
    }

    logger.info(`Report "${req.params.name}" run manually from the panel`);
    const result = await job();
    res.json({ ok: true, sent: Boolean(result), result: result || null });
  }));

  // ---- groups -------------------------------------------------------------
  api.get('/groups', wrap(async (req, res) => {
    // Refresh names from WhatsApp so the list reflects reality, then return ours.
    if (whatsapp.connected) {
      for (const g of await whatsapp.listGroups()) repo.groups.upsert(g.id, g.name);
    }
    res.json({ groups: repo.groups.all() });
  }));

  api.put('/groups/:id', (req, res) => {
    const id = Number(req.params.id);
    const { is_active: isActive, purpose, send_enabled: sendEnabled } = req.body || {};

    if (purpose !== undefined) repo.groups.setPurpose(id, purpose);
    if (req.body?.bank_name !== undefined) repo.groups.setBank(id, req.body.bank_name);
    if (isActive !== undefined) repo.groups.setActive(id, isActive);
    // Set last: a bank purpose forces sending off, and that must win.
    if (sendEnabled !== undefined) repo.groups.setSendEnabled(id, sendEnabled);

    const group = repo.groups.all().find((g) => g.id === id);
    res.json({ group });
  });

  // ---- employees ----------------------------------------------------------
  /** The CRM's canonical bank list, for the group screen's dropdown. */
  api.get('/banks', wrap(async (req, res) => {
    const banks = await crm.request('GET', '/leads/banks').catch(() => []);
    res.json({ banks: Array.isArray(banks) ? banks : (banks.banks || []) });
  }));

  api.get('/bank-shares', (req, res) => {
    res.json({ shares: repo.bankShares.recent(Number(req.query.limit) || 50) });
  });

  api.get('/employees', (req, res) => {
    res.json({ employees: repo.employees.all() });
  });

  /** The CRM's own user list, to seed the map (C9 — it has no phone numbers). */
  api.get('/crm/users', wrap(async (req, res) => {
    const users = await crm.loadUsers();
    res.json({ users });
  }));

  api.post('/employees', (req, res) => {
    const { wa_phone: waPhone, crm_profile_id: crmProfileId, name, email } = req.body || {};

    const normalised = phoneUtil.normalise(waPhone);
    if (!normalised.normalised) {
      return res.status(400).json({
        error: 'Enter a valid Indian mobile number, e.g. 9876543210'
      });
    }
    if (!crmProfileId || !name) {
      return res.status(400).json({ error: 'A CRM user and a name are required' });
    }

    res.json({
      employee: repo.employees.upsert({
        waPhone: normalised.e164, crmProfileId, name, email
      })
    });
  });

  api.delete('/employees/:id', (req, res) => {
    repo.employees.remove(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---- leads --------------------------------------------------------------
  api.get('/leads', (req, res) => {
    res.json({ leads: repo.leads.recent(Number(req.query.limit) || 50) });
  });

  api.get('/leads/held', (req, res) => {
    res.json({ leads: repo.leads.held() });
  });

  /**
   * Conversations with no phone number, and so no lead.
   *
   * These are real customers being answered by the bot. Surfacing them is the
   * whole point: an unidentified chat that nobody can see is indistinguishable
   * from a customer who never wrote.
   */
  /**
   * Start a chat over.
   *
   * The next message from that number is treated as a first contact: it gets
   * the greeting again and walks the script from the top. Used when a
   * conversation has gone wrong, or to test the opening without finding a phone
   * that has never written in.
   *
   * Our local copy of the chat goes; the CRM keeps the lead and everything
   * already sent to it.
   */
  api.post('/dm/reset', (req, res) => {
    const { chat } = req.body || {};
    const thread = repo.dmThreads.find(chat);

    if (!thread) {
      return res.status(404).json({ error: `No chat found for "${chat}"` });
    }

    const { messages } = repo.dmThreads.reset(thread.chat_id);
    logger.warn(`Chat ${thread.chat_id} (${thread.phone || 'no number'}) reset from `
      + `the admin panel by ${req.user?.username} — ${messages} message(s) cleared`);

    res.json({ ok: true, chatId: thread.chat_id, phone: thread.phone, messages });
  });

  api.get('/dm/unidentified', (req, res) => {
    res.json({ chats: repo.dmThreads.unidentified(Number(req.query.limit) || 50) });
  });

  /** Assign a held lead by hand, then push it immediately. */
  api.post('/leads/:id/assign', wrap(async (req, res) => {
    const lead = repo.leads.byId(Number(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const { employee_id: employeeId, name } = req.body || {};
    const employee = repo.employees.all().find((e) => e.id === Number(employeeId));
    if (!employee) return res.status(400).json({ error: 'Unknown employee' });

    // A held lead may have been waiting precisely because it had no name.
    if (name) {
      require('../db').get()
        .prepare('UPDATE leads SET name = ? WHERE id = ?').run(name, lead.id);
    }

    const updated = repo.leads.byId(lead.id);
    if (!updated.name) {
      return res.status(400).json({ error: 'This lead still needs a name' });
    }

    repo.leads.assign(lead.id, employee.id, employee.wa_phone);

    const group = repo.groups.all().find((g) => g.id === lead.group_id);
    await orchestrator.pushLead(repo.leads.byId(lead.id), null, group, undefined);

    res.json({ lead: repo.leads.byId(lead.id) });
  }));

  // ---- diagnostics --------------------------------------------------------
  /** Counts by reason — the fastest way to see what the bot is not understanding. */
  api.get('/skipped', (req, res) => {
    res.json({
      reasons: repo.skipped.reasonCounts(),
      recent: repo.skipped.recent(Number(req.query.limit) || 100)
    });
  });

  api.get('/logs', (req, res) => {
    res.json({ logs: repo.logs.recent(Number(req.query.limit) || 200) });
  });

  app.use('/api', api);

  // ---- static panel -------------------------------------------------------
  const webRoot = path.join(__dirname, '..', '..', 'web');
  app.use(express.static(webRoot));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(webRoot, 'index.html'), (error) => {
      if (error) res.status(404).json({ error: 'Admin panel not built' });
    });
  });

  return http.createServer(app);
}

module.exports = { createServer, requireAuth };
