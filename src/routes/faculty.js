const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// GET all faculty (optionally by department)
router.get('/', async (req, res) => {
  try {
    const { department_id } = req.query;
    let query = 'SELECT * FROM faculty WHERE is_active = true';
    let params = [];
    if (department_id) {
      query += ' AND department_id = $1';
      params.push(department_id);
    }
    query += ' ORDER BY seniority';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add faculty
// Emails are unique in the database, and "removing" a faculty member only
// deactivates them (the row stays). So if the email belongs to a removed
// faculty member, bring them back with the new details; if it belongs to an
// active one, say so clearly instead of crashing.
router.post('/', async (req, res) => {
  const { name, email, seniority, department_id, max_hours_per_week } = req.body;
  try {
    if (email) {
      const existing = await pool.query(
        'SELECT id, name, is_active FROM faculty WHERE email = $1',
        [email]
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.is_active) {
          return res.status(409).json({
            error: `A faculty member with this email already exists (${row.name}).`
          });
        }
        const revived = await pool.query(
          `UPDATE faculty
           SET name=$1, seniority=$2, department_id=$3, max_hours_per_week=$4, is_active=true
           WHERE id=$5 RETURNING *`,
          [name, seniority, department_id, max_hours_per_week, row.id]
        );
        return res.json(revived.rows[0]);
      }
    }

    const result = await pool.query(
      'INSERT INTO faculty (name, email, seniority, department_id, max_hours_per_week) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, email || null, seniority, department_id, max_hours_per_week]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update faculty
router.put('/:id', async (req, res) => {
  const { name, email, seniority, department_id, max_hours_per_week } = req.body;
  try {
    const result = await pool.query(
      'UPDATE faculty SET name=$1, email=$2, seniority=$3, department_id=$4, max_hours_per_week=$5 WHERE id=$6 RETURNING *',
      [name, email, seniority, department_id, max_hours_per_week, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE faculty
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('UPDATE faculty SET is_active = false WHERE id = $1', [req.params.id]);
    res.json({ message: 'Faculty deactivated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;