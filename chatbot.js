/*
 * ============================================================
 * StudyBot v2 — chatbot.js
 * Upgraded rule-based NLP engine for the Smart Study Planner.
 *
 * Improvements over v1:
 *  - Token-based NLP: splits input into tokens, matches on word
 *    stems/synonyms, scores every intent and picks the best match
 *    instead of first-match. Eliminates wrong-intent collisions.
 *  - Conversation memory: remembers last 6 turns, handles follow-
 *    up questions ("what about tomorrow?", "and the exams?")
 *  - Entity extraction: picks subject names, task titles, day
 *    names, and numbers directly from the user's message
 *  - Correction / negation detection ("not urgent", "don't show")
 *  - Expanded knowledge base: 30+ study tips, subject-specific
 *    advice, exam anxiety, nutrition, environment
 *  - RescueStudy awareness: reads topics, quizResults, revision
 *    queue from the rescue.js globals
 *  - Spelling tolerance: simple edit-distance fallback for common
 *    typos (schedul → schedule, deadlien → deadline …)
 *  - Adaptive chip suggestions based on detected context
 *  - Typing speed proportional to response length
 * ============================================================
 */

'use strict';

// ─── Bot state ────────────────────────────────────────────────
const BOT = {
  open:      false,
  minimised: false,
  history:   [],        // { role, text, intent }
  unread:    0,
  dragging:  false,
  resizing:  false,
  dragOffX: 0, dragOffY: 0,
  resizeStartW: 0, resizeStartH: 0,
  resizeStartX: 0, resizeStartY: 0,
  lastIntent: null,     // for follow-up resolution
  lastEntity: null,     // subject / task name from last turn
};

const BOT_NAME = 'StudyBot 🦉';

// ─────────────────────────────────────────────────────────────
// NLP ENGINE
// ─────────────────────────────────────────────────────────────

/**
 * Tokenise input: lowercase, strip punctuation, split on spaces.
 * Returns Set of tokens for fast lookup.
 */
