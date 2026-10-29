const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// GET all blocked slots
router.get('/', async (req, res) => {
  try {
    const { department_id } = req.query;
    let query = `
      SELECT bs.*, ts.day, ts.period_number, ts.start_time, ts.end_time 
      FROM blocked_slots bs
      JOIN time_slots ts ON bs.time_slot_id = ts.id
      WHERE 1=1
    `;
    let params = [];
    if (department_id) {
      query += ` AND bs.department_id = $1`;
      params.push(department_id);
    }
    query += ' ORDER BY ts.day, ts.period_number';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add blocked slot
router.post('/', async (req, res) => {
  const { department_id, time_slot_id, reason, semester, is_recurring } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO blocked_slots (department_id, time_slot_id, reason, semester, is_recurring) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [department_id, time_slot_id, reason, semester, is_recurring ?? true]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE blocked slot
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM blocked_slots WHERE id=$1', [req.params.id]);
    res.json({ message: 'Blocked slot removed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;