/*
 * ============================================================
 * RescueStudy — rescue.js
 * Adaptive AI Study Intelligence Layer
 * Implements features A-O purely in vanilla JS.
 * No external APIs. Reads/writes localStorage + /api/topics + /api/rescue.
 *
 * ALGORITHMS (transparent, no AI model):
 *  - Revision priority score = weakness(40%) + urgency(35%) + quizMiss(25%)
 *  - Readiness score = syllabusComp(40%) + quizAcc(35%) + masteryRatio(25%)
 *  - Subject risk = inverse readiness, bucketed into low/medium/high
 *  - Comeback points awarded on session complete, gap improvement, return after miss
 * ============================================================
 */

'use strict';

// ─── State ────────────────────────────────────────────────────
let topics      = [];   // [{id, subject, topic, status, prereq, quizMisses, studyMisses}]
let rescueData  = {     // all other rescue module data
  quizResults:    [],   // [{id, topic, subject, confidence, accuracy, date}]
  marksTargets:   [],   // [{id, subject, current, target, date}]
  pvLogs:         [],   // [{id, date, planned, actual, note}]
  microTasks:     [],   // [{id, topicId, label, duration, done}]
  comebackPoints: 0,
  achievements:   [],   // strings
  missedReasons:  {},   // taskId → reason string
};

let distractionActive = false;
let simActive         = false;

const STATUS_LABELS = {
  'not-started':    { label: 'Not Started', icon: '⬜' },
  'not-understood': { label: 'Not Understood', icon: '🔴' },
  'needs-revision': { label: 'Needs Revision', icon: '🟡' },
  'mastered':       { label: 'Mastered', icon: '🟢' },
};

const MICRO_TEMPLATES = [
  { label: 'Review key concepts', duration: 15 },
  { label: 'Write a 5-line summary', duration: 10 },
  { label: 'Active recall — cover notes and recite', duration: 15 },
  { label: 'Solve 3 practice questions', duration: 20 },
  { label: 'Draw a mind map of the topic', duration: 15 },
  { label: 'Find and review one worked example', duration: 10 },
  { label: 'Make 5 flashcards for key terms', duration: 10 },
  { label: 'Explain the topic out loud (Feynman technique)', duration: 15 },
];

const STUDY_METHODS = [
  { from: 'Re-reading notes', to: 'Active recall — close notes, recite key points', reason: 'Re-reading gives a false sense of familiarity. Active recall builds real memory.' },
  { from: 'Passive reading', to: 'Solve practice problems', reason: 'Practice problems expose gaps that reading hides.' },
  { from: 'Long single sessions', to: 'Pomodoro sessions (25 min + 5 min break)', reason: 'Shorter focused bursts reduce mental fatigue.' },
  { from: 'Linear notes', to: 'Mind map or concept diagram', reason: 'Visual organisation helps see how ideas connect.' },
  { from: 'Reviewing everything', to: 'Spaced repetition — focus only on weak areas', reason: 'Spending equal time on mastered topics is inefficient.' },
];

// ─── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(rescueInit, 200); // wait for script.js loadState to finish
});

async function rescueInit() {
  await loadRescueState();
  bindRescueEvents();
  renderRescueAll();
  // Set today's date default for plan-vs-reality input
  const pvDate = document.getElementById('pvDate');
  if (pvDate) pvDate.value = new Date().toISOString().slice(0, 10);
}

async function loadRescueState() {
  const [apiTopics, apiRescue] = await Promise.all([
    rescueFetch('/topics'),
    rescueFetch('/rescue'),
  ]);
  topics      = apiTopics   || loadJSON('rs_topics',  []);
  rescueData  = apiRescue   || loadJSON('rs_rescue',  {
    quizResults:[], marksTargets:[], pvLogs:[], microTasks:[],
    comebackPoints:0, achievements:[], missedReasons:{},
  });
  // Normalise missing fields
  if (!rescueData.quizResults)  rescueData.quizResults   = [];
  if (!rescueData.marksTargets) rescueData.marksTargets  = [];
  if (!rescueData.pvLogs)       rescueData.pvLogs        = [];
  if (!rescueData.microTasks)   rescueData.microTasks    = [];
  if (!rescueData.achievements) rescueData.achievements  = [];
  if (!rescueData.missedReasons)rescueData.missedReasons = {};
  if (!rescueData.comebackPoints) rescueData.comebackPoints = 0;
}

function renderRescueAll() {
  renderHeatmap();
  renderQuizResults();
  renderMarksDisplay();
  renderRevisionQueue();
  renderMicroTasks();
  renderReadiness();
  renderSubjectRisk();
  renderCountdownStrategy();
  renderDeadlineCollision();
  renderComebackScore();
  renderMethodSwitcher();
  renderPVHistory();
  renderAutopsy();
}

// ─── API ──────────────────────────────────────────────────────
async function rescueFetch(path, options = {}) {
  try {
    const url = '/api' + path;
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) return null;
    return res.status === 204 ? null : res.json();
  } catch { return null; }
}

async function saveTopics() {
  await rescueFetch('/topics', { method: 'PUT', body: topics });
  saveJSON('rs_topics', topics);
}

async function saveRescue() {
  await rescueFetch('/rescue', { method: 'PUT', body: rescueData });
  saveJSON('rs_rescue', rescueData);
}