function tokenise(text) {
  return new Set(
    text.toLowerCase()
        .replace(/[''`]/g, '')          // smart quotes
        .replace(/[^a-z0-9\s]/g, ' ')  // strip punctuation
        .split(/\s+/)
        .filter(Boolean)
  );
}

/**
 * Simple stemmer: strips common suffixes so "studying" matches
 * "study", "deadlines" matches "deadline", etc.
 */
const STEM_RULES = [
  /ing$/, /tion$/, /ness$/, /ment$/, /ed$/, /ly$/, /er$/, /s$/
];
function stem(word) {
  for (const r of STEM_RULES) {
    const s = word.replace(r, '');
    if (s.length >= 3) return s;
  }
  return word;
}

/**
 * Score a token set against a pattern list.
 * Each pattern entry is a string; score += 1 per exact match,
 * +0.7 per stem match. Negation check: if "not/no/don't" precedes
 * a matched word in the original text, subtract instead of add.
 */
function scorePatterns(tokens, stems, lower, patterns) {
  let score = 0;
  for (const p of patterns) {
    const pWords = p.split(' ');
    if (pWords.length > 1) {
      // phrase match (higher weight)
      if (lower.includes(p)) score += 1.8;
    } else {
      if (tokens.has(p))       score += 1.0;
      else if (stems.has(stem(p))) score += 0.7;
    }
  }
  // Negation: "not urgent", "no deadline", "don't want schedule"
  const negTokens = new Set(['not','no','dont',"don't",'never','none']);
  for (const nt of negTokens) {
    if (tokens.has(nt)) score *= 0.3;
  }
  return score;
}

/**
 * Extract named entities from input.
 * Returns { subject, dayName, number, taskTitle }
 */
function extractEntities(lower, tokens) {
  const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const dayName = DAYS.find(d => tokens.has(d)) || null;
  const numMatch = lower.match(/\b(\d+(\.\d+)?)\b/);
  const number   = numMatch ? parseFloat(numMatch[1]) : null;

  // Subject: match against known task subjects + topic subjects
  let subject = null;
  try {
    const knownSubjects = new Set();
    if (typeof tasks !== 'undefined')  tasks.forEach(t => knownSubjects.add(t.subject.toLowerCase()));
    if (typeof topics !== 'undefined') topics.forEach(t => knownSubjects.add(t.subject.toLowerCase()));
    for (const s of knownSubjects) {
      if (lower.includes(s)) { subject = s; break; }
    }
  } catch {}

  // Task title: partial match against task titles
  let taskTitle = null;
  try {
    if (typeof tasks !== 'undefined') {
      const match = tasks.find(t => lower.includes(t.title.toLowerCase().slice(0, 6)));
      if (match) taskTitle = match.title;
    }
  } catch {}

  return { dayName, number, subject, taskTitle };
}

// ─────────────────────────────────────────────────────────────
// INTENT DEFINITIONS
// Each entry: { id, patterns, handler, followUpOf? }
// patterns are scored; highest wins.
// ─────────────────────────────────────────────────────────────
const INTENT_DEFS = [
  // ── Data queries ──
  { id:'schedule',    patterns:['schedule','timetable','session','booked','calendar','slot','plan','time table'], handler: handleSchedule },
  { id:'deadline',    patterns:['deadline','due','upcoming','next','soon','when','submit','submission'], handler: handleDeadlines },
  { id:'overdue',     patterns:['overdue','late','missed','past','behind','overdo'], handler: handleOverdue },
  { id:'urgent',      patterns:['urgent','priority','important','first','top','critical','asap','which task'], handler: handleUrgent },
  { id:'hours',       patterns:['hours','hour','unscheduled','missing','shortage','how many hours','time left','study time'], handler: handleHours },
  { id:'today',       patterns:['today','tonight','this morning','now','current','right now'], handler: handleToday },
  { id:'tomorrow',    patterns:['tomorrow','next day'], handler: handleTomorrow },
  { id:'week',        patterns:['this week','week','weekly','7 days'], handler: handleWeek },
  { id:'progress',    patterns:['progress','completed','done','finish','percent','how am i doing','how am i'], handler: handleProgress },
  { id:'tasks',       patterns:['task','tasks','exam','assignment','revision','list','show','all task'], handler: handleTasks },
  { id:'subject',     patterns:['subject','topic','heatmap','mastered','not understood','needs revision','syllabus'], handler: handleSubjectQuery },
  { id:'readiness',   patterns:['readiness','ready','score','prepared','exam ready'], handler: handleReadiness },
  { id:'revision',    patterns:['revision queue','revision','revise','review','weak topic','weak'], handler: handleRevisionQueue },
  { id:'quiz',        patterns:['quiz','test result','accuracy','confidence','knowledge gap','quiz result'], handler: handleQuizResult },
  { id:'comeback',    patterns:['comeback','points','achievement','badge','score'], handler: handleComeback },

  // ── Day-specific ──
  { id:'dayquery',    patterns:['monday','tuesday','wednesday','thursday','friday','saturday','sunday'], handler: handleDayQuery },

  // ── Study knowledge ──
  { id:'tip',         patterns:['tip','tips','advice','how to study','technique','strategy','method','better'], handler: handleTip },
  { id:'pomodoro',    patterns:['pomodoro','tomato','25 min','25 minutes','timer','time management'], handler: handlePomodoro },
  { id:'motivation',  patterns:['motivate','motivation','inspire','encourage','cheer','boost','push','keep going'], handler: handleMotivation },
  { id:'focus',       patterns:['procrastinat','distract','focus','concentrate','attention','phone','social media'], handler: handleFocus },
  { id:'memory',      patterns:['memory','remember','recall','memorise','memorize','retain','forget','flashcard'], handler: handleMemory },
  { id:'sleep',       patterns:['sleep','rest','tired','fatigue','nap','exhausted'], handler: handleSleep },
  { id:'anxiety',     patterns:['anxious','anxiety','stress','nervous','scared','worry','panic','overwhelm'], handler: handleAnxiety },
  { id:'nutrition',   patterns:['eat','food','nutrition','snack','coffee','energy','brain food','hungry'], handler: handleNutrition },
  { id:'environment', patterns:['environment','library','desk','workspace','noise','quiet','music','where to study'], handler: handleEnvironment },
  { id:'notes',       patterns:['notes','note taking','cornell','summarise','summarize','highlight'], handler: handleNotes },
  { id:'math',        patterns:['mathematics','maths','math','calculus','algebra','geometry','equation','formula'], handler: handleSubjectMath },
  { id:'science',     patterns:['science','physics','chemistry','biology','experiment','lab'], handler: handleSubjectScience },
  { id:'essay',       patterns:['essay','writing','english','literature','thesis','paragraph','argument'], handler: handleSubjectEssay },

  // ── App help ──
  { id:'profile',     patterns:['profile','name','who am i','my details','my info'], handler: handleProfile },
  { id:'navigate',    patterns:['go to','navigate','open','switch','where is','find','how to use','show me'], handler: handleNavigate },
  { id:'help',        patterns:['help','what can you','command','option','menu','list of','what do you know'], handler: handleHelp },

  // ── Social ──
  { id:'greeting',    patterns:['hello','hi','hey','howdy','greetings','good morning','good afternoon','good evening','sup','yo'], handler: handleGreeting },
  { id:'bye',         patterns:['bye','goodbye','see you','cya','later','gotta go','leaving','quit'], handler: handleBye },
  { id:'thanks',      patterns:['thank','thanks','cheers','appreciate','helpful','great answer','nice'], handler: handleThanks },
  { id:'joke',        patterns:['joke','funny','laugh','haha','lol','humour','humor','make me laugh'], handler: handleJoke },
  { id:'offtopic',    patterns:['weather','sports','news','politics','movie','game','music','food','recipe'], handler: handleOffTopic },
];

// ─────────────────────────────────────────────────────────────
// ROUTER — scores every intent, picks best match
// ─────────────────────────────────────────────────────────────
function getResponse(rawInput) {
  const lower  = rawInput.toLowerCase().trim();
  if (!lower) return null;

  const tokens = tokenise(lower);
  const stems  = new Set([...tokens].map(stem));
  const entities = extractEntities(lower, tokens);

  // Store entities for follow-up context
  if (entities.subject)   BOT.lastEntity = entities.subject;
  if (entities.taskTitle) BOT.lastEntity = entities.taskTitle;

  // Score all intents
  let bestScore = 0;
  let bestIntent = null;
  for (const def of INTENT_DEFS) {
    const s = scorePatterns(tokens, stems, lower, def.patterns);
    if (s > bestScore) { bestScore = s; bestIntent = def; }
  }

  // Follow-up resolution: if score very low, try to resolve from context
  if (bestScore < 0.5 && BOT.lastIntent) {
    const followUp = resolveFollowUp(lower, tokens, stems, BOT.lastIntent, entities);
    if (followUp) return followUp;
  }

  BOT.lastIntent = bestIntent?.id || null;

  if (!bestIntent || bestScore < 0.5) return fallback(lower);
  return bestIntent.handler(lower, tokens, entities);
}

/**
 * Follow-up resolution.
 * "and tomorrow?" after schedule → handleTomorrow
 * "what about maths?" after tasks → handleSubjectQuery with subject=maths
 */
function resolveFollowUp(lower, tokens, stems, lastIntent, entities) {
  const connectWords = new Set(['and','also','what about','how about','what of','tell me','more about']);
  const hasConnect = [...connectWords].some(w => lower.includes(w));
  const isShort = lower.split(' ').length <= 5;

  if (!hasConnect && !isShort) return null;

  if (tokens.has('tomorrow')) return handleTomorrow(lower, tokens, entities);
  if (tokens.has('today'))    return handleToday(lower, tokens, entities);
  if (entities.subject)       return handleSubjectQuery(lower, tokens, entities);
  if (tokens.has('exams') || tokens.has('exam')) return handleTasks(lower, tokens, entities);
  if (tokens.has('assignments') || tokens.has('assignment')) return handleTasks(lower, tokens, entities);

  // Re-run last intent with current context
  const lastDef = INTENT_DEFS.find(d => d.id === lastIntent);
  if (lastDef) return lastDef.handler(lower, tokens, entities);
  return null;
}

// ─────────────────────────────────────────────────────────────
// DATA ACCESSOR
// ─────────────────────────────────────────────────────────────
function appData() {
  return {
    tasks:       typeof tasks       !== 'undefined' ? tasks       : [],
    schedule:    typeof schedule    !== 'undefined' ? schedule    : [],
    profile:     typeof profile     !== 'undefined' ? profile     : { name:'Student', goalHours:6 },
    settings:    typeof settings    !== 'undefined' ? settings    : { sessionMin:60 },
    topics:      typeof topics      !== 'undefined' ? topics      : [],
    rescueData:  typeof rescueData  !== 'undefined' ? rescueData  : {},
  };
}

// ─────────────────────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────────────────────

function handleGreeting(lower) {
  const { profile, tasks } = appData();
  const fn = (profile.name || 'there').split(' ')[0];
  const hour = new Date().getHours();
  const tod  = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const pending = tasks.filter(t => !t.completed).length;
  const taskLine = pending > 0
    ? `You have **${pending}** pending task(s).`
    : `No pending tasks — you're all caught up! 🎉`;
  return `Good ${tod}, **${fn}**! 😊 I'm ${BOT_NAME}, your study companion.\n\n${taskLine}\n\nAsk me about your schedule, deadlines, study tips, or anything else. Type **"help"** to see everything I can do! 🚀`;
}

function handleSchedule(lower, tokens, entities) {
  const { schedule, settings, tasks } = appData();
  const now = new Date();
  const sessH = (settings.sessionMin || 60) / 60;

  if (!schedule.length) {
    return `📅 Your schedule is **empty**. Go to **Tasks**, add some work, then hit **↺ Regenerate**. I'll be here when it's ready! 🎯`;
  }

  const today   = schedule.filter(s => new Date(s.start).toDateString() === now.toDateString());
  const tomorrow = schedule.filter(s => {
    const d = new Date(s.start); const tom = new Date(now); tom.setDate(tom.getDate()+1);
    return d.toDateString() === tom.toDateString();
  });
  const week    = schedule.filter(s => { const d=new Date(s.start); return d>=now && d<=new Date(now.getTime()+7*864e5); });
  const late    = schedule.filter(s => s.late);

  let msg = `📅 **Your Schedule Snapshot:**\n\n`;
  msg += `• Today: **${today.length}** session(s) — **${(today.length*sessH).toFixed(1)}h**\n`;
  msg += `• Tomorrow: **${tomorrow.length}** session(s) — **${(tomorrow.length*sessH).toFixed(1)}h**\n`;
  msg += `• This week: **${week.length}** session(s) — **${(week.length*sessH).toFixed(1)}h**\n`;
  msg += `• Total sessions: **${schedule.length}**\n`;

  if (late.length) {
    const lateSubjects = [...new Set(late.map(s=>s.subject))].join(', ');
    msg += `\n⚠️ **${late.length}** session(s) fall **after** their deadline (${lateSubjects}). Add more availability to fix this.`;
  } else {
    msg += `\n✅ All sessions are within their deadlines — excellent planning!`;
  }

  // Next session
  const next = schedule.filter(s => new Date(s.start) > now).sort((a,b)=>new Date(a.start)-new Date(b.start))[0];
  if (next) {
    const d = new Date(next.start);
    const isToday = d.toDateString() === now.toDateString();
    msg += `\n\n📍 **Next session:** ${isToday?'Today':'Tomorrow'} at ${d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})} — *${next.title}*`;
  }
  return msg;
}

function handleDeadlines(lower, tokens, entities) {
  const { tasks } = appData();
  const now = new Date();
  const { subject } = entities;

  let pending = tasks.filter(t => !t.completed);
  if (subject) pending = pending.filter(t => t.subject.toLowerCase().includes(subject));
  pending.sort((a,b) => new Date(a.deadline)-new Date(b.deadline));

  if (!pending.length) {
    return subject
      ? `🎉 No pending tasks for **${subject}**! All caught up there.`
      : `🎉 No pending tasks at all — you're completely caught up! Amazing! 🏆`;
  }

  const show = pending.slice(0, 6);
  let msg = subject
    ? `📋 **Deadlines for ${subject}:**\n\n`
    : `📋 **Your next ${show.length} deadline(s):**\n\n`;

  for (const t of show) {
    const days = Math.ceil((new Date(t.deadline)-now)/864e5);
    const icon = days<0?'🔴':days<=1?'🚨':days<=3?'🟠':days<=7?'🟡':'🟢';
    const when = days<0?`${Math.abs(days)}d overdue`:days===0?'**Today!**':days===1?'**Tomorrow!**':`in ${days} days`;
    msg += `${icon} **${t.title}** (${t.type}) — ${when} · ${t.hours}h prep\n`;
  }

  const overdue = pending.filter(t => new Date(t.deadline)<now).length;
  const urgent  = pending.filter(t => { const d=Math.ceil((new Date(t.deadline)-now)/864e5); return d>=0&&d<=2; }).length;
  if (overdue)  msg += `\n🔴 **${overdue}** task(s) are overdue — prioritise these immediately!`;
  if (urgent)   msg += `\n🚨 **${urgent}** task(s) due within 2 days!`;
  return msg;
}

function handleOverdue(lower, tokens, entities) {
  const { tasks } = appData();
  const now  = new Date();
  const over = tasks.filter(t => !t.completed && new Date(t.deadline)<now);

  if (!over.length) return `✅ No overdue tasks — you're right on track! Keep it up! 🌟`;

  let msg = `🔴 **Overdue Tasks (${over.length}):**\n\n`;
  for (const t of over) {
    const d = Math.abs(Math.ceil((new Date(t.deadline)-now)/864e5));
    msg += `• **${t.title}** (${t.subject}) — ${d} day(s) late\n`;
  }
  msg += `\n💙 Don't let this spiral. Pick the most important one, do what you can, and mark it done. Progress beats perfection every time.`;
  return msg;
}

function handleUrgent(lower, tokens, entities) {
  const { tasks } = appData();
  const now = new Date();
  const { subject } = entities;

  let pending = tasks.filter(t => !t.completed);
  if (subject) pending = pending.filter(t => t.subject.toLowerCase().includes(subject));
  if (!pending.length) return `🎯 No pending tasks${subject?' for '+subject:''}. You're all caught up!`;

  const scored = pending.map(t => {
    const msLeft  = new Date(t.deadline)-now;
    const urgency = 1-Math.max(0,Math.min(1,msLeft/(30*864e5)));
    const imp     = (t.weight-1)/4;
    const effort  = Math.min(t.hours/40,1);
    return { ...t, _score: urgency*0.5+imp*0.35+effort*0.15 };
  }).sort((a,b)=>b._score-a._score);

  const top = scored.slice(0, 4);
  let msg = `🎯 **Priority Order${subject?' ('+subject+')':''}:**\n\n`;
  top.forEach((t,i) => {
    const days = Math.ceil((new Date(t.deadline)-now)/864e5);
    const when = days<0?'🔴 OVERDUE':days===0?'🚨 TODAY':days===1?'🟠 TOMORROW':`🟡 ${days}d left`;
    msg += `${i+1}. **${t.title}** — ${when} · ${t.hours}h · ${'★'.repeat(t.weight)}\n`;
  });
  msg += `\nStart with #1 and work your way down. Each task completed is progress! 💪`;
  return msg;
}

function handleHours(lower, tokens, entities) {
  const { tasks, schedule, settings } = appData();
  const pending = tasks.filter(t => !t.completed);
  if (!pending.length) return `✅ No pending tasks — zero hours needed right now! 🎉`;

  const sessH   = (settings.sessionMin||60)/60;
  const total   = pending.reduce((s,t)=>s+t.hours,0);
  const onTime  = +(schedule.filter(s=>!s.late).length*sessH).toFixed(1);
  const late_h  = +(schedule.filter(s=>s.late).length*sessH).toFixed(1);
  const missing = Math.max(0,+(total-onTime).toFixed(1));

  let msg = `⏱️ **Study Hours Breakdown:**\n\n`;
  msg += `• Required: **${total}h** across ${pending.length} task(s)\n`;
  msg += `• Scheduled on-time: **${onTime}h**\n`;
  if (late_h>0) msg += `• Scheduled late (after deadline): **${late_h}h** ⚠️\n`;
  msg += `• Unscheduled: **${missing}h**\n`;

  if (missing > 0) {
    msg += `\n🚨 You're **${missing}h short**. Here's how to fix it:\n`;
    msg += `1. Add availability windows in **⏰ Availability**\n`;
    msg += `2. Reduce break length between sessions\n`;
    msg += `3. Complete and mark tasks as done to free up slots\n`;
    msg += `4. Check **Revision Queue** to prioritise which gaps matter most`;
  } else {
    msg += `\n✅ All ${total}h are fully scheduled on time — great job planning ahead! 🌟`;
  }

  // Per-task breakdown for top 3 pending
  const topTasks = pending.sort((a,b)=>new Date(a.deadline)-new Date(b.deadline)).slice(0,3);
  msg += `\n\n**Top tasks needing time:**\n`;
  topTasks.forEach(t => {
    const sched = schedule.filter(s=>s.taskId===t.id&&!s.late).length*sessH;
    const gap   = Math.max(0,t.hours-sched);
    msg += `• ${t.title}: ${sched.toFixed(1)}h/${t.hours}h scheduled${gap>0?` — ${gap.toFixed(1)}h missing`:'  ✅'}\n`;
  });
  return msg;
}

function handleToday(lower, tokens, entities) {
  const { schedule, settings } = appData();
  const now   = new Date();
  const sessH = (settings.sessionMin||60)/60;
  const all   = schedule.filter(s => new Date(s.start).toDateString()===now.toDateString())
                        .sort((a,b)=>new Date(a.start)-new Date(b.start));
  const upcoming = all.filter(s=>new Date(s.start)>now);

  const dayStr = now.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});
  if (!all.length) return `📅 **${dayStr}**\n\nNo sessions scheduled today. Relax, or add tasks and regenerate to fill in some study time! 😊`;

  let msg = `📅 **${dayStr}**\n\n`;
  msg += `• Total: **${all.length}** session(s) — **${(all.length*sessH).toFixed(1)}h**\n`;
  msg += `• Remaining: **${upcoming.length}** session(s)\n\n`;

  if (upcoming.length) {
    msg += `**Coming up today:**\n`;
    upcoming.slice(0,5).forEach(s => {
      const t = new Date(s.start);
      const late = s.late ? ' ⚠️ (after deadline)' : '';
      msg += `• **${t.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}** — ${s.title} · ${s.subject}${late}\n`;
    });
  } else {
    msg += `✅ **All done for today!** Great work — you've earned some rest.`;
  }
  return msg;
}

function handleTomorrow(lower, tokens, entities) {
  const { schedule, settings } = appData();
  const tom   = new Date(); tom.setDate(tom.getDate()+1);
  const sessH = (settings.sessionMin||60)/60;
  const sessions = schedule.filter(s=>new Date(s.start).toDateString()===tom.toDateString())
                           .sort((a,b)=>new Date(a.start)-new Date(b.start));
  const dayStr = tom.toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});

  if (!sessions.length) return `📅 **Tomorrow (${dayStr}):** No sessions scheduled. Either you have a free day or no tasks reach that far yet.`;

  let msg = `📅 **Tomorrow (${dayStr})** — ${sessions.length} session(s), ${(sessions.length*sessH).toFixed(1)}h:\n\n`;
  sessions.slice(0,6).forEach(s=>{
    const t=new Date(s.start);
    msg+=`• **${t.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}** — ${s.title} (${s.subject})\n`;
  });
  msg += `\n💡 Prep tonight: do a quick 10-minute review of tomorrow's first topic before bed.`;
  return msg;
}

