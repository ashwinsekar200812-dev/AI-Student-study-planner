/*
 * Smart Study Planner — server.js
 * Express backend with JSON file storage.
 * Run: node server.js
 * API base: http://localhost:3000
 */

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Paths ────────────────────────────────────────────────────
const DATA_DIR       = path.join(__dirname, 'data');
const TASKS_FILE     = path.join(DATA_DIR, 'tasks.json');
const AVAIL_FILE     = path.join(DATA_DIR, 'availability.json');
const SETTINGS_FILE  = path.join(DATA_DIR, 'settings.json');
const PROFILE_FILE   = path.join(DATA_DIR, 'profile.json');
const TOPICS_FILE    = path.join(DATA_DIR, 'topics.json');
const RESCUE_FILE    = path.join(DATA_DIR, 'rescue.json');

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '8mb' }));  // allow base64 photo uploads
app.use(express.static(__dirname));

// ─── Ensure data directory and default files exist ───────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const DEFAULT_PROFILE = {
  name:       'Student',
  email:      '',
  institution:'',
  course:     '',
  year:       '',
  bio:        '',
  avatar:     '', // initials-based, stored as text
  goalHours:  6,
  theme:      'navy',
};

function ensureFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
  }
}

ensureFile(TASKS_FILE,    []);
ensureFile(PROFILE_FILE,  DEFAULT_PROFILE);
ensureFile(AVAIL_FILE,    {});
ensureFile(SETTINGS_FILE, { sessionMin: 60, breakMin: 10 });
ensureFile(TOPICS_FILE,   []);
ensureFile(RESCUE_FILE,   { quizResults:[], marksTargets:[], pvLogs:[], microTasks:[], comebackPoints:0, achievements:[], missedReasons:{} });

// ─── Helpers ──────────────────────────────────────────────────
function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─── TASKS API ────────────────────────────────────────────────

// GET /api/tasks — get all tasks
app.get('/api/tasks', (req, res) => {
  const tasks = readJSON(TASKS_FILE) || [];
  res.json(tasks);
});

// POST /api/tasks — add a new task
app.post('/api/tasks', (req, res) => {
  const tasks = readJSON(TASKS_FILE) || [];
  const task  = {
    id:        Date.now().toString(36) + Math.random().toString(36).slice(2),
    title:     req.body.title,
    subject:   req.body.subject,
    type:      req.body.type,
    deadline:  req.body.deadline,
    hours:     req.body.hours,
    weight:    req.body.weight,
    completed: false,
    createdAt: new Date().toISOString(),
  };

  // Basic validation
  if (!task.title || !task.subject || !task.deadline || !task.hours) {
    return res.status(400).json({ error: 'title, subject, deadline, and hours are required.' });
  }
  if (task.hours <= 0) {
    return res.status(400).json({ error: 'hours must be a positive number.' });
  }

  tasks.push(task);
  writeJSON(TASKS_FILE, tasks);
  res.status(201).json(task);
});

// PUT /api/tasks/:id — update a task
app.put('/api/tasks/:id', (req, res) => {
  const tasks = readJSON(TASKS_FILE) || [];
  const idx   = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found.' });

  tasks[idx] = { ...tasks[idx], ...req.body, id: tasks[idx].id };
  writeJSON(TASKS_FILE, tasks);
  res.json(tasks[idx]);
});

// DELETE /api/tasks/:id — delete a task
app.delete('/api/tasks/:id', (req, res) => {
  let tasks = readJSON(TASKS_FILE) || [];
  const exists = tasks.find(t => t.id === req.params.id);
  if (!exists) return res.status(404).json({ error: 'Task not found.' });

  tasks = tasks.filter(t => t.id !== req.params.id);
  writeJSON(TASKS_FILE, tasks);
  res.json({ success: true });
});

// PATCH /api/tasks/:id/toggle — toggle completion
app.patch('/api/tasks/:id/toggle', (req, res) => {
  const tasks = readJSON(TASKS_FILE) || [];
  const idx   = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found.' });

  tasks[idx].completed = !tasks[idx].completed;
  writeJSON(TASKS_FILE, tasks);
  res.json(tasks[idx]);
});

// DELETE /api/tasks — reset all tasks to sample data
app.delete('/api/tasks', (req, res) => {
  writeJSON(TASKS_FILE, []);
  res.json({ success: true });
});

// ─── AVAILABILITY API ─────────────────────────────────────────

// GET /api/availability
app.get('/api/availability', (req, res) => {
  const avail = readJSON(AVAIL_FILE) || {};
  res.json(avail);
});

// PUT /api/availability — save full availability object
app.put('/api/availability', (req, res) => {
  const avail = req.body;
  if (typeof avail !== 'object' || Array.isArray(avail)) {
    return res.status(400).json({ error: 'Availability must be an object.' });
  }
  writeJSON(AVAIL_FILE, avail);
  res.json(avail);
});

// ─── SETTINGS API ─────────────────────────────────────────────

// GET /api/settings
app.get('/api/settings', (req, res) => {
  const settings = readJSON(SETTINGS_FILE) || { sessionMin: 60, breakMin: 10 };
  res.json(settings);
});

// PUT /api/settings
app.put('/api/settings', (req, res) => {
  const { sessionMin, breakMin } = req.body;
  if (!sessionMin || !breakMin) {
    return res.status(400).json({ error: 'sessionMin and breakMin are required.' });
  }
  const settings = { sessionMin: Number(sessionMin), breakMin: Number(breakMin) };
  writeJSON(SETTINGS_FILE, settings);
  res.json(settings);
});

// ─── PROFILE API ──────────────────────────────────────────────

// GET /api/profile
app.get('/api/profile', (req, res) => {
  const profile = readJSON(PROFILE_FILE) || DEFAULT_PROFILE;
  res.json(profile);
});

// PUT /api/profile — update full profile
app.put('/api/profile', (req, res) => {
  const existing = readJSON(PROFILE_FILE) || DEFAULT_PROFILE;
  const allowed = ['name','email','institution','course','year','bio','avatar','goalHours','theme','pictureData'];
  const updated = { ...existing };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updated[key] = req.body[key];
  }
  if (!updated.name || !updated.name.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  if (updated.goalHours && (isNaN(updated.goalHours) || updated.goalHours < 1 || updated.goalHours > 24)) {
    return res.status(400).json({ error: 'Daily goal hours must be between 1 and 24.' });
  }
  writeJSON(PROFILE_FILE, updated);
  res.json(updated);
});

// ─── TOPICS API ───────────────────────────────────────────────
app.get('/api/topics',    (req, res) => res.json(readJSON(TOPICS_FILE) || []));
app.put('/api/topics',    (req, res) => { writeJSON(TOPICS_FILE, req.body); res.json(req.body); });

// ─── RESCUE DATA API ──────────────────────────────────────────
app.get('/api/rescue',    (req, res) => res.json(readJSON(RESCUE_FILE) || {}));
app.put('/api/rescue',    (req, res) => { writeJSON(RESCUE_FILE, req.body); res.json(req.body); });

// ─── Catch-all: serve index.html ──────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n✅ Smart Study Planner running at http://localhost:${PORT}\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    const alt = Number(PORT) + 1;
    console.log(`⚠️  Port ${PORT} busy — trying port ${alt}...`);
    app.listen(alt, () => {
      console.log(`\n✅ Smart Study Planner running at http://localhost:${alt}\n`);
    });
  } else {
    console.error('Server error:', e.message);
  }
});