// ─── EVENTS ───────────────────────────────────────────────────
function bindRescueEvents() {

  // ── Heatmap: add topic ──
  document.getElementById('heatAddBtn')?.addEventListener('click', async () => {
    const subj = document.getElementById('heatSubject').value.trim();
    const top  = document.getElementById('heatTopic').value.trim();
    const stat = document.getElementById('heatStatus').value;
    const prereq = document.getElementById('heatPrereq').value.trim();
    const err = document.getElementById('heatError');
    if (!subj) { err.textContent = 'Subject is required.'; return; }
    if (!top)  { err.textContent = 'Topic is required.'; return; }
    err.textContent = '';
    topics.push({ id: ruid(), subject: subj, topic: top, status: stat, prereq, quizMisses: 0, studyMisses: 0 });
    await saveTopics();
    document.getElementById('heatSubject').value = '';
    document.getElementById('heatTopic').value   = '';
    document.getElementById('heatPrereq').value  = '';
    awardComebackPoints(5, `Added topic: ${top}`);
    renderRescueAll();
  });

  // ── Heatmap: delegate status/delete clicks ──
  document.getElementById('heatmapContainer')?.addEventListener('click', async e => {
    const btn = e.target.closest('.topic-status-btn');
    const del = e.target.closest('.topic-del-btn');
    if (btn) {
      const id = btn.closest('.topic-card')?.dataset.id;
      const topic = topics.find(t => t.id === id);
      if (!topic) return;
      const oldStatus = topic.status;
      topic.status = btn.dataset.status;
      if (topic.status === 'mastered' && oldStatus !== 'mastered') awardComebackPoints(10, `Mastered: ${topic.topic}`);
      await saveTopics();
      renderRescueAll();
    }
    if (del) {
      const id = del.dataset.id;
      topics = topics.filter(t => t.id !== id);
      await saveTopics();
      renderRescueAll();
    }
  });

  // ── Quiz ──
  document.getElementById('quizSubmitBtn')?.addEventListener('click', async () => {
    const topic   = document.getElementById('quizTopic').value.trim();
    const subject = document.getElementById('quizSubject').value.trim();
    const conf    = +document.getElementById('quizConfidence').value;
    const acc     = +document.getElementById('quizAccuracy').value;
    const err     = document.getElementById('quizError');
    if (!topic)   { err.textContent = 'Topic is required.'; return; }
    if (!subject) { err.textContent = 'Subject is required.'; return; }
    if (isNaN(acc) || acc < 0 || acc > 100) { err.textContent = 'Accuracy must be 0–100.'; return; }
    err.textContent = '';
    rescueData.quizResults.push({ id: ruid(), topic, subject, confidence: conf, accuracy: acc, date: new Date().toISOString() });
    // Flag quiz misses on matching topics
    const t = topics.find(tp => tp.topic.toLowerCase() === topic.toLowerCase() && tp.subject.toLowerCase() === subject.toLowerCase());
    if (t && acc < 60) { t.quizMisses = (t.quizMisses || 0) + 1; await saveTopics(); }
    // Auto-update status if accuracy very low
    if (t && acc < 40 && t.status !== 'not-understood') { t.status = 'not-understood'; await saveTopics(); }
    if (t && acc >= 80 && t.status !== 'mastered') { t.status = 'mastered'; await saveTopics(); }
    await saveRescue();
    document.getElementById('quizTopic').value = '';
    document.getElementById('quizAccuracy').value = '';
    awardComebackPoints(3, 'Recorded quiz result');
    renderRescueAll();
  });

  // ── Marks improvement ──
  document.getElementById('marksAddBtn')?.addEventListener('click', async () => {
    const subj = document.getElementById('marksSubject').value.trim();
    const cur  = +document.getElementById('marksCurrent').value;
    const tgt  = +document.getElementById('marksTarget').value;
    const err  = document.getElementById('marksError');
    if (!subj) { err.textContent = 'Subject is required.'; return; }
    if (isNaN(cur)||cur<0||cur>100) { err.textContent = 'Current score must be 0–100.'; return; }
    if (isNaN(tgt)||tgt<0||tgt>100) { err.textContent = 'Target score must be 0–100.'; return; }
    err.textContent = '';
    const existing = rescueData.marksTargets.findIndex(m => m.subject.toLowerCase() === subj.toLowerCase());
    const entry = { id: ruid(), subject: subj, current: cur, target: tgt, date: new Date().toISOString() };
    if (existing >= 0) rescueData.marksTargets[existing] = entry;
    else rescueData.marksTargets.push(entry);
    await saveRescue();
    renderRescueAll();
  });

  // ── Revision queue refresh ──
  document.getElementById('refreshQueueBtn')?.addEventListener('click', renderRevisionQueue);

  // ── Simulator ──
  document.getElementById('simToggleBtn')?.addEventListener('click', () => {
    const panel = document.getElementById('simulatorPanel');
    const btn   = document.getElementById('simToggleBtn');
    const shown = panel.style.display !== 'none';
    panel.style.display = shown ? 'none' : 'block';
    btn.textContent = shown ? 'Show Simulator' : 'Hide Simulator';
  });
  document.getElementById('simRunBtn')?.addEventListener('click', runSimulation);
  document.getElementById('simClearBtn')?.addEventListener('click', () => {
    document.getElementById('simResult').innerHTML = '';
    document.getElementById('simMissDay').value = '';
    document.getElementById('simDailyHours').value = '0';
  });

  // ── Micro-task generator ──
  document.getElementById('microGenBtn')?.addEventListener('click', async () => {
    const queue = buildRevisionQueue();
    if (!queue.length) { showRescueToast('Add some topics first to generate micro-tasks.'); return; }
    const top = queue[0];
    const newTasks = MICRO_TEMPLATES.map(tpl => ({
      id: ruid(), topicRef: top.topic, subject: top.subject, label: tpl.label, duration: tpl.duration, done: false,
    }));
    rescueData.microTasks = [...(rescueData.microTasks || []).filter(m => m.topicRef !== top.topic || m.subject !== top.subject), ...newTasks];
    await saveRescue();
    renderMicroTasks();
    showRescueToast(`Generated ${newTasks.length} micro-tasks for "${top.topic}"`);
  });

  // ── Micro-task checkboxes ──
  document.getElementById('microTaskList')?.addEventListener('click', async e => {
    const cb = e.target.closest('.micro-task-cb');
    if (!cb) return;
    const id = cb.dataset.id;
    const mt = rescueData.microTasks.find(m => m.id === id);
    if (!mt) return;
    mt.done = !mt.done;
    if (mt.done) awardComebackPoints(2, `Completed micro-task: ${mt.label}`);
    await saveRescue();
    renderMicroTasks();
  });

  // ── Distraction recovery ──
  document.getElementById('distractBtn')?.addEventListener('click', () => {
    distractionActive = true;
    renderDistractionBox();
  });
  document.getElementById('restart5Btn')?.addEventListener('click', () => {
    showRescueToast('Starting 5-minute restart ⏱ Focus on just one small thing!');
    distractionActive = false;
    renderDistractionBox();
  });
  document.getElementById('shortTaskBtn')?.addEventListener('click', () => {
    const pending = (rescueData.microTasks || []).filter(m => !m.done);
    if (pending.length) {
      showRescueToast(`Try this: "${pending[0].label}" — ${pending[0].duration} min. You got this! 💪`);
    } else {
      showRescueToast('Try writing a 3-line summary of the last thing you read. 10 minutes max.');
    }
    distractionActive = false;
    renderDistractionBox();
  });
  document.getElementById('resumeBtn')?.addEventListener('click', () => {
    const next = (rescueData.microTasks || []).find(m => !m.done);
    if (next) showRescueToast(`Resuming: "${next.label}" — ${next.duration} min. Let's go! 🚀`);
    else showRescueToast('All micro-tasks done! Generate a new set or pick a new topic.');
    distractionActive = false;
    renderDistractionBox();
  });

  // ── Readiness refresh ──
  document.getElementById('refreshReadinessBtn')?.addEventListener('click', () => {
    renderReadiness();
    renderSubjectRisk();
    renderCountdownStrategy();
  });

  // ── Plan vs Reality ──
  document.getElementById('pvSaveBtn')?.addEventListener('click', async () => {
    const date    = document.getElementById('pvDate').value;
    const planned = +document.getElementById('pvPlanned').value;
    const actual  = +document.getElementById('pvActual').value;
    const note    = document.getElementById('pvNote').value.trim();
    const err     = document.getElementById('pvError');
    if (!date) { err.textContent = 'Date is required.'; return; }
    if (isNaN(planned)||planned<0) { err.textContent = 'Planned minutes must be 0 or more.'; return; }
    if (isNaN(actual)||actual<0)   { err.textContent = 'Actual minutes must be 0 or more.'; return; }
    err.textContent = '';
    const existing = rescueData.pvLogs.findIndex(p => p.date === date);
    const entry = { id: ruid(), date, planned, actual, note };
    if (existing >= 0) rescueData.pvLogs[existing] = entry;
    else rescueData.pvLogs.push(entry);
    if (actual >= planned * 0.9) awardComebackPoints(8, `Completed planned study on ${date}`);
    await saveRescue();
    renderPVHistory();
    renderAutopsy();
    showRescueToast('Daily log saved! 📓');
  });

  // ── Missed reason selects ── (delegated from autopsy)
  document.getElementById('autopsyMissed')?.addEventListener('change', async e => {
    const sel = e.target.closest('.missed-reason-select');
    if (!sel) return;
    rescueData.missedReasons[sel.dataset.taskid] = sel.value;
    await saveRescue();
  });
}