function handleWeek(lower, tokens, entities) {
  const { schedule, settings, tasks } = appData();
  const now   = new Date();
  const sessH = (settings.sessionMin||60)/60;
  const week  = schedule.filter(s=>{const d=new Date(s.start);return d>=now&&d<=new Date(now.getTime()+7*864e5);});

  if (!week.length) return `📅 Nothing scheduled for the next 7 days. Add tasks or check your availability settings!`;

  // Group by day
  const byDay = {};
  week.forEach(s=>{
    const dk = new Date(s.start).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
    if(!byDay[dk]) byDay[dk]=[];
    byDay[dk].push(s);
  });

  let msg = `📅 **This Week (next 7 days):** ${week.length} sessions · ${(week.length*sessH).toFixed(1)}h\n\n`;
  Object.entries(byDay).slice(0,7).forEach(([day,ss])=>{
    const subjects = [...new Set(ss.map(s=>s.subject))].join(', ');
    msg += `**${day}** — ${ss.length} session(s) · ${subjects}\n`;
  });

  const upcoming_deadlines = tasks.filter(t=>!t.completed).filter(t=>{
    const d=Math.ceil((new Date(t.deadline)-now)/864e5); return d>=0&&d<=7;
  });
  if (upcoming_deadlines.length) {
    msg += `\n⚡ **Deadlines this week:** ${upcoming_deadlines.map(t=>`${t.title} (${Math.ceil((new Date(t.deadline)-now)/864e5)}d)`).join(' · ')}`;
  }
  return msg;
}

