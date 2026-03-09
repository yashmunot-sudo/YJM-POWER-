const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── EXISTING ROUTES ────────────────────────────────────

app.get('/api/cases', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM cases WHERE status != 'closed' ORDER BY created_date DESC`);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.post('/api/cases', async (req, res) => {
  try {
    const { title, domain, priority, outcome, case_type, status } = req.body;
    const result = await pool.query(
      `INSERT INTO cases (title, domain, priority, outcome, case_type, status, is_private)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE((SELECT is_private FROM domains WHERE name=$2),false))
       RETURNING *`,
      [title, domain, priority||'normal', outcome||'', case_type||'execution', status||'planning']
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── UPDATED: PATCH /api/cases/:id — accepts all V5 fields ──
app.patch('/api/cases/:id', async (req, res) => {
  try {
    const { status, outcome_verified, priority, review_action, last_reviewed_at } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;
    if(status !== undefined)           { fields.push(`status=$${idx++}`);             values.push(status); }
    if(outcome_verified !== undefined) { fields.push(`outcome_verified=$${idx++}`);   values.push(outcome_verified); }
    if(priority !== undefined)         { fields.push(`priority=$${idx++}`);           values.push(priority); }
    if(review_action !== undefined)    { fields.push(`review_action=$${idx++}`);      values.push(review_action); }
    if(last_reviewed_at !== undefined) { fields.push(`last_reviewed_at=$${idx++}`);   values.push(last_reviewed_at); }
    fields.push(`updated_date=NOW()`);
    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE cases SET ${fields.join(',')} WHERE case_id=$${idx} RETURNING *`,
      values
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── NEW ROUTE 1: GET /api/cases/:id — single case for outcome not-yet flow ──
app.get('/api/cases/:id', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM cases WHERE case_id=$1`, [req.params.id]);
    if(!result.rows.length) return res.status(404).json({ error: 'Case not found' });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── NEW ROUTE 2: POST /api/cases/:id/verify — outcome verification ──
app.post('/api/cases/:id/verify', async (req, res) => {
  try {
    const { outcome_verified, outcome_proof, status } = req.body;
    if(!outcome_proof || outcome_proof.trim().length < 5) {
      return res.status(400).json({ error: 'outcome_proof is required' });
    }
    const result = await pool.query(
      `UPDATE cases SET
        outcome_verified=$1,
        outcome_proof=$2,
        outcome_verified_at=NOW(),
        status=$3,
        updated_date=NOW()
       WHERE case_id=$4 RETURNING *`,
      [outcome_verified, outcome_proof, status||'review', req.params.id]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── NEW ROUTE 3: GET /api/domains/counts — pending task count per domain ──
app.get('/api/domains/counts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.domain, COUNT(t.task_id) AS pending_count
      FROM cases c
      JOIN tasks t ON t.case_id = c.case_id
      WHERE t.status = 'pending'
        AND c.status != 'closed'
        AND c.domain IS NOT NULL
      GROUP BY c.domain
    `);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── NEW ROUTE 4: GET /api/review/weekly — stale cases for weekly review ──
