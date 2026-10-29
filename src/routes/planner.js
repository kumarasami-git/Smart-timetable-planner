const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// Which subjects each section (batch) studies. A section with no rows here
// uses every subject of its semester.
pool.query(`
  CREATE TABLE IF NOT EXISTS batch_subjects (
    batch_id   INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    PRIMARY KEY (batch_id, subject_id)
  )`).catch(e => console.error('batch_subjects table:', e.message));

// Columns used by electives / project hours, and room in batch_split so several
// elective subjects can sit in the same period ('E1-1', 'E1-2' …).
const setup = [
  'ALTER TABLE subjects ADD COLUMN IF NOT EXISTS elective_group VARCHAR(20)',
  'ALTER TABLE subjects ADD COLUMN IF NOT EXISTS is_project BOOLEAN DEFAULT false',
  `DO $$ DECLARE r record; BEGIN
     FOR r IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'timetable_slots'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) ILIKE '%batch_split%'
     LOOP EXECUTE format('ALTER TABLE timetable_slots DROP CONSTRAINT %I', r.conname); END LOOP;
   END $$`,
  'ALTER TABLE timetable_slots ALTER COLUMN batch_split TYPE VARCHAR(20) USING batch_split::text'
];
(async () => {
  for (const q of setup) {
    try { await pool.query(q); } catch (e) { console.error('planner setup:', e.message); }
  }
})();