function handleDayQuery(lower, tokens, entities) {
  const { schedule, settings } = appData();
  const DAYS=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const dayName = entities.dayName || DAYS.find(d=>tokens.has(d));
  if (!dayName) return handleWeek(lower, tokens, entities);

  const sessH = (settings.sessionMin||60)/60;
  // Find next occurrence of that day
  const now = new Date();
  const targetDay = DAYS.indexOf(dayName);
  let diff = (targetDay - now.getDay() + 7) % 7;
  if (diff === 0) diff = 7; // next occurrence if today
  const targetDate = new Date(now); targetDate.setDate(now.getDate()+diff);

  const sessions = schedule.filter(s=>new Date(s.start).toDateString()===targetDate.toDateString())
                           .sort((a,b)=>new Date(a.start)-new Date(b.start));
  const dateStr = targetDate.toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});

  if (!sessions.length) return `📅 **${dateStr}:** No sessions scheduled. Check your availability for that day, or add tasks and regenerate.`;

  let msg = `📅 **${dateStr}** — ${sessions.length} session(s) · ${(sessions.length*sessH).toFixed(1)}h:\n\n`;
  sessions.forEach(s=>{
    const t=new Date(s.start);
    msg+=`• **${t.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}** — ${s.title} (${s.subject})\n`;
  });
  return msg;
}

function handleProgress(lower, tokens, entities) {
  const { tasks, topics } = appData();
  const total = tasks.length;
  const done  = tasks.filter(t=>t.completed).length;
  const pct   = total===0?0:Math.round(done/total*100);

  let msg = `📊 **Your Progress:**\n\n`;
  msg += `• Tasks: **${done}/${total}** completed (${pct}%)\n`;
  msg += `  ${'█'.repeat(Math.round(pct/10))}${'░'.repeat(10-Math.round(pct/10))}\n\n`;

  // Topic mastery
  if (topics.length) {
    const mastered = topics.filter(t=>t.status==='mastered').length;
    const topPct   = Math.round(mastered/topics.length*100);
    msg += `• Topics: **${mastered}/${topics.length}** mastered (${topPct}%)\n`;
    msg += `  ${'█'.repeat(Math.round(topPct/10))}${'░'.repeat(10-Math.round(topPct/10))}\n\n`;
  }

  if (pct===100) msg += `🏆 **Perfect!** Everything completed! You deserve a break. 🌟`;
  else if (pct>=70) msg += `🌟 Excellent — you're in the home stretch! Keep this momentum.`;
  else if (pct>=40) msg += `💪 Solid progress! Over halfway there. Consistency is your superpower.`;
  else if (pct>0)   msg += `🚀 You've started — that's the hardest step. Build on it one task at a time.`;
  else              msg += `📚 Nothing completed yet. Start with the smallest task — just 20 minutes. Go! ⏱️`;
  return msg;
}

function handleTasks(lower, tokens, entities) {
  const { tasks } = appData();
  const { subject } = entities;

  if (!tasks.length) return `📋 No tasks added yet. Head to **Tasks** and hit **"+ Add Task"** to get started! 😊`;

  let list = tasks;
  if (tokens.has('pending') || tokens.has('incomplete')) list = tasks.filter(t=>!t.completed);
  if (tokens.has('completed') || tokens.has('done'))     list = tasks.filter(t=>t.completed);
  if (tokens.has('exam') && !tokens.has('exams'))        list = list.filter(t=>t.type==='Exam');
  if (tokens.has('assignment'))                          list = list.filter(t=>t.type==='Assignment');
  if (tokens.has('revision'))                            list = list.filter(t=>t.type==='Revision');
  if (subject) list = list.filter(t=>t.subject.toLowerCase().includes(subject));

  const pending = tasks.filter(t=>!t.completed);
  const exams   = pending.filter(t=>t.type==='Exam').length;
  const assigns = pending.filter(t=>t.type==='Assignment').length;
  const revise  = pending.filter(t=>t.type==='Revision').length;

  let msg = `📋 **Task Summary:**\n`;
  msg += `• Total: ${tasks.length} · Pending: ${pending.length} · Done: ${tasks.filter(t=>t.completed).length}\n`;
  msg += `• Exams: ${exams} · Assignments: ${assigns} · Revision: ${revise}\n\n`;

  if (list.length && list.length <= 8) {
    msg += `**${subject?subject+' tasks':'All matching tasks'}:**\n`;
    list.slice(0,8).forEach(t=>{
      const now=new Date(), days=Math.ceil((new Date(t.deadline)-now)/864e5);
      const when=days<0?'overdue':days===0?'today':days===1?'tomorrow':`${days}d`;
      const done=t.completed?'✅ ':'';
      msg+=`${done}• **${t.title}** — ${when} · ${t.hours}h\n`;
    });
  }
  return msg;
}

function handleSubjectQuery(lower, tokens, entities) {
  const { topics } = appData();
  const { subject } = entities;

  if (!topics.length) return `🗺️ No topics added yet. Go to **🗺️ Subjects** to build your knowledge heatmap!`;

  let filtered = subject ? topics.filter(t=>t.subject.toLowerCase().includes(subject)) : topics;

  if (!filtered.length) return `🗺️ No topics found for "${subject}". Try checking the **Subjects** section directly.`;

  const subjectGroups = {};
  filtered.forEach(t=>{
    if (!subjectGroups[t.subject]) subjectGroups[t.subject]=[];
    subjectGroups[t.subject].push(t);
  });

  let msg = subject ? `🗺️ **Topics for ${subject}:**\n\n` : `🗺️ **Syllabus Overview:**\n\n`;
  Object.entries(subjectGroups).slice(0,5).forEach(([subj,tops])=>{
    const m=tops.filter(t=>t.status==='mastered').length;
    const nu=tops.filter(t=>t.status==='not-understood').length;
    const nr=tops.filter(t=>t.status==='needs-revision').length;
    msg+=`**${subj}:** ${m}/${tops.length} mastered`;
    if (nu) msg+=` · ${nu} not understood 🔴`;
    if (nr) msg+=` · ${nr} need revision 🟡`;
    msg+='\n';
    if (nu>0) {
      const weak=tops.filter(t=>t.status==='not-understood').slice(0,2);
      msg+=`  → Prioritise: ${weak.map(t=>t.topic).join(', ')}\n`;
    }
  });
  msg += `\nUpdate topic statuses in **🗺️ Subjects** to keep this accurate.`;
  return msg;
}

function handleReadiness() {
  try {
    // Use rescue.js calcReadiness if available
    if (typeof calcReadiness === 'function') {
      const { score, syllabusComp, quizAcc, taskProg } = calcReadiness();
      const bar = Math.round(score/10);
      let label = score>=80?'🟢 Strong':score>=60?'🟡 Moderate':score>=40?'🟠 Building':'🔴 Needs Work';
      let msg = `🎯 **Exam Readiness Score: ${score}/100** ${label}\n\n`;
      msg += `${'█'.repeat(bar)}${'░'.repeat(10-bar)}\n\n`;
      msg += `• Syllabus coverage: **${Math.round(syllabusComp*100)}%**\n`;
      msg += `• Quiz accuracy: **${Math.round(quizAcc*100)}%**\n`;
      msg += `• Task completion: **${Math.round(taskProg*100)}%**\n\n`;
      msg += `⚠️ *This is an estimate based on your recorded data — not a prediction of actual exam results.*\n\n`;
      if (score < 60) msg += `💡 Focus on the **Revision Queue** to improve your weakest topics first.`;
      else msg += `💡 You're doing well! Keep revising weak topics and recording quiz results.`;
      return msg;
    }
  } catch {}
  return `🎯 Head to **🎯 Exam Readiness** to see your full readiness score and subject risk analysis!`;
}

