const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// GET all faculty-subject mappings
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT fs.*, f.name as faculty_name, s.name as subject_name 
       FROM faculty_subjects fs
       JOIN faculty f ON fs.faculty_id = f.id
       JOIN subjects s ON fs.subject_id = s.id
       ORDER BY f.name`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST assign subject to faculty
router.post('/', async (req, res) => {
  const { faculty_id, subject_id } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO faculty_subjects (faculty_id, subject_id) VALUES ($1, $2) RETURNING *',
      [faculty_id, subject_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE mapping
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM faculty_subjects WHERE id=$1', [req.params.id]);
    res.json({ message: 'Mapping removed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;