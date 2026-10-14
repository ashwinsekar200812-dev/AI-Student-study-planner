/*
 * ============================================================
 * Smart Study Planner — script.js
 * Priority-based greedy scheduling algorithm (no AI API).
 *
 * PRIORITY SCORE FORMULA (per task):
 *   urgency     = 1 - clamp((msToDeadline / MAX_HORIZON_MS), 0, 1)
 *   importance  = (weight - 1) / 4          // normalised 0..1
 *   effort      = clamp(hours / MAX_HOURS, 0, 1)
 *   score       = urgency * 0.50 + importance * 0.35 + effort * 0.15
 *
 * Tasks are sorted descending by score, then greedily placed
 * into the earliest available study window slots before their
 * deadlines.  Slots that fall after a task's deadline are
 * marked "late" and counted as unscheduled for warning purposes.
 * ============================================================
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────
const API_BASE        = '/api';           // backend REST API
const LS_SCHEDULE     = 'ssp_schedule';  // schedule still cached locally
const MAX_HORIZON_MS  = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_HOURS       = 40;

// ─── API helpers ─────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  try {
    const res = await fetch(API_BASE + path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  } catch (e) {
    // Fallback to localStorage if backend is unavailable
    console.warn('API unavailable, using localStorage fallback:', e.message);
    return null;
  }
}

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ─── Default availability ────────────────────────────────────
const DEFAULT_AVAIL = {
  Sunday:    [{ start: '10:00', end: '13:00' }, { start: '15:00', end: '20:00' }],
  Monday:    [{ start: '18:00', end: '22:00' }],
  Tuesday:   [{ start: '18:00', end: '22:00' }],
  Wednesday: [{ start: '18:00', end: '22:00' }],
  Thursday:  [{ start: '18:00', end: '22:00' }],
  Friday:    [{ start: '16:00', end: '20:00' }],
  Saturday:  [{ start: '09:00', end: '13:00' }, { start: '15:00', end: '19:00' }],
};

const DEFAULT_SETTINGS = { sessionMin: 60, breakMin: 10 };

const DEFAULT_PROFILE = {
  name: 'Student', email: '', institution: '', course: '',
  year: '', bio: '', avatar: '', goalHours: 6, theme: 'navy', pictureData: '',
};

const AVATAR_COLORS = [
  '#1a2744','#2563eb','#7c3aed','#db2777','#dc2626',
  '#d97706','#16a34a','#0891b2','#9333ea','#0f766e',
];

// current profile state
let profile = { ...DEFAULT_PROFILE };

// ─── Sample tasks ─────────────────────────────────────────────
function buildSampleTasks() {
  const now = new Date();
  const d = (daysAhead, h = 23, m = 59) => {
    const t = new Date(now);
    t.setDate(t.getDate() + daysAhead);
    t.setHours(h, m, 0, 0);
    return t.toISOString();
  };
  return [
    { id: uid(), title: 'Calculus Final Exam',       subject: 'Mathematics',   type: 'Exam',       deadline: d(7,  9,  0), hours: 12, weight: 5, completed: false },
    { id: uid(), title: 'Literature Essay',           subject: 'English Lit',   type: 'Assignment', deadline: d(4, 23, 59), hours: 6,  weight: 3, completed: false },
    { id: uid(), title: 'Physics Lab Report',         subject: 'Physics',       type: 'Assignment', deadline: d(3, 23, 59), hours: 4,  weight: 4, completed: false },
    { id: uid(), title: 'History Chapter Review',     subject: 'History',       type: 'Revision',   deadline: d(6, 23, 59), hours: 3,  weight: 2, completed: false },
    { id: uid(), title: 'Chemistry Quiz Prep',        subject: 'Chemistry',     type: 'Revision',   deadline: d(2, 14,  0), hours: 2,  weight: 3, completed: false },
    { id: uid(), title: 'Statistics Assignment',      subject: 'Statistics',    type: 'Assignment', deadline: d(5, 23, 59), hours: 5,  weight: 3, completed: false },
  ];
}

// ─── Utilities ───────────────────────────────────────────────
function uid() {
  return Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function fmtHours(h) {
  if (h === 0) return '0h';
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fmtTime(date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function daysUntil(iso) {
  const diff = new Date(iso) - new Date();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function starsHtml(n) {
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

// ─── Storage helpers ──────────────────────────────────────────
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// ─── App state ────────────────────────────────────────────────
let tasks      = [];
let avail      = {};
let settings   = {};
let schedule   = [];        // array of session objects
let prevSchedule = [];      // snapshot before last regeneration

let currentSection    = 'dashboard';
let taskFilter        = 'all';
let editingTaskId     = null;
let starValue         = 3;
let currentWeekOffset = 0;  // weeks relative to today

// ─── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  loadState();
});

async function loadState() {
  // Load all data from backend in parallel
  const [apiTasks, apiAvail, apiSettings, apiProfile] = await Promise.all([
    apiFetch('/tasks'),
    apiFetch('/availability'),
    apiFetch('/settings'),
    apiFetch('/profile'),
  ]);

  // Use API data if available, fall back to localStorage, then defaults
  tasks    = apiTasks    || loadJSON('ssp_tasks', null)    || buildSampleTasks();
  avail    = apiAvail    || loadJSON('ssp_availability', null) || JSON.parse(JSON.stringify(DEFAULT_AVAIL));
  settings = apiSettings || loadJSON('ssp_settings', null) || { ...DEFAULT_SETTINGS };
  profile  = apiProfile  || loadJSON('ssp_profile', null)  || { ...DEFAULT_PROFILE };

  // If backend had no tasks yet, seed with sample data
  if (Array.isArray(tasks) && tasks.length === 0) {
    const samples = buildSampleTasks();
    for (const t of samples) {
      await apiFetch('/tasks', { method: 'POST', body: t });
    }
    tasks = samples;
  }

  // If backend had no availability yet, save defaults
  if (apiAvail && Object.keys(apiAvail).length === 0) {
    await apiFetch('/availability', { method: 'PUT', body: avail });
  }

  prevSchedule = loadJSON(LS_SCHEDULE, []);
  generateSchedule();
  renderAll();
}

async function saveState() {
  // Schedule is still cached locally (it's derived data)
  saveJSON(LS_SCHEDULE, schedule);
}

// Save tasks/avail/settings individually via API
async function saveTask(task, isNew) {
  if (isNew) {
    const saved = await apiFetch('/tasks', { method: 'POST', body: task });
    if (saved) task.id = saved.id; // use server-assigned id if available
  } else {
    await apiFetch(`/tasks/${task.id}`, { method: 'PUT', body: task });
  }
  saveJSON('ssp_tasks', tasks); // localStorage fallback
}

async function deleteTaskAPI(id) {
  await apiFetch(`/tasks/${id}`, { method: 'DELETE' });
  saveJSON('ssp_tasks', tasks);
}

async function toggleTaskAPI(id) {
  await apiFetch(`/tasks/${id}/toggle`, { method: 'PATCH' });
  saveJSON('ssp_tasks', tasks);
}

async function saveAvailAPI() {
  await apiFetch('/availability', { method: 'PUT', body: avail });
  saveJSON('ssp_availability', avail);
}

async function saveSettingsAPI() {
  await apiFetch('/settings', { method: 'PUT', body: settings });
  saveJSON('ssp_settings', settings);
}

// ─── Rendering orchestrator ───────────────────────────────────
function renderAll() {
  renderDashboard();
  renderTaskList();
  renderTimetable();
  renderAvailability();
  renderProfile();
}

// ─────────────────────────────────────────────────────────────
// SCHEDULING ALGORITHM
// ─────────────────────────────────────────────────────────────

/**
 * Compute priority score for a task.
 * urgency(50%) + importance(35%) + effort(15%)
 */