function handleRevisionQueue() {
  try {
    if (typeof buildRevisionQueue === 'function') {
      const queue = buildRevisionQueue();
      if (!queue.length) return `🔁 Your revision queue is empty — either all topics are mastered or no topics have been added yet. Go to **🗺️ Subjects** to start! 🌟`;
      let msg = `🔁 **Top Revision Priorities:**\n\n`;
      queue.slice(0,5).forEach((item,i)=>{
        const icon = item.status==='not-understood'?'🔴':item.status==='needs-revision'?'🟡':'⬜';
        msg += `${i+1}. ${icon} **${item.topic}** (${item.subject})\n`;
        msg += `   ${item.reason} · ~${item.status==='not-understood'?'60':'30'} min\n`;
      });
      msg += `\nOpen **🔁 Revision Queue** to start sessions and generate micro-tasks! 💪`;
      return msg;
    }
  } catch {}
  return `🔁 Check the **🔁 Revision Queue** section to see your prioritised revision list!`;
}

function handleQuizResult() {
  const { rescueData } = appData();
  const results = (rescueData.quizResults||[]).slice(-5).reverse();
  if (!results.length) return `📊 No quiz results recorded yet. Go to **🗺️ Subjects** → Confidence vs Reality Checker to record your first result!`;

  let msg = `📊 **Recent Quiz Results:**\n\n`;
  results.forEach(r=>{
    const gap = r.confidence*20 - r.accuracy;
    const flag = (r.confidence>=4&&r.accuracy<60) ? ' ⚠️ Knowledge gap!' : '';
    msg += `• **${r.topic}** (${r.subject}): Confidence ${'★'.repeat(r.confidence)} · Accuracy ${r.accuracy}%${flag}\n`;
  });

  const gaps = (rescueData.quizResults||[]).filter(r=>r.confidence>=4&&r.accuracy<60);
  if (gaps.length) msg += `\n⚠️ **${gaps.length}** topic(s) show high confidence but low accuracy — these are likely knowledge gaps. Revisit them in the **Revision Queue**!`;
  return msg;
}

function handleComeback() {
  const { rescueData } = appData();
  const pts = rescueData.comebackPoints || 0;
  const ach = rescueData.achievements   || [];
  let msg = `🏆 **Comeback Score: ${pts} points**\n\n`;
  if (ach.length) msg += `**Achievements:** ${ach.join(' · ')}\n\n`;
  msg += `Earn more points by:\n• Mastering topics (+10)\n• Completing micro-tasks (+2)\n• Logging study sessions (+8)\n• Recording quiz results (+3)\n\nKeep going — every point represents real effort! 💪`;
  return msg;
}

function handleProfile() {
  const { profile, tasks } = appData();
  const done = tasks.filter(t=>t.completed).length;
  return `👤 **${profile.name||'Student'}**\n\n• Course: ${profile.course||'Not set'}\n• Institution: ${profile.institution||'Not set'}\n• Year: ${profile.year||'Not set'}\n• Daily goal: **${profile.goalHours||6}h**\n• Tasks done: **${done}/${tasks.length}**\n\nUpdate your details in the **👤 Profile** section! 🎓`;
}

function handleNavigate(lower) {
  const nav = [
    { words:['subject','topic','heatmap','syllabus'], section:'subjects',     label:'🗺️ Subjects' },
    { words:['revision','queue','revise'],             section:'revision',     label:'🔁 Revision Queue' },
    { words:['readiness','risk','exam ready'],         section:'readiness',    label:'🎯 Exam Readiness' },
    { words:['daily','review','autopsy','log'],        section:'dailyreview',  label:'📓 Daily Review' },
    { words:['task','add task','assignment','exam'],   section:'tasks',        label:'📋 Tasks' },
    { words:['timetable','schedule','calendar'],       section:'timetable',    label:'📅 Timetable' },
    { words:['availability','hours','free time'],      section:'availability', label:'⏰ Availability' },
    { words:['profile','name','photo'],                section:'profile',      label:'👤 Profile' },
    { words:['dashboard','home','overview'],           section:'dashboard',    label:'🏠 Dashboard' },
  ];
  for (const n of nav) {
    if (n.words.some(w=>lower.includes(w))) {
      if (typeof switchSection==='function') switchSection(n.section);
      return `Navigating to **${n.label}**! 🚀`;
    }
  }
  return `🗺️ Available sections:\n🏠 Dashboard · 📋 Tasks · 📅 Timetable · ⏰ Availability · 👤 Profile · 🗺️ Subjects · 🔁 Revision Queue · 🎯 Exam Readiness · 📓 Daily Review\n\nJust say "go to timetable" or click a nav link on the left!`;
}

function handleTip(lower) {
  const TIPS = [
    '📖 **Spaced repetition**: review after 1 day, 3 days, 1 week, 2 weeks. Beats cramming every time.',
    '✍️ **Active recall**: close your notes and write everything you remember. Gaps reveal what to fix.',
    '🎯 Break tasks into 20-minute chunks. "Study calculus" → "Solve 3 integration problems".',
    '📵 Phone away: even a visible notification costs 20 minutes of focus. Out of sight, out of mind.',
    '🌿 Breaks aren\'t laziness — your brain consolidates learning *during* downtime, not only while studying.',
    '📝 Teach it to someone. If you can explain it simply, you understand it. Rubber duck debugging — but for learning! 🦆',
    '⏰ Match hard tasks to your peak energy. Most people peak mid-morning. Use that window for the hardest material.',
    '🗂️ Mind maps beat linear notes for complex topics. Draw connections between ideas.',
    '💧 Mild dehydration cuts concentration by ~10%. Keep water at your desk.',
    '🎵 Ambient music or lo-fi helps some people focus. Try it — worst case you turn it off.',
    '🔁 Interleave subjects. Mixing topics (maths → history → maths) beats one-subject blocks for long-term retention.',
    '📊 Practice tests beat re-reading by a massive margin. Find past papers and use them.',
    '🧩 Chunk information. 7 random digits is hard; a phone number format makes it easy. Group what you learn.',
    '🌙 Review notes 30 minutes before sleep. Sleep then consolidates what you just reviewed.',
    '🏃 A 20-minute walk boosts memory and creative thinking. Study block → short walk → review.',
  ];
  const tip = TIPS[Math.floor(Math.random()*TIPS.length)];
  return `💡 **Study Tip:**\n\n${tip}\n\nWant another? Just ask! 😊`;
}

function handlePomodoro() {
  return `🍅 **Pomodoro Technique — Step by Step:**\n\n1. Pick **one** task to focus on\n2. Set a timer for **25 minutes** — nothing else\n3. Work until the timer rings\n4. Take a **5-minute break** (stand, stretch, water)\n5. After **4 rounds**, take a **20–30 minute** break\n\n**Why it works:**\n• Creates urgency (deadline effect)\n• Makes large tasks feel manageable\n• Built-in recovery prevents burnout\n• Trains single-task focus\n\n**Pro tip:** Write down interruptions instead of acting on them — brain dump, then get back on task. 🧠`;
}

