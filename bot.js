// FWC Goal ($FWCG) - football alert + group manager
// Node.js + Telegraf v4 + Express webhook mode
// Primary API: football-data.org (10 req/min per key, no daily cap)
// Backup API: api-football.com (100 req/day per key, true live data)
// State: GitHub repo (milestone writes only)
// Pure ASCII source. Emojis as escapes in E object.

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fetch = require('node-fetch');

// ---------- Emoji table ----------
const E = {
  ball: '\u26BD',
  lock: '\u{1F512}',
  unlock: '\u{1F513}',
  fire: '\u{1F525}',
  star: '\u2B50',
  party: '\u{1F389}'
};

// ---------- Env ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID || '0', 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = parseInt(process.env.PORT || '3000', 10);

// API keys: comma-separated lists
const FD_KEYS = (process.env.FOOTBALL_DATA_KEYS || process.env.FOOTBALL_API_KEY || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const AF_KEYS = (process.env.API_FOOTBALL_KEYS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const STATE_FILE = process.env.STATE_FILE || 'state.json';

if (!BOT_TOKEN) { console.error('Missing BOT_TOKEN'); process.exit(1); }
if (!WEBHOOK_URL) { console.error('Missing WEBHOOK_URL'); process.exit(1); }

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// ---------- State (in memory; persisted on milestones only) ----------
let state = {
  groupId: null,
  autopilot: false,
  settings: {
    goalAlerts: true,
    polls: true,
    autoLock: true,
    antiLink: true,
    antiForward: true,
    antiExternalTag: true,
    allowXLinks: true
  },
  trackedMatches: {},
  offenses: {},
  schedulePostedFor: ''
};

// hot in-memory caches
const matchCache = {};      // matchId -> { data, at, lastScore }
const todayCache = { data: null, at: 0 };
let liveMatchCount = 0;

// ---------- GitHub persistence (milestone-only) ----------
let stateSha = null;
let saveInFlight = false;
let pendingSave = false;

async function loadState() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.log('GitHub not configured, in-memory only');
    return;
  }
  try {
    const r = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + STATE_FILE, {
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'fwcg-bot'
      }
    });
    if (r.status === 404) { console.log('No state file yet'); return; }
    if (!r.ok) { console.log('GitHub load failed:', r.status); return; }
    const data = await r.json();
    stateSha = data.sha;
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    state = Object.assign(state, JSON.parse(content));
    console.log('State loaded');
  } catch (err) { console.log('loadState err:', err.message); }
}

async function saveStateNow() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  if (saveInFlight) { pendingSave = true; return; }
  saveInFlight = true;
  try {
    const body = {
      message: 'state update',
      content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64')
    };
    if (stateSha) body.sha = stateSha;
    const r = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + STATE_FILE, {
      method: 'PUT',
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'fwcg-bot'
      },
      body: JSON.stringify(body)
    });
    if (r.ok) {
      const data = await r.json();
      if (data.content && data.content.sha) stateSha = data.content.sha;
    } else if (r.status === 409 || r.status === 422) {
      stateSha = null;
      await loadState();
    } else {
      console.log('save failed:', r.status);
    }
  } catch (err) { console.log('save err:', err.message); }
  finally {
    saveInFlight = false;
    if (pendingSave) { pendingSave = false; setTimeout(saveStateNow, 1500); }
  }
}

// debounced save (for non-critical updates like offense counts)
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveStateNow(); }, 10000);
}

// ---------- Helpers ----------
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function isAdmin(ctx) {
  if (!ctx.from || !ctx.chat) return false;
  if (ctx.from.id === OWNER_ID) return true;
  try {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return m && (m.status === 'creator' || m.status === 'administrator');
  } catch (e) { return false; }
}

function flagFor(code) {
  if (!code || code.length < 2) return '';
  const A = 0x1F1E6;
  try {
    return String.fromCodePoint(code.toUpperCase().charCodeAt(0) - 65 + A) +
           String.fromCodePoint(code.toUpperCase().charCodeAt(1) - 65 + A);
  } catch (e) { return ''; }
}

function teamName(team) {
  if (!team) return '?';
  return team.shortName || team.name || team.tla || '?';
}

function teamFlag(team) {
  if (!team) return '';
  return flagFor((team.tla || '').slice(0, 2));
}