function priorityScore(task) {
  const now     = Date.now();
  const dl      = new Date(task.deadline).getTime();
  const msLeft  = dl - now;
  const urgency = 1 - clamp(msLeft / MAX_HORIZON_MS, 0, 1);
  const importance = (task.weight - 1) / 4;
  const effort  = clamp(task.hours / MAX_HOURS, 0, 1);
  return urgency * 0.50 + importance * 0.35 + effort * 0.15;
}

/**
 * Expand daily availability into concrete slot objects for the
 * next HORIZON days, respecting session/break settings.
 * Returns array of {start:Date, end:Date, dayName:string}
 */
function expandSlots(horizonDays) {
  const slots = [];
  const now   = new Date();
  const sessionMs = settings.sessionMin * 60 * 1000;
  const breakMs   = settings.breakMin   * 60 * 1000;

  for (let d = 0; d <= horizonDays; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    day.setSeconds(0, 0);

    const dayName = DAYS[day.getDay()];
    const windows = avail[dayName] || [];

    for (const win of windows) {
      const [sh, sm] = win.start.split(':').map(Number);
      const [eh, em] = win.end.split(':').map(Number);

      let cursor = new Date(day);
      cursor.setHours(sh, sm, 0, 0);
      const winEnd = new Date(day);
      winEnd.setHours(eh, em, 0, 0);

      // Skip windows that have already passed today
      if (winEnd <= now) continue;
      if (cursor < now) cursor = new Date(now); // start from now within today's window

      while (cursor.getTime() + sessionMs <= winEnd.getTime()) {
        const slotEnd = new Date(cursor.getTime() + sessionMs);
        slots.push({ start: new Date(cursor), end: slotEnd, dayName });
        cursor = new Date(slotEnd.getTime() + breakMs);
      }
    }
  }
  return slots;
}

/**
 * Main scheduling function.
 * Fills `schedule` with session objects and detects shortages.
 */
function generateSchedule() {
  prevSchedule = schedule.slice();
  schedule = [];

  const now        = new Date();
  const pendingTasks = tasks.filter(t => !t.completed);
  if (pendingTasks.length === 0) { saveJSON(LS_SCHEDULE, schedule); return; }

  // Find furthest deadline to size the slot horizon
  const maxDeadlineMs = Math.max(...pendingTasks.map(t => new Date(t.deadline).getTime()));
  const horizonDays   = Math.min(
    Math.ceil((maxDeadlineMs - now.getTime()) / (1000 * 60 * 60 * 24)) + 1,
    60
  );

  const allSlots = expandSlots(horizonDays);   // available time slots

  // Sort tasks by priority score descending
  const sorted = [...pendingTasks].sort((a, b) => priorityScore(b) - priorityScore(a));

  // Track remaining hours per task
  const remaining = {};
  for (const t of sorted) remaining[t.id] = t.hours;

  // Track which slots are used (by slot index)
  const usedSlots = new Set();

  // For each task in priority order, fill slots before deadline
  for (const task of sorted) {
    const deadline = new Date(task.deadline);
    let hoursLeft  = remaining[task.id];

    for (let i = 0; i < allSlots.length && hoursLeft > 0; i++) {
      if (usedSlots.has(i)) continue;
      const slot = allSlots[i];

      const isLate = slot.start >= deadline;

      // Only schedule in-time slots first; we'll handle overflow below
      if (isLate) continue;

      usedSlots.add(i);
      const sessionHours = settings.sessionMin / 60;
      hoursLeft = +(hoursLeft - sessionHours).toFixed(4);

      schedule.push({
        taskId:    task.id,
        title:     task.title,
        subject:   task.subject,
        type:      task.type,
        start:     slot.start.toISOString(),
        end:       slot.end.toISOString(),
        dayName:   slot.dayName,
        late:      false,
        overflow:  false,
      });
    }

    // If still unscheduled hours remain, mark overflow sessions (after deadline)
    if (hoursLeft > 0) {
      for (let i = 0; i < allSlots.length && hoursLeft > 0; i++) {
        if (usedSlots.has(i)) continue;
        const slot = allSlots[i];
        const isLate = slot.start >= deadline;
        if (!isLate) continue;

        usedSlots.add(i);
        const sessionHours = settings.sessionMin / 60;
        hoursLeft = +(hoursLeft - sessionHours).toFixed(4);

        schedule.push({
          taskId:   task.id,
          title:    task.title,
          subject:  task.subject,
          type:     task.type,
          start:    slot.start.toISOString(),
          end:      slot.end.toISOString(),
          dayName:  slot.dayName,
          late:     true,
          overflow: false,
        });
      }
    }

    // If still unscheduled after exhausting all slots, record as unschedulable
    remaining[task.id] = Math.max(0, hoursLeft);
  }

  saveJSON(LS_SCHEDULE, schedule);
}

/**
 * Build a schedule summary object for display.
 */
function buildSummary() {
  const now = new Date();
  const pendingTasks = tasks.filter(t => !t.completed);
  const sessionHours = settings.sessionMin / 60;

  let totalRequired = 0;
  let scheduledInTime = 0;
  let scheduledLate   = 0;

  const taskScheduled = {}; // taskId -> hours scheduled on-time
  for (const t of pendingTasks) taskScheduled[t.id] = 0;

  for (const s of schedule) {
    if (!s.late) {
      scheduledInTime += sessionHours;
      if (taskScheduled[s.taskId] !== undefined)
        taskScheduled[s.taskId] += sessionHours;
    } else {
      scheduledLate += sessionHours;
    }
  }

  for (const t of pendingTasks) totalRequired += t.hours;

  const unscheduledHours = Math.max(0, totalRequired - scheduledInTime);

  // Per-task analysis
  const taskAnalysis = pendingTasks.map(t => {
    const sched   = taskScheduled[t.id] || 0;
    const needed  = t.hours;
    const missing = Math.max(0, needed - sched);
    const dl      = new Date(t.deadline);
    const daysLeft = Math.ceil((dl - now) / (1000 * 60 * 60 * 24));
    return {
      task:     t,
      needed,
      sched,
      missing,
      daysLeft,
      atRisk:   missing > 0,
    };
  });

  return {
    totalRequired,
    scheduledInTime,
    scheduledLate,
    unscheduledHours,
    taskAnalysis,
  };
}