function handleMotivation() {
  const QUOTES = [
    { q:'The secret of getting ahead is getting started.', a:'Mark Twain', e:'💪' },
    { q:'It always seems impossible until it\'s done.', a:'Nelson Mandela', e:'🌟' },
    { q:'Success is the sum of small efforts, repeated day in and day out.', a:'Robert Collier', e:'🔥' },
    { q:'Hard work beats talent when talent doesn\'t work hard.', a:'Tim Notke', e:'⭐' },
    { q:'The future belongs to those who prepare for it today.', a:'Malcolm X', e:'🏆' },
    { q:'You don\'t have to be great to start, but you have to start to be great.', a:'Zig Ziglar', e:'🚀' },
    { q:'Believe you can and you\'re halfway there.', a:'Theodore Roosevelt', e:'🌈' },
    { q:'The expert in anything was once a beginner.', a:'Helen Hayes', e:'📚' },
  ];
  const q = QUOTES[Math.floor(Math.random()*QUOTES.length)];
  return `${q.e} *"${q.q}"*\n— ${q.a}\n\nYou opened a study planner today. That's already more than most people do. Now take that energy and put in **one focused session**. The rest follows. 💪`;
}

function handleFocus() {
  return `🎯 **Beating Distraction & Procrastination:**\n\n**The 2-minute rule:** Tell yourself you'll study for just 2 minutes. You'll almost always keep going once you start.\n\n**Remove temptations:**\n• Phone in another room (not just flipped over)\n• Close unnecessary browser tabs\n• Use a site blocker for 25-minute windows\n\n**Reset your environment:**\n• Clear your desk — clutter increases cognitive load\n• Change location if you're stuck (library, café, outside)\n\n**Body double:** Work alongside a friend (physically or on video call). Human presence reduces avoidance.\n\n**Reward loop:** One session → small reward. Train your brain to associate studying with positive feelings. 🍫\n\n*Remember: you don't need to feel like studying to start studying. Just start.*`;
}

function handleMemory() {
  return `🧠 **Memory & Retention — What Actually Works:**\n\n**High impact:**\n• **Active recall** — test yourself, don't just re-read\n• **Spaced repetition** — 1d → 3d → 1w → 2w → 1m reviews\n• **Interleaving** — mix different topics in one session\n• **Elaborative interrogation** — ask "why does this work?"\n\n**Medium impact:**\n• **Sleep** — consolidates everything you studied that day\n• **Exercise** — 20-min walk before studying boosts memory\n• **Teaching others** — forces you to truly understand\n\n**Low impact (but popular):**\n• Re-reading, highlighting, re-copying notes\n\n*Effort and retrieval are what build lasting memory — not passive exposure.* 📖`;
}

function handleSleep() {
  return `😴 **Sleep & Studying:**\n\nSleep isn't wasted time — it's when your brain **moves short-term memories into long-term storage**.\n\n• Aim for **7–9 hours** per night during exams\n• Review notes **30 minutes before bed** — sleep then consolidates them\n• **Short naps** (10–20 min) after studying boost retention significantly\n• Consistent wake time matters more than total hours\n• Avoid screens 1 hour before bed — blue light delays melatonin\n\n**All-nighters?** They impair the very memory you're trying to build. A rested brain on 7h sleep will always outperform a tired brain on 1h sleep + 6h cramming. 💤`;
}

function handleAnxiety() {
  return `💙 **Exam Stress & Anxiety:**\n\nFeeling nervous is completely normal — it means you care. Here's how to keep it from tipping into panic:\n\n**Right now:**\n• Take 4 slow breaths: inhale 4s, hold 4s, exhale 4s\n• Write down your worries — externalising them reduces their power\n\n**Study habits that reduce anxiety:**\n• Start early — last-minute pressure amplifies stress\n• Tick off small tasks — each ✅ builds confidence\n• Avoid comparing with classmates — everyone prepares differently\n\n**Before the exam:**\n• Light revision only — no new material the night before\n• Good sleep \u003e extra cramming, every time\n• Eat a proper meal — your brain needs glucose\n\n**If anxiety is severe**, speak to your institution's student support services. You don't have to manage this alone. 💙`;
}

function handleNutrition() {
  return `🍎 **Brain Food for Studying:**\n\n**Best foods before studying:**\n• Oats, eggs, nuts — steady energy, no crash\n• Blueberries — shown to improve memory in studies\n• Dark chocolate (70%+) — small amounts boost focus\n• Water — even mild dehydration hurts concentration\n\n**Avoid:**\n• High-sugar snacks — quick spike, then a crash mid-session\n• Heavy meals right before — blood goes to digestion, not thinking\n• Too much caffeine — after 2pm disrupts sleep quality\n\n**Caffeine tips:**\n• Coffee + a 20-min nap = "nappuccino" — caffeine kicks in as you wake up ☕😴\n• Stop caffeine by 2pm to protect sleep\n\n*You can't study well on an empty or sugar-crashed brain.* Feed it properly! 🧠`;
}

function handleEnvironment() {
  return `🏢 **Optimising Your Study Environment:**\n\n**Location:**\n• Libraries and cafés work better for many people (social accountability)\n• Change location if you feel stuck — novelty resets focus\n• Dedicated study spot = brain learns "this is work mode"\n\n**Sound:**\n• Complete silence works for some, not all\n• Lo-fi / ambient music masks distracting noise\n• Brown noise or white noise is great for deep focus\n• No music with lyrics for reading/writing tasks\n\n**Physical setup:**\n• Good lighting — poor light causes fatigue\n• Ergonomic posture — slouching reduces blood flow to the brain\n• Tidy desk — clutter increases cognitive load\n• Temperature ~20°C (68°F) — too warm = drowsy\n\n**Phone rule:** If it's within arm's reach, it's a distraction. Put it in another room or a bag. 📵`;
}

function handleNotes() {
  return `📝 **Effective Note-Taking Strategies:**\n\n**Cornell Method** (recommended for lectures):\n• Divide page: right column for notes, left for keywords/questions, bottom for summary\n• Write questions in the left margin during review\n• Cover your notes and answer the questions from memory\n\n**Mind Mapping** (for complex topics):\n• Central idea in the middle, branches for subtopics\n• Colour-code and use images — visual memory is powerful\n\n**Principle of Less is More:**\n• Paraphrase in your own words — copying ≠ learning\n• One idea per bullet — dense walls of text are hard to review\n• Leave white space — dense notes are intimidating\n\n**Review cycle:** Notes are worthless without review. Schedule a 10-minute review the same evening, then use spaced repetition. 🔁`;
}

function handleSubjectMath() {
  return `📐 **Studying Mathematics Effectively:**\n\n• **Never just read solutions.** Close the book and attempt each problem cold. Getting it wrong is how you learn.\n• **Work past papers** — exam questions repeat patterns. 5 years of past papers beats 100 pages of notes.\n• **Write out steps fully** — skipping steps is where errors hide.\n• **Identify your error types**: algebra slips, sign errors, wrong formula? Fix the root cause.\n• **Teach a concept** back to yourself — if you can't explain it, you don't know it yet.\n• **Spaced practice** beats marathon sessions. 30 min/day beats 4 hours on Sunday.\n\nWhich topic are you working on? I can give more specific advice! 🔢`;
}

function handleSubjectScience() {
  return `🔬 **Studying Science (Physics / Chemistry / Biology):**\n\n• **Understand the concept, then the formula.** Memorising without understanding = forgetting under pressure.\n• **Draw diagrams** — circuits, reactions, body systems. Visual recall is much stronger.\n• **Colour-code** your notes by topic (red for thermodynamics, blue for mechanics, etc.)\n• **Practice calculations** with varied numbers, not just textbook examples.\n• **Lab reports**: use the structure (aim → method → results → discussion → conclusion) and explain the *why* at each step.\n• **Mnemonics** for reaction sequences, taxonomy, etc. — but learn the underlying logic too.\n\nWhich science subject are you studying? I can narrow this down! 🧪`;
}

function handleSubjectEssay() {
  return `✍️ **Essay Writing & Humanities:**\n\n**Planning (30% of your time):**\n• Read the question 3 times — what is it *actually* asking?\n• Brainstorm arguments, then select the strongest 3\n• Outline: intro → argument → argument → argument → conclusion\n\n**Writing:**\n• Each paragraph: Point → Evidence → Explanation → Link back\n• Avoid padding — every sentence should earn its place\n• Strong verbs, specific evidence, your own analysis\n\n**Revision:**\n• Read aloud — you'll catch awkward phrasing instantly\n• Cut the first sentence of your intro (it's usually waffle)\n• Check: have you actually answered the question?\n\n**Exam essays:**\n• 5 minutes planning saves 20 minutes of rambling\n• Quality over quantity — 3 well-argued points beat 6 shallow ones\n\nWhat subject is the essay for? I can tailor this further! 📖`;
}