// ---------- Key rotation pool ----------
function makePool(keys, cooldownMs) {
  const pool = keys.map(k => ({ key: k, cooldownUntil: 0, errors: 0 }));
  return {
    next() {
      const now = Date.now();
      // pick the one with earliest cooldownUntil that has passed, prefer least errors
      const ready = pool.filter(p => p.cooldownUntil <= now);
      if (!ready.length) return null;
      ready.sort((a, b) => a.errors - b.errors);
      return ready[0];
    },
    park(entry, ms) {
      if (!entry) return;
      entry.cooldownUntil = Date.now() + (ms || cooldownMs);
      entry.errors += 1;
    },
    ok(entry) { if (entry) entry.errors = Math.max(0, entry.errors - 1); },
    size() { return pool.length; },
    available() { return pool.filter(p => p.cooldownUntil <= Date.now()).length; }
  };
}

const fdPool = makePool(FD_KEYS, 65000);    // 65s cooldown on 429
const afPool = makePool(AF_KEYS, 3600000);  // 1h cooldown if daily limit hit

// ---------- API fetchers with rotation + SWR ----------
async function fdGet(path) {
  const entry = fdPool.next();
  if (!entry) return null;
  try {
    const r = await fetch('https://api.football-data.org/v4' + path, {
      headers: { 'X-Auth-Token': entry.key }
    });
    if (r.status === 429) { fdPool.park(entry, 65000); return null; }
    if (!r.ok) { console.log('FD ' + path + ' -> ' + r.status); return null; }
    fdPool.ok(entry);
    return await r.json();
  } catch (err) {
    console.log('fdGet err:', err.message);
    fdPool.park(entry, 30000);
    return null;
  }
}

// api-football.com (RapidAPI-style headers)
async function afGet(path) {
  const entry = afPool.next();
  if (!entry) return null;
  try {
    const r = await fetch('https://v3.football.api-sports.io' + path, {
      headers: { 'x-apisports-key': entry.key }
    });
    if (r.status === 429 || r.status === 499) { afPool.park(entry, 3600000); return null; }
    if (!r.ok) { console.log('AF ' + path + ' -> ' + r.status); return null; }
    afPool.ok(entry);
    const data = await r.json();
    if (data && data.errors && Object.keys(data.errors).length) {
      const errStr = JSON.stringify(data.errors);
      if (/limit|quota|requests/i.test(errStr)) afPool.park(entry, 3600000);
      return null;
    }
    return data;
  } catch (err) {
    console.log('afGet err:', err.message);
    afPool.park(entry, 60000);
    return null;
  }
}

// ---------- Match data fetching with SWR ----------
async function fetchTodayMatches(force) {
  const now = Date.now();
  if (!force && todayCache.data && now - todayCache.at < 60000) return todayCache.data;
  const today = new Date().toISOString().slice(0, 10);
  const data = await fdGet('/competitions/WC/matches?dateFrom=' + today + '&dateTo=' + today);
  const matches = (data && data.matches) || [];
  todayCache.data = matches;
  todayCache.at = now;
  return matches;
}

async function fetchMatchDetail(matchId, force) {
  const now = Date.now();
  const cached = matchCache[matchId];
  // serve cache while fetching fresh
  if (!force && cached && now - cached.at < 15000) return cached.data;
  const data = await fdGet('/matches/' + matchId);
  if (!data) return cached ? cached.data : null;
  const match = data.match || data;
  matchCache[matchId] = { data: match, at: now };
  return match;
}

// api-football corroboration for live score (used only when goal suspected)
async function afVerifyLiveScore(homeName, awayName) {
  if (!AF_KEYS.length) return null;
  // fetch all live fixtures, find ours
  const data = await afGet('/fixtures?live=all');
  if (!data || !data.response) return null;
  const normalize = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');
  const hN = normalize(homeName), aN = normalize(awayName);
  for (const f of data.response) {
    const fh = normalize(f.teams && f.teams.home && f.teams.home.name);
    const fa = normalize(f.teams && f.teams.away && f.teams.away.name);
    if ((fh.includes(hN) || hN.includes(fh)) && (fa.includes(aN) || aN.includes(fa))) {
      return {
        homeScore: f.goals && f.goals.home,
        awayScore: f.goals && f.goals.away,
        minute: f.fixture && f.fixture.status && f.fixture.status.elapsed,
        events: f.events || null
      };
    }
  }
  return null;
}

// ---------- Group lock / unlock ----------
const FULL_PERMS = {
  can_send_messages: true, can_send_audios: true, can_send_documents: true,
  can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
  can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
  can_add_web_page_previews: true, can_change_info: false, can_invite_users: true,
  can_pin_messages: false
};
const LOCKED_PERMS = {
  can_send_messages: false, can_send_audios: false, can_send_documents: false,
  can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
  can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
  can_add_web_page_previews: false, can_change_info: false, can_invite_users: true,
  can_pin_messages: false
};