// ─────────────────────────────────────────────────────────────
// A. SYLLABUS HEATMAP
// ─────────────────────────────────────────────────────────────
function renderHeatmap() {
  const el = document.getElementById('heatmapContainer');
  if (!el) return;
  if (!topics.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🗺️</div><p>Add subjects and topics above to build your knowledge heatmap.</p></div>`;
    return;
  }
  // Group by subject
  const bySubject = {};
  for (const t of topics) {
    if (!bySubject[t.subject]) bySubject[t.subject] = [];
    bySubject[t.subject].push(t);
  }
  el.innerHTML = Object.entries(bySubject).map(([subj, tops]) => {
    const total     = tops.length;
    const mastered  = tops.filter(t => t.status === 'mastered').length;
    const pct       = total ? Math.round((mastered / total) * 100) : 0;
    return `
    <div class="card heatmap-subject">
      <div class="card-header-row" style="margin-bottom:12px;">
        <div class="heatmap-subject-title">📖 ${esc(subj)}</div>
        <span style="font-size:0.78rem;font-weight:700;color:var(--success)">${mastered}/${total} mastered (${pct}%)</span>
      </div>
      <div class="heatmap-grid">
        ${tops.map(t => renderTopicCard(t)).join('')}
      </div>
    </div>`;
  }).join('');
}

function renderTopicCard(t) {
  const sl  = STATUS_LABELS[t.status] || STATUS_LABELS['not-started'];
  const prereqNote = t.prereq ? `<div class="topic-prereq-tag">🔗 Prereq: ${esc(t.prereq)}</div>` : '';
  const locked = t.prereq ? isPrereqBlocked(t) : false;
  const lockNote = locked ? `<div style="font-size:0.68rem;color:var(--danger);margin-top:4px;">⚠️ Prereq "${esc(t.prereq)}" not yet mastered</div>` : '';
  return `
  <div class="topic-card ${t.status}" data-id="${t.id}">
    <button class="topic-del-btn" data-id="${t.id}" title="Remove topic" aria-label="Remove">✕</button>
    <div class="topic-name">${esc(t.topic)}</div>
    <div class="topic-status-label">${sl.icon} ${sl.label}</div>
    ${prereqNote}${lockNote}
    <div class="topic-actions">
      <button class="topic-status-btn ns${t.status==='not-started'?' active':''}" data-status="not-started">⬜</button>
      <button class="topic-status-btn nu${t.status==='not-understood'?' active':''}" data-status="not-understood">🔴</button>
      <button class="topic-status-btn nr${t.status==='needs-revision'?' active':''}" data-status="needs-revision">🟡</button>
      <button class="topic-status-btn m${t.status==='mastered'?' active':''}" data-status="mastered">🟢</button>
    </div>
  </div>`;
}

function isPrereqBlocked(t) {
  if (!t.prereq) return false;
  const prereq = topics.find(p => p.topic.toLowerCase() === t.prereq.toLowerCase() && p.subject.toLowerCase() === t.subject.toLowerCase());
  return prereq && prereq.status !== 'mastered';
}

// ─────────────────────────────────────────────────────────────
// B. CONFIDENCE vs REALITY
// ─────────────────────────────────────────────────────────────
function renderQuizResults() {
  const el = document.getElementById('quizResultsList');
  if (!el) return;
  const results = (rescueData.quizResults || []).slice(-10).reverse();
  if (!results.length) {
    el.innerHTML = `<p class="help-text">No quiz results yet. Record a result above.</p>`;
    return;
  }
  el.innerHTML = results.map(r => {
    const gap     = r.confidence * 20 - r.accuracy; // confidence*20 = expected%, accuracy = real%
    const isGap   = r.confidence >= 4 && r.accuracy < 60;
    const flagHtml = isGap
      ? `<span class="quiz-gap-flag">⚠️ Knowledge gap</span>`
      : `<span class="quiz-ok-flag">✅ Aligned</span>`;
    const recHtml = isGap
      ? `<div style="font-size:0.75rem;color:var(--danger);margin-top:4px;">Recommendation: Schedule another practice session for "${esc(r.topic)}"</div>` : '';
    return `
    <div class="quiz-result-item" style="flex-direction:column;align-items:flex-start;gap:4px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <strong>${esc(r.topic)}</strong>
        <span style="color:var(--text-muted);font-size:0.78rem;">${esc(r.subject)}</span>
        ${flagHtml}
      </div>
      <div style="display:flex;gap:12px;font-size:0.78rem;color:var(--text-muted);">
        <span>Confidence: ${'★'.repeat(r.confidence)}${'☆'.repeat(5-r.confidence)}</span>
        <span>Accuracy: <strong>${r.accuracy}%</strong></span>
        <span>${new Date(r.date).toLocaleDateString()}</span>
      </div>
      ${recHtml}
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// C. SMART REVISION QUEUE
// ─────────────────────────────────────────────────────────────
/*
 * Revision priority score:
 *   weakness(40%) = not-understood:1.0, needs-revision:0.6, not-started:0.3, mastered:0
 *   urgency(35%)  = days until nearest exam in same subject, normalised (closer = higher)
 *   quizMiss(25%) = min(quizMisses/5, 1)
 */
function buildRevisionQueue() {
  const now = new Date();
  if (!topics.length) return [];

  // Get upcoming exams per subject
  const examsBySubject = {};
  try {
    if (typeof tasks !== 'undefined') {
      tasks.filter(t => !t.completed && t.type === 'Exam').forEach(t => {
        const days = Math.ceil((new Date(t.deadline) - now) / 864e5);
        if (days >= 0) {
          if (!examsBySubject[t.subject] || days < examsBySubject[t.subject]) {
            examsBySubject[t.subject] = days;
          }
        }
      });
    }
  } catch {}

  return topics
    .filter(t => t.status !== 'mastered')
    .map(t => {
      const weakMap = { 'not-understood': 1.0, 'needs-revision': 0.6, 'not-started': 0.3 };
      const weakness = weakMap[t.status] || 0;
      const daysToExam = examsBySubject[t.subject];
      const urgency = daysToExam !== undefined ? Math.max(0, 1 - daysToExam / 14) : 0.1;
      const quizMiss = Math.min((t.quizMisses || 0) / 5, 1);
      const score = weakness * 0.40 + urgency * 0.35 + quizMiss * 0.25;
      const locked = isPrereqBlocked(t);
      let reason = [];
      if (t.status === 'not-understood') reason.push('Not understood');
      if (t.status === 'needs-revision') reason.push('Needs revision');
      if (urgency > 0.5) reason.push('Exam soon');
      if (t.quizMisses > 0) reason.push(`${t.quizMisses} quiz miss${t.quizMisses>1?'es':''}`);
      if (!reason.length) reason.push('Not started');
      return { ...t, score, reason: reason.join(' · '), daysToExam, locked };
    })
    .sort((a, b) => b.score - a.score);
}

function renderRevisionQueue() {
  const el = document.getElementById('revisionQueue');
  if (!el) return;
  const queue = buildRevisionQueue();
  if (!queue.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🎉</div><p>All topics are mastered or no topics added yet!</p></div>`;
    return;
  }
  el.innerHTML = queue.slice(0, 12).map((item, i) => {
    const lockNote = item.locked
      ? `<span class="revision-reason" style="background:#fee2e2;color:var(--danger)">🔒 Prereq needed</span>` : '';
    const estTime = item.status === 'not-understood' ? '60 min' : item.status === 'needs-revision' ? '30 min' : '20 min';
    return `
    <div class="revision-item">
      <div class="revision-rank">${i+1}</div>
      <div class="revision-body">
        <div class="revision-title">${esc(item.topic)}</div>
        <div class="revision-meta">
          <span>📚 ${esc(item.subject)}</span>
          <span class="revision-reason">${esc(item.reason)}</span>
          <span class="revision-time">⏱ ~${estTime}</span>
          ${lockNote}
          ${item.daysToExam !== undefined ? `<span style="font-size:0.72rem;color:var(--danger);font-weight:600;">📅 Exam in ${item.daysToExam}d</span>` : ''}
        </div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="startRevision('${esc(item.id)}')">▶ Start</button>
    </div>`;
  }).join('');
}

function startRevision(topicId) {
  const t = topics.find(tp => tp.id === topicId);
  if (!t) return;
  if (isPrereqBlocked(t)) {
    showRescueToast(`⚠️ Complete "${t.prereq}" first — or override by changing its status to Mastered.`);
    return;
  }
  showRescueToast(`▶ Starting revision for "${t.topic}". Good luck! 💪`);
  awardComebackPoints(3, `Started revision: ${t.topic}`);
  // Switch to the revision section for micro-tasks
  if (typeof switchSection === 'function') switchSection('revision');
}

// ─────────────────────────────────────────────────────────────
// D. SCHEDULE TRADE-OFF / WHAT-IF SIMULATOR
// ─────────────────────────────────────────────────────────────
function runSimulation() {
  const missDay   = document.getElementById('simMissDay').value;
  const reduceBy  = parseFloat(document.getElementById('simDailyHours').value) || 0;
  const resultEl  = document.getElementById('simResult');

  if (!missDay && reduceBy === 0) {
    resultEl.innerHTML = `<p class="help-text">Select a day to miss or a reduction in hours, then run the simulation.</p>`;
    return;
  }

  try {
    if (typeof tasks === 'undefined' || typeof settings === 'undefined') {
      resultEl.innerHTML = `<p class="help-text" style="color:var(--danger)">Simulation requires the main planner to be loaded.</p>`;
      return;
    }

    // Build a modified avail
    const simAvail = JSON.parse(JSON.stringify(avail));
    if (missDay) delete simAvail[missDay];
    if (reduceBy > 0) {
      for (const day of Object.keys(simAvail)) {
        simAvail[day] = simAvail[day].map(w => {
          const [sh, sm] = w.start.split(':').map(Number);
          const [eh, em] = w.end.split(':').map(Number);
          const startMins = sh * 60 + sm;
          const endMins   = eh * 60 + em;
          const newEnd    = Math.max(startMins + 30, endMins - reduceBy * 60);
          const nh = Math.floor(newEnd / 60), nm = newEnd % 60;
          return { start: w.start, end: `${String(nh).padStart(2,'0')}:${String(nm).padStart(2,'0')}` };
        });
      }
    }

    // Count available slots in original vs simulated
    const origSlots = countSlotsFromAvail(avail, settings);
    const simSlots  = countSlotsFromAvail(simAvail, settings);
    const origHours = +(origSlots * settings.sessionMin / 60).toFixed(1);
    const simHours  = +(simSlots  * settings.sessionMin / 60).toFixed(1);
    const lostHours = +(origHours - simHours).toFixed(1);

    const pending = tasks.filter(t => !t.completed);
    const totalNeeded = pending.reduce((s, t) => s + t.hours, 0);
    const shortfall = Math.max(0, +(totalNeeded - simHours).toFixed(1));

    let changes = [];
    if (missDay) changes.push(`<div class="sim-diff">❌ Removed: <span class="removed">${missDay}</span> study windows</div>`);
    if (reduceBy > 0) changes.push(`<div class="sim-diff">⬇️ Reduced daily availability by <span class="removed">${reduceBy}h</span></div>`);
    changes.push(`<div class="sim-diff">📉 Available study time: <span class="removed">${origHours}h → ${simHours}h</span> (lost ${lostHours}h)</div>`);
    if (shortfall > 0) {
      changes.push(`<div class="sim-diff" style="color:var(--danger);font-weight:700;">⚠️ Shortfall: You need ${totalNeeded}h but only ${simHours}h available — <span class="removed">${shortfall}h short</span></div>`);
      const atRisk = pending.sort((a,b) => priorityScore(a) - priorityScore(b)).slice(0, 3);
      changes.push(`<div class="sim-diff">Tasks most likely to be displaced: ${atRisk.map(t=>`<span class="removed">${esc(t.title)}</span>`).join(', ')}</div>`);
    } else {
      changes.push(`<div class="sim-diff" style="color:var(--success);">✅ All ${totalNeeded}h still fit within the modified schedule.</div>`);
    }

    resultEl.innerHTML = `
    <div class="sim-result-card">
      <h4>🔬 Simulation Result (not applied to your real plan)</h4>
      ${changes.join('')}
      <div class="form-actions" style="margin-top:12px;">
        <button class="btn btn-amber btn-sm" onclick="applySimPlan()">✅ Apply This Plan</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('simResult').innerHTML=''">✕ Cancel</button>
      </div>
      <div style="font-size:0.72rem;color:var(--text-muted);margin-top:8px;">⚠️ Applying this plan will update your availability and regenerate the schedule.</div>
    </div>`;

    // Store for apply
    window._simAvail = simAvail;
  } catch (e) {
    resultEl.innerHTML = `<p style="color:var(--danger);font-size:0.82rem;">Simulation error: ${e.message}</p>`;
  }
}

function countSlotsFromAvail(availObj, sett) {
  let count = 0;
  const sessionMs = sett.sessionMin * 60 * 1000;
  const breakMs   = sett.breakMin   * 60 * 1000;
  const horizon   = 14; // 2 weeks
  const now = new Date();
  for (let d = 0; d <= horizon; d++) {
    const day = new Date(now); day.setDate(day.getDate() + d);
    const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day.getDay()];
    const windows = availObj[dayName] || [];
    for (const win of windows) {
      const [sh,sm] = win.start.split(':').map(Number);
      const [eh,em] = win.end.split(':').map(Number);
      let cursor = new Date(day); cursor.setHours(sh,sm,0,0);
      const winEnd = new Date(day); winEnd.setHours(eh,em,0,0);
      while (cursor.getTime() + sessionMs <= winEnd.getTime()) {
        count++;
        cursor = new Date(cursor.getTime() + sessionMs + breakMs);
      }
    }
  }
  return count;
}

async function applySimPlan() {
  if (!window._simAvail) return;
  if (typeof avail === 'undefined') return;
  // Update global avail and call existing save functions
  Object.assign(avail, window._simAvail);
  // Remove any days not in sim
  for (const day of Object.keys(avail)) {
    if (!window._simAvail[day]) delete avail[day];
  }
  if (typeof saveAvailAPI === 'function') await saveAvailAPI();
  if (typeof generateSchedule === 'function') generateSchedule();
  if (typeof saveState === 'function') await saveState();
  if (typeof renderAll === 'function') renderAll();
  document.getElementById('simResult').innerHTML = `<p style="color:var(--success);font-weight:700;">✅ Plan applied and schedule regenerated!</p>`;
  window._simAvail = null;
  showRescueToast('Simulation plan applied!');
}

// ─────────────────────────────────────────────────────────────
// E. MICRO-TASK GENERATOR
// ─────────────────────────────────────────────────────────────
function renderMicroTasks() {
  const el = document.getElementById('microTaskList');
  if (!el) return;
  const tasks_ = rescueData.microTasks || [];
  if (!tasks_.length) {
    el.innerHTML = `<p class="help-text">Click "Generate for Top Topic" to create micro-tasks for your highest-priority topic.</p>`;
    return;
  }
  // Group by topic
  const byTopic = {};
  for (const m of tasks_) {
    const key = `${m.subject} — ${m.topicRef}`;
    if (!byTopic[key]) byTopic[key] = [];
    byTopic[key].push(m);
  }
  el.innerHTML = Object.entries(byTopic).map(([key, items]) => {
    const done = items.filter(i => i.done).length;
    return `
    <div class="micro-task-group">
      <div class="micro-task-group-title">${esc(key)} (${done}/${items.length} done)</div>
      ${items.map(m => `
        <div class="micro-task-item${m.done?' done':''}">
          <div class="micro-task-cb${m.done?' done':''}" data-id="${m.id}" role="checkbox" aria-checked="${m.done}" tabindex="0">${m.done?'✓':''}</div>
          <div class="micro-task-label">${esc(m.label)}</div>
          <div class="micro-task-duration">~${m.duration}min</div>
        </div>`).join('')}
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// F. DISTRACTION RECOVERY
// ─────────────────────────────────────────────────────────────
function renderDistractionBox() {
  const status  = document.getElementById('distractionStatus');
  const btn     = document.getElementById('distractBtn');
  const r5      = document.getElementById('restart5Btn');
  const short   = document.getElementById('shortTaskBtn');
  const resume  = document.getElementById('resumeBtn');
  if (!status) return;
  if (distractionActive) {
    status.innerHTML = `
    <div class="distraction-box">
      <p>😤 <strong>It happens to everyone.</strong> You haven't lost your progress. Here's how to get back:</p>
      <p>• Take one slow breath. Seriously — it resets focus.</p>
      <p>• Choose how to restart below. Even 5 minutes counts.</p>
    </div>`;
    if (btn)   btn.style.display   = 'none';
    if (r5)    r5.style.display    = 'inline-flex';
    if (short) short.style.display = 'inline-flex';
    if (resume)resume.style.display= 'inline-flex';
  } else {
    status.innerHTML = '';
    if (btn)   btn.style.display   = 'inline-flex';
    if (r5)    r5.style.display    = 'none';
    if (short) short.style.display = 'none';
    if (resume)resume.style.display= 'none';
  }
}

// ─────────────────────────────────────────────────────────────
// G. EXAM READINESS & RISK DASHBOARD
// ─────────────────────────────────────────────────────────────
/*
 * Readiness score formula (estimate only, not a prediction):
 *   syllabusComp(40%) = mastered/total topics
 *   quizAcc(35%)      = avg quiz accuracy over last 10 results
 *   taskProgress(25%) = completed tasks / total tasks
 */
function calcReadiness() {
  const total    = topics.length;
  const mastered = topics.filter(t => t.status === 'mastered').length;
  const syllabusComp = total > 0 ? mastered / total : 0;

  const recent = (rescueData.quizResults || []).slice(-10);
  const quizAcc = recent.length > 0
    ? recent.reduce((s, r) => s + r.accuracy, 0) / (recent.length * 100) : 0;

  let taskProg = 0;
  try {
    if (typeof tasks !== 'undefined' && tasks.length > 0) {
      taskProg = tasks.filter(t => t.completed).length / tasks.length;
    }
  } catch {}

  const score = Math.round((syllabusComp * 0.40 + quizAcc * 0.35 + taskProg * 0.25) * 100);
  return { score, syllabusComp, quizAcc, taskProg };
}

function renderReadiness() {
  const el = document.getElementById('readinessScore');
  if (!el) return;
  const { score, syllabusComp, quizAcc, taskProg } = calcReadiness();
  const color = score >= 70 ? 'var(--success)' : score >= 40 ? 'var(--amber)' : 'var(--danger)';
  const deg   = Math.round(score / 100 * 360);

  el.innerHTML = `
  <div class="readiness-ring-wrap">
    <div class="readiness-ring" style="background:conic-gradient(${color} ${deg}deg, var(--border) ${deg}deg);">
      <div class="readiness-ring-inner">
        <div class="readiness-pct" style="color:${color}">${score}</div>
        <div class="readiness-lbl">/ 100</div>
      </div>
    </div>
    <div class="readiness-breakdown">
      ${readinessRow('Syllabus Coverage', syllabusComp, 'var(--success)')}
      ${readinessRow('Quiz Accuracy', quizAcc, 'var(--primary)')}
      ${readinessRow('Task Completion', taskProg, 'var(--amber)')}
    </div>
  </div>
  <p style="font-size:0.78rem;color:var(--text-muted);font-style:italic;">⚠️ This score is an estimate based on your input data. It does not predict actual exam results.</p>`;
}

function readinessRow(label, ratio, color) {
  const pct = Math.round(ratio * 100);
  return `
  <div class="readiness-row">
    <div class="readiness-row-label">${label}</div>
    <div class="readiness-row-bar-wrap">
      <div class="readiness-row-bar" style="width:${pct}%;background:${color};"></div>
    </div>
    <div class="readiness-row-val" style="color:${color}">${pct}%</div>
  </div>`;
}

function renderSubjectRisk() {
  const el = document.getElementById('subjectRisk');
  if (!el) return;

  // Get subjects from topics + tasks
  const subjectSet = new Set([...topics.map(t => t.subject)]);
  try { if (typeof tasks !== 'undefined') tasks.forEach(t => subjectSet.add(t.subject)); } catch {}

  if (!subjectSet.size) {
    el.innerHTML = `<p class="help-text">Add subjects and topics in the Subjects tab to see risk analysis.</p>`;
    return;
  }

  const riskCards = [...subjectSet].map(subj => {
    const subTopics = topics.filter(t => t.subject === subj);
    const total     = subTopics.length;
    const mastered  = subTopics.filter(t => t.status === 'mastered').length;
    const notUnderstood = subTopics.filter(t => t.status === 'not-understood').length;
    const recent    = (rescueData.quizResults || []).filter(r => r.subject === subj).slice(-5);
    const avgAcc    = recent.length ? recent.reduce((s,r)=>s+r.accuracy,0)/recent.length : null;

    let risk = 'low', reasons = [];
    if (total === 0 || mastered / total < 0.3)    { risk = 'high'; reasons.push('Few mastered topics'); }
    if (notUnderstood > 0)                        { risk = 'high'; reasons.push(`${notUnderstood} not-understood topic(s)`); }
    if (avgAcc !== null && avgAcc < 50)            { risk = 'high'; reasons.push(`Quiz avg: ${Math.round(avgAcc)}%`); }
    else if (avgAcc !== null && avgAcc < 70)       { if (risk !== 'high') risk = 'medium'; reasons.push(`Quiz avg: ${Math.round(avgAcc)}%`); }
    if (total > 0 && mastered / total >= 0.6 && risk !== 'high') risk = 'low';
    if (total > 0 && mastered / total >= 0.3 && mastered / total < 0.6 && risk === 'low') risk = 'medium';
    if (!reasons.length) reasons.push(risk === 'low' ? 'Good topic coverage' : 'Limited topic data');

    const riskLabel = { low:'✅ Low Risk', medium:'⚠️ Medium Risk', high:'🔴 High Risk' }[risk];
    return `
    <div class="risk-card ${risk}">
      <span class="risk-label">${riskLabel}</span>
      <div class="risk-subject">${esc(subj)}</div>
      <div class="risk-reason">${reasons.map(r => `• ${r}`).join('<br>')}</div>
    </div>`;
  });

  el.innerHTML = `<div class="risk-grid">${riskCards.join('')}</div>`;
}

// ─────────────────────────────────────────────────────────────
// L. EXAM-DAY COUNTDOWN STRATEGY
// ─────────────────────────────────────────────────────────────
function renderCountdownStrategy() {
  const el = document.getElementById('countdownStrategy');
  if (!el) return;

  let nearest = null;
  try {
    if (typeof tasks !== 'undefined') {
      const exams = tasks.filter(t => !t.completed && t.type === 'Exam').sort((a,b) => new Date(a.deadline)-new Date(b.deadline));
      if (exams.length) nearest = exams[0];
    }
  } catch {}

  if (!nearest) {
    el.innerHTML = `<p class="help-text">Add an Exam task to see countdown study recommendations.</p>`;
    return;
  }

  const days = Math.ceil((new Date(nearest.deadline) - new Date()) / 864e5);
  let items = [];

  if (days > 14) {
    items = [
      { icon: '📖', text: `<strong>${days} days</strong> until "${esc(nearest.title)}" — you have good time.` },
      { icon: '🏗️', text: 'Focus on <strong>foundational concepts</strong> and understanding core ideas.' },
      { icon: '🗺️', text: 'Work through your syllabus systematically. Update topic statuses as you go.' },
      { icon: '📝', text: 'Take notes and build a study reference sheet while material is fresh.' },
    ];
  } else if (days > 3) {
    items = [
      { icon: '⚡', text: `<strong>${days} days</strong> until "${esc(nearest.title)}" — focus is key.` },
      { icon: '🔴', text: 'Prioritise <strong>weak and not-understood topics</strong> in the Revision Queue.' },
      { icon: '✏️', text: 'Work through <strong>practice questions</strong> rather than re-reading notes.' },
      { icon: '📊', text: 'Record quiz results to spot remaining knowledge gaps.' },
    ];
  } else if (days > 1) {
    items = [
      { icon: '🚨', text: `<strong>${days} days</strong> until "${esc(nearest.title)}" — final sprint!` },
      { icon: '⚡', text: '<strong>Quick-recall</strong> your key formulas, dates, and definitions — no new material.' },
      { icon: '😴', text: 'Protect your sleep — tired recall is much worse than rested recall.' },
      { icon: '✅', text: 'Do one light practice run to build exam confidence, not to learn new things.' },
    ];
  } else if (days === 1) {
    items = [
      { icon: '🌙', text: `Exam tomorrow: "<strong>${esc(nearest.title)}</strong>"` },
      { icon: '📋', text: 'Review your top 10 key points only. Keep it light and positive.' },
      { icon: '😴', text: 'Sleep is the most powerful exam tool. Aim for 7–8 hours tonight.' },
      { icon: '🚫', text: 'No all-nighters. Sleep consolidates what you have already studied.' },
    ];
  } else {
    items = [
      { icon: '🎯', text: `Exam today: "<strong>${esc(nearest.title)}</strong>" — you've prepared for this!` },
      { icon: '🧘', text: 'Stay calm. Take slow breaths before you start.' },
      { icon: '⏰', text: 'Manage your time in the exam: skim all questions first, answer what you know.' },
    ];
  }

  el.innerHTML = items.map(item => `
  <div class="countdown-item">
    <div class="countdown-icon">${item.icon}</div>
    <div class="countdown-text">${item.text}</div>
  </div>`).join('');
}

// ─────────────────────────────────────────────────────────────
// M. DEADLINE COLLISION WARNING
// ─────────────────────────────────────────────────────────────
function renderDeadlineCollision() {
  const el = document.getElementById('deadlineCollision');
  if (!el) return;

  try {
    if (typeof tasks === 'undefined' || typeof avail === 'undefined') {
      el.innerHTML = `<p class="help-text">Load the planner to see collision warnings.</p>`;
      return;
    }

    // Calculate available hours per day for the next 14 days
    const now = new Date();
    const dailyNeeded = {};  // date string → required hours that day from schedule
    const dailyAvail  = {};

    if (typeof schedule !== 'undefined') {
      for (const s of schedule) {
        const d = new Date(s.start).toDateString();
        dailyNeeded[d] = (dailyNeeded[d] || 0) + (typeof settings !== 'undefined' ? settings.sessionMin / 60 : 1);
      }
    }

    const collisions = [];
    for (let i = 0; i < 14; i++) {
      const day = new Date(now); day.setDate(day.getDate() + i);
      const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day.getDay()];
      const windows = (avail[dayName] || []);
      let avHours = 0;
      for (const w of windows) {
        const [sh,sm] = w.start.split(':').map(Number);
        const [eh,em] = w.end.split(':').map(Number);
        avHours += (eh*60+em - sh*60-sm) / 60;
      }
      const needed = dailyNeeded[day.toDateString()] || 0;
      if (needed > avHours && avHours > 0) {
        collisions.push({ date: day.toLocaleDateString(), needed: +needed.toFixed(1), available: +avHours.toFixed(1) });
      }
    }

    if (!collisions.length) {
      el.innerHTML = `<p style="color:var(--success);font-weight:600;">✅ No deadline collisions detected in the next 14 days.</p>`;
      return;
    }

    el.innerHTML = `
    <div class="warning-area" style="margin-bottom:0;">
      <h3>⚠️ Overloaded Days Detected</h3>
      ${collisions.map(c => `
        <div class="warning-item danger">
          <strong>${c.date}:</strong> ${c.needed}h scheduled but only ${c.available}h available.
          Consider moving lower-priority tasks to a less busy day.
        </div>`).join('')}
    </div>`;
  } catch(e) {
    el.innerHTML = `<p class="help-text">Unable to calculate collisions: ${e.message}</p>`;
  }
}

// ─────────────────────────────────────────────────────────────
// N. MARKS IMPROVEMENT PLANNER
// ─────────────────────────────────────────────────────────────
function renderMarksDisplay() {
  const el = document.getElementById('marksDisplay');
  if (!el) return;
  const entries = rescueData.marksTargets || [];
  if (!entries.length) {
    el.innerHTML = `<p class="help-text">No targets set yet.</p>`;
    return;
  }
  el.innerHTML = entries.map(e => {
    const gap = e.target - e.current;
    const achievable = gap <= 30;
    const subTopics = topics.filter(t => t.subject.toLowerCase() === e.subject.toLowerCase() && t.status !== 'mastered');
    const rec = subTopics.length > 0
      ? `Revise: ${subTopics.slice(0,3).map(t=>t.topic).join(', ')}`
      : 'Focus on practice questions for this subject.';
    return `
    <div class="marks-item">
      <div style="flex:1;">
        <strong>${esc(e.subject)}</strong>
        <div style="font-size:0.77rem;color:var(--text-muted);margin-top:2px;">
          Current: ${e.current}% → Target: ${e.target}%
          — Gap: <span class="marks-gap${achievable?' achievable':''}">${gap > 0 ? '+'+gap : gap}%</span>
        </div>
        <div style="font-size:0.75rem;color:var(--primary-dark);margin-top:3px;">💡 ${esc(rec)}</div>
        <div style="font-size:0.68rem;color:var(--text-muted);font-style:italic;margin-top:2px;">Note: targets are motivational guides, not predictions of actual results.</div>
      </div>
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// O. COMEBACK SCORE
// ─────────────────────────────────────────────────────────────
function awardComebackPoints(pts, reason) {
  rescueData.comebackPoints = (rescueData.comebackPoints || 0) + pts;
  checkAchievements();
}

function checkAchievements() {
  const pts = rescueData.comebackPoints || 0;
  const ach = rescueData.achievements || [];
  const milestones = [
    { pts: 10,  badge: '🌱 Getting Started'    },
    { pts: 50,  badge: '📖 Consistent Learner' },
    { pts: 100, badge: '🔥 On Fire'            },
    { pts: 200, badge: '⭐ Study Champion'      },
    { pts: 500, badge: '🏆 Scholar Elite'       },
  ];
  for (const m of milestones) {
    if (pts >= m.pts && !ach.includes(m.badge)) {
      rescueData.achievements.push(m.badge);
      showRescueToast(`🏆 Achievement unlocked: ${m.badge}`);
    }
  }
}

function renderComebackScore() {
  const el = document.getElementById('comebackScore');
  if (!el) return;
  const pts = rescueData.comebackPoints || 0;
  const ach = rescueData.achievements || [];
  el.innerHTML = `
  <div class="comeback-wrap">
    <div class="comeback-score-circle">${pts}</div>
    <div>
      <div style="font-size:0.875rem;font-weight:700;color:var(--navy);margin-bottom:8px;">
        ${pts} Comeback Points — keep earning by revising, completing micro-tasks, and logging study sessions.
      </div>
      ${ach.length ? `<div class="comeback-achievements">${ach.map(a=>`<span class="achievement-badge">${a}</span>`).join('')}</div>` : `<p style="font-size:0.8rem;color:var(--text-muted);">No achievements yet. Start studying to earn them!</p>`}
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────
// K. STUDY METHOD SWITCHER
// ─────────────────────────────────────────────────────────────
function renderMethodSwitcher() {
  const el = document.getElementById('methodSwitcher');
  if (!el) return;
  // Find topics with repeated quiz misses >= 2
  const struggling = topics.filter(t => (t.quizMisses || 0) >= 2);
  if (!struggling.length) {
    el.innerHTML = `<p class="help-text">No struggling topics detected yet. Record quiz results in the Subjects tab — when a topic has 2+ quiz misses, a study method suggestion will appear here.</p>`;
    return;
  }
  el.innerHTML = struggling.map((t, i) => {
    const method = STUDY_METHODS[i % STUDY_METHODS.length];
    return `
    <div class="method-item">
      <div class="method-icon">🔀</div>
      <div class="method-body">
        <div class="method-topic">${esc(t.topic)} <span style="font-size:0.75rem;color:var(--text-muted);">(${esc(t.subject)})</span></div>
        <div class="method-suggestion">Try instead of "${esc(method.from)}": <strong>${esc(method.to)}</strong></div>
        <div class="method-reason">💡 ${esc(method.reason)}</div>
        <div style="font-size:0.7rem;color:var(--text-muted);margin-top:3px;">Based on rule: ≥2 quiz misses for this topic. Not an AI recommendation.</div>
      </div>
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// H. PLAN vs REALITY TRACKER
// ─────────────────────────────────────────────────────────────
function renderPVHistory() {
  const el = document.getElementById('pvHistory');
  if (!el) return;
  const logs = (rescueData.pvLogs || []).slice(-14).reverse();
  if (!logs.length) {
    el.innerHTML = `<p class="help-text">No logs yet. Save today's entry above.</p>`;
    return;
  }
  // Suggest better estimates if consistently over
  const over = logs.filter(l => l.actual > l.planned * 1.2).length;
  const suggestion = over >= 3 ? `<div class="algo-note">📊 You've exceeded your plan ${over} days recently. Consider adding 20% buffer to future daily plans.</div>` : '';

  el.innerHTML = suggestion + logs.map(l => {
    const maxMin = Math.max(l.planned, l.actual, 1);
    const planW  = Math.round((l.planned / maxMin) * 100);
    const actW   = Math.round((l.actual  / maxMin) * 100);
    const isOver = l.actual > l.planned;
    return `
    <div class="pvr-row">
      <div class="pvr-date">${new Date(l.date).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</div>
      <div class="pvr-bar-wrap">
        <div class="pvr-bar-planned" style="width:${planW}%"></div>
        <div class="pvr-bar-actual"  style="width:${actW}%;opacity:0.85;"></div>
      </div>
      <div style="font-size:0.77rem;min-width:100px;">
        📋${l.planned}m / ✅${l.actual}m
        ${isOver ? `<span class="pvr-over">+${l.actual-l.planned}m over</span>` : ''}
      </div>
      ${l.note ? `<div style="font-size:0.72rem;color:var(--text-muted);">${esc(l.note)}</div>` : ''}
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// I. DAILY STUDY AUTOPSY
// ─────────────────────────────────────────────────────────────
function renderAutopsy() {
  const summaryEl = document.getElementById('autopsySummary');
  const missedEl  = document.getElementById('autopsyMissed');
  if (!summaryEl || !missedEl) return;

  const today = new Date().toDateString();
  let completedToday = 0, totalScheduledToday = 0;
  let topicsRevised = new Set();
  let timeSpent = 0;

  try {
    if (typeof schedule !== 'undefined' && typeof tasks !== 'undefined' && typeof settings !== 'undefined') {
      const todaySessions = schedule.filter(s => new Date(s.start).toDateString() === today);
      totalScheduledToday = todaySessions.length;
      const sessH = settings.sessionMin / 60;
      for (const s of todaySessions) {
        const t = tasks.find(tk => tk.id === s.taskId);
        if (t && t.completed) { completedToday++; timeSpent += sessH; topicsRevised.add(t.subject); }
      }
    }
  } catch {}

  const log = (rescueData.pvLogs || []).find(l => l.date === new Date().toISOString().slice(0,10));
  if (log) timeSpent = log.actual / 60;

  summaryEl.innerHTML = `
  <div class="autopsy-stat">
    <div class="autopsy-stat-item"><div class="autopsy-stat-val">${completedToday}</div><div class="autopsy-stat-lbl">Sessions Done</div></div>
    <div class="autopsy-stat-item"><div class="autopsy-stat-val">${totalScheduledToday}</div><div class="autopsy-stat-lbl">Scheduled</div></div>
    <div class="autopsy-stat-item"><div class="autopsy-stat-val">${timeSpent > 0 ? fmtHours(timeSpent) : '—'}</div><div class="autopsy-stat-lbl">Time Spent</div></div>
    <div class="autopsy-stat-item"><div class="autopsy-stat-val">${topicsRevised.size}</div><div class="autopsy-stat-lbl">Subjects Touched</div></div>
  </div>`;

  // Missed tasks
  let missed = [];
  try {
    if (typeof tasks !== 'undefined') {
      missed = tasks.filter(t => !t.completed && daysUntil(t.deadline) < 0);
    }
  } catch {}

  if (!missed.length) {
    missedEl.innerHTML = `<p style="color:var(--success);font-weight:600;font-size:0.85rem;">✅ No missed tasks. Excellent!</p>`;
  } else {
    missedEl.innerHTML = `
    <h4 style="font-size:0.82rem;font-weight:700;color:var(--danger);margin-bottom:8px;">📌 Missed / Overdue Tasks — reason helps us improve tomorrow's plan:</h4>
    ${missed.map(t => `
      <div class="missed-task-row">
        <span style="flex:1;font-weight:600;">${esc(t.title)}</span>
        <span style="font-size:0.75rem;color:var(--text-muted);">${esc(t.subject)}</span>
        <select class="missed-reason-select" data-taskid="${t.id}">
          <option value="">Reason?</option>
          <option value="difficult" ${rescueData.missedReasons[t.id]==='difficult'?'selected':''}>Difficult topic</option>
          <option value="distracted" ${rescueData.missedReasons[t.id]==='distracted'?'selected':''}>Got distracted</option>
          <option value="no-time" ${rescueData.missedReasons[t.id]==='no-time'?'selected':''}>Ran out of time</option>
          <option value="other" ${rescueData.missedReasons[t.id]==='other'?'selected':''}>Other</option>
        </select>
      </div>`).join('')}`;
  }
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────
function ruid() { return Math.random().toString(36).slice(2,9) + Date.now().toString(36); }

function showRescueToast(msg) {
  // Reuse existing showToast if available
  if (typeof showToast === 'function') { showToast(msg); return; }
  const old = document.getElementById('rescueToast');
  if (old) old.remove();
  const el = document.createElement('div');
  el.id = 'rescueToast';
  el.textContent = msg;
  el.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#1a2744;color:#fff;padding:10px 20px;border-radius:99px;font-size:0.85rem;font-weight:600;z-index:9998;box-shadow:0 4px 12px rgba(0,0,0,0.2);';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// Re-use esc from script.js (defined globally), fallback if not loaded
function rescEsc(s) {
  if (typeof esc === 'function') return esc(s);
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// Alias so templates can use esc() directly
if (typeof esc === 'undefined') window.esc = rescEsc;

// fmtHours alias
function fmtH(h) {
  if (typeof fmtHours === 'function') return fmtHours(h);
  if (h === 0) return '0h';
  const hh = Math.floor(h), mm = Math.round((h-hh)*60);
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`;
}

// Expose applySimPlan and startRevision globally
window.applySimPlan   = applySimPlan;
window.startRevision  = startRevision;
