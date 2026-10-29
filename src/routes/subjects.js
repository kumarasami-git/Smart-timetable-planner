const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// GET all subjects (optionally by department)
router.get('/', async (req, res) => {
  try {
    const { department_id, semester } = req.query;
    let query = 'SELECT * FROM subjects WHERE 1=1';
    let params = [];
    let count = 1;
    if (department_id) {
      query += ` AND department_id = $${count}`;
      params.push(department_id);
      count++;
    }
    if (semester) {
      query += ` AND semester = $${count}`;
      params.push(semester);
    }
    query += ' ORDER BY credits DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add subject
router.post('/', async (req, res) => {
  const { name, code, department_id, credits, theory_hours, lab_hours, has_lab, semester } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO subjects (name, code, department_id, credits, theory_hours, lab_hours, has_lab, semester) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [name, code, department_id, credits, theory_hours, lab_hours || 0, has_lab || false, semester]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update subject
router.put('/:id', async (req, res) => {
  const { name, code, credits, theory_hours, lab_hours, has_lab, semester } = req.body;
  try {
    const result = await pool.query(
      'UPDATE subjects SET name=$1, code=$2, credits=$3, theory_hours=$4, lab_hours=$5, has_lab=$6, semester=$7 WHERE id=$8 RETURNING *',
      [name, code, credits, theory_hours, lab_hours, has_lab, semester, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE subject
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM subjects WHERE id=$1', [req.params.id]);
    res.json({ message: 'Subject deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;