/**
 * Detect what changed between prevSchedule and schedule.
 * Returns array of descriptive strings.
 */
function detectChanges() {
  const sessionHours = settings.sessionMin / 60;
  const changes = [];

  // Count sessions per task in old and new schedule
  const countSessions = (sch) => {
    const map = {};
    for (const s of sch) {
      if (!map[s.taskId]) map[s.taskId] = { title: s.title, count: 0, late: 0 };
      map[s.taskId].count++;
      if (s.late) map[s.taskId].late++;
    }
    return map;
  };

  const oldMap = countSessions(prevSchedule);
  const newMap = countSessions(schedule);

  const allIds = new Set([...Object.keys(oldMap), ...Object.keys(newMap)]);

  for (const id of allIds) {
    const o = oldMap[id];
    const n = newMap[id];
    const title = (n || o).title;
    const oldH = o ? +(o.count * sessionHours).toFixed(1) : 0;
    const newH = n ? +(n.count * sessionHours).toFixed(1) : 0;
    const diff = +(newH - oldH).toFixed(1);

    if (diff === 0) continue;
    if (diff > 0)  changes.push(`"${title}" gained ${fmtHours(Math.abs(diff))} of sessions.`);
    if (diff < 0)  changes.push(`"${title}" lost ${fmtHours(Math.abs(diff))} — displaced by higher-priority tasks.`);
  }

  return changes;
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────
function renderDashboard() {
  const summary = buildSummary();

  // Personalised greeting
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = (profile.name || 'Scholar').split(' ')[0];
  const heroH1 = document.querySelector('.hero-banner .hero-text h1');
  if (heroH1) heroH1.textContent = `${greeting}, ${firstName}! 👋`;

  // Stats
  setText('statTotalHours',   fmtHours(summary.totalRequired));
  setText('statScheduled',    fmtHours(summary.scheduledInTime));
  setText('statUnscheduled',  fmtHours(summary.unscheduledHours));

  const total     = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  setText('statCompleted', `${completed} / ${total}`);

  // Progress bar
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  document.getElementById('progressBar').style.width = pct + '%';
  setText('progressLabel', `${pct}% complete`);

  // Warnings
  renderWarnings(summary);

  // Upcoming deadlines
  renderUpcoming();

  // Mini timetable
  renderMiniTimetable();
}

function renderWarnings(summary) {
  const area = document.getElementById('warningArea');
  const lines = [];

  if (summary.unscheduledHours > 0) {
    lines.push({
      cls: 'danger',
      msg: `You need ${fmtHours(summary.totalRequired)} of study before your deadlines, but only ` +
           `${fmtHours(summary.scheduledInTime)} can be scheduled. ` +
           `You are ${fmtHours(summary.unscheduledHours)} short.`,
    });
  }

  for (const ta of summary.taskAnalysis) {
    if (!ta.atRisk) continue;
    if (ta.daysLeft < 0) {
      lines.push({ cls: 'danger', msg: `"${ta.task.title}" deadline has passed — ${fmtHours(ta.missing)} cannot be scheduled.` });
    } else if (ta.missing > 0) {
      lines.push({ cls: 'warning', msg: `"${ta.task.title}" (${ta.task.type}) — ${fmtHours(ta.missing)} unscheduled with ${ta.daysLeft} day(s) left.` });
    }
  }

  if (lines.length === 0) {
    area.style.display = 'none';
    return;
  }

  area.style.display = 'block';
  area.innerHTML = `<h3>⚠️ Scheduling Warnings</h3>` +
    lines.map(l => `<div class="warning-item ${l.cls === 'danger' ? 'danger' : ''}">${l.msg}</div>`).join('');
}

function renderUpcoming() {
  const el = document.getElementById('upcomingList');
  const now = new Date();
  const upcoming = tasks
    .filter(t => !t.completed)
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline))
    .slice(0, 6);

  if (upcoming.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🎉</div><p>No upcoming tasks!</p></div>`;
    return;
  }

  el.innerHTML = upcoming.map(t => {
    const days  = daysUntil(t.deadline);
    const cls   = days < 0 ? 'overdue' : days <= 2 ? 'urgent' : 'ok';
    const label = days < 0 ? 'Overdue' : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days} days`;
    const badgeCls = t.type === 'Exam' ? 'badge-exam' : t.type === 'Assignment' ? 'badge-assignment' : 'badge-revision';
    return `
      <div class="deadline-item">
        <span class="deadline-badge ${badgeCls}">${t.type}</span>
        <div class="deadline-info">
          <div class="deadline-title">${esc(t.title)}</div>
          <div class="deadline-meta">${esc(t.subject)} · ${fmtDateTime(t.deadline)} · ${fmtHours(t.hours)} prep</div>
        </div>
        <div class="deadline-time ${cls}">${label}</div>
      </div>`;
  }).join('');
}

function renderMiniTimetable() {
  const el = document.getElementById('miniTimetable');
  const today = new Date();

  // Show next 7 days
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    days.push(d);
  }

  const html = days.map(day => {
    const dayStr = day.toDateString();
    const daySessions = schedule.filter(s => new Date(s.start).toDateString() === dayStr);
    const label = i => {
      if (i === 0) return 'Today';
      if (i === 1) return 'Tomorrow';
      return day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    };
    const idx = days.indexOf(day);
    const sessHtml = daySessions.length === 0
      ? `<span class="mini-empty">Free</span>`
      : daySessions.map(s =>
          `<span class="mini-session${s.late ? ' late' : ''}">${esc(s.title.length > 20 ? s.title.slice(0,18)+'…' : s.title)}</span>`
        ).join('');
    return `<div class="mini-day">
      <div class="mini-day-label">${label(idx)}</div>
      <div class="mini-sessions">${sessHtml}</div>
    </div>`;
  }).join('');

  el.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────
