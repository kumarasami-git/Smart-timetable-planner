const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// GET all rooms
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rooms ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add room
router.post('/', async (req, res) => {
  const { name, capacity, type, building } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO rooms (name, capacity, type, building) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, capacity, type, building]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update room
router.put('/:id', async (req, res) => {
  const { name, capacity, type, building, is_available } = req.body;
  try {
    const result = await pool.query(
      'UPDATE rooms SET name=$1, capacity=$2, type=$3, building=$4, is_available=$5 WHERE id=$6 RETURNING *',
      [name, capacity, type, building, is_available, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE room
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM rooms WHERE id=$1', [req.params.id]);
    res.json({ message: 'Room deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;