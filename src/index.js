const express = require('express');
const cors = require('cors');
require('dotenv').config();
require('./config/db');

const app = express();

app.use(cors());
app.use(express.json());

const departmentRoutes = require('./routes/departments');
app.use('/api/departments', departmentRoutes);

const facultyRoutes = require('./routes/faculty');
app.use('/api/faculty', facultyRoutes);

const subjectRoutes = require('./routes/subjects');
app.use('/api/subjects', subjectRoutes);

const roomRoutes = require('./routes/rooms');
app.use('/api/rooms', roomRoutes);

const batchRoutes = require('./routes/batches');
app.use('/api/batches', batchRoutes);

const blockedSlotRoutes = require('./routes/blockedSlots');
app.use('/api/blocked-slots', blockedSlotRoutes);

const timetableRoutes = require('./routes/timetable');
app.use('/api/timetable', timetableRoutes);

const facultySubjectRoutes = require('./routes/facultySubjects');
app.use('/api/faculty-subjects', facultySubjectRoutes);

const plannerRoutes = require('./routes/planner');
app.use('/api/planner', plannerRoutes);

// Test route
app.get('/', (req, res) => {
  res.json({ message: '✅ Timetable Planner API is running!' });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});