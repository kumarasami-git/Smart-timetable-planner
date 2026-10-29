const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// GET all batches
router.get('/', async (req, res) => {
  try {
    const { department_id, semester } = req.query;
    let query = 'SELECT * FROM batches WHERE 1=1';
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
    query += ' ORDER BY id';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add batch
router.post('/', async (req, res) => {
  const { name, department_id, semester, strength } = req.body;
  const is_split = strength > 30;
  try {
    const result = await pool.query(
      'INSERT INTO batches (name, department_id, semester, strength, is_split) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, department_id, semester, strength, is_split]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update batch
router.put('/:id', async (req, res) => {
  const { name, semester, strength } = req.body;
  const is_split = strength > 30;
  try {
    const result = await pool.query(
      'UPDATE batches SET name=$1, semester=$2, strength=$3, is_split=$4 WHERE id=$5 RETURNING *',
      [name, semester, strength, is_split, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE batch
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM batches WHERE id=$1', [req.params.id]);
    res.json({ message: 'Batch deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;