// TASKS
// ─────────────────────────────────────────────────────────────
function renderTaskList() {
  const el = document.getElementById('taskList');
  let filtered = [...tasks];

  if (taskFilter === 'completed') filtered = filtered.filter(t => t.completed);
  else if (taskFilter === 'pending') filtered = filtered.filter(t => !t.completed);
  else if (['Exam','Assignment','Revision'].includes(taskFilter))
    filtered = filtered.filter(t => t.type === taskFilter);

  filtered.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

  if (filtered.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><p>No tasks match this filter.</p></div>`;
    return;
  }

  el.innerHTML = filtered.map(t => {
    const days   = daysUntil(t.deadline);
    const badgeCls = t.type === 'Exam' ? 'badge-exam' : t.type === 'Assignment' ? 'badge-assignment' : 'badge-revision';

    let statusCls, statusLabel;
    if (t.completed) { statusCls = 'status-done'; statusLabel = 'Done'; }
    else if (days < 0) { statusCls = 'status-late'; statusLabel = 'Overdue'; }
    else if (days <= 2) { statusCls = 'status-urgent'; statusLabel = `${days}d left`; }
    else { statusCls = 'status-ok'; statusLabel = `${days}d left`; }

    return `
    <div class="task-card${t.completed ? ' completed' : ''}" data-id="${t.id}">
      <div class="task-checkbox${t.completed ? ' checked' : ''}" role="checkbox"
           aria-checked="${t.completed}" tabindex="0"
           data-action="toggle" data-id="${t.id}">
        ${t.completed ? '✓' : ''}
      </div>
      <div class="task-body">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta">
          <span><span class="deadline-badge ${badgeCls}">${t.type}</span></span>
          <span>📚 ${esc(t.subject)}</span>
          <span>⏳ ${fmtHours(t.hours)}</span>
          <span class="stars-display">${starsHtml(t.weight)}</span>
          <span>📅 ${fmtDateTime(t.deadline)}</span>
        </div>
      </div>
      <div class="task-actions">
        <span class="task-status-badge ${statusCls}">${statusLabel}</span>
        <button class="icon-btn" title="Edit" data-action="edit" data-id="${t.id}">✏️</button>
        <button class="icon-btn delete" title="Delete" data-action="delete" data-id="${t.id}">🗑️</button>
      </div>
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// TIMETABLE
// ─────────────────────────────────────────────────────────────
function renderTimetable() {
  renderWeekLabel();
  renderTimetableGrid();
  renderScheduleSummary();
}

function renderWeekLabel() {
  const today = new Date();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - today.getDay() + currentWeekOffset * 7);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  const fmt = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  setText('weekLabel', `${fmt(startOfWeek)} – ${fmt(endOfWeek)}`);
}

function renderTimetableGrid() {
  const el = document.getElementById('timetableGrid');
  const today = new Date();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - today.getDay() + currentWeekOffset * 7);

  // Build array of 7 day objects
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    days.push(d);
  }

  // Collect all sessions for this week, keyed by day index
  const sessionsByDay = days.map(day => {
    const dayStr = day.toDateString();
    return schedule
      .filter(s => new Date(s.start).toDateString() === dayStr)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  });

  // Find max sessions in any day (determines number of rows)
  const maxRows = Math.max(1, ...sessionsByDay.map(s => s.length));

  if (sessionsByDay.every(s => s.length === 0)) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📅</div><p>No sessions for this week. Add tasks or adjust availability.</p></div>`;
    return;
  }

  // Build table header row — one column per day
  const headerCells = days.map((day, i) => {
    const isToday = day.toDateString() === today.toDateString();
    const dayName = day.toLocaleDateString(undefined, { weekday: 'short' });
    const dayDate = day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `<th class="tt-th${isToday ? ' tt-th-today' : ''}">
      ${isToday ? '📍 ' : ''}${dayName}<br/>
      <span class="tt-th-date">${dayDate}</span>
      <br/><span class="tt-session-count">${sessionsByDay[i].length > 0 ? sessionsByDay[i].length + ' session(s)' : '—'}</span>
    </th>`;
  }).join('');

  // Build data rows
  let rowsHtml = '';
  for (let row = 0; row < maxRows; row++) {
    const cells = days.map((day, di) => {
      const s = sessionsByDay[di][row];
      if (!s) return `<td class="tt-td tt-td-empty"></td>`;

      const badgeCls = s.type === 'Exam' ? 'badge-exam' : s.type === 'Assignment' ? 'badge-assignment' : 'badge-revision';
      const cellCls  = s.late ? ' tt-td-late' : '';
      const lateTag  = s.late ? `<span class="task-status-badge status-late">⚠ Late</span>` : '';

      return `<td class="tt-td${cellCls}">
        <div class="tt-cell-time">${fmtTime(new Date(s.start))} – ${fmtTime(new Date(s.end))}</div>
        <div class="tt-cell-title">${esc(s.title)}</div>
        <div class="tt-cell-meta">
          <span class="deadline-badge ${badgeCls}">${s.type}</span>
          <span class="tt-duration-badge">${settings.sessionMin}min</span>
          ${lateTag}
        </div>
        <div class="tt-cell-subject">📚 ${esc(s.subject)}</div>
      </td>`;
    }).join('');
    rowsHtml += `<tr>${cells}</tr>`;
  }

  el.innerHTML = `
    <div class="tt-table-wrap">
      <table class="tt-table">
        <thead>
          <tr>
            ${headerCells}
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>`;
}

function renderScheduleSummary() {
  const el = document.getElementById('scheduleSummary');
  const summary = buildSummary();
  const changes = detectChanges();

  const statsHtml = `
    <div class="summary-grid">
      <div class="summary-stat">
        <div class="summary-stat-val">${fmtHours(summary.totalRequired)}</div>
        <div class="summary-stat-lbl">Total Required</div>
      </div>
      <div class="summary-stat">
        <div class="summary-stat-val">${fmtHours(summary.scheduledInTime)}</div>
        <div class="summary-stat-lbl">Scheduled (on time)</div>
      </div>
      <div class="summary-stat">
        <div class="summary-stat-val">${fmtHours(summary.scheduledLate)}</div>
        <div class="summary-stat-lbl">Scheduled (late)</div>
      </div>
      <div class="summary-stat">
        <div class="summary-stat-val" style="color:${summary.unscheduledHours > 0 ? 'var(--danger)' : 'var(--success)'}">
          ${fmtHours(summary.unscheduledHours)}
        </div>
        <div class="summary-stat-lbl">Unscheduled</div>
      </div>
    </div>`;

  const atRisk = summary.taskAnalysis.filter(ta => ta.atRisk);
  const unschedHtml = atRisk.length === 0 ? `<p style="color:var(--success);font-size:.85rem;">✅ All tasks are fully scheduled within their deadlines.</p>` :
    `<h3 style="font-size:.875rem;margin-bottom:8px;color:var(--danger)">🚨 Tasks with unscheduled hours:</h3>
     <div class="unscheduled-list">
       ${atRisk.map(ta => `
         <div class="unscheduled-item">
           <strong>${esc(ta.task.title)}</strong>
           Need ${fmtHours(ta.needed)}, only ${fmtHours(ta.sched)} scheduled (${fmtHours(ta.missing)} missing).
           Deadline: ${fmtDateTime(ta.task.deadline)}
           ${ta.daysLeft < 0 ? ' — <strong>OVERDUE</strong>' : ` — ${ta.daysLeft} day(s) left.`}
         </div>`).join('')}
     </div>`;

  const changesHtml = changes.length === 0 ? '' : `
    <div style="margin-top:16px;background:var(--warn-light);border:1px solid #fbbf24;border-radius:8px;padding:12px 16px;">
      <h3 style="font-size:.875rem;color:var(--warning);margin-bottom:8px;">📝 What changed after last regeneration:</h3>
      ${changes.map(c => `<div style="font-size:.82rem;color:#78350f;margin-bottom:4px;">• ${c}</div>`).join('')}
    </div>`;

  el.innerHTML = statsHtml + unschedHtml + changesHtml;
}

// ─────────────────────────────────────────────────────────────
// AVAILABILITY
// ─────────────────────────────────────────────────────────────
function renderAvailability() {
  document.getElementById('sessionLength').value = settings.sessionMin;
  document.getElementById('breakLength').value   = settings.breakMin;

  const container = document.getElementById('availabilityEditor');
  container.innerHTML = DAYS.map(day => {
    const windows = avail[day] || [];
    return `
    <div class="avail-day">
      <div class="avail-day-label">${day}</div>
      <div class="avail-windows" id="windows-${day}">
        ${windows.map((w, i) => windowRowHtml(day, i, w.start, w.end)).join('')}
      </div>
      <button class="add-window-btn" data-day="${day}">+ Add Window</button>
    </div>`;
  }).join('');
}

function windowRowHtml(day, idx, start, end) {
  return `
  <div class="avail-window" data-day="${day}" data-idx="${idx}">
    <input type="time" class="win-start" value="${start}" data-day="${day}" data-idx="${idx}" />
    <span style="font-size:.8rem;color:var(--text-muted)">to</span>
    <input type="time" class="win-end" value="${end}" data-day="${day}" data-idx="${idx}" />
    <button class="avail-remove" data-day="${day}" data-idx="${idx}">Remove</button>
  </div>`;
}

function collectAvailFromUI() {
  const result = {};
  for (const day of DAYS) {
    result[day] = [];
    const container = document.getElementById(`windows-${day}`);
    if (!container) continue;
    const rows = container.querySelectorAll('.avail-window');
    rows.forEach(row => {
      const s = row.querySelector('.win-start').value;
      const e = row.querySelector('.win-end').value;
      if (s && e) result[day].push({ start: s, end: e });
    });
  }
  return result;
}

function validateAvailability(a) {
  for (const day of DAYS) {
    const wins = (a[day] || []).slice().sort((x, y) => x.start.localeCompare(y.start));
    for (const w of wins) {
      if (w.start >= w.end) return `${day}: start time must be before end time (${w.start} – ${w.end}).`;
    }
    for (let i = 1; i < wins.length; i++) {
      if (wins[i].start < wins[i - 1].end)
        return `${day}: windows overlap (${wins[i-1].start}–${wins[i-1].end} and ${wins[i].start}–${wins[i].end}).`;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// TASK FORM
// ─────────────────────────────────────────────────────────────
function resetForm() {
  document.getElementById('taskForm').reset();
  document.getElementById('taskTitle').value     = '';
  document.getElementById('taskSubject').value   = '';
  document.getElementById('taskType').value      = 'Exam';
  document.getElementById('taskDeadline').value  = '';
  document.getElementById('taskHours').value     = '';
  document.getElementById('taskImportance').value = '3';
  document.getElementById('formError').textContent = '';
  document.getElementById('formTitle').textContent  = 'Add New Task';
  document.getElementById('taskSubmitBtn').textContent = 'Add Task';
  document.getElementById('taskCancelBtn').style.display = 'none';
  setStars(3);
  editingTaskId = null;
}

function setStars(val) {
  starValue = val;
  document.getElementById('taskImportance').value = val;
  document.querySelectorAll('#starRow .star').forEach(s => {
    s.classList.toggle('active', +s.dataset.val <= val);
  });
}

function validateTaskForm() {
  const title    = document.getElementById('taskTitle').value.trim();
  const subject  = document.getElementById('taskSubject').value.trim();
  const deadline = document.getElementById('taskDeadline').value;
  const hoursVal = document.getElementById('taskHours').value;
  const hours    = parseFloat(hoursVal);

  if (!title)       return 'Title is required.';
  if (!subject)     return 'Subject is required.';
  if (!deadline)    return 'Deadline is required.';
  if (!hoursVal || isNaN(hours) || hours <= 0) return 'Estimated hours must be a positive number.';
  if (hours > 500)  return 'Estimated hours seem unrealistically large.';

  const dlDate = new Date(deadline);
  if (isNaN(dlDate.getTime())) return 'Please enter a valid deadline date/time.';

  // Allow past deadlines but warn — don't block (user may be tracking late tasks)
  if (!editingTaskId) {
    const dup = tasks.find(t =>
      t.title.toLowerCase() === title.toLowerCase() &&
      t.subject.toLowerCase() === subject.toLowerCase() &&
      t.deadline === dlDate.toISOString()
    );
    if (dup) return 'A task with this title, subject, and deadline already exists.';
  }
  return null;
}

function getFormData() {
  return {
    title:    document.getElementById('taskTitle').value.trim(),
    subject:  document.getElementById('taskSubject').value.trim(),
    type:     document.getElementById('taskType').value,
    deadline: new Date(document.getElementById('taskDeadline').value).toISOString(),
    hours:    parseFloat(document.getElementById('taskHours').value),
    weight:   +document.getElementById('taskImportance').value || 3,
    // completed is NOT overwritten here — preserved in the spread below when editing
  };
}

function populateFormForEdit(task) {
  document.getElementById('taskTitle').value    = task.title;
  document.getElementById('taskSubject').value  = task.subject;
  document.getElementById('taskType').value     = task.type;
  // datetime-local wants "YYYY-MM-DDTHH:MM"
  const dl = new Date(task.deadline);
  const pad = n => String(n).padStart(2, '0');
  document.getElementById('taskDeadline').value =
    `${dl.getFullYear()}-${pad(dl.getMonth()+1)}-${pad(dl.getDate())}T${pad(dl.getHours())}:${pad(dl.getMinutes())}`;
  document.getElementById('taskHours').value    = task.hours;
  setStars(task.weight || 3);
  document.getElementById('formTitle').textContent     = 'Edit Task';
  document.getElementById('taskSubmitBtn').textContent = 'Save Changes';
  document.getElementById('taskCancelBtn').style.display = 'inline-flex';
  editingTaskId = task.id;
}

// ─────────────────────────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────────────────────────
function bindEvents() {
  // Navigation
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      switchSection(link.dataset.section);
      // close mobile sidebar
      document.getElementById('sidebar').classList.remove('open');
    });
  });

  document.getElementById('hamburger').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  // Add task buttons
  ['addTaskBtnTop','addTaskBtnDash'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
      switchSection('tasks');
      resetForm();
      document.getElementById('taskTitle').focus();
    });
  });

  // Star rating
  document.querySelectorAll('#starRow .star').forEach(star => {
    star.addEventListener('click', () => setStars(+star.dataset.val));
    star.addEventListener('mouseover', () => {
      document.querySelectorAll('#starRow .star').forEach(s => {
        s.classList.toggle('active', +s.dataset.val <= +star.dataset.val);
      });
    });
  });
  document.getElementById('starRow').addEventListener('mouseleave', () => setStars(starValue));

  // Task form submit
  document.getElementById('taskForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = validateTaskForm();
    if (err) { document.getElementById('formError').textContent = err; return; }
    document.getElementById('formError').textContent = '';

    const data = getFormData();
    const wasEditing = editingTaskId;
    if (wasEditing) {
      const idx = tasks.findIndex(t => t.id === wasEditing);
      if (idx !== -1) tasks[idx] = { ...tasks[idx], ...data };
      await saveTask(tasks[tasks.findIndex(t => t.id === wasEditing)], false);
    } else {
      const newTask = { id: uid(), completed: false, ...data };
      tasks.push(newTask);
      await saveTask(newTask, true);
    }

    generateSchedule();
    saveState();
    renderAll();
    resetForm();

    if (!wasEditing) switchSection('timetable');
  });

  document.getElementById('taskCancelBtn').addEventListener('click', () => resetForm());

  // Task list interactions (toggle, edit, delete)
  document.getElementById('taskList').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;

    if (action === 'toggle') toggleTask(id);
    if (action === 'edit')   editTask(id);
    if (action === 'delete') confirmDelete(id);
  });

  // Keyboard on checkbox
  document.getElementById('taskList').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      const cb = e.target.closest('[data-action="toggle"]');
      if (cb) { e.preventDefault(); toggleTask(cb.dataset.id); }
    }
  });

  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      taskFilter = btn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTaskList();
    });
  });

  // Timetable regen
  ['regenBtn','regenBtnDash'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
      generateSchedule();
      saveState();
      renderAll();
      switchSection('timetable');
    });
  });

  // Week navigation
  document.getElementById('prevWeekBtn').addEventListener('click', () => {
    currentWeekOffset--;
    renderTimetable();
  });
  document.getElementById('nextWeekBtn').addEventListener('click', () => {
    currentWeekOffset++;
    renderTimetable();
  });

  // Availability editor — dynamic events
  document.getElementById('availabilityEditor').addEventListener('click', e => {
    if (e.target.classList.contains('add-window-btn')) {
      const day = e.target.dataset.day;
      const container = document.getElementById(`windows-${day}`);
      const idx = container.querySelectorAll('.avail-window').length;
      container.insertAdjacentHTML('beforeend', windowRowHtml(day, idx, '09:00', '12:00'));
    }
    if (e.target.classList.contains('avail-remove')) {
      e.target.closest('.avail-window').remove();
    }
  });

  document.getElementById('saveSettings').addEventListener('click', async () => {
    const sl = parseInt(document.getElementById('sessionLength').value);
    const bl = parseInt(document.getElementById('breakLength').value);
    if (sl < 30 || sl > 180) { alert('Session length must be 30–180 minutes.'); return; }
    if (bl < 0  || bl > 60)  { alert('Break length must be 0–60 minutes.'); return; }
    settings = { sessionMin: sl, breakMin: bl };
    await saveSettingsAPI();
    generateSchedule();
    saveState();
    renderAll();
    alert('Settings saved and schedule regenerated.');
  });

  document.getElementById('saveAvailBtn').addEventListener('click', async () => {
    const newAvail = collectAvailFromUI();
    const err = validateAvailability(newAvail);
    if (err) { document.getElementById('availError').textContent = err; return; }
    document.getElementById('availError').textContent = '';
    avail = newAvail;
    await saveAvailAPI();
    generateSchedule();
    saveState();
    renderAll();
    alert('Availability saved and schedule regenerated.');
  });

  // Reset demo
  document.getElementById('resetBtn').addEventListener('click', () => {
    confirmDialog(
      'Reset Demo Data',
      'This will remove all tasks and restore the original sample data. Are you sure?',
      async () => {
        // Clear tasks on backend
        await apiFetch('/tasks', { method: 'DELETE' });
        // Re-seed sample tasks
        const samples = buildSampleTasks();
        for (const t of samples) {
          await apiFetch('/tasks', { method: 'POST', body: t });
        }
        tasks    = samples;
        avail    = JSON.parse(JSON.stringify(DEFAULT_AVAIL));
        settings = { ...DEFAULT_SETTINGS };
        await saveAvailAPI();
        await saveSettingsAPI();
        prevSchedule = [];
        generateSchedule();
        saveState();
        currentWeekOffset = 0;
        taskFilter = 'all';
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.filter-btn[data-filter="all"]').classList.add('active');
        resetForm();
        renderAll();
        switchSection('dashboard');
      }
    );
  });

  // Modal close
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modalOverlay')) closeModal();
  });

  // Profile form
  document.getElementById('profileForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = validateProfileForm();
    if (err) { document.getElementById('profileError').textContent = err; return; }
    document.getElementById('profileError').textContent = '';
    profile = {
      ...profile,
      name:        document.getElementById('profName').value.trim(),
      email:       document.getElementById('profEmail').value.trim(),
      institution: document.getElementById('profInstitution').value.trim(),
      course:      document.getElementById('profCourse').value.trim(),
      year:        document.getElementById('profYear').value,
      bio:         document.getElementById('profBio').value.trim(),
      goalHours:   parseFloat(document.getElementById('profGoal').value) || 6,
    };
    await apiFetch('/profile', { method: 'PUT', body: profile });
    saveJSON('ssp_profile', profile);
    renderProfile();
    renderDashboard();
    showToast('Profile saved successfully! 🎉');
  });

  document.getElementById('profileResetBtn').addEventListener('click', () => {
    populateProfileForm();
  });

  // ── Profile photo upload ──────────────────────────────────
  document.getElementById('profileAvatar')?.addEventListener('click',       () => document.getElementById('avatarFileInput').click());
  document.getElementById('avatarUploadOverlay')?.addEventListener('click', () => document.getElementById('avatarFileInput').click());
  document.getElementById('avatarUploadBtn')?.addEventListener('click',     () => document.getElementById('avatarFileInput').click());

  document.getElementById('avatarFileInput')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Please choose an image file (JPG, PNG, etc.)'); return; }
    if (file.size > 5 * 1024 * 1024) { showToast('Image must be under 5 MB.'); return; }
    const reader = new FileReader();
    reader.onload = ev => openCropModal(ev.target.result);
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  document.getElementById('avatarRemoveBtn')?.addEventListener('click', async () => {
    profile.pictureData = '';
    await apiFetch('/profile', { method: 'PUT', body: profile });
    saveJSON('ssp_profile', profile);
    renderProfile();
    showToast('Profile photo removed.');
  });

  // Avatar colour change (colour swatches — shown only when no photo)
  document.getElementById('avatarSwatches')?.addEventListener('click', async e => {
    const sw = e.target.closest('.avatar-swatch');
    if (!sw) return;
    profile.avatar = sw.dataset.color;
    await apiFetch('/profile', { method: 'PUT', body: profile });
    saveJSON('ssp_profile', profile);
    renderProfile();
  });

  // Sidebar profile edit button
  document.getElementById('sidebarProfile').addEventListener('click', e => {
    const btn = e.target.closest('.sp-edit-btn');
    if (btn) switchSection('profile');
  });
}

// ─── Task operations ──────────────────────────────────────────
async function toggleTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  task.completed = !task.completed;
  await toggleTaskAPI(id);
  generateSchedule();
  saveState();
  renderAll();
}

async function editTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  switchSection('tasks');
  populateFormForEdit(task);
  document.getElementById('taskFormCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function confirmDelete(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  confirmDialog(
    'Delete Task',
    `Are you sure you want to delete "${task.title}"?`,
    async () => {
      tasks = tasks.filter(t => t.id !== id);
      await deleteTaskAPI(id);
      generateSchedule();
      saveState();
      renderAll();
    }
  );
}

// ─── Section switching ────────────────────────────────────────
function switchSection(name) {
  currentSection = name;
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(`section-${name}`)?.classList.add('active');
  document.querySelectorAll('.nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.section === name);
  });
}

// ─── Modal / confirm ──────────────────────────────────────────
function closeModal() {
  document.getElementById('modalOverlay').style.display = 'none';
}

function confirmDialog(title, msg, onYes) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMsg').textContent   = msg;
  document.getElementById('confirmOverlay').style.display = 'flex';

  const yes = document.getElementById('confirmYes');
  const no  = document.getElementById('confirmNo');

  const cleanup = () => {
    document.getElementById('confirmOverlay').style.display = 'none';
    yes.removeEventListener('click', onYesClick);
    no.removeEventListener('click', onNoClick);
  };
  const onYesClick = () => { cleanup(); onYes(); };
  const onNoClick  = () => cleanup();

  yes.addEventListener('click', onYesClick);
  no.addEventListener('click',  onNoClick);
}

// ─── Helpers ──────────────────────────────────────────────────
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── PROFILE ──────────────────────────────────────────────────

function getInitials(name) {
  if (!name) return 'S';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function renderProfile() {
  const initials = getInitials(profile.name);
  const avatarBg = profile.avatar || AVATAR_COLORS[0];
  const hasPhoto = !!(profile.pictureData);

  // ── Big profile avatar ──
  const pa = document.getElementById('profileAvatar');
  if (pa) {
    if (hasPhoto) {
      pa.innerHTML = `<img src="${profile.pictureData}" alt="Profile photo" />`;
      pa.style.background = 'transparent';
    } else {
      pa.innerHTML = initials;
      pa.style.background = avatarBg;
    }
  }

  // ── Show / hide remove button ──
  const removeBtn = document.getElementById('avatarRemoveBtn');
  if (removeBtn) removeBtn.style.display = hasPhoto ? 'inline-flex' : 'none';

  // ── Colour row: hide when photo is set ──
  const colorRow = document.getElementById('avatarColorRow');
  if (colorRow) colorRow.style.display = hasPhoto ? 'none' : 'flex';

  // ── Render colour swatches ──
  const swatchWrap = document.getElementById('avatarSwatches');
  if (swatchWrap) {
    swatchWrap.innerHTML = AVATAR_COLORS.map(c =>
      `<div class="avatar-swatch${profile.avatar === c ? ' selected' : ''}"
            data-color="${c}" style="background:${c}" title="${c}"></div>`
    ).join('');
  }

  // ── Display fields ──
  setText('profileDisplayName',   profile.name   || 'Student');
  setText('profileDisplayCourse', profile.course || '—');
  setText('profileDisplayInst',   profile.institution || '—');

  // ── Quick stats ──
  const done  = tasks.filter(t => t.completed).length;
  const total = tasks.length;
  setText('pqsGoal',  (profile.goalHours || 6) + 'h');
  setText('pqsDone',  done);
  setText('pqsTotal', total);

  // ── Sidebar mini card ──
  const spAvatar = document.getElementById('spAvatar');
  if (spAvatar) {
    if (hasPhoto) {
      spAvatar.innerHTML = `<img src="${profile.pictureData}" alt="Profile photo" />`;
      spAvatar.style.background = 'transparent';
    } else {
      spAvatar.innerHTML = initials;
      spAvatar.style.background = avatarBg;
    }
  }
  setText('spName',   profile.name   || 'Student');
  setText('spCourse', profile.course || 'Add your course →');

  // ── Populate form fields ──
  populateProfileForm();
}

function populateProfileForm() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  set('profName',        profile.name);
  set('profEmail',       profile.email);
  set('profInstitution', profile.institution);
  set('profCourse',      profile.course);
  set('profYear',        profile.year);
  set('profBio',         profile.bio);
  set('profGoal',        profile.goalHours || 6);
}

function validateProfileForm() {
  const name = document.getElementById('profName').value.trim();
  if (!name) return 'Full name is required.';
  if (name.length < 2) return 'Name must be at least 2 characters.';
  const goal = parseFloat(document.getElementById('profGoal').value);
  if (document.getElementById('profGoal').value && (isNaN(goal) || goal < 1 || goal > 24)) {
    return 'Daily goal must be between 1 and 24 hours.';
  }
  return null;
}

// ─── TOAST ────────────────────────────────────────────────────
function showToast(msg) {
  const existing = document.getElementById('toastMsg');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.id = 'toastMsg';
  t.textContent = msg;
  t.style.cssText = `
    position:fixed; bottom:28px; left:50%; transform:translateX(-50%);
    background:var(--navy); color:#fff; padding:12px 24px; border-radius:99px;
    font-size:0.875rem; font-weight:600; box-shadow:0 8px 24px rgba(0,0,0,0.2);
    z-index:9999; animation:fadeIn 0.2s ease;
    white-space:nowrap; border:1px solid rgba(255,255,255,0.1);
  `;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─── PHOTO CROP MODAL ─────────────────────────────────────────
/*
 * Opens a modal with:
 *  - circular preview of the uploaded image
 *  - zoom slider
 *  - Confirm → crops to 200×200 circle, saves as base64
 */

let cropState = { src: '', zoom: 1, offsetX: 0, offsetY: 0, dragging: false, lastX: 0, lastY: 0 };

function openCropModal(dataUrl) {
  // Remove existing modal if any
  const old = document.getElementById('cropModalOverlay');
  if (old) old.remove();

  cropState = { src: dataUrl, zoom: 1, offsetX: 0, offsetY: 0, dragging: false, lastX: 0, lastY: 0 };

  const overlay = document.createElement('div');
  overlay.id = 'cropModalOverlay';
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = '2000';

  overlay.innerHTML = `
    <div class="modal crop-modal" role="dialog" aria-modal="true" aria-labelledby="cropModalTitle">
      <div class="modal-header">
        <h2 id="cropModalTitle">🖼️ Adjust Your Photo</h2>
        <button class="modal-close" id="cropCancel" aria-label="Cancel">✕</button>
      </div>
      <div class="modal-body">
        <p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:16px;text-align:center;">
          Drag to reposition · Use the slider to zoom
        </p>

        <!-- Circular preview with draggable image -->
        <div class="crop-preview-wrap" id="cropPreviewWrap">
          <canvas id="cropCanvas" width="200" height="200"
                  style="cursor:grab;border-radius:50%;display:block;width:200px;height:200px;"
                  aria-label="Drag to reposition image"></canvas>
        </div>

        <!-- Zoom slider -->
        <div class="crop-slider-row">
          <label for="cropZoom">🔍 Zoom</label>
          <input type="range" id="cropZoom" min="0.5" max="3" step="0.05" value="1" />
          <span id="cropZoomVal" style="font-size:0.78rem;font-weight:700;color:var(--text-muted);min-width:36px;">1×</span>
        </div>

        <div class="form-actions" style="justify-content:center;gap:12px;">
          <button class="btn btn-primary" id="cropConfirm">✅ Use This Photo</button>
          <button class="btn btn-ghost"   id="cropCancelBtn">Cancel</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  // Draw initial canvas
  const img = new Image();
  img.onload = () => {
    cropState.img = img;
    // Auto-fit zoom so image fills the circle
    const minDim = Math.min(img.naturalWidth, img.naturalHeight);
    cropState.baseScale = 200 / minDim;
    cropState.zoom = 1;
    cropState.offsetX = (img.naturalWidth  - minDim) / 2;
    cropState.offsetY = (img.naturalHeight - minDim) / 2;
    drawCropCanvas();
  };
  img.src = dataUrl;

  // Zoom slider
  document.getElementById('cropZoom').addEventListener('input', e => {
    cropState.zoom = parseFloat(e.target.value);
    document.getElementById('cropZoomVal').textContent = cropState.zoom.toFixed(2) + '×';
    drawCropCanvas();
  });

  // Canvas drag
  const canvas = document.getElementById('cropCanvas');
  canvas.addEventListener('mousedown',  e => { cropState.dragging = true; cropState.lastX = e.clientX; cropState.lastY = e.clientY; canvas.style.cursor = 'grabbing'; });
  canvas.addEventListener('touchstart', e => { cropState.dragging = true; cropState.lastX = e.touches[0].clientX; cropState.lastY = e.touches[0].clientY; }, { passive: true });

  document.addEventListener('mousemove', onCropDrag);
  document.addEventListener('touchmove', onCropDragTouch, { passive: true });
  document.addEventListener('mouseup',   () => { cropState.dragging = false; canvas.style.cursor = 'grab'; });
  document.addEventListener('touchend',  () => { cropState.dragging = false; });

  // Buttons
  document.getElementById('cropConfirm').addEventListener('click',    confirmCrop);
  document.getElementById('cropCancel').addEventListener('click',     cancelCrop);
  document.getElementById('cropCancelBtn').addEventListener('click',  cancelCrop);
  overlay.addEventListener('click', e => { if (e.target === overlay) cancelCrop(); });
}

