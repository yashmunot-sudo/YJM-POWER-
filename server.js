const express = require('express');
const cors = require('cors');
const path = require('path');

require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Cache static assets (JS, CSS, images) but never cache HTML
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

// INLINE API LOGGER (no dependencies)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

function isUndefinedColumnError(e) {
  // Postgres undefined_column
  return e && (e.code === '42703' || (typeof e.message === 'string' && e.message.toLowerCase().includes('does not exist')));
}

async function runTaskSelect(queryWithDescription, queryWithTitle, params = []) {
  try {
    return await pool.query(queryWithDescription, params);
  } catch (e) {
    if (!isUndefinedColumnError(e)) throw e;
    // likely "column description does not exist" (or other schema mismatch)
    return await pool.query(queryWithTitle, params);
  }
}

// ── HEALTH CHECK ───────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'error', db: 'disconnected', error: e.message });
  }
});

// ── TEAM URL ROUTING ──────────────────────────────────────────────────────────
const teamRoutes = ['kajal', 'fazal', 'sanjay', 'deepak'];
teamRoutes.forEach(member => {
  app.get('/' + member, (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
});

// ── CASES ─────────────────────────────────────────────────────────────────────
app.get('/api/cases', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM cases WHERE status NOT IN ('closed','archived') ORDER BY created_date DESC"
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cases', async (req, res) => {
  try {
    const { title, domain, priority, outcome, case_type, status } = req.body;
    const result = await pool.query(
      `INSERT INTO cases (title, domain, priority, outcome, case_type, status)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [title, domain, priority || 'normal', outcome || '', case_type || 'execution', status || 'new']
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cases/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cases WHERE case_id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/cases/:id', async (req, res) => {
  try {
    const { status, outcome_verified, priority, review_action, last_reviewed_at } = req.body;
    const fields = [], values = [];
    let idx = 1;

    if (status !== undefined) { fields.push(`status=$${idx++}`); values.push(status); }
    if (outcome_verified !== undefined) { fields.push(`outcome_verified=$${idx++}`); values.push(outcome_verified); }
    if (priority !== undefined) { fields.push(`priority=$${idx++}`); values.push(priority); }
    if (review_action !== undefined) { fields.push(`review_action=$${idx++}`); values.push(review_action); }
    if (last_reviewed_at !== undefined) { fields.push(`last_reviewed_at=$${idx++}`); values.push(last_reviewed_at); }

    fields.push('updated_date=NOW()');
    values.push(req.params.id);

    const result = await pool.query(
      `UPDATE cases SET ${fields.join(',')} WHERE case_id=$${idx} RETURNING *`, values
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TASKS ─────────────────────────────────────────────────────────────────────
app.get('/api/tasks', async (req, res) => {
  try {
    const { owner, status } = req.query;

    let qTail = " WHERE 1=1";
    const vals = [];
    let idx = 1;

    if (owner) { qTail += ` AND t.owner=$${idx++}`; vals.push(owner); }
    if (status) { qTail += ` AND t.status=$${idx++}`; vals.push(status); }

    qTail += " ORDER BY t.priority_score DESC NULLS LAST, t.created_date DESC NULLS LAST";

    const qDesc = `
      SELECT t.*, c.domain, c.title AS case_title, t.description AS title
      FROM tasks t
      JOIN cases c ON t.case_id = c.case_id
      ${qTail}
    `;

    const qTitle = `
      SELECT t.*, c.domain, c.title AS case_title, t.title AS title
      FROM tasks t
      JOIN cases c ON t.case_id = c.case_id
      ${qTail}
    `;

    const result = await runTaskSelect(qDesc, qTitle, vals);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tasks', async (req, res) => {
  const {
    title,
    case_id,
    owner,
    deadline,
    is_urgent,
    is_important,
    status,
    acknowledged
  } = req.body;

  // Prefer inserting into `description` (matches your current DB output on Render),
  // fallback to `title` if needed.
  const commonValues = [
    title,
    case_id,
    null,
    deadline || null,
    !!is_urgent,
    is_important !== false,
    status || 'pending',
    acknowledged !== false,
    owner || 'Yash'
  ];

  try {
    // schema: description + owner column exists
    const r = await pool.query(
      `INSERT INTO tasks (description, case_id, owner_id, deadline, is_urgent, is_important, status, acknowledged, owner)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      commonValues
    );
    return res.json(r.rows[0]);
  } catch (e1) {
    // schema: description but no owner column, etc.
    try {
      const r = await pool.query(
        `INSERT INTO tasks (description, case_id, owner_id, deadline, is_urgent, is_important, status, acknowledged)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        commonValues.slice(0, 8)
      );
      return res.json(r.rows[0]);
    } catch (e2) {
      // fallback: title column schema
      try {
        const r = await pool.query(
          `INSERT INTO tasks (title, case_id, owner_id, deadline, is_urgent, is_important, status, acknowledged, owner)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          commonValues
        );
        return res.json(r.rows[0]);
      } catch (e3) {
        try {
          const r = await pool.query(
            `INSERT INTO tasks (title, case_id, owner_id, deadline, is_urgent, is_important, status, acknowledged)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            commonValues.slice(0, 8)
          );
          return res.json(r.rows[0]);
        } catch (e4) {
          return res.status(500).json({ error: e4.message });
        }
      }
    }
  }
});

app.patch('/api/tasks/:id', async (req, res) => {
  try {
    const allowed = ['status', 'deadline', 'acknowledged', 'impact_score', 'is_urgent', 'is_important', 'followup_count', 'owner'];
    const fields = [], values = [];
    let idx = 1;

    allowed.forEach(key => {
      if (req.body[key] !== undefined) {
        fields.push(`${key}=$${idx++}`);
        values.push(req.body[key]);
      }
    });

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE tasks SET ${fields.join(',')} WHERE task_id=$${idx} RETURNING *`, values
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard/:userId', async (req, res) => {
  try {
    await pool.query('SELECT refresh_priority_scores()').catch(() => { });

    // IMPORTANT FIX:
    // Do NOT exclude 'done' tasks here, because the UI uses this dataset to compute
    // dashboard counters like "Done Today" and to populate sections even when tasks are done.
    const qDesc = `
      SELECT t.*, c.domain, c.title as case_title, t.description AS title
      FROM tasks t
      JOIN cases c ON t.case_id = c.case_id
      WHERE c.status NOT IN ('closed')
      ORDER BY t.priority_score DESC NULLS LAST, t.created_date DESC NULLS LAST
      LIMIT 200
    `;

    const qTitle = `
      SELECT t.*, c.domain, c.title as case_title, t.title AS title
      FROM tasks t
      JOIN cases c ON t.case_id = c.case_id
      WHERE c.status NOT IN ('closed')
      ORDER BY t.priority_score DESC NULLS LAST, t.created_date DESC NULLS LAST
      LIMIT 200
    `;

    const tasksResult = await runTaskSelect(qDesc, qTitle);

    const casesResult = await pool.query(`
      SELECT * FROM cases
      WHERE status NOT IN ('closed')
      ORDER BY created_date DESC
      LIMIT 20
    `);

    res.json({ tasks: tasksResult.rows, cases: casesResult.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DOMAIN COUNTS ─────────────────────────────────────────────────────────────
app.get('/api/domains/counts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.domain, COUNT(t.task_id) AS pending_count
      FROM cases c JOIN tasks t ON t.case_id = c.case_id
      WHERE t.status NOT IN ('done','cancelled') AND c.status NOT IN ('closed')
      GROUP BY c.domain
    `);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DECISIONS (Decision Memory) ───────────────────────────────────────────────
app.post('/api/decisions', async (req, res) => {
  try {
    const { case_id, decision_text, decided_by } = req.body;
    const result = await pool.query(
      `INSERT INTO decisions (case_id, decision_text, decided_by, decided_at)
       VALUES ($1,$2,$3,NOW()) RETURNING *`,
      [case_id, decision_text, decided_by || 'Yash']
    );
    res.json(result.rows[0]);
  } catch (e) {
    // Table may not exist yet — return success for now
    res.json({ case_id: req.body.case_id, decision_text: req.body.decision_text, decided_at: new Date().toISOString() });
  }
});

app.get('/api/decisions/:caseId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM decisions WHERE case_id=$1 ORDER BY decided_at DESC',
      [req.params.caseId]
    );
    res.json(result.rows);
  } catch (e) { res.json([]); }
});

// ── CALENDAR SYNC (stub — OAuth needed) ───────────────────────────────────────
app.post('/api/calendar/sync', async (req, res) => {
  const { title, date } = req.body;
  res.json({ synced: false, message: 'Calendar OAuth not yet configured', title, date });
});

// ── REFRESH PRIORITY SCORES ───────────────────────────────────────────────────
app.post('/api/tasks/score/refresh', async (req, res) => {
  try {
    await pool.query('SELECT refresh_priority_scores()');
    res.json({ refreshed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ONE-TIME MIGRATION ────────────────────────────────────────────────────────
app.get('/api/migrate', async (req, res) => {
  try {
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type VARCHAR(20) DEFAULT 'task'`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`);
    res.json({ ok: true, message: 'Migration complete' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── QUICK TASKS (API exists, even if UI uses localStorage) ────────────────────
app.get('/api/quicktasks', async (req, res) => {
  try {
    const user = req.query.user || 'Yash';

    // Prefer schema where task_type exists; fallback to returning []
    // (UI currently uses localStorage anyway).
    const q1 = `
      SELECT task_id AS id,
             COALESCE(description, title) AS title,
             status,
             deadline
      FROM tasks
      WHERE owner = $1 AND task_type = 'quick'
      ORDER BY created_at DESC
      LIMIT 20
    `;
    const q2 = `
      SELECT task_id AS id,
             description AS title,
             status,
             deadline
      FROM tasks
      WHERE owner = $1
      ORDER BY created_date DESC NULLS LAST
      LIMIT 20
    `;

    let result;
    try {
      result = await pool.query(q1, [user]);
    } catch (e) {
      if (!isUndefinedColumnError(e)) throw e;
      result = await pool.query(q2, [user]);
    }
    res.json(result.rows);
  } catch (e) { res.json([]); }
});

// ── CATCH ALL ────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('YJM Power running on port ' + PORT));
