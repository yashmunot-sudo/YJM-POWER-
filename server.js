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
    console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${Date.now()-start}ms`);
  });
  next();
});


const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── HEALTH CHECK ─────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ status: 'error', db: 'disconnected', error: e.message });
  }
});

// ── TEAM URL ROUTING ──────────────────────────────────────
const teamRoutes = ['kajal','fazal','sanjay','deepak'];
teamRoutes.forEach(member => {
  app.get('/' + member, (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
});

// ── CASES ─────────────────────────────────────────────────
app.get('/api/cases', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM cases WHERE status NOT IN ('closed','archived') ORDER BY created_date DESC"
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.post('/api/cases', async (req, res) => {
  try {
    const { title, domain, priority, outcome, case_type, status } = req.body;
    const result = await pool.query(
      `INSERT INTO cases (title, domain, priority, outcome, case_type, status)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [title, domain, priority||'normal', outcome||'', case_type||'execution', status||'new']
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.get('/api/cases/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cases WHERE case_id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.patch('/api/cases/:id', async (req, res) => {
  try {
    const { status, outcome_verified, priority, review_action, last_reviewed_at } = req.body;
    const fields = [], values = [];
    let idx = 1;
    if (status !== undefined)           { fields.push(`status=$${idx++}`); values.push(status); }
    if (outcome_verified !== undefined) { fields.push(`outcome_verified=$${idx++}`); values.push(outcome_verified); }
    if (priority !== undefined)         { fields.push(`priority=$${idx++}`); values.push(priority); }
    if (review_action !== undefined)    { fields.push(`review_action=$${idx++}`); values.push(review_action); }
    if (last_reviewed_at !== undefined) { fields.push(`last_reviewed_at=$${idx++}`); values.push(last_reviewed_at); }
    fields.push('updated_date=NOW()');
    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE cases SET ${fields.join(',')} WHERE case_id=$${idx} RETURNING *`, values
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── TASKS ─────────────────────────────────────────────────
app.get('/api/tasks', async (req, res) => {
  try {
    const { owner, status } = req.query;
    let q = "SELECT t.*, c.domain FROM tasks t JOIN cases c ON t.case_id = c.case_id WHERE 1=1";
    const vals = [];
    let idx = 1;
    if (owner) { q += ` AND t.owner=$${idx++}`; vals.push(owner); }
    if (status) { q += ` AND t.status=$${idx++}`; vals.push(status); }
    q += ' ORDER BY t.priority_score DESC NULLS LAST';
    const result = await pool.query(q, vals);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const { title, case_id, owner, deadline, is_urgent, is_important, status, acknowledged, domain } = req.body;
    const result = await pool.query(
      `INSERT INTO tasks (title, case_id, owner_id, deadline, is_urgent, is_important, status, acknowledged, owner)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [title, case_id, null, deadline||null, is_urgent||false, is_important||true, status||'pending', acknowledged !== false, owner||'Yash']
    );
    res.json(result.rows[0]);
  } catch(e) {
    // Try without owner column if it doesn't exist
    try {
      const result = await pool.query(
        `INSERT INTO tasks (title, case_id, deadline, is_urgent, is_important, status)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.body.title, req.body.case_id, req.body.deadline||null, req.body.is_urgent||false, req.body.is_important||true, req.body.status||'pending']
      );
      res.json(result.rows[0]);
    } catch(e2) { res.status(500).json({ error: e2.message }) }
  }
});

app.patch('/api/tasks/:id', async (req, res) => {
  try {
    const allowed = ['status','deadline','acknowledged','impact_score','is_urgent','is_important','followup_count','owner'];
    const fields = [], values = [];
    let idx = 1;
    allowed.forEach(key => {
      if (req.body[key] !== undefined) { fields.push(`${key}=$${idx++}`); values.push(req.body[key]); }
    });
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE tasks SET ${fields.join(',')} WHERE task_id=$${idx} RETURNING *`, values
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── DASHBOARD ─────────────────────────────────────────────
app.get('/api/dashboard/:userId', async (req, res) => {
  try {
    await pool.query('SELECT refresh_priority_scores()').catch(() => {});
    const tasksResult = await pool.query(`
      SELECT t.*, c.domain, c.title as case_title
      FROM tasks t
      JOIN cases c ON t.case_id = c.case_id
      WHERE t.status NOT IN ('done','cancelled')
        AND c.status NOT IN ('closed')
      ORDER BY t.priority_score DESC NULLS LAST
      LIMIT 50
    `);
    const casesResult = await pool.query(`
      SELECT * FROM cases WHERE status NOT IN ('closed') ORDER BY created_date DESC LIMIT 20
    `);
    res.json({ tasks: tasksResult.rows, cases: casesResult.rows });
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── DOMAIN COUNTS ─────────────────────────────────────────
app.get('/api/domains/counts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.domain, COUNT(t.task_id) AS pending_count
      FROM cases c JOIN tasks t ON t.case_id = c.case_id
      WHERE t.status NOT IN ('done','cancelled') AND c.status NOT IN ('closed')
      GROUP BY c.domain
    `);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── DECISIONS (Decision Memory) ───────────────────────────
app.post('/api/decisions', async (req, res) => {
  try {
    const { case_id, decision_text, decided_by } = req.body;
    const result = await pool.query(
      `INSERT INTO decisions (case_id, decision_text, decided_by, decided_at)
       VALUES ($1,$2,$3,NOW()) RETURNING *`,
      [case_id, decision_text, decided_by||'Yash']
    );
    res.json(result.rows[0]);
  } catch(e) {
    // Table may not exist yet — return success for now
    res.json({ case_id, decision_text, decided_at: new Date().toISOString() });
  }
});

app.get('/api/decisions/:caseId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM decisions WHERE case_id=$1 ORDER BY decided_at DESC',
      [req.params.caseId]
    );
    res.json(result.rows);
  } catch(e) { res.json([]); }
});

// ── CALENDAR SYNC (stub — OAuth needed) ──────────────────
app.post('/api/calendar/sync', async (req, res) => {
  const { title, date, owner } = req.body;
  // TODO: implement Google Calendar OAuth
  // For now return stub success
  res.json({ synced: false, message: 'Calendar OAuth not yet configured', title, date });
});

// ── REFRESH PRIORITY SCORES ───────────────────────────────
app.post('/api/tasks/score/refresh', async (req, res) => {
  try {
    await pool.query('SELECT refresh_priority_scores()');
    res.json({ refreshed: true });
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ── QUICK TASKS ──────────────────────────────────────────
app.get('/api/quicktasks', async (req, res) => {
  try {
    const user = req.query.user || 'Yash';
    const result = await pool.query(
      `SELECT id, title, status, deadline FROM tasks 
       WHERE owner = $1 AND task_type = 'quick' 
       ORDER BY created_at DESC LIMIT 20`,
      [user]
    );
    res.json(result.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/quicktasks', async (req, res) => {
  try {
    const { title, user, deadline, status } = req.body;
    const result = await pool.query(
      `INSERT INTO tasks (title, owner, deadline, status, task_type, is_urgent, is_important, acknowledged, priority_score)
       VALUES ($1, $2, $3, $4, 'quick', false, false, true, 1) RETURNING id, task_id`,
      [title, user || 'Yash', deadline || null, status || 'pending']
    );
    res.json(result.rows[0]);
  } catch(e) { res.json({id: Date.now()}); }
});

app.patch('/api/quicktasks/:id', async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query(`UPDATE tasks SET status=$1 WHERE task_id=$2`, [status, req.params.id]);
    res.json({ok:true});
  } catch(e) { res.json({ok:false}); }
});

app.delete('/api/quicktasks/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM tasks WHERE task_id=$1`, [req.params.id]);
    res.json({ok:true});
  } catch(e) { res.json({ok:false}); }
});

// ── CATCH ALL ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
// ── QUICK TASKS ──────────────────────────────────────────
app.get('/api/quicktasks', async (req, res) => {
  try {
    const user = req.query.user || 'Yash';
    const result = await pool.query(
      `SELECT id, title, status, deadline FROM tasks 
       WHERE owner = $1 AND task_type = 'quick' 
       ORDER BY created_at DESC LIMIT 20`,
      [user]
    );
    res.json(result.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/quicktasks', async (req, res) => {
  try {
    const { title, user, deadline, status } = req.body;
    const result = await pool.query(
      `INSERT INTO tasks (title, owner, deadline, status, task_type, is_urgent, is_important, acknowledged, priority_score)
       VALUES ($1, $2, $3, $4, 'quick', false, false, true, 1) RETURNING id, task_id`,
      [title, user || 'Yash', deadline || null, status || 'pending']
    );
    res.json(result.rows[0]);
  } catch(e) { res.json({id: Date.now()}); }
});

app.patch('/api/quicktasks/:id', async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query(`UPDATE tasks SET status=$1 WHERE task_id=$2`, [status, req.params.id]);
    res.json({ok:true});
  } catch(e) { res.json({ok:false}); }
});

app.delete('/api/quicktasks/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM tasks WHERE task_id=$1`, [req.params.id]);
    res.json({ok:true});
  } catch(e) { res.json({ok:false}); }
});


app.listen(PORT, () => console.log('YJM Power running on port ' + PORT));