app.get('/api/review/weekly', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.case_id,
        c.title,
        c.domain,
        c.status,
        c.priority,
        EXTRACT(DAY FROM NOW() - COALESCE(c.last_reviewed_at, c.created_date))::int AS days_idle
      FROM cases c
      WHERE c.status NOT IN ('closed','review')
        AND COALESCE(c.last_reviewed_at, c.created_date) < NOW() - INTERVAL '7 days'
      ORDER BY days_idle DESC
      LIMIT 20
    `);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── NEW ROUTE 5: POST /api/tasks/score/refresh — recalculate priority scores ──
app.post('/api/tasks/score/refresh', async (req, res) => {
  try {
    await pool.query(`SELECT refresh_priority_scores()`);
    res.json({ success: true, message: 'Priority scores refreshed' });
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.get('/api/tasks', async (req, res) => {
  try {
    const { owner_id, case_id } = req.query;
    let q = `SELECT t.*, p.name as owner_name, c.title as case_title, c.domain, c.is_private
             FROM tasks t
             LEFT JOIN people p ON t.owner_id=p.person_id
             LEFT JOIN cases c ON t.case_id=c.case_id
             WHERE 1=1`;
    const params = [];
    if(owner_id){ params.push(owner_id); q+=` AND t.owner_id=$${params.length}`; }
    if(case_id){  params.push(case_id);  q+=` AND t.case_id=$${params.length}`; }
    q+=` ORDER BY COALESCE(t.priority_score,0) DESC, t.impact_score DESC, t.deadline ASC`;
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const { case_id, description, owner_id, execution_mode, deadline, priority,
            impact_score, kajal_instructions, is_urgent, is_important } = req.body;
    const result = await pool.query(
      `INSERT INTO tasks
         (case_id, description, owner_id, execution_mode, deadline, priority,
          impact_score, kajal_instructions, is_urgent, is_important)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [case_id, description, owner_id, execution_mode||'delegate',
       deadline||null, priority||'normal', impact_score||3,
       kajal_instructions||null, is_urgent||false, is_important||false]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.patch('/api/tasks/:id', async (req, res) => {
  try {
    const { status, completion_note } = req.body;
    const result = await pool.query(
      `UPDATE tasks SET status=$1, completion_note=$2, completed_at=NOW(), updated_date=NOW()
       WHERE task_id=$3 RETURNING *`,
      [status, completion_note||null, req.params.id]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.get('/api/people', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM people WHERE is_active=true ORDER BY person_id`);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.get('/api/domains', async (req, res) => {
  try {
    const { user_type } = req.query;
    let q = `SELECT * FROM domains`;
    if(user_type && user_type !== 'yash') q += ` WHERE is_private=false`;
    q += ` ORDER BY domain_id`;
    const result = await pool.query(q);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── UPDATED: GET /api/dashboard/:owner_id — refreshes scores first, returns top 7 by priority_score ──
app.get('/api/dashboard/:owner_id', async (req, res) => {
  try {
    const oid = req.params.owner_id;

    // Refresh priority scores silently before fetching
    try { await pool.query(`SELECT refresh_priority_scores()`); } catch(e) { /* non-fatal */ }

    const [tasks, overdue, blocked, cases] = await Promise.all([
      pool.query(`
        SELECT t.*, p.name as owner_name, c.title as case_title, c.domain, c.is_private
        FROM tasks t
        LEFT JOIN people p ON t.owner_id=p.person_id
        LEFT JOIN cases c ON t.case_id=c.case_id
        WHERE t.owner_id=$1 AND t.status='pending'
        ORDER BY COALESCE(t.priority_score,0) DESC, t.impact_score DESC, t.deadline ASC
        LIMIT 7
      `, [oid]),
      pool.query(`
        SELECT t.*, p.name as owner_name, c.title as case_title
        FROM tasks t
        LEFT JOIN people p ON t.owner_id=p.person_id
        LEFT JOIN cases c ON t.case_id=c.case_id
        WHERE t.deadline < CURRENT_DATE AND t.status NOT IN ('done','cancelled')
      `, []),
      pool.query(`
        SELECT t.*, dep.description as waiting_for, p.name as owner_name
        FROM tasks t
        JOIN tasks dep ON t.depends_on_task_id=dep.task_id
        LEFT JOIN people p ON t.owner_id=p.person_id
        WHERE t.depends_on_task_id IS NOT NULL AND dep.status!='done'
      `, []),
      pool.query(`SELECT * FROM cases WHERE status!='closed' ORDER BY created_date DESC`, [])
    ]);

    res.json({ tasks:tasks.rows, overdue:overdue.rows, blocked:blocked.rows, cases:cases.rows });
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── NEW ROUTE 6: GET /api/resources — external resources list ──
app.get('/api/resources', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM external_resources WHERE is_active=true ORDER BY category, name`
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── NEW ROUTE 7: POST /api/resources — add external resource ──
app.post('/api/resources', async (req, res) => {
  try {
    const { name, category, firm_name, contact_phone, contact_email, speciality, rate_info, notes } = req.body;
    if(!name || !category) return res.status(400).json({ error: 'name and category are required' });
    const result = await pool.query(
      `INSERT INTO external_resources
         (name, category, firm_name, contact_phone, contact_email, speciality, rate_info, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [name, category, firm_name||null, contact_phone||null, contact_email||null,
       speciality||null, rate_info||null, notes||null]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── NEW ROUTE 8: POST /api/calendar/sync — Google Calendar sync (stub, ready for OAuth) ──
app.post('/api/calendar/sync', async (req, res) => {
  try {
    const { events, calendar } = req.body;
    if(!events || !events.length) return res.status(400).json({ error: 'No events provided' });

    // ── Google Calendar OAuth integration ──
    // To activate: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN in Render env vars
    // Then replace this stub with the full OAuth flow below

    if(!process.env.GOOGLE_REFRESH_TOKEN) {
      // Stub: log and return success so frontend does not break
      console.log(`[Calendar Sync] ${events.length} events received — OAuth not yet configured`);
      events.forEach(e => console.log(`  → [${e.owner}] ${e.title} on ${e.date}`));
      return res.json({ success: true, synced: 0, message: 'Stub — configure Google OAuth to activate' });
    }

    // Full OAuth flow (activates once env vars are set):
    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'https://developers.google.com/oauthplayground'
    );
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const gcal = google.calendar({ version: 'v3', auth: oauth2Client });

    const results = [];
    for(const event of events) {
      try {
        const created = await gcal.events.insert({
          calendarId: 'primary',
          requestBody: {
            summary: event.title,
            description: event.description || '',
            start: { date: event.date },
            end:   { date: event.date },
            colorId: event.owner === 'Yash' ? '5' : '1'
          }
        });
        results.push({ title: event.title, eventId: created.data.id, status: 'created' });
      } catch(err) {
        results.push({ title: event.title, status: 'failed', error: err.message });
      }
    }

    const synced = results.filter(r => r.status === 'created').length;
    res.json({ success: true, synced, total: events.length, results });

  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── EXISTING: AI generate (legacy route kept for compatibility) ──
app.post('/api/ai/generate', async (req, res) => {
  try {
    const { description, domain, outcome } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'No API key', fallback: true });
    if (!description) return res.status(400).json({ error: 'description required' });
    const prompt = `You are the AI Chief of Staff for Yash J. Munot, CEO of Varsha Forgings, Pune, India.\nDomain: ${domain||'Business'}\nProblem: ${description}\nOutcome: ${outcome||'Not specified'}\n\nRespond in valid JSON only:\n{"title":"case title","outcome":"measurable outcome","priority":"normal|high|critical|low","tasks":[{"description":"action","owner":"Yash|Fazal|Sanjay|Deepak|Kajal","execution_mode":"self|delegate|outsource","impact_score":3}]}`;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await r.json();
    const text = d.content[0].text.trim().replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    res.json(JSON.parse(text));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EXISTING: Setup route ──
app.get('/api/setup', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS domains (domain_id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, icon TEXT, is_private BOOLEAN NOT NULL DEFAULT FALSE, context_notes TEXT);
      CREATE TABLE IF NOT EXISTS people (person_id SERIAL PRIMARY KEY, name TEXT NOT NULL, role TEXT, person_type TEXT NOT NULL DEFAULT 'team', whatsapp_number TEXT, email TEXT, access_level TEXT NOT NULL DEFAULT 'own_tasks', can_see_private BOOLEAN NOT NULL DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE);
      CREATE TABLE IF NOT EXISTS cases (case_id SERIAL PRIMARY KEY, title TEXT NOT NULL, domain TEXT, is_private BOOLEAN NOT NULL DEFAULT FALSE, case_type TEXT NOT NULL DEFAULT 'execution', priority TEXT NOT NULL DEFAULT 'normal', outcome TEXT, outcome_verified BOOLEAN DEFAULT FALSE, status TEXT NOT NULL DEFAULT 'new', ai_summary TEXT, created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, closed_date TIMESTAMP);
      CREATE TABLE IF NOT EXISTS tasks (task_id SERIAL PRIMARY KEY, case_id INTEGER REFERENCES cases(case_id), description TEXT NOT NULL, kajal_instructions TEXT, completion_note TEXT, owner_id INTEGER REFERENCES people(person_id), execution_mode TEXT NOT NULL DEFAULT 'delegate', deadline DATE, priority TEXT DEFAULT 'normal', impact_score INTEGER DEFAULT 3, status TEXT NOT NULL DEFAULT 'pending', depends_on_task_id INTEGER REFERENCES tasks(task_id), whatsapp_sent BOOLEAN DEFAULT FALSE, completed_at TIMESTAMP, created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    `);
    await pool.query(`
      INSERT INTO domains (name,icon,is_private) VALUES
      ('Business','⚙️',false),('Customer','🤝',false),('Strategy','🎯',false),
      ('Operations','🏭',false),('Finance','💰',false),('AIFI','🏛️',false),
      ('Legal','⚖️',false),('Wealth','📈',true),('Health','❤️',true),('Neha','💗',true)
      ON CONFLICT (name) DO NOTHING;
    `);
    await pool.query(`
      INSERT INTO people (name,role,person_type,access_level,can_see_private) VALUES
      ('Yash','CEO','yash','full',true),
      ('Fazal','Operations + Purchase','team','own_tasks',false),
      ('Sanjay','Logistics + Sales','team','own_tasks',false),
      ('Deepak','Accounts','team','own_tasks',false),
      ('Kajal','EA — Coordination','kajal','own_tasks',false)
      ON CONFLICT DO NOTHING;
    `);
    res.json({ message: 'Setup complete' });
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`YJM Power running on port ${PORT}`));