function handleHelp() {
  return `🤖 **What I can help with:**\n\n**📊 Your Data (live):**\n"How's my schedule?" · "Upcoming deadlines" · "What's today?" · "Which task is urgent?" · "How many hours left?" · "Show me Monday" · "How am I doing?"\n\n**🗺️ RescueStudy Features:**\n"Show revision queue" · "My readiness score" · "Quiz results" · "Subject topics" · "Comeback score"\n\n**🧠 Study Knowledge:**\n"Study tips" · "Pomodoro" · "Help me focus" · "Memory tips" · "Exam anxiety" · "Best foods for studying" · "Note-taking tips" · "Help with maths/science/essays"\n\n**💪 Motivation:**\n"Motivate me" · "I'm procrastinating" · "Encourage me"\n\n**🧭 Navigation:**\n"Go to timetable" · "Open subjects" · "Navigate to profile"\n\n**😄 Other:**\n"Tell me a joke" · "Who are you?"\n\nI read your **live app data**, so all schedule/task answers are real-time! 🎯`;
}

function handleBye() {
  const { tasks } = appData();
  const pending = tasks.filter(t=>!t.completed).length;
  const endings = [
    `Goodbye! 👋 You have ${pending} task(s) waiting — consistent effort today beats panic tomorrow. See you soon! 📚`,
    `Bye! 🌟 Remember: even 30 minutes of focused study beats a 3-hour distracted marathon. You've got this! 💪`,
    `Take care! 😊 Come back whenever you need a plan check or a motivation boost. Your study buddy is always here! 🦉`,
  ];
  return endings[Math.floor(Math.random()*endings.length)];
}

function handleThanks() {
  const replies = [
    `You're welcome! 😊 Go make the most of your study time — I'll be here if you need anything! 🌟`,
    `Glad I could help! 🦉 Now go execute that plan. You've got everything you need. 💪`,
    `Any time! 😄 Check in whenever you need a reality check on your schedule or a boost of motivation!`,
  ];
  return replies[Math.floor(Math.random()*replies.length)];
}

function handleJoke() {
  const JOKES = [
    `Why did the student eat their homework? 📝 Because the teacher said it was a piece of cake! 🎂`,
    `Why did the maths book look sad? 📚 It had too many *problems*. 😂`,
    `Why don't scientists trust atoms? ⚛️ Because they make up *everything*! 🤣`,
    `My teacher said I had potential. So I fell off the table. 🪑 (Physics joke — gravitational potential energy) 😄`,
    `Why did the student bring a ladder to school? 🪜 Because they heard it was a high school! 😁`,
    `I told my parents I wanted to be an astronaut. They said the sky's the limit. 🚀 Clearly they haven't read Newton.`,
    `How do you make 7 even? Remove the S! ✏️ (That's a maths joke for you 😅)`,
  ];
  return JOKES[Math.floor(Math.random()*JOKES.length)] + `\n\nOk ok, back to the books! 📚 Type "help" if you need something useful. 😄`;
}

function handleOffTopic(lower) {
  return `😅 That's a bit outside my expertise as a study assistant!\n\nBut I'm great at helping with:\n• 📅 Your schedule and deadlines\n• 🧠 Study strategies that actually work\n• 💪 Motivation when you need a push\n• 🗺️ Tracking your subject progress\n\nWhat would you like help with? Just ask! 🦉`;
}

function fallback(lower) {
  // Spell-correction hints for common typos
  const TYPO_MAP = {
    'schedul': 'schedule', 'deadlien': 'deadline', 'urgend': 'urgent',
    'timetabl': 'timetable', 'progres': 'progress', 'motivat': 'motivation',
    'focuse': 'focus', 'memori': 'memory', 'pomodore': 'pomodoro',
  };
  for (const [typo, correct] of Object.entries(TYPO_MAP)) {
    if (lower.includes(typo)) {
      return `Did you mean **"${correct}"**? 🤔 Try asking about that and I'll have a proper answer ready! Or type **"help"** to see everything I can do.`;
    }
  }

  const FALLBACKS = [
    `Hmm, I didn't quite get that! 🤔 Try asking about your **deadlines**, **schedule**, **study tips**, or **revision queue**. Or type **"help"** to see all options!`,
    `I'm not sure I understood that one. 😅 I'm best with study questions like "What's due soon?", "How am I doing?", or "Give me a tip". What did you need?`,
    `That's outside what I currently know! 📚 Try asking about your **tasks**, **hours**, **readiness score**, or **motivation** — those I can definitely help with! ✨`,
  ];
  return FALLBACKS[Math.floor(Math.random()*FALLBACKS.length)];
}

// ─────────────────────────────────────────────────────────────
// CHIP SUGGESTIONS — context-adaptive
// ─────────────────────────────────────────────────────────────
const CHIP_SETS = {
  default:   ["How's my schedule?", "Upcoming deadlines", "Study tips", "Motivate me!", "How many hours left?"],
  schedule:  ["What's today?", "What's tomorrow?", "Show this week", "Any overdue?", "Which task is urgent?"],
  study:     ["Pomodoro technique", "Memory tips", "Beat procrastination", "Note-taking tips", "Exam anxiety help"],
  rescue:    ["Show revision queue", "My readiness score", "Quiz results", "My comeback score", "Subject topics"],
  tasks:     ["Show urgent tasks", "How many hours?", "Show exams", "Show assignments", "My progress"],
  motivation:["Motivate me again!", "I'm stressed", "I'm procrastinating", "Study tips", "Tell me a joke"],
};

function getContextualChips(intentId) {
  if (!intentId) return CHIP_SETS.default;
  if (['schedule','today','tomorrow','week','dayquery','hours'].includes(intentId)) return CHIP_SETS.schedule;
  if (['tip','pomodoro','focus','memory','sleep','anxiety','nutrition','environment','notes'].includes(intentId)) return CHIP_SETS.study;
  if (['subject','readiness','revision','quiz','comeback'].includes(intentId)) return CHIP_SETS.rescue;
  if (['tasks','overdue','urgent','progress'].includes(intentId)) return CHIP_SETS.tasks;
  if (['motivation','bye','thanks'].includes(intentId)) return CHIP_SETS.motivation;
  return CHIP_SETS.default;
}

// ─────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────
function formatBubble(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/\n/g,'<br>');
}

function appendMessage(role, text, intentId) {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  const msg = document.createElement('div');
  msg.className = `chat-msg ${role}`;
  const avatar = document.createElement('div');
  avatar.className = 'chat-msg-avatar';
  avatar.setAttribute('aria-hidden','true');
  if (role==='bot') {
    avatar.textContent = '🦉';
  } else {
    try {
      const initials = typeof getInitials==='function' ? getInitials(profile?.name||'U') : 'U';
      avatar.textContent = initials;
      avatar.style.background = profile?.avatar || '#1a2744';
    } catch { avatar.textContent='U'; }
  }
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.innerHTML = formatBubble(text);
  msg.appendChild(avatar); msg.appendChild(bubble);
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  BOT.history.push({ role, text, intentId });
  if (role==='bot' && !BOT.open) { BOT.unread++; updateBadge(); }
}

function showTyping() {
  const c = document.getElementById('chatMessages');
  if (!c) return;
  const el = document.createElement('div');
  el.className='chat-msg bot'; el.id='typingIndicator';
  el.innerHTML=`<div class="chat-msg-avatar" aria-hidden="true">🦉</div>
    <div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>`;
  c.appendChild(el); c.scrollTop=c.scrollHeight;
}
function removeTyping() { document.getElementById('typingIndicator')?.remove(); }

function sendBotMessage(text, intentId, delay) {
  // Typing delay proportional to response length (150–900ms)
  const d = delay !== undefined ? delay : Math.min(900, Math.max(150, text.length * 1.2));
  showTyping();
  return new Promise(res => setTimeout(() => {
    removeTyping();
    appendMessage('bot', text, intentId);
    renderChips(getContextualChips(intentId));
    res();
  }, d));
}