function onCropDrag(e) {
  if (!cropState.dragging || !cropState.img) return;
  const dx = (e.clientX - cropState.lastX) / (cropState.baseScale * cropState.zoom);
  const dy = (e.clientY - cropState.lastY) / (cropState.baseScale * cropState.zoom);
  cropState.offsetX -= dx;
  cropState.offsetY -= dy;
  cropState.lastX = e.clientX;
  cropState.lastY = e.clientY;
  clampCropOffset();
  drawCropCanvas();
}

function onCropDragTouch(e) {
  if (!cropState.dragging || !cropState.img) return;
  const dx = (e.touches[0].clientX - cropState.lastX) / (cropState.baseScale * cropState.zoom);
  const dy = (e.touches[0].clientY - cropState.lastY) / (cropState.baseScale * cropState.zoom);
  cropState.offsetX -= dx;
  cropState.offsetY -= dy;
  cropState.lastX = e.touches[0].clientX;
  cropState.lastY = e.touches[0].clientY;
  clampCropOffset();
  drawCropCanvas();
}

function clampCropOffset() {
  const { img, zoom, baseScale } = cropState;
  if (!img) return;
  const visibleInSrc = 200 / (baseScale * zoom);
  cropState.offsetX = Math.max(0, Math.min(cropState.offsetX, img.naturalWidth  - visibleInSrc));
  cropState.offsetY = Math.max(0, Math.min(cropState.offsetY, img.naturalHeight - visibleInSrc));
}

