const pool = require('./config/db');

async function generateTimetable(department_id, semester, academic_year) {
  try {
    const subjectsResult = await pool.query(
      'SELECT * FROM subjects WHERE department_id = $1 AND semester = $2 ORDER BY credits DESC',
      [department_id, semester]
    );
    const semesterSubjects = subjectsResult.rows;

    const mappingResult = await pool.query(
      `SELECT fs.*, f.name as faculty_name, f.max_hours_per_week
       FROM faculty_subjects fs
       JOIN faculty f ON fs.faculty_id = f.id
       JOIN subjects s ON fs.subject_id = s.id
       WHERE s.department_id = $1 AND f.is_active = true`,
      [department_id]
    );
    const mappings = mappingResult.rows;

    // Blocks apply to every semester (semester IS NULL) or only to this one.
    let blockedResult;
    try {
      blockedResult = await pool.query(
        'SELECT time_slot_id FROM blocked_slots WHERE department_id = $1 AND (semester IS NULL OR semester = $2)',
        [department_id, semester]
      );
    } catch (e) {
      blockedResult = await pool.query(
        'SELECT time_slot_id FROM blocked_slots WHERE department_id = $1',
        [department_id]
      );
    }
    const blockedSlotIds = blockedResult.rows.map(r => r.time_slot_id);

    const timeSlotsResult = await pool.query('SELECT * FROM time_slots ORDER BY id');
    const timeSlots = timeSlotsResult.rows;

    const batchesResult = await pool.query(
      'SELECT * FROM batches WHERE department_id = $1 AND semester = $2 ORDER BY id',
      [department_id, semester]
    );
    const batches = batchesResult.rows;

    // ── Per-section subject selection (e.g. IT vs IOT sections of the same
    // semester differ by one subject). A section with no saved selection
    // simply uses every subject of the semester.
    const batchSubjectIds = {}; // batch_id -> Set of subject_id
    try {
      if (batches.length > 0) {
        const bsRes = await pool.query(
          'SELECT batch_id, subject_id FROM batch_subjects WHERE batch_id = ANY($1)',
          [batches.map(b => b.id)]
        );
        for (const r of bsRes.rows) {
          if (!batchSubjectIds[r.batch_id]) batchSubjectIds[r.batch_id] = new Set();
          batchSubjectIds[r.batch_id].add(r.subject_id);
        }
      }
    } catch (e) { /* table not created yet: every section uses all subjects */ }

    // ── Load EXISTING faculty commitments across ALL departments/semesters
    // for this academic year, so a faculty member already booked elsewhere
    // (another department, another semester) isn't double-booked here, and
    // their weekly hour cap accounts for what they're already teaching.
    const existingResult = await pool.query(
      `SELECT faculty_id, time_slot_id FROM timetable_slots
       WHERE academic_year = $1 AND faculty_id IS NOT NULL`,
      [academic_year]
    );

    const facultyBusySlots = {}; // faculty_id -> Set of time_slot_id
    const facultyHoursUsed = {}; // faculty_id -> number of hours already committed

    for (const row of existingResult.rows) {
      if (!facultyBusySlots[row.faculty_id]) facultyBusySlots[row.faculty_id] = new Set();
      facultyBusySlots[row.faculty_id].add(row.time_slot_id);
      facultyHoursUsed[row.faculty_id] = (facultyHoursUsed[row.faculty_id] || 0) + 1;
    }

    const facultyMaxHours = {};
    mappings.forEach(m => {
      facultyMaxHours[m.faculty_id] = m.max_hours_per_week ?? 16;
    });

    const allAssigned = [];
    const results = [];
    const warnings = [];

    // Elective groups (e.g. E1, E2): all subjects of a group run at the same
    // time (students choose one) and the group gets ELECTIVE_HOURS a week,
    // at most 2 a day, preferably as 2 consecutive periods.
    const ELECTIVE_HOURS = 12;
    const ELECTIVE_MAX_PER_DAY = 2;
    // Later sections of the same semester reuse the first section's elective
    // timing and faculty (one combined class, so teachers aren't double-booked).
    const electivePlan = {};

    function getSlot(day, period) {
      return timeSlots.find(ts => ts.day === day && ts.period_number === period);
    }

    function isBlocked(slotId) {
      return blockedSlotIds.includes(slotId);
    }

    function isBatchSlotTaken(batchId, slotId) {
      return allAssigned.some(a => a.batch_id === batchId && a.time_slot_id === slotId);
    }

    function isFacultyBusyAt(facultyId, slotId) {
      if (facultyId == null) return false;
      return !!(facultyBusySlots[facultyId] && facultyBusySlots[facultyId].has(slotId));
    }

    function markFacultyBusy(facultyId, slotId) {
      if (facultyId == null) return;
      if (!facultyBusySlots[facultyId]) facultyBusySlots[facultyId] = new Set();
      facultyBusySlots[facultyId].add(slotId);
      facultyHoursUsed[facultyId] = (facultyHoursUsed[facultyId] || 0) + 1;
    }

    // Picks the best eligible faculty for a subject across a set of slot ids
    // (1 slot for a theory hour, 2 for a lab pair). A subject can have
    // several mapped faculty; this picks whoever is free at every one of
    // the given slots AND has enough remaining weekly hours, preferring
    // whoever has the most hours left (keeps load balanced across teachers).
    // Returns null if the subject has mapped faculty but none are eligible
    // right now, or undefined... no: returns null in both "no mapping at
    // all" and "no one eligible" cases — callers distinguish via `hasMapping`.
    //
    // Load limiting: faculty also teach other semesters/subjects, so we
    // don't fill their whole week. Tier 1 keeps everyone at or under
    // LOAD_LIMIT_PERCENT of their weekly cap; only if no eligible faculty
    // fits there do we fall back to the hard cap (so classes never go
    // untaught just because of the reserve).
    //
    // Section stickiness: once a faculty member is used for a subject in a
    // section, that same person keeps teaching it for that section.
    const LOAD_LIMIT_PERCENT = 60;
    const preferredFaculty = {}; // "batchId:subjectId" -> faculty_id
    let currentBatchId = null;

    function pickFaculty(subjectId, slotIds, excludeIds) {
      const eligible = mappings.filter(m => m.subject_id === subjectId && !(excludeIds && excludeIds.has(m.faculty_id)));
      if (eligible.length === 0) return { hasMapping: false, facultyId: null };

      const free = eligible.filter(m => {
        const hardCap = facultyMaxHours[m.faculty_id] ?? 16;
        const used = facultyHoursUsed[m.faculty_id] || 0;
        if (used + slotIds.length > hardCap) return false;
        if (slotIds.some(sid => isFacultyBusyAt(m.faculty_id, sid))) return false;
        return true;
      });

      if (free.length === 0) return { hasMapping: true, facultyId: null };

      const withinSoft = free.filter(m => {
        const softCap = Math.floor((facultyMaxHours[m.faculty_id] ?? 16) * LOAD_LIMIT_PERCENT / 100);
        return (facultyHoursUsed[m.faculty_id] || 0) + slotIds.length <= softCap;
      });
      const pool = withinSoft.length > 0 ? withinSoft : free;

      const preferredId = preferredFaculty[`${currentBatchId}:${subjectId}`];
      if (preferredId != null && pool.some(m => m.faculty_id === preferredId)) {
        return { hasMapping: true, facultyId: preferredId };
      }

      pool.sort((a, b) => {
        const remA = (facultyMaxHours[a.faculty_id] ?? 16) - (facultyHoursUsed[a.faculty_id] || 0);
        const remB = (facultyMaxHours[b.faculty_id] ?? 16) - (facultyHoursUsed[b.faculty_id] || 0);
        return remB - remA;
      });

      return { hasMapping: true, facultyId: pool[0].faculty_id };
    }

    function push(assigned, facultyId, subjectId, roomId, batchId, slotId, split) {
      const entry = {
        faculty_id: facultyId,
        subject_id: subjectId,
        room_id: roomId,
        batch_id: batchId,
        time_slot_id: slotId,
        batch_split: split,
        academic_year,
        semester
      };
      assigned.push(entry);
      allAssigned.push(entry);
      if (facultyId != null) {
        const key = `${batchId}:${subjectId}`;
        if (preferredFaculty[key] == null) preferredFaculty[key] = facultyId;
      }
    }

    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const allPairs = [[1,2],[3,4],[5,6]];

    function rotateArray(arr, offset) {
      const len = arr.length;
      const o = ((offset % len) + len) % len;
      return [...arr.slice(o), ...arr.slice(0, o)];
    }

    // Explicit, genuinely different day/pair orderings per section index.
    const dayPermutations = [
      ['Monday', 'Wednesday', 'Friday', 'Tuesday', 'Thursday', 'Saturday'],
      ['Thursday', 'Monday', 'Saturday', 'Wednesday', 'Tuesday', 'Friday'],
      ['Friday', 'Saturday', 'Tuesday', 'Monday', 'Wednesday', 'Thursday'],
    ];
    const pairPermutations = [
      [[1,2],[3,4],[5,6]],
      [[5,6],[1,2],[3,4]],
      [[3,4],[5,6],[1,2]],
    ];

    let batchIndex = 0;
    for (const batch of batches) {
      currentBatchId = batch.id;
      const assigned = [];
      const chosen = batchSubjectIds[batch.id];
      const subjects = chosen && chosen.size > 0
        ? semesterSubjects.filter(sub => chosen.has(sub.id))
        : semesterSubjects;
      const permIdx = batchIndex % dayPermutations.length;
      batchIndex++;

      const batchDays = dayPermutations[permIdx];
      const batchPairs = pairPermutations[permIdx];

      const labSubjects = subjects.filter(s => s.has_lab && !s.elective_group);

      function findLabDay(excludeDay, restrictPairs, subjA, subjB) {
        const pairs = restrictPairs || batchPairs;
        for (const day of batchDays) {
          if (day === excludeDay) continue;
          if (day === 'Saturday') continue;
          for (const [p1, p2] of pairs) {
            const s1 = getSlot(day, p1);
            const s2 = getSlot(day, p2);
            if (!s1 || !s2) continue;
            if (isBlocked(s1.id) || isBlocked(s2.id)) continue;
            if (isBatchSlotTaken(batch.id, s1.id) || isBatchSlotTaken(batch.id, s2.id)) continue;
            const pickA = pickFaculty(subjA.id, [s1.id, s2.id]);
            const pickB = pickFaculty(subjB.id, [s1.id, s2.id]);
            if (pickA.hasMapping && !pickA.facultyId) continue;
            if (pickB.hasMapping && !pickB.facultyId) continue;
            // Two simultaneous labs can't share one teacher.
            if (pickA.facultyId && pickA.facultyId === pickB.facultyId) continue;
            return { day, s1, s2, facA: pickA.facultyId, facB: pickB.facultyId };
          }
        }
        return null;
      }

      // ── STEP 0: Electives ──
      const electiveGroups = {};
      subjects.filter(s => s.elective_group).forEach(s => {
        (electiveGroups[s.elective_group] = electiveGroups[s.elective_group] || []).push(s);
      });
      let groupIdx = 0;
      for (const g of Object.keys(electiveGroups).sort()) {
        const members = electiveGroups[g];
        const label = sub => `${g}-${members.findIndex(m => m.id === sub) + 1}`;
        const emit = (slotList, assignments) => {
          for (const sl of slotList) {
            for (const a of assignments) push(assigned, a.facultyId, a.subjectId, 3, batch.id, sl.id, label(a.subjectId));
          }
        };

        // Reuse the plan from an earlier section of this semester.
        if (electivePlan[g]) {
          let hours = 0;
          for (const blk of electivePlan[g]) {
            const slotList = blk.slotIds.map(id => timeSlots.find(t => t.id === id));
            if (slotList.some(sl => isBlocked(sl.id) || isBatchSlotTaken(batch.id, sl.id))) continue;
            const asg = blk.assignments.filter(a => members.some(m => m.id === a.subjectId));
            emit(slotList, asg);
            hours += slotList.length;
          }
          if (hours < ELECTIVE_HOURS) warnings.push(`${batch.name}: elective ${g} has ${hours}/${ELECTIVE_HOURS} hours.`);
          groupIdx++;
          continue;
        }

        const plan = [];
        let hoursLeft = ELECTIVE_HOURS;
        const dayHours = {};
        const days_ = rotateArray(batchDays, groupIdx * 2);
        groupIdx++;

        const tryPlace = (slotList) => {
          if (slotList.some(sl => !sl || isBlocked(sl.id) || isBatchSlotTaken(batch.id, sl.id) ||
              (sl.day === 'Saturday' && sl.period_number > 4))) return false;
          const ids = slotList.map(sl => sl.id);
          const picked = {};
          const usedFaculty = new Set();
          // subjects with the fewest possible teachers choose first, so a
          // teacher shared by two subjects goes to the one that needs them
          const order = [...members].sort((a, b) =>
            mappings.filter(x => x.subject_id === a.id).length - mappings.filter(x => x.subject_id === b.id).length);
          for (const m of order) {
            const pk = pickFaculty(m.id, ids, usedFaculty);
            if (pk.hasMapping && !pk.facultyId) return false;       // a subject has no free teacher
            if (pk.facultyId != null) usedFaculty.add(pk.facultyId); // one teacher can't take two simultaneous classes
            picked[m.id] = pk.facultyId;
          }
          const picks = members.map(m => ({ subjectId: m.id, facultyId: picked[m.id] }));
          for (const sl of slotList) for (const pk of picks) markFacultyBusy(pk.facultyId, sl.id);
          emit(slotList, picks);
          plan.push({ slotIds: ids, assignments: picks });
          hoursLeft -= ids.length;
          return true;
        };

        const pairOrder = [[1,2],[3,4],[5,6],[2,3],[4,5]];
        for (const day of days_) {                                  // one 2-period block per day
          if (hoursLeft < 2) break;
          for (const [a, b] of pairOrder) {
            if (tryPlace([getSlot(day, a), getSlot(day, b)])) { dayHours[day] = 2; break; }
          }
        }
        for (const day of days_) {                                  // top up with single periods
          while (hoursLeft > 0 && (dayHours[day] || 0) < ELECTIVE_MAX_PER_DAY) {
            let placed = false;
            for (const pn of [1,2,3,4,5,6]) {
              if (tryPlace([getSlot(day, pn)])) { dayHours[day] = (dayHours[day] || 0) + 1; placed = true; break; }
            }
            if (!placed) break;
          }
        }
        electivePlan[g] = plan;
        if (hoursLeft > 0) {
          warnings.push(`${batch.name}: elective ${g} could only be given ${ELECTIVE_HOURS - hoursLeft}/${ELECTIVE_HOURS} hours ` +
            `(blocked periods or faculty availability/hour limits).`);
        }
      }

      // ── STEP 1: Labs — pair up has_lab subjects two at a time; each
      // pair swaps which split does which subject on the second lab day ──
      for (let i = 0; i + 1 < labSubjects.length; i += 2) {
        const subjA = labSubjects[i];
        const subjB = labSubjects[i + 1];

        const labDay1 = findLabDay(null, [[1,2],[3,4],[5,6]], subjA, subjB);
        if (labDay1) {
          push(assigned, labDay1.facA, subjA.id, 1, batch.id, labDay1.s1.id, 'A');
          push(assigned, labDay1.facA, subjA.id, 1, batch.id, labDay1.s2.id, 'A');
          markFacultyBusy(labDay1.facA, labDay1.s1.id);
          markFacultyBusy(labDay1.facA, labDay1.s2.id);
          push(assigned, labDay1.facB, subjB.id, 2, batch.id, labDay1.s1.id, 'B');
          push(assigned, labDay1.facB, subjB.id, 2, batch.id, labDay1.s2.id, 'B');
          markFacultyBusy(labDay1.facB, labDay1.s1.id);
          markFacultyBusy(labDay1.facB, labDay1.s2.id);

          const restrictedPairs = batchPairs.filter(p => !(p[0] === 1 && p[1] === 2));
          const labDay2 = findLabDay(labDay1.day, restrictedPairs.length ? restrictedPairs : [[3,4],[5,6]], subjB, subjA);
          if (labDay2) {
            push(assigned, labDay2.facA, subjB.id, 2, batch.id, labDay2.s1.id, 'A');
            push(assigned, labDay2.facA, subjB.id, 2, batch.id, labDay2.s2.id, 'A');
            markFacultyBusy(labDay2.facA, labDay2.s1.id);
            markFacultyBusy(labDay2.facA, labDay2.s2.id);
            push(assigned, labDay2.facB, subjA.id, 1, batch.id, labDay2.s1.id, 'B');
            push(assigned, labDay2.facB, subjA.id, 1, batch.id, labDay2.s2.id, 'B');
            markFacultyBusy(labDay2.facB, labDay2.s1.id);
            markFacultyBusy(labDay2.facB, labDay2.s2.id);
          }
        }
      }

      // Odd lab subject left over with no partner to pair against: give
      // both splits the same subject, but on two separate (non-simultaneous)
      // slots — a single faculty can't supervise two rooms at once.
      if (labSubjects.length % 2 === 1) {
        const subj = labSubjects[labSubjects.length - 1];
        for (const split of ['A', 'B']) {
          for (const day of batchDays) {
            if (day === 'Saturday') continue;
            let placed = false;
            for (const [p1, p2] of batchPairs) {
              const s1 = getSlot(day, p1);
              const s2 = getSlot(day, p2);
              if (!s1 || !s2) continue;
              if (isBlocked(s1.id) || isBlocked(s2.id)) continue;
              if (isBatchSlotTaken(batch.id, s1.id) || isBatchSlotTaken(batch.id, s2.id)) continue;
              const pick = pickFaculty(subj.id, [s1.id, s2.id]);
              if (pick.hasMapping && !pick.facultyId) continue;
              push(assigned, pick.facultyId, subj.id, 1, batch.id, s1.id, split);
              push(assigned, pick.facultyId, subj.id, 1, batch.id, s2.id, split);
              markFacultyBusy(pick.facultyId, s1.id);
              markFacultyBusy(pick.facultyId, s2.id);
              placed = true;
              break;
            }
            if (placed) break;
          }
        }
      }

      // ── STEP 2: Placement (identified by the is_placement flag, not a
      // hardcoded code — no faculty attached) ──
      const placementSubj = subjects.find(s => s.is_placement && !s.elective_group);
      if (placementSubj) {
        let placed = false;
        for (const day of batchDays) {
          if (placed) break;
          for (const [p1, p2] of batchPairs) {
            if (day === 'Saturday' && p2 > 4) continue;
            const s1 = getSlot(day, p1);
            const s2 = getSlot(day, p2);
            if (!s1 || !s2) continue;
            if (isBlocked(s1.id) || isBlocked(s2.id)) continue;
            if (isBatchSlotTaken(batch.id, s1.id) || isBatchSlotTaken(batch.id, s2.id)) continue;
            push(assigned, null, placementSubj.id, 3, batch.id, s1.id, null);
            push(assigned, null, placementSubj.id, 3, batch.id, s2.id, null);
            placed = true;
            break;
          }
        }
      }

      // ── STEP 3: Theory ──
      const theorySlots = timeSlots.filter(ts => {
        if (isBlocked(ts.id)) return false;
        if (ts.day === 'Saturday' && ts.period_number > 4) return false;
        return true;
      });

      // Period 1 is handled separately by the "guarantee P1" pass below.
      const slotsByDay = {};
      days.forEach(day => {
        slotsByDay[day] = theorySlots.filter(ts => ts.day === day && ts.period_number !== 1);
      });

      const theorySubjects = subjects.filter(s => s.theory_hours > 0 && !s.is_placement && !s.elective_group && !s.is_project);

      for (const subject of theorySubjects) {
        let hoursLeft = subject.theory_hours;
        const usedDays = [];
        const rotated = rotateArray(batchDays, subject.id);

        // ── Guarantee at least one 1st-hour (Period 1) slot for this subject ──
        if (hoursLeft > 0) {
          let p1Day = null;

          for (const day of rotated) {
            const slot = getSlot(day, 1);
            if (!slot) continue;
            if (isBlocked(slot.id)) continue;
            if (isBatchSlotTaken(batch.id, slot.id)) continue;
            const pick = pickFaculty(subject.id, [slot.id]);
            if (pick.hasMapping && !pick.facultyId) continue;
            const crossClash = allAssigned.some(a =>
              a.time_slot_id === slot.id && a.subject_id === subject.id && a.batch_id !== batch.id
            );
            if (crossClash) continue;
            p1Day = day;
            break;
          }

          if (!p1Day) {
            for (const day of rotated) {
              const slot = getSlot(day, 1);
              if (!slot) continue;
              if (isBlocked(slot.id)) continue;
              if (isBatchSlotTaken(batch.id, slot.id)) continue;
              const pick = pickFaculty(subject.id, [slot.id]);
              if (pick.hasMapping && !pick.facultyId) continue;
              p1Day = day;
              break;
            }
          }

          if (p1Day) {
            const slot = getSlot(p1Day, 1);
            const pick = pickFaculty(subject.id, [slot.id]);
            push(assigned, pick.facultyId, subject.id, 3, batch.id, slot.id, null);
            markFacultyBusy(pick.facultyId, slot.id);
            usedDays.push(p1Day);
            hoursLeft--;
          }
        }

        for (const day of rotated) {
          if (hoursLeft === 0) break;
          if (usedDays.includes(day)) continue;

          const daySlots = slotsByDay[day] || [];
          for (const slot of daySlots) {
            if (isBatchSlotTaken(batch.id, slot.id)) continue;
            const pick = pickFaculty(subject.id, [slot.id]);
            if (pick.hasMapping && !pick.facultyId) continue;

            push(assigned, pick.facultyId, subject.id, 3, batch.id, slot.id, null);
            markFacultyBusy(pick.facultyId, slot.id);
            usedDays.push(day);
            hoursLeft--;
            break;
          }
        }
      }

      // ── Project hours: every remaining free period (no faculty) ──
      const projectSubj = subjects.find(s => s.is_project);
      if (projectSubj) {
        for (const ts of timeSlots) {
          if (isBlocked(ts.id)) continue;
          if (ts.day === 'Saturday' && ts.period_number > 4) continue;
          if (isBatchSlotTaken(batch.id, ts.id)) continue;
          push(assigned, null, projectSubj.id, 3, batch.id, ts.id, null);
        }
      }

      // ── STEP 4: Save ──
      for (const slot of assigned) {
        await pool.query(
          `INSERT INTO timetable_slots
          (faculty_id, subject_id, room_id, batch_id, time_slot_id, batch_split, academic_year, semester)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT DO NOTHING`,
          [slot.faculty_id, slot.subject_id, slot.room_id, slot.batch_id,
           slot.time_slot_id, slot.batch_split, slot.academic_year, slot.semester]
        );
      }

      results.push({ batch: batch.name, assigned: assigned.length });
    }

    return {
      success: true,
      results,
      total_assigned: allAssigned.length,
      warnings,
    };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { generateTimetable };