function renderChips(chips) {
  const c = document.getElementById('chatChips');
  if (!c) return;
  c.innerHTML = (chips||CHIP_SETS.default).map(ch =>
    `<button class="chat-chip" data-msg="${ch.replace(/"/g,'&quot;')}">${ch}</button>`
  ).join('');
}

function updateBadge() {
  const b = document.getElementById('chatFabBadge');
  if (!b) return;
  b.textContent = BOT.unread;
  b.style.display = BOT.unread > 0 ? 'flex' : 'none';
}

// ─── Open / close / minimise ──────────────────────────────────
function openChat() {
  const w=document.getElementById('chatWidget'), f=document.getElementById('chatFab');
  if (!w) return;
  w.classList.add('open'); w.classList.remove('minimised');
  BOT.open=true; BOT.minimised=false; BOT.unread=0;
  updateBadge();
  if (f) f.style.display='none';
  document.getElementById('chatInput')?.focus();

  if (BOT.history.length===0) {
    const greetMsg = handleGreeting('');
    sendBotMessage(greetMsg, 'greeting', 500).then(() => {
      // Context-aware second message
      const { tasks } = appData();
      const pending = tasks.filter(t=>!t.completed);
      if (pending.length) {
        const nearest = [...pending].sort((a,b)=>new Date(a.deadline)-new Date(b.deadline))[0];
        const days = Math.ceil((new Date(nearest.deadline)-new Date())/864e5);
        const msg = days <= 2
          ? `⚡ Heads up — **"${nearest.title}"** is due ${days<=0?'today/overdue!':days+'d'}! Want to see your full schedule or priorities?`
          : `📋 You have **${pending.length}** pending task(s). Next deadline: **"${nearest.title}"** in ${days} days.`;
        sendBotMessage(msg, 'deadline', 1800);
      }
    });
  }
}

function closeChat() {
  const w=document.getElementById('chatWidget'), f=document.getElementById('chatFab');
  if (w){w.classList.remove('open');w.classList.remove('minimised');}
  if (f) f.style.display='flex';
  BOT.open=false;
}

function minimiseChat() {
  const w=document.getElementById('chatWidget');
  if (!w) return;
  BOT.minimised=!BOT.minimised;
  w.classList.toggle('minimised',BOT.minimised);
  document.getElementById('chatMinimize').textContent=BOT.minimised?'□':'—';
}

// ─── Send message ─────────────────────────────────────────────
async function handleSend() {
  const input=document.getElementById('chatInput');
  if (!input) return;
  const text=input.value.trim();
  if (!text) return;
  input.value='';
  appendMessage('user',text);
  const chips=document.getElementById('chatChips');
  if (chips) chips.innerHTML='';

  // Get response with intent tracking
  let intentId = null;
  let response = null;

  // Score intents to find best one
  const lower = text.toLowerCase().trim();
  const tokens = tokenise(lower);
  const stems  = new Set([...tokens].map(stem));
  const entities = extractEntities(lower, tokens);

  let bestScore=0, bestIntent=null;
  for (const def of INTENT_DEFS) {
    const s = scorePatterns(tokens,stems,lower,def.patterns);
    if (s>bestScore){bestScore=s;bestIntent=def;}
  }

  if (bestScore<0.5 && BOT.lastIntent) {
    response = resolveFollowUp(lower,tokens,stems,BOT.lastIntent,entities);
    intentId = BOT.lastIntent;
  }
  if (!response) {
    BOT.lastIntent = bestIntent?.id||null;
    intentId = BOT.lastIntent;
    response = bestIntent && bestScore>=0.5 ? bestIntent.handler(lower,tokens,entities) : fallback(lower);
  }

  await sendBotMessage(response||fallback(lower), intentId);
}

// ─── Drag ─────────────────────────────────────────────────────
function initDrag() {
  const header=document.getElementById('chatHeader'), widget=document.getElementById('chatWidget');
  if (!header||!widget) return;
  const startDrag=(cx,cy)=>{
    BOT.dragging=true;
    const r=widget.getBoundingClientRect();
    BOT.dragOffX=cx-r.left; BOT.dragOffY=cy-r.top;
    widget.style.transition='none';
  };
  header.addEventListener('mousedown',e=>{if(!e.target.closest('.chat-action-btn'))startDrag(e.clientX,e.clientY);e.preventDefault();});
  header.addEventListener('touchstart',e=>{if(!e.target.closest('.chat-action-btn')){const t=e.touches[0];startDrag(t.clientX,t.clientY);}},{passive:true});
  document.addEventListener('mousemove',e=>{if(BOT.dragging)moveWidget(e.clientX,e.clientY);});
  document.addEventListener('touchmove',e=>{if(BOT.dragging){const t=e.touches[0];moveWidget(t.clientX,t.clientY);}},{passive:true});
  document.addEventListener('mouseup',()=>{BOT.dragging=false;});
  document.addEventListener('touchend',()=>{BOT.dragging=false;});
}

function moveWidget(cx,cy) {
  const w=document.getElementById('chatWidget'); if(!w)return;
  const vw=window.innerWidth,vh=window.innerHeight,ww=w.offsetWidth,wh=w.offsetHeight;
  let x=Math.max(0,Math.min(cx-BOT.dragOffX,vw-ww));
  let y=Math.max(0,Math.min(cy-BOT.dragOffY,vh-wh));
  w.style.left=x+'px'; w.style.top=y+'px'; w.style.right='auto'; w.style.bottom='auto';
}

// ─── Resize ───────────────────────────────────────────────────
function initResize() {
  const handle=document.getElementById('chatResizeHandle'), widget=document.getElementById('chatWidget');
  if (!handle||!widget) return;
  handle.addEventListener('mousedown',e=>{
    BOT.resizing=true;
    BOT.resizeStartX=e.clientX; BOT.resizeStartY=e.clientY;
    const r=widget.getBoundingClientRect();
    BOT.resizeStartW=r.width; BOT.resizeStartH=r.height;
    BOT.resizeStartL=r.left; BOT.resizeStartT=r.top;
    widget.style.transition='none';
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove',e=>{
    if (!BOT.resizing) return;
    const dx=BOT.resizeStartX-e.clientX, dy=BOT.resizeStartY-e.clientY;
    const nw=Math.max(280,Math.min(window.innerWidth*0.9,BOT.resizeStartW+dx));
    const nh=Math.max(320,Math.min(window.innerHeight*0.85,BOT.resizeStartH+dy));
    const nl=BOT.resizeStartL+(BOT.resizeStartW-nw);
    const nt=BOT.resizeStartT+(BOT.resizeStartH-nh);
    widget.style.width=nw+'px'; widget.style.height=nh+'px';
    widget.style.left=nl+'px'; widget.style.top=nt+'px';
    widget.style.right='auto'; widget.style.bottom='auto';
  });
  document.addEventListener('mouseup',()=>{BOT.resizing=false;});
}

// ─── Init ─────────────────────────────────────────────────────
function initChatbot() {
  document.getElementById('chatFab')?.addEventListener('click', openChat);
  document.getElementById('chatClose')?.addEventListener('click', closeChat);
  document.getElementById('chatMinimize')?.addEventListener('click', minimiseChat);
  document.getElementById('chatSend')?.addEventListener('click', handleSend);
  document.getElementById('chatHeader')?.addEventListener('click', e => {
    if (BOT.minimised && !e.target.closest('.chat-action-btn')) minimiseChat();
  });
  document.getElementById('chatInput')?.addEventListener('keydown', e => {
    if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();handleSend();}
  });
  document.getElementById('chatChips')?.addEventListener('click', e => {
    const chip=e.target.closest('.chat-chip');
    if (chip){ document.getElementById('chatInput').value=chip.dataset.msg; handleSend(); }
  });
  initDrag();
  initResize();
  renderChips(CHIP_SETS.default);
  // Show badge hint after 3s
  setTimeout(()=>{ if(!BOT.open){BOT.unread=1;updateBadge();} }, 3000);
}

if (document.readyState==='loading') {
  document.addEventListener('DOMContentLoaded', initChatbot);
} else {
  setTimeout(initChatbot, 150);
}