// GET sections of a department + semester, each with its subject_ids
router.get('/sections', async (req, res) => {
  try {
    const { department_id, semester } = req.query;
    const b = await pool.query(
      'SELECT * FROM batches WHERE department_id = $1 AND semester = $2 ORDER BY id',
      [department_id, semester]
    );
    const ids = b.rows.map(r => r.id);
    const map = {};
    if (ids.length) {
      const bs = await pool.query(
        'SELECT batch_id, subject_id FROM batch_subjects WHERE batch_id = ANY($1)', [ids]);
      bs.rows.forEach(r => { (map[r.batch_id] = map[r.batch_id] || []).push(r.subject_id); });
    }
    res.json(b.rows.map(r => ({ ...r, subject_ids: map[r.id] || [] })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create a section. Any other NOT NULL column on `batches` that has no
// default (e.g. a strength/size column) is filled with a neutral value so
// this works whatever the batches table looks like.
router.post('/sections', async (req, res) => {
  const { name, department_id, semester } = req.body;
  try {
    if (!name || !department_id || !semester) {
      return res.status(400).json({ error: 'name, department_id and semester are required' });
    }
    const dup = await pool.query(
      'SELECT id FROM batches WHERE department_id=$1 AND semester=$2 AND name=$3',
      [department_id, semester, name]);
    if (dup.rows.length) return res.status(409).json({ error: `Section "${name}" already exists for this semester.` });

    const cols = { name, department_id, semester };
    const info = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'batches' AND is_nullable = 'NO' AND column_default IS NULL`);
    for (const c of info.rows) {
      if (c.column_name in cols || c.column_name === 'id') continue;
      if (/int|numeric|double|real/.test(c.data_type)) cols[c.column_name] = 60;
      else if (/char|text/.test(c.data_type)) cols[c.column_name] = name;
      else if (c.data_type === 'boolean') cols[c.column_name] = true;
      else if (/^(date|timestamp)/.test(c.data_type)) cols[c.column_name] = new Date();
    }
    const keys = Object.keys(cols);
    const r = await pool.query(
      `INSERT INTO batches (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`,
      keys.map(k => cols[k]));
    res.json({ ...r.rows[0], subject_ids: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT replace the subjects a section studies
router.put('/sections/:id/subjects', async (req, res) => {
  const client = await pool.connect();
  try {
    const ids = (req.body.subject_ids || []).map(Number);
    await client.query('BEGIN');
    await client.query('DELETE FROM batch_subjects WHERE batch_id = $1', [req.params.id]);
    for (const sid of ids) {
      await client.query(
        'INSERT INTO batch_subjects (batch_id, subject_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [req.params.id, sid]);
    }
    await client.query('COMMIT');
    res.json({ batch_id: Number(req.params.id), subject_ids: ids });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE a section (and its timetable + subject selection)
router.delete('/sections/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM timetable_slots WHERE batch_id = $1', [req.params.id]);
    await pool.query('DELETE FROM batch_subjects WHERE batch_id = $1', [req.params.id]);
    await pool.query('DELETE FROM batches WHERE id = $1', [req.params.id]);
    res.json({ message: 'Section deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───────── Departments (add / rename / delete from the UI) ─────────
router.post('/departments', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Department name is required' });
    const dup = await pool.query('SELECT id FROM departments WHERE LOWER(name) = LOWER($1)', [name]);
    if (dup.rows.length) return res.status(409).json({ error: `Department "${name}" already exists.` });

    const cols = { name };
    const info = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'departments' AND is_nullable = 'NO' AND column_default IS NULL`);
    for (const c of info.rows) {
      if (c.column_name in cols || c.column_name === 'id') continue;
      if (c.column_name === 'code') cols.code = name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 10);
      else if (/char|text/.test(c.data_type)) cols[c.column_name] = name;
      else if (/int|numeric|double|real/.test(c.data_type)) cols[c.column_name] = 0;
    }
    const keys = Object.keys(cols);
    const r = await pool.query(
      `INSERT INTO departments (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`,
      keys.map(k => cols[k]));
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/departments/:id', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Department name is required' });
    const dup = await pool.query('SELECT id FROM departments WHERE LOWER(name) = LOWER($1) AND id <> $2', [name, req.params.id]);
    if (dup.rows.length) return res.status(409).json({ error: `Department "${name}" already exists.` });
    const r = await pool.query('UPDATE departments SET name = $1 WHERE id = $2 RETURNING *', [name, req.params.id]);
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Only an empty department can be deleted, so nothing else is orphaned.
router.delete('/departments/:id', async (req, res) => {
  try {
    const used = [];
    for (const [table, label] of [['subjects', 'subjects'], ['faculty', 'faculty'], ['batches', 'sections']]) {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE department_id = $1` + (table === 'faculty' ? ' AND is_active = true' : ''),
        [req.params.id]);
      if (r.rows[0].n > 0) used.push(`${r.rows[0].n} ${label}`);
    }
    if (used.length) {
      return res.status(409).json({ error: `This department still has ${used.join(', ')}. Remove them first.` });
    }
    await pool.query('DELETE FROM departments WHERE id = $1', [req.params.id]);
    res.json({ message: 'Department deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───────── Blocked periods (meetings, mentoring …) ─────────
// A block can apply to every semester (semester = NULL) or just one.
pool.query('ALTER TABLE blocked_slots ADD COLUMN IF NOT EXISTS semester INTEGER')
  .catch(e => console.error('blocked_slots.semester:', e.message));

async function blockedColumns() {
  const r = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'blocked_slots'`);
  return r.rows;
}

router.get('/blocked', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT bs.*, ts.day, ts.period_number FROM blocked_slots bs
       JOIN time_slots ts ON ts.id = bs.time_slot_id
       WHERE bs.department_id = $1 ORDER BY ts.id`, [req.query.department_id]);
    res.json(r.rows.map(row => ({ ...row, reason: row.reason ?? row.description ?? 'Blocked' })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/blocked', async (req, res) => {
  try {
    const { department_id, day, period_number, reason, semester } = req.body;
    const ts = await pool.query('SELECT id FROM time_slots WHERE day = $1 AND period_number = $2', [day, period_number]);
    if (!ts.rows.length) return res.status(400).json({ error: `No time slot for ${day} period ${period_number}` });
    const slotId = ts.rows[0].id;

    const dup = await pool.query(
      `SELECT id FROM blocked_slots WHERE department_id = $1 AND time_slot_id = $2
       AND semester IS NOT DISTINCT FROM $3::int`, [department_id, slotId, semester ?? null]);
    if (dup.rows.length) return res.status(409).json({ error: `${day} period ${period_number} is already blocked for that scope.` });

    const columns = await blockedColumns();
    const names = columns.map(c => c.column_name);
    const cols = { department_id, time_slot_id: slotId, semester: semester ?? null };
    if (names.includes('reason')) cols.reason = reason || 'Blocked';
    else if (names.includes('description')) cols.description = reason || 'Blocked';
    for (const c of columns) {
      if (c.is_nullable !== 'NO' || c.column_default !== null || c.column_name === 'id' || c.column_name in cols) continue;
      if (/char|text/.test(c.data_type)) cols[c.column_name] = reason || 'Blocked';
      else if (/int|numeric/.test(c.data_type)) cols[c.column_name] = 0;
    }
    const keys = Object.keys(cols);
    const r = await pool.query(
      `INSERT INTO blocked_slots (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`,
      keys.map(k => cols[k]));
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/blocked/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM blocked_slots WHERE id = $1', [req.params.id]);
    res.json({ message: 'Unblocked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───────── Subject type flags ─────────
// Sets how a subject is scheduled (theory hours, lab, placement) regardless of
// what the general subjects route stores.
router.patch('/subjects/:id', async (req, res) => {
  try {
    const { theory_hours, has_lab, is_placement, elective_group, is_project } = req.body;
    const r = await pool.query(
      `UPDATE subjects SET theory_hours = $1, has_lab = $2, is_placement = $3,
         elective_group = $4, is_project = $5 WHERE id = $6 RETURNING *`,
      [theory_hours, !!has_lab, !!is_placement, elective_group || null, !!is_project, req.params.id]);
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───────── Electives: paste-in import ─────────
// rows: [{ group:'E1', code, name, faculty:['Dr Baburaj', ...] }]
// Subjects are created (or updated if the code already exists in the same
// department + semester), faculty are matched by name (titles ignored) and
// created if missing, and each faculty is mapped to the subject.
const TITLE = /^((dr|mr|ms|mrs|prof|professor)\s+)+/;
const normName = n => String(n).toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim().replace(TITLE, '').trim();
const isPrefix = (a, b) => a.length <= b.length && a.every((t, i) => t === b[i]);

async function insertRow(client, table, cols) {
  const info = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL`, [table]);
  for (const c of info.rows) {
    if (c.column_name in cols || c.column_name === 'id') continue;
    if (/int|numeric|double|real/.test(c.data_type)) cols[c.column_name] = 0;
    else if (/char|text/.test(c.data_type)) cols[c.column_name] = '';
    else if (c.data_type === 'boolean') cols[c.column_name] = false;
  }
  const keys = Object.keys(cols);
  const r = await client.query(
    `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`,
    keys.map(k => cols[k]));
  return r.rows[0];
}

router.post('/electives/import', async (req, res) => {
  const { department_id, semester, rows, credits, add_project } = req.body;
  const client = await pool.connect();
  try {
    if (!department_id || !semester || !Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: 'department_id, semester and at least one row are required' });
    }
    await client.query('BEGIN');
    const fac = (await client.query('SELECT * FROM faculty WHERE department_id = $1 AND is_active = true', [department_id])).rows
      .map(f => ({ ...f, tokens: normName(f.name).split(' ') }));
    const out = { subjects_created: 0, subjects_updated: 0, faculty_created: [], mappings_created: 0, project_created: false, matched: [] };

    async function findOrCreateFaculty(name) {
      const t = normName(name).split(' ');
      const exact = fac.find(f => f.tokens.join(' ') === t.join(' '));
      const loose = exact || fac.find(f => isPrefix(t, f.tokens) || isPrefix(f.tokens, t));
      if (loose) { if (!out.matched.includes(`${name} → ${loose.name}`)) out.matched.push(`${name} → ${loose.name}`); return loose; }
      // create with a clearly-marked placeholder e-mail the user can edit in step 2
      const slug = t.join('.').replace(/[^a-z0-9.]/g, '') || 'faculty';
      let email = `${slug}@pending.invalid`, n = 1;
      while ((await client.query('SELECT 1 FROM faculty WHERE email = $1', [email])).rows.length) email = `${slug}${++n}@pending.invalid`;
      const row = await insertRow(client, 'faculty', {
        name: name.trim(), email, seniority: 'Assistant Professor', department_id, max_hours_per_week: 16
      });
      const f = { ...row, tokens: t };
      fac.push(f);
      out.faculty_created.push({ name: row.name, email });
      return f;
    }

    for (const r of rows) {
      const code = String(r.code || '').trim(), name = String(r.name || '').trim(), group = String(r.group || '').trim().toUpperCase();
      if (!code || !name || !group) throw new Error(`Each row needs a group, code and subject name (got "${group}", "${code}", "${name}").`);
      let sub = (await client.query('SELECT * FROM subjects WHERE code = $1', [code])).rows[0];
      if (sub) {
        if (String(sub.department_id) !== String(department_id) || String(sub.semester) !== String(semester)) {
          throw new Error(`Code ${code} already belongs to another department/semester (${sub.name}).`);
        }
        await client.query(
          `UPDATE subjects SET name=$1, elective_group=$2, theory_hours=0, has_lab=false, is_placement=false, is_project=false WHERE id=$3`,
          [name, group, sub.id]);
        out.subjects_updated++;
      } else {
        sub = await insertRow(client, 'subjects', {
          name, code, credits: parseInt(credits, 10) || 3, theory_hours: 0, has_lab: false, is_placement: false,
          is_project: false, elective_group: group, department_id, semester
        });
        out.subjects_created++;
      }
      for (const fname of (r.faculty || [])) {
        const f = await findOrCreateFaculty(fname);
        const has = await client.query('SELECT 1 FROM faculty_subjects WHERE faculty_id = $1 AND subject_id = $2', [f.id, sub.id]);
        if (!has.rows.length) {
          await insertRow(client, 'faculty_subjects', { faculty_id: f.id, subject_id: sub.id });
          out.mappings_created++;
        }
      }
    }

    if (add_project) {
      const has = await client.query(
        'SELECT 1 FROM subjects WHERE department_id = $1 AND semester = $2 AND is_project = true', [department_id, semester]);
      if (!has.rows.length) {
        let code = `PRJ${department_id}${semester}`, n = 1;
        while ((await client.query('SELECT 1 FROM subjects WHERE code = $1', [code])).rows.length) code = `PRJ${department_id}${semester}-${++n}`;
        await insertRow(client, 'subjects', {
          name: 'Project Work', code, credits: 2, theory_hours: 0, has_lab: false, is_placement: false,
          is_project: true, elective_group: null, department_id, semester
        });
        out.project_created = true;
      }
    }
    await client.query('COMMIT');
    res.json(out);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;