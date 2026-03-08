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

app.get('/api/cases', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM cases WHERE status != 'closed' ORDER BY created_date DESC`);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.post('/api/cases', async (req, res) => {
  try {
    const { title, domain, priority, outcome, case_type } = req.body;
    const result = await pool.query(
      `INSERT INTO cases (title, domain, priority, outcome, case_type, is_private)
       VALUES ($1,$2,$3,$4,$5,(SELECT is_private FROM domains WHERE name=$2))
       RETURNING *`,
      [title, domain, priority||'normal', outcome||'', case_type||'execution']
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.patch('/api/cases/:id', async (req, res) => {
  try {
    const { status, outcome_verified } = req.body;
    const result = await pool.query(
      `UPDATE cases SET status=$1, outcome_verified=$2, updated_date=NOW() WHERE case_id=$3 RETURNING *`,
      [status, outcome_verified, req.params.id]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.get('/api/tasks', async (req, res) => {
  try {
    const { owner_id, case_id } = req.query;
    let q = `SELECT t.*, p.name as owner_name, c.title as case_title, c.domain, c.is_private FROM tasks t LEFT JOIN people p ON t.owner_id=p.person_id LEFT JOIN cases c ON t.case_id=c.case_id WHERE 1=1`;
    const params = [];
    if(owner_id){ params.push(owner_id); q+=` AND t.owner_id=$${params.length}`; }
    if(case_id){ params.push(case_id); q+=` AND t.case_id=$${params.length}`; }
    q+=` ORDER BY t.impact_score DESC, t.deadline ASC`;
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const { case_id, description, owner_id, execution_mode, deadline, priority, impact_score, kajal_instructions } = req.body;
    const result = await pool.query(
      `INSERT INTO tasks (case_id,description,owner_id,execution_mode,deadline,priority,impact_score,kajal_instructions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [case_id, description, owner_id, execution_mode||'delegate', deadline||null, priority||'normal', impact_score||3, kajal_instructions||null]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.patch('/api/tasks/:id', async (req, res) => {
  try {
    const { status, completion_note } = req.body;
    const result = await pool.query(
      `UPDATE tasks SET status=$1, completion_note=$2, completed_at=NOW(), updated_date=NOW() WHERE task_id=$3 RETURNING *`,
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

app.get('/api/dashboard/:owner_id', async (req, res) => {
  try {
    const oid = req.params.owner_id;
    const [tasks, overdue, blocked, cases] = await Promise.all([
      pool.query(`SELECT t.*, p.name as owner_name, c.title as case_title, c.domain, c.is_private FROM tasks t LEFT JOIN people p ON t.owner_id=p.person_id LEFT JOIN cases c ON t.case_id=c.case_id WHERE t.owner_id=$1 AND t.status='pending' ORDER BY t.impact_score DESC, t.deadline ASC LIMIT 7`,[oid]),
      pool.query(`SELECT t.*, p.name as owner_name, c.title as case_title FROM tasks t LEFT JOIN people p ON t.owner_id=p.person_id LEFT JOIN cases c ON t.case_id=c.case_id WHERE t.deadline < CURRENT_DATE AND t.status NOT IN ('done','cancelled')`,[]),
      pool.query(`SELECT t.*, dep.description as waiting_for, p.name as owner_name FROM tasks t JOIN tasks dep ON t.depends_on_task_id=dep.task_id LEFT JOIN people p ON t.owner_id=p.person_id WHERE t.depends_on_task_id IS NOT NULL AND dep.status!='done'`,[]),
      pool.query(`SELECT * FROM cases WHERE status!='closed' ORDER BY created_date DESC`,[])
    ]);
    res.json({ tasks:tasks.rows, overdue:overdue.rows, blocked:blocked.rows, cases:cases.rows });
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.get('/api/setup', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS domains (domain_id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, icon TEXT, is_private BOOLEAN NOT NULL DEFAULT FALSE, context_notes TEXT);
      CREATE TABLE IF NOT EXISTS people (person_id SERIAL PRIMARY KEY, name TEXT NOT NULL, role TEXT, person_type TEXT NOT NULL DEFAULT 'team', whatsapp_number TEXT, email TEXT, access_level TEXT NOT NULL DEFAULT 'own_tasks', can_see_private BOOLEAN NOT NULL DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE);
      CREATE TABLE IF NOT EXISTS cases (case_id SERIAL PRIMARY KEY, title TEXT NOT NULL, domain TEXT, is_private BOOLEAN NOT NULL DEFAULT FALSE, case_type TEXT NOT NULL DEFAULT 'execution', priority TEXT NOT NULL DEFAULT 'normal', outcome TEXT, outcome_verified BOOLEAN DEFAULT FALSE, status TEXT NOT NULL DEFAULT 'new', ai_summary TEXT, created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, closed_date TIMESTAMP);
      CREATE TABLE IF NOT EXISTS tasks (task_id SERIAL PRIMARY KEY, case_id INTEGER REFERENCES cases(case_id), description TEXT NOT NULL, kajal_instructions TEXT, completion_note TEXT, owner_id INTEGER REFERENCES people(person_id), execution_mode TEXT NOT NULL DEFAULT 'delegate', deadline DATE, priority TEXT DEFAULT 'normal', impact_score INTEGER DEFAULT 3, status TEXT NOT NULL DEFAULT 'pending', depends_on_task_id INTEGER REFERENCES tasks(task_id), whatsapp_sent BOOLEAN DEFAULT FALSE, completed_at TIMESTAMP, created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    `);
    await pool.query(`
      INSERT INTO domains (name,icon,is_private,context_notes) VALUES
      ('Business','⚙',false,'Varsha Forgings operations'),
      ('Customer','🤝',false,'Quotations, follow-ups'),
      ('Strategy','🎯',false,'JV, partnerships'),
      ('Operations','🏭',false,'Production, quality'),
      ('Finance','💰',false,'Accounts, payments'),
      ('New Opps','🚀',false,'New opportunities'),
      ('AIFI','🏛',false,'AIFI President role'),
      ('EO Forum','🌐',false,'EO chapter'),
      ('Workflows','⚡',false,'SOPs, automation'),
      ('Rental','🔑',false,'Rental properties'),
      ('Legal','⚖',false,'Contracts, compliance'),
      ('Wealth','📈',true,'Portfolio — PRIVATE'),
      ('Health','❤',true,'Health — PRIVATE'),
      ('Personal','👤',true,'Personal — PRIVATE'),
      ('Family','👨‍👩‍👧‍👦',true,'Family — PRIVATE'),
      ('Property','🏠',true,'Property — PRIVATE'),
      ('Vehicles','🚗',true,'Vehicles — PRIVATE'),
      ('Neha','💗',true,'Relationship — PRIVATE')
      ON CONFLICT (name) DO NOTHING;
    `);
    await pool.query(`
      INSERT INTO people (name,role,person_type,access_level,can_see_private) VALUES
      ('Yash','CEO — Varsha Forgings','yash','full',true),
      ('Fazal','Operations + Purchase','team','own_tasks',false),
      ('Sanjay','Logistics + Sales','team','own_tasks',false),
      ('Deepak','Accounts','team','own_tasks',false),
      ('Kajal','EA — Coordination','kajal','own_tasks',false)
      ON CONFLICT DO NOTHING;
    `);
    res.json({ message:'Setup complete' });
  } catch(e) { res.status(500).json({ error: e.message }) }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`YJM Power running on port ${PORT}`));