function drawCropCanvas() {
  const canvas = document.getElementById('cropCanvas');
  if (!canvas || !cropState.img) return;
  const ctx = canvas.getContext('2d');
  const { img, zoom, offsetX, offsetY, baseScale } = cropState;
  const visibleInSrc = 200 / (baseScale * zoom);

  ctx.clearRect(0, 0, 200, 200);

  // Clip to circle
  ctx.save();
  ctx.beginPath();
  ctx.arc(100, 100, 100, 0, Math.PI * 2);
  ctx.clip();

  ctx.drawImage(img,
    offsetX, offsetY, visibleInSrc, visibleInSrc,  // source rect
    0,       0,       200,          200             // dest rect
  );

  ctx.restore();

  // Circle border
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth   = 4;
  ctx.beginPath();
  ctx.arc(100, 100, 98, 0, Math.PI * 2);
  ctx.stroke();
}

async function confirmCrop() {
  const canvas = document.getElementById('cropCanvas');
  if (!canvas) return;

  // Export as compressed JPEG
  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  profile.pictureData = dataUrl;

  await apiFetch('/profile', { method: 'PUT', body: profile });
  saveJSON('ssp_profile', profile);
  renderProfile();
  cancelCrop();
  showToast('Profile photo updated! 📸');
}

function cancelCrop() {
  const overlay = document.getElementById('cropModalOverlay');
  if (overlay) {
    document.removeEventListener('mousemove', onCropDrag);
    document.removeEventListener('touchmove', onCropDragTouch);
    overlay.remove();
  }
}
