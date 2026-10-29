const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { generateTimetable } = require('../scheduler');

// Generate timetable
router.post('/generate', async (req, res) => {
  const { department_id, semester, academic_year } = req.body;
  try {
    const result = await generateTimetable(department_id, semester, academic_year);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET timetable for a batch
router.get('/batch/:batch_id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ts.*, 
        f.name as faculty_name, 
        s.name as subject_name, s.code as subject_code,
        r.name as room_name,
        t.day, t.period_number, t.start_time, t.end_time
       FROM timetable_slots ts
       LEFT JOIN faculty f ON ts.faculty_id = f.id
       JOIN subjects s ON ts.subject_id = s.id
       JOIN rooms r ON ts.room_id = r.id
       JOIN time_slots t ON ts.time_slot_id = t.id
       WHERE ts.batch_id = $1
       ORDER BY t.day, t.period_number`,
      [req.params.batch_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET timetable for a faculty
router.get('/faculty/:faculty_id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ts.*, 
        s.name as subject_name, s.code as subject_code,
        r.name as room_name,
        b.name as batch_name,
        t.day, t.period_number, t.start_time, t.end_time
       FROM timetable_slots ts
       JOIN subjects s ON ts.subject_id = s.id
       JOIN rooms r ON ts.room_id = r.id
       JOIN batches b ON ts.batch_id = b.id
       JOIN time_slots t ON ts.time_slot_id = t.id
       WHERE ts.faculty_id = $1
       ORDER BY t.day, t.period_number`,
      [req.params.faculty_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE timetable (reset) — scoped to one department when given, so
// resetting one department's timetable doesn't wipe another department's
// data that happens to share the same semester number.
router.delete('/reset', async (req, res) => {
  const { department_id, semester, academic_year } = req.body;
  try {
    if (department_id) {
      await pool.query(
        `DELETE FROM timetable_slots
         WHERE semester = $1 AND academic_year = $2
         AND batch_id IN (SELECT id FROM batches WHERE department_id = $3)`,
        [semester, academic_year, department_id]
      );
    } else {
      await pool.query(
        `DELETE FROM timetable_slots WHERE semester = $1 AND academic_year = $2`,
        [semester, academic_year]
      );
    }
    res.json({ message: 'Timetable reset successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
module.exports = router;