async function setGroupLocked(chatId, locked) {
  try {
    await bot.telegram.setChatPermissions(chatId, locked ? LOCKED_PERMS : FULL_PERMS);
    return true;
  } catch (err) { console.log('lock err:', err.message); return false; }
}

// ---------- Moderation ----------
const SCAM_PATTERNS = [
  /free\s+airdrop/i,
  /claim\s+now/i,
  /\bdm\s+me\b/i,
  /private\s+key/i,
  /seed\s+phrase/i,
  /send\s+\d+\s*(usdt|bnb|eth|sol)/i,
  /guaranteed\s+(profit|returns|gains)/i,
  /pump\s+signal/i,
  /double\s+your\s+(money|crypto|bnb|eth)/i
];

function isXLink(url) {
  return /^(https?:\/\/)?(www\.)?(x\.com|twitter\.com|t\.co)\//i.test(url);
}

function hasExternalTelegramLink(text) {
  if (!text) return false;
  return /(?:t\.me|telegram\.me)\/[A-Za-z0-9_+\-]+/i.test(text);
}

function hasPromoMention(text, entities) {
  if (!entities || !entities.length) return false;
  const hasMention = entities.some(e => e.type === 'mention');
  if (!hasMention) return false;
  return /\b(join|follow|sub(scribe)?|check\s+out|visit|trending|moonshot)\b/i.test(text);
}

function hasSuspiciousLink(text) {
  if (!text) return false;
  const urls = text.match(/https?:\/\/[^\s]+/gi) || [];
  for (const u of urls) {
    if (isXLink(u)) continue;
    if (/t\.me\/|telegram\.me\//i.test(u)) return true;
    if (/bit\.ly|tinyurl|cutt\.ly|grabify|iplogger|shorturl/i.test(u)) return true;
  }
  return false;
}

function hasMassMention(entities) {
  if (!entities) return false;
  let n = 0;
  for (const e of entities) if (e.type === 'mention' || e.type === 'text_mention') n++;
  return n >= 5;
}

function hasScamWord(text) {
  if (!text) return false;
  for (const p of SCAM_PATTERNS) if (p.test(text)) return true;
  return false;
}

const recentMsgs = {};
function isFlooding(userId) {
  const now = Date.now();
  if (!recentMsgs[userId]) recentMsgs[userId] = [];
  recentMsgs[userId].push(now);
  recentMsgs[userId] = recentMsgs[userId].filter(t => now - t < 8000);
  return recentMsgs[userId].length > 5;
}

async function handleOffense(ctx) {
  const userId = ctx.from.id;
  if (!state.offenses[userId]) state.offenses[userId] = { count: 0, lastAt: 0 };
  const rec = state.offenses[userId];
  if (Date.now() - rec.lastAt > 24 * 3600 * 1000) rec.count = 0;
  rec.count += 1;
  rec.lastAt = Date.now();
  scheduleSave();

  try { await ctx.deleteMessage(); } catch (e) {}

  if (rec.count === 1) return;

  if (rec.count === 2) {
    try {
      const name = '@' + (ctx.from.username || ctx.from.first_name || 'user');
      const msg = await ctx.reply('heads up ' + name + ', keep it about football');
      setTimeout(() => { ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}); }, 25000);
    } catch (e) {}
    return;
  }

  try {
    const until = Math.floor(Date.now() / 1000) + 2 * 3600;
    await ctx.telegram.restrictChatMember(ctx.chat.id, userId, {
      permissions: { can_send_messages: false },
      until_date: until
    });
    const name = '@' + (ctx.from.username || ctx.from.first_name || 'user');
    const msg = await ctx.reply('muted ' + name + ' for 2h');
    setTimeout(() => { ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}); }, 45000);
  } catch (e) { console.log('mute err:', e.message); }
}

// ---------- Message variants ----------
const GOAL_OPENERS = ['GOAL', 'goal', 'GOAL ' + E.ball, E.ball + E.ball, 'in!', E.fire, E.party];
const KICKOFF_LINES = [
  'we are underway',
  'kickoff. chat locked till the break',
  'here we go',
  'underway. talk at half-time',
  'ball is rolling'
];
const HT_LINES = [
  'half-time. chat is open',
  'break time',
  'first half done. talk among yourselves',
  'half-time whistle'
];
const FT_LINES = ['full time', 'final whistle', 'thats it', 'all over'];
const SH_LINES = ['second half. chat locked', 'back underway', 'they are back out'];
const PREGOAL_LINES = ['score change detected', 'goal incoming', 'looks like a goal'];

// ---------- Formatting ----------
function fmtMatchLine(m) {
  const h = m.homeTeam || {}, a = m.awayTeam || {};
  const t = new Date(m.utcDate);
  const time = String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0');
  return time + ' UTC  ' + teamFlag(h) + ' ' + teamName(h) + ' vs ' + teamName(a) + ' ' + teamFlag(a);
}

function fmtScoreObj(m) {
  if (!m || !m.score) return { home: 0, away: 0 };
  if (m.score.fullTime && m.score.fullTime.home != null) return m.score.fullTime;
  if (m.score.halfTime && m.score.halfTime.home != null) return m.score.halfTime;
  return { home: 0, away: 0 };
}

function fmtScore(m) {
  const s = fmtScoreObj(m);
  return (s.home == null ? 0 : s.home) + ' - ' + (s.away == null ? 0 : s.away);
}

function scoreLine(m) {
  return teamName(m.homeTeam) + ' ' + fmtScore(m) + ' ' + teamName(m.awayTeam);
}

function liveMinute(m) {
  // real minute based on kickoff time
  if (!m.utcDate) return null;
  const start = new Date(m.utcDate).getTime();
  const diff = Date.now() - start;
  if (diff < 0) return null;
  let mins = Math.floor(diff / 60000);
  if (mins > 120) mins = 120;
  return mins;
}

// ---------- Match flow ----------
async function postDailySchedule() {
  if (!state.groupId) return;
  const today = new Date().toISOString().slice(0, 10);
  if (state.schedulePostedFor === today) return;
  const matches = await fetchTodayMatches(true);
  state.schedulePostedFor = today;
  saveStateNow();
  if (!matches.length) return;
  const lines = ['today'];
  for (const m of matches) lines.push(fmtMatchLine(m));
  try { await bot.telegram.sendMessage(state.groupId, lines.join('\n')); } catch (e) {}
}

async function ensurePollForMatch(m) {
  if (!state.settings.polls) return;
  const id = String(m.id);
  if (!state.trackedMatches[id]) state.trackedMatches[id] = {};
  const rec = state.trackedMatches[id];
  if (rec.pollMsgId) return;
  const ko = new Date(m.utcDate).getTime();
  const diff = ko - Date.now();
  if (diff > 60 * 60 * 1000 || diff < 0) return;

  const h = m.homeTeam || {}, a = m.awayTeam || {};
  const q = teamName(h) + ' vs ' + teamName(a) + ' - who wins?';
  const opts = [teamFlag(h) + ' ' + teamName(h), teamFlag(a) + ' ' + teamName(a), 'Draw'];
  try {
    const sent = await bot.telegram.sendPoll(state.groupId, q, opts, {
      is_anonymous: false,
      allows_multiple_answers: false
    });
    rec.pollMsgId = sent.message_id;
    rec.pollId = sent.poll && sent.poll.id;
    saveStateNow();
  } catch (e) { console.log('poll err:', e.message); }
}

async function announceKickoff(m) {
  const id = String(m.id);
  const rec = state.trackedMatches[id];
  if (rec.kickoffSent) return;
  if (rec.pollMsgId) {
    try { await bot.telegram.stopPoll(state.groupId, rec.pollMsgId); } catch (e) {}
  }
  if (state.settings.autoLock) await setGroupLocked(state.groupId, true);
  const text = teamName(m.homeTeam) + ' vs ' + teamName(m.awayTeam) + '\n' + pick(KICKOFF_LINES);
  try { await bot.telegram.sendMessage(state.groupId, text); } catch (e) {}
  rec.kickoffSent = true;
  saveStateNow();
}

async function announceHalftime(m) {
  const id = String(m.id);
  const rec = state.trackedMatches[id];
  if (rec.halftimeSent) return;
  if (state.settings.autoLock) await setGroupLocked(state.groupId, false);
  const text = pick(HT_LINES) + '\n' + scoreLine(m);
  try { await bot.telegram.sendMessage(state.groupId, text); } catch (e) {}
  rec.halftimeSent = true;
  saveStateNow();
}

async function announceSecondHalf(m) {
  const id = String(m.id);
  const rec = state.trackedMatches[id];
  if (rec.secondHalfSent) return;
  if (state.settings.autoLock) await setGroupLocked(state.groupId, true);
  try { await bot.telegram.sendMessage(state.groupId, pick(SH_LINES)); } catch (e) {}
  rec.secondHalfSent = true;
  saveStateNow();
}

async function announceFulltime(m, detail) {
  const id = String(m.id);
  const rec = state.trackedMatches[id];
  if (rec.fulltimeSent) return;
  if (state.settings.autoLock) await setGroupLocked(state.groupId, false);
  const lines = [pick(FT_LINES), scoreLine(m)];
  const goals = (detail && detail.goals) || m.goals || [];
  if (goals.length) {
    const home = [], away = [];
    for (const g of goals) {
      const who = (g.scorer && g.scorer.name) || '?';
      const min = (g.minute != null ? g.minute + "'" : '');
      const line = who + (min ? ' ' + min : '');
      const teamId = g.team && g.team.id;
      if (teamId === (m.homeTeam && m.homeTeam.id)) home.push(line);
      else if (teamId === (m.awayTeam && m.awayTeam.id)) away.push(line);
    }
    if (home.length || away.length) {
      lines.push('');
      lines.push(teamName(m.homeTeam) + ': ' + (home.join(', ') || '-'));
      lines.push(teamName(m.awayTeam) + ': ' + (away.join(', ') || '-'));
    }
  }
  try { await bot.telegram.sendMessage(state.groupId, lines.join('\n')); } catch (e) {}
  rec.fulltimeSent = true;
  saveStateNow();
}

// Smart goal dedup with 90s correction window
async function checkGoals(m, detail) {
  if (!state.settings.goalAlerts) return;
  const id = String(m.id);
  const rec = state.trackedMatches[id];
  if (!rec.lastGoalIds) rec.lastGoalIds = [];
  if (!rec.goalAt) rec.goalAt = {}; // goal key -> when we posted
  const goals = (detail && detail.goals) || m.goals || [];
  const now = Date.now();

  for (const g of goals) {
    const scorerKey = (g.scorer && g.scorer.id) || (g.scorer && g.scorer.name) || '?';
    const teamKey = (g.team && g.team.id) || '?';
    // primary key: scorer + team (minute can change, scorer rarely)
    const primary = scorerKey + '|' + teamKey;
    // if we posted this exact scorer+team combo in last 90s, skip (minute correction)
    if (rec.goalAt[primary] && now - rec.goalAt[primary] < 90000) continue;
    // if it's a new scorer+team, check if minute also seen (handles same player scoring twice)
    const minuteKey = primary + '|' + (g.minute || '?');
    if (rec.lastGoalIds.indexOf(minuteKey) !== -1) continue;
    rec.lastGoalIds.push(minuteKey);
    rec.goalAt[primary] = now;

    const scorer = (g.scorer && g.scorer.name) || 'unknown';
    const min = (g.minute != null ? g.minute + "'" : (liveMinute(m) ? liveMinute(m) + "'" : "?'"));
    let scoringTeam = '';
    if (g.team && g.team.id === (m.homeTeam && m.homeTeam.id)) scoringTeam = teamName(m.homeTeam);
    else if (g.team && g.team.id === (m.awayTeam && m.awayTeam.id)) scoringTeam = teamName(m.awayTeam);

    const text = pick(GOAL_OPENERS) + '\n' + scoreLine(m) + '\n' +
      scorer + (scoringTeam ? ' (' + scoringTeam + ')' : '') + ' ' + min;
    try { await bot.telegram.sendMessage(state.groupId, text); } catch (e) {}
  }
  // clean old goalAt entries (>5min)
  for (const k in rec.goalAt) if (now - rec.goalAt[k] > 300000) delete rec.goalAt[k];
  saveStateNow();
}

// Score-change pre-detection: if score changed but goals array not updated yet
async function checkScoreChange(m, detail) {
  if (!state.settings.goalAlerts) return;
  const id = String(m.id);
  const rec = state.trackedMatches[id];
  const s = fmtScoreObj(detail || m);
  const newTotal = (s.home || 0) + (s.away || 0);
  if (rec.lastTotalScore == null) { rec.lastTotalScore = newTotal; return; }
  if (newTotal > rec.lastTotalScore) {
    // score went up but checkGoals will post the proper alert if scorer is known
    // only post a pre-goal alert if we haven't posted any goal in last 30s
    const recentGoal = rec.goalAt && Object.values(rec.goalAt).some(t => Date.now() - t < 30000);
    if (!recentGoal) {
      const min = liveMinute(m);
      const text = pick(PREGOAL_LINES) + '\n' + scoreLine(detail || m) + (min ? '\n' + min + "'" : '');
      try { await bot.telegram.sendMessage(state.groupId, text); } catch (e) {}
      // mark this as a "pre" alert so the full alert is suppressed if it arrives within 60s
      if (!rec.goalAt) rec.goalAt = {};
      rec.goalAt['__pre__' + newTotal] = Date.now();
    }
  }
  rec.lastTotalScore = newTotal;
}

// ---------- Adaptive polling tick ----------
let tickRunning = false;
let lastSchedulePoll = 0;
let lastFullPoll = 0;

async function runMatchUpdate(m) {
  const id = String(m.id);
  if (!state.trackedMatches[id]) state.trackedMatches[id] = {};
  const rec = state.trackedMatches[id];
  const status = m.status;

  if (status === 'SCHEDULED' || status === 'TIMED') {
    await ensurePollForMatch(m);
    return;
  }

  if (status === 'LIVE' || status === 'IN_PLAY') {
    if (!rec.kickoffSent) await announceKickoff(m);
    const detail = await fetchMatchDetail(m.id);
    if (detail) {
      await checkScoreChange(m, detail);
      await checkGoals(m, detail);
    }
    if (rec.halftimeSent && !rec.secondHalfSent) {
      const ko = new Date(m.utcDate).getTime();
      if (Date.now() - ko > 60 * 60 * 1000) await announceSecondHalf(m);
    }
    return;
  }

  if (status === 'PAUSED') {
    if (!rec.kickoffSent) await announceKickoff(m);
    if (!rec.halftimeSent) await announceHalftime(m);
    return;
  }

  if (status === 'FINISHED') {
    const detail = await fetchMatchDetail(m.id, true);
    if (detail) await checkGoals(m, detail);
    if (!rec.fulltimeSent) await announceFulltime(m, detail);
    return;
  }
}

async function autopilotTick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    if (!state.autopilot || !state.groupId) return;

    const now = Date.now();
    const hourUtc = new Date().getUTCHours();
    if (hourUtc >= 6 && hourUtc <= 22 && now - lastSchedulePoll > 60000) {
      await postDailySchedule();
      lastSchedulePoll = now;
    }

    // full schedule poll every 60s
    if (now - lastFullPoll > 60000) {
      lastFullPoll = now;
      const matches = await fetchTodayMatches();
      // run all match updates in parallel
      await Promise.all(matches.map(m => runMatchUpdate(m).catch(e => console.log('match upd err:', e.message))));
      // recount live matches for adaptive scheduler
      liveMatchCount = matches.filter(m => m.status === 'LIVE' || m.status === 'IN_PLAY' || m.status === 'PAUSED').length;
    } else if (liveMatchCount > 0) {
      // fast path: only refresh live matches
      const matches = (todayCache.data || []).filter(m => m.status === 'LIVE' || m.status === 'IN_PLAY' || m.status === 'PAUSED');
      if (matches.length) {
        // refresh status from cached today list (cheap)
        await Promise.all(matches.map(async m => {
          // force detail fetch for live matches
          const detail = await fetchMatchDetail(m.id, true);
          if (detail) {
            // merge live score back into m
            if (detail.score) m.score = detail.score;
            if (detail.status) m.status = detail.status;
            if (detail.goals) m.goals = detail.goals;
            await runMatchUpdate(m);
          }
        }));
      }
    }
  } catch (err) { console.log('tick err:', err.message); }
  finally { tickRunning = false; }
}

// Adaptive scheduler: faster when matches are live
function scheduleNext() {
  let delay;
  const now = Date.now();
  // check if any live match is in final 10 min of a half
  let nearGoalTime = false;
  for (const m of (todayCache.data || [])) {
    if (m.status !== 'LIVE' && m.status !== 'IN_PLAY') continue;
    const min = liveMinute(m);
    if (min != null && ((min >= 35 && min <= 50) || (min >= 80 && min <= 100))) {
      nearGoalTime = true; break;
    }
  }
  if (liveMatchCount === 0) delay = 60000;       // 60s idle
  else if (nearGoalTime) delay = 8000;            // 8s in hot zones
  else delay = 20000;                              // 20s normal live
  setTimeout(async () => { await autopilotTick(); scheduleNext(); }, delay);
}

// Pre-warm: 5 min before kickoff, start polling that match every 30s
async function preWarmCheck() {
  if (!state.autopilot || !state.groupId) return;
  const matches = todayCache.data || [];
  const now = Date.now();
  for (const m of matches) {
    if (m.status !== 'SCHEDULED' && m.status !== 'TIMED') continue;
    const ko = new Date(m.utcDate).getTime();
    const diff = ko - now;
    if (diff > 0 && diff < 5 * 60 * 1000) {
      // refresh this match aggressively
      await fetchMatchDetail(m.id, true);
    }
  }
}
setInterval(preWarmCheck, 30000);

// ---------- Moderation handler ----------
bot.on('message', async (ctx, next) => {
  try {
    if (!ctx.chat || (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')) return next();
    if (!state.groupId) { state.groupId = ctx.chat.id; saveStateNow(); }
    if (await isAdmin(ctx)) return next();

    const msg = ctx.message;
    const text = msg.text || msg.caption || '';
    const entities = msg.entities || msg.caption_entities || [];

    if (msg.forward_from_chat || msg.forward_from || msg.forward_sender_name) {
      if (state.settings.antiForward) { await handleOffense(ctx); return; }
    }
    if (isFlooding(ctx.from.id)) { await handleOffense(ctx); return; }
    if (text) {
      if (hasScamWord(text)) { await handleOffense(ctx); return; }
      if (hasMassMention(entities)) { await handleOffense(ctx); return; }
      if (state.settings.antiLink && hasExternalTelegramLink(text)) { await handleOffense(ctx); return; }
      if (state.settings.antiLink && hasSuspiciousLink(text)) { await handleOffense(ctx); return; }
      if (state.settings.antiExternalTag && hasPromoMention(text, entities)) { await handleOffense(ctx); return; }
    }
    return next();
  } catch (err) { console.log('mod err:', err.message); return next(); }
});

// ---------- Community commands ----------
bot.command('match', async (ctx) => {
  // current live match
  const matches = todayCache.data || await fetchTodayMatches();
  const live = matches.find(m => m.status === 'LIVE' || m.status === 'IN_PLAY' || m.status === 'PAUSED');
  if (!live) {
    return ctx.reply('no match live right now').then(s => {
      setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, s.message_id).catch(() => {}), 30000);
    }).catch(() => {});
  }
  const min = liveMinute(live);
  const text = scoreLine(live) + (min != null ? '\n' + min + "'" : '');
  try { await ctx.reply(text); } catch (e) {}
});

bot.command('today', async (ctx) => {
  const matches = todayCache.data || await fetchTodayMatches();
  if (!matches.length) {
    return ctx.reply('nothing on today').then(s => {
      setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, s.message_id).catch(() => {}), 30000);
    }).catch(() => {});
  }
  const lines = matches.map(fmtMatchLine);
  try { await ctx.reply(lines.join('\n')); } catch (e) {}
});

bot.command('next', async (ctx) => {
  const matches = todayCache.data || await fetchTodayMatches();
  const now = Date.now();
  const upcoming = matches.filter(m => new Date(m.utcDate).getTime() > now).sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
  if (!upcoming.length) {
    return ctx.reply('no match coming up today').then(s => {
      setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, s.message_id).catch(() => {}), 30000);
    }).catch(() => {});
  }
  try { await ctx.reply(fmtMatchLine(upcoming[0])); } catch (e) {}
});

// ---------- Admin commands ----------
bot.command('start', async (ctx) => {
  if (ctx.chat.type === 'private') {
    await ctx.reply('add me to your group, make me admin, then /setup');
  }
});

bot.command('help', async (ctx) => {
  if (await isAdmin(ctx)) {
    await ctx.reply([
      'admin:',
      '/setup /settings /lock /unlock',
      '/autopilot_on /autopilot_off',
      '',
      'community:',
      '/match /today /next'
    ].join('\n'));
  } else {
    await ctx.reply('/match /today /next');
  }
});

bot.command('setup', async (ctx) => {
  if (!await isAdmin(ctx)) return;
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return ctx.reply('run /setup inside the group');
  }
  state.groupId = ctx.chat.id;
  saveStateNow();
  const text = [
    'setup',
    '',
    'i need these admin rights: delete messages, restrict members, send messages, manage polls',
    '',
    'api keys go in env vars:',
    'FOOTBALL_DATA_KEYS = comma-separated keys from football-data.org',
    'API_FOOTBALL_KEYS = comma-separated keys from api-football.com (optional)',
    '',
    'pools loaded: fd=' + fdPool.size() + ', af=' + afPool.size(),
    '',
    'when ready tap below'
  ].join('\n');
  await ctx.reply(text, Markup.inlineKeyboard([
    [Markup.button.callback('turn on autopilot', 'AP_ON')],
    [Markup.button.callback('settings', 'OPEN_SETTINGS')]
  ]));
});

bot.command('autopilot_on', async (ctx) => {
  if (!await isAdmin(ctx)) return;
  state.autopilot = true; saveStateNow();
  await ctx.reply('autopilot on');
});

bot.command('autopilot_off', async (ctx) => {
  if (!await isAdmin(ctx)) return;
  state.autopilot = false; saveStateNow();
  await ctx.reply('autopilot off');
});

bot.command('lock', async (ctx) => {
  if (!await isAdmin(ctx)) return;
  const ok = await setGroupLocked(ctx.chat.id, true);
  if (!ok) await ctx.reply('cant lock, check admin rights');
});

bot.command('unlock', async (ctx) => {
  if (!await isAdmin(ctx)) return;
  const ok = await setGroupLocked(ctx.chat.id, false);
  if (!ok) await ctx.reply('cant unlock, check admin rights');
});

bot.command('settings', async (ctx) => {
  if (!await isAdmin(ctx)) return;
  await showSettings(ctx);
});

bot.command('status', async (ctx) => {
  if (!await isAdmin(ctx)) return;
  const text = [
    'autopilot: ' + (state.autopilot ? 'on' : 'off'),
    'group: ' + (state.groupId || 'not set'),
    'fd keys: ' + fdPool.size() + ' (' + fdPool.available() + ' ready)',
    'af keys: ' + afPool.size() + ' (' + afPool.available() + ' ready)',
    'live matches: ' + liveMatchCount,
    'tracked: ' + Object.keys(state.trackedMatches).length
  ].join('\n');
  await ctx.reply(text);
});

async function showSettings(ctx) {
  const s = state.settings;
  const on = v => v ? 'on' : 'off';
  const text = [
    'settings',
    '',
    'autopilot: ' + on(state.autopilot),
    'goal alerts: ' + on(s.goalAlerts),
    'polls: ' + on(s.polls),
    'auto lock: ' + on(s.autoLock),
    'anti link: ' + on(s.antiLink),
    'anti forward: ' + on(s.antiForward),
    'anti ext tag: ' + on(s.antiExternalTag),
    'allow x links: ' + on(s.allowXLinks)
  ].join('\n');
  const mk = (k, label, val) => Markup.button.callback((val ? '[on]' : '[off]') + ' ' + label, 'T_' + k);
  const kb = Markup.inlineKeyboard([
    [mk('autopilot', 'autopilot', state.autopilot)],
    [mk('goalAlerts', 'goals', s.goalAlerts), mk('polls', 'polls', s.polls)],
    [mk('autoLock', 'auto lock', s.autoLock), mk('antiLink', 'anti link', s.antiLink)],
    [mk('antiForward', 'anti forward', s.antiForward), mk('antiExternalTag', 'anti ext tag', s.antiExternalTag)],
    [mk('allowXLinks', 'allow x links', s.allowXLinks)]
  ]);
  try {
    if (ctx.callbackQuery) await ctx.editMessageText(text, kb);
    else await ctx.reply(text, kb);
  } catch (e) { try { await ctx.reply(text, kb); } catch (e2) {} }
}

bot.action('AP_ON', async (ctx) => {
  if (!await isAdmin(ctx)) return ctx.answerCbQuery('admins only');
  state.autopilot = true; saveStateNow();
  await ctx.answerCbQuery('on');
  try { await ctx.editMessageText('autopilot on'); } catch (e) {}
});

bot.action('OPEN_SETTINGS', async (ctx) => {
  if (!await isAdmin(ctx)) return ctx.answerCbQuery('admins only');
  await ctx.answerCbQuery();
  await showSettings(ctx);
});

bot.action(/^T_(.+)$/, async (ctx) => {
  if (!await isAdmin(ctx)) return ctx.answerCbQuery('admins only');
  const key = ctx.match[1];
  if (key === 'autopilot') state.autopilot = !state.autopilot;
  else if (state.settings.hasOwnProperty(key)) state.settings[key] = !state.settings[key];
  saveStateNow();
  await ctx.answerCbQuery('updated');
  await showSettings(ctx);
});

// ---------- Webhook + server ----------
app.get('/', (req, res) => res.send('ok'));
app.get('/health', (req, res) => res.json({
  ok: true,
  autopilot: state.autopilot,
  group: state.groupId,
  live: liveMatchCount,
  fd_keys: fdPool.size(),
  af_keys: afPool.size()
}));

const SECRET_PATH = '/tg/' + BOT_TOKEN.split(':')[1].slice(0, 16);
app.use(SECRET_PATH, (req, res) => bot.webhookCallback(SECRET_PATH)(req, res));

(async () => {
  await loadState();
  app.listen(PORT, async () => {
    console.log('listening on ' + PORT);
    console.log('fd keys: ' + fdPool.size() + ', af keys: ' + afPool.size());
    try {
      await bot.telegram.setWebhook(WEBHOOK_URL.replace(/\/$/, '') + SECRET_PATH);
      console.log('webhook set');
    } catch (err) { console.log('webhook err:', err.message); }
    scheduleNext();
  });
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
