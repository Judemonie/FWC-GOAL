// FWC Goal ($FWCG) - football alert + group manager
// Node.js + Telegraf v4 + Express webhook mode
// Primary API: football-data.org (10 req/min per key, no daily cap)
// Backup API: api-football.com (100 req/day per key, true live data)
// State: GitHub repo (milestone writes only)
// Pure ASCII source. Emojis as escapes in E object.

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fetch = require('node-fetch');
const { ethers } = require('ethers');

// ---------- Emoji table ----------
const E = {
  ball: '\u26BD',
  lock: '\u{1F512}',
  unlock: '\u{1F513}',
  fire: '\u{1F525}',
  star: '\u2B50',
  party: '\u{1F389}',
  trophy: '\u{1F3C6}',
  money: '\u{1F4B0}',
  check: '\u2705',
  cross: '\u274C',
  warn: '\u26A0\uFE0F',
  green: '\u{1F7E2}',
  pause: '\u23F8\uFE0F',
  play: '\u25B6\uFE0F',
  flag: '\u{1F3C1}',
  bell: '\u{1F514}',
  zap: '\u26A1',
  point: '\u{1F447}',
  yellow: '\u{1F7E8}',
  red: '\u{1F7E5}',
  swap: '\u{1F504}',
  clipboard: '\u{1F4CB}',
  vote: '\u{1F5F3}\uFE0F'
};

// ---------- Env ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID || '0', 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = parseInt(process.env.PORT || '3000', 10);

// Football league code: WC, PL, CL, PD, SA, BL1, FL1, EC, ELC
const LEAGUE = (process.env.LEAGUE || 'WC').toUpperCase();

// API keys: comma-separated lists
const FD_KEYS = (process.env.FOOTBALL_DATA_KEYS || process.env.FOOTBALL_API_KEY || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const AF_KEYS = (process.env.API_FOOTBALL_KEYS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const STATE_FILE = process.env.STATE_FILE || 'state.json';

// ---------- Rewards system env ----------
const FWC_CONTRACT = (process.env.FWC_CONTRACT || '').toLowerCase();
const FWC_DECIMALS = parseInt(process.env.FWC_DECIMALS || '18', 10);
const REWARD_WALLET_KEY = process.env.REWARD_WALLET_KEY || '';
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

// Holder gate: minimum FWC token amount required to predict (price-independent)
const MIN_HOLD_FWC = parseFloat(process.env.MIN_HOLD_FWC || '2026000');

// Bag scaling for share weighting in pool split (sqrt formula, capped)
const BAG_MULTIPLIER_CAP = parseFloat(process.env.BAG_MULTIPLIER_CAP || '5');

// Per-pool DAILY budgets (USD). Split equally across selected matches.
const EASY_POOL_USD = parseFloat(process.env.EASY_POOL_USD || '10');
const MEDIUM_POOL_USD = parseFloat(process.env.MEDIUM_POOL_USD || '15');
const HARD_POOL_USD = parseFloat(process.env.HARD_POOL_USD || '25');

// Per-win hard cap (USD) - belt and suspenders, no single winner exceeds this
const PER_WIN_CAP_USD = parseFloat(process.env.PER_WIN_CAP_USD || '25');

// Voting/selection
const VOTE_HOUR_UTC = parseInt(process.env.VOTE_HOUR_UTC || '5', 10);  // also when daily schedule posts
const VOTE_CLOSE_HOURS_BEFORE = parseFloat(process.env.VOTE_CLOSE_HOURS_BEFORE || '2');

// Auto-repost active prompts after this many non-bot group messages
const REPOST_THRESHOLD = parseInt(process.env.REPOST_THRESHOLD || '8', 10);
// Max times we will repost a single prompt (avoid infinite spam)
const REPOST_MAX = parseInt(process.env.REPOST_MAX || '5', 10);


if (!BOT_TOKEN) { console.error('Missing BOT_TOKEN'); process.exit(1); }
if (!WEBHOOK_URL) { console.error('Missing WEBHOOK_URL'); process.exit(1); }

const bot = new Telegraf(BOT_TOKEN);
const app = express();

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
    allowXLinks: true,
    predictions: true
  },
  trackedMatches: {},
  offenses: {},
  schedulePostedFor: '',
  predictions: {},
  predictionMsgs: {},
  userWallets: {},
  pendingRewards: [],
  approvedRewards: [],
  dailyTotals: {},
  instructionsMsgId: null,
  // Voting / match selection
  dailyVote: {},        // dateStr -> { matchIds:[], votes: { userId -> matchId }, msgId, postedAt, closed, selected: [matchIds] }
  rollover: { easy: 0, medium: 0, hard: 0 }, // unwon pool money carries to next day
  // batch reminder tracking
  lastBatchReminderMsgId: null,
  lastBatchReminderAt: 0,
  // track loud-pinned daily messages so they can be unpinned next day
  dailyPins: []
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
    const loaded = JSON.parse(content);
    // deep-merge settings so any newly added defaults stay enabled
    const defaultSettings = state.settings;
    const loadedSettings = loaded.settings || {};
    loaded.settings = Object.assign({}, defaultSettings, loadedSettings);
    // ensure newer top-level keys exist with defaults
    if (!loaded.rollover) loaded.rollover = { easy: 0, medium: 0, hard: 0 };
    if (!loaded.dailyVote) loaded.dailyVote = {};
    if (!loaded.predictions) loaded.predictions = {};
    if (!loaded.predictionMsgs) loaded.predictionMsgs = {};
    if (!loaded.userWallets) loaded.userWallets = {};
    if (!loaded.pendingRewards) loaded.pendingRewards = [];
    if (!loaded.approvedRewards) loaded.approvedRewards = [];
    if (!loaded.dailyTotals) loaded.dailyTotals = {};
    state = Object.assign(state, loaded);
    console.log('State loaded. predictions setting:', state.settings.predictions);
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
      // also write a rotating backup once every ~30 min
      maybeBackup();
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

// Rotating backups (5 slots)
let lastBackupAt = 0;
let backupShaMap = {};
async function maybeBackup() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  const now = Date.now();
  // backup at most every 30 minutes
  if (now - lastBackupAt < 30 * 60 * 1000) return;
  lastBackupAt = now;
  const slot = (Math.floor(now / (30 * 60 * 1000)) % 5) + 1;
  const filename = 'state-backup-' + slot + '.json';
  try {
    // get current sha if exists
    const headers = {
      'Authorization': 'token ' + GITHUB_TOKEN,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'fwcg-bot'
    };
    if (!backupShaMap[slot]) {
      const head = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + filename, { headers });
      if (head.ok) {
        const d = await head.json();
        backupShaMap[slot] = d.sha;
      }
    }
    const body = {
      message: 'backup slot ' + slot,
      content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64')
    };
    if (backupShaMap[slot]) body.sha = backupShaMap[slot];
    const r = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + filename, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(body)
    });
    if (r.ok) {
      const d = await r.json();
      if (d.content && d.content.sha) backupShaMap[slot] = d.content.sha;
    } else if (r.status === 409 || r.status === 422) {
      backupShaMap[slot] = null;
    }
  } catch (err) { console.log('backup err:', err.message); }
}

// debounced save (for non-critical updates like offense counts)
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveStateNow(); }, 10000);
}

// ---------- Helpers ----------
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Format FWC amount with thousand separators (full length, not M shorthand)
function fmtFwc(amount) {
  const n = Math.round(Number(amount) || 0);
  return n.toLocaleString('en-US');
}

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

// FIFA country name -> ISO-2 code mapping for World Cup 2026 + common international teams.
// Source: FIFA member associations + ISO 3166-1 alpha-2.
const COUNTRY_TO_ISO2 = {
  'argentina': 'AR', 'australia': 'AU', 'austria': 'AT', 'belgium': 'BE',
  'brazil': 'BR', 'canada': 'CA', 'chile': 'CL', 'colombia': 'CO',
  'costa rica': 'CR', 'croatia': 'HR', 'czech republic': 'CZ', 'czechia': 'CZ',
  'denmark': 'DK', 'ecuador': 'EC', 'egypt': 'EG', 'england': 'GB',
  'france': 'FR', 'germany': 'DE', 'ghana': 'GH', 'iran': 'IR',
  'italy': 'IT', 'ivory coast': 'CI', 'cote d ivoire': 'CI',
  'japan': 'JP', 'jordan': 'JO', 'mexico': 'MX', 'morocco': 'MA',
  'netherlands': 'NL', 'new zealand': 'NZ', 'nigeria': 'NG',
  'north macedonia': 'MK', 'norway': 'NO', 'panama': 'PA',
  'paraguay': 'PY', 'peru': 'PE', 'poland': 'PL', 'portugal': 'PT',
  'qatar': 'QA', 'republic of ireland': 'IE', 'ireland': 'IE',
  'romania': 'RO', 'saudi arabia': 'SA', 'scotland': 'GB',
  'senegal': 'SN', 'serbia': 'RS', 'slovakia': 'SK', 'slovenia': 'SI',
  'south africa': 'ZA', 'south korea': 'KR', 'korea republic': 'KR',
  'spain': 'ES', 'sweden': 'SE', 'switzerland': 'CH', 'tunisia': 'TN',
  'turkey': 'TR', 'turkiye': 'TR', 'uae': 'AE', 'united arab emirates': 'AE',
  'united states': 'US', 'usa': 'US', 'uruguay': 'UY', 'uzbekistan': 'UZ',
  'venezuela': 'VE', 'wales': 'GB', 'algeria': 'DZ', 'cameroon': 'CM',
  'cape verde': 'CV', 'cabo verde': 'CV', 'curacao': 'CW',
  'dominican republic': 'DO', 'el salvador': 'SV', 'guatemala': 'GT',
  'haiti': 'HT', 'honduras': 'HN', 'jamaica': 'JM', 'bolivia': 'BO',
  'finland': 'FI', 'greece': 'GR', 'hungary': 'HU', 'iceland': 'IS',
  'israel': 'IL', 'kazakhstan': 'KZ', 'kosovo': 'XK', 'luxembourg': 'LU',
  'malta': 'MT', 'moldova': 'MD', 'montenegro': 'ME', 'russia': 'RU',
  'ukraine': 'UA', 'iraq': 'IQ', 'lebanon': 'LB', 'oman': 'OM',
  'palestine': 'PS', 'syria': 'SY', 'yemen': 'YE',
  'china': 'CN', 'china pr': 'CN', 'india': 'IN', 'indonesia': 'ID',
  'malaysia': 'MY', 'philippines': 'PH', 'singapore': 'SG',
  'thailand': 'TH', 'vietnam': 'VN', 'angola': 'AO', 'burkina faso': 'BF',
  'congo': 'CG', 'dr congo': 'CD', 'gabon': 'GA', 'guinea': 'GN',
  'kenya': 'KE', 'libya': 'LY', 'mali': 'ML', 'mauritania': 'MR',
  'mozambique': 'MZ', 'sudan': 'SD', 'tanzania': 'TZ', 'togo': 'TG',
  'uganda': 'UG', 'zambia': 'ZM', 'zimbabwe': 'ZW', 'bahrain': 'BH',
  'kuwait': 'KW', 'azerbaijan': 'AZ', 'belarus': 'BY', 'bulgaria': 'BG',
  'estonia': 'EE', 'georgia': 'GE', 'latvia': 'LV', 'lithuania': 'LT',
  'albania': 'AL', 'armenia': 'AM', 'bosnia and herzegovina': 'BA',
  'cyprus': 'CY'
};

function countryToFlag(countryName) {
  if (!countryName) return '';
  const key = String(countryName).toLowerCase().trim();
  const iso = COUNTRY_TO_ISO2[key];
  return iso ? flagFor(iso) : '';
}

function teamName(team) {
  if (!team) return '?';
  return team.shortName || team.name || team.tla || '?';
}

// Leagues where teams are national teams (use country flags)
// All other leagues are club tournaments where flags would be misleading
const NATIONAL_LEAGUES = ['WC', 'EC', 'COPA', 'AFC', 'AFCON'];

function isNationalLeague() {
  return NATIONAL_LEAGUES.indexOf((LEAGUE || '').toUpperCase()) !== -1;
}

function teamFlag(team) {
  if (!team) return '';
  // Only show flags for national-team tournaments (World Cup, Euros, etc.)
  // For club tournaments, both teams are typically same-country so flags add noise.
  if (!isNationalLeague()) return '';
  // Prefer explicit country (set by AF data shaper), fall back to team name.
  const country = (team.country) || (team.area && team.area.name) || team.name;
  return countryToFlag(country);
}

// flag + name with conditional space (no leading/trailing space when flag is empty)
function teamLabel(team) {
  const flag = teamFlag(team);
  const name = teamName(team);
  return flag ? flag + ' ' + name : name;
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
  const data = await fdGet('/competitions/' + LEAGUE + '/matches?dateFrom=' + today + '&dateTo=' + today);
  const matches = (data && data.matches) || [];
  todayCache.data = matches;
  todayCache.at = now;
  return matches;
}

// Track live state of each match to pick the right API
function isLikelyLive(cached) {
  if (!cached || !cached.data) return false;
  const s = cached.data.status;
  return s === 'LIVE' || s === 'IN_PLAY' || s === 'PAUSED';
}

// Convert api-football response to football-data-shaped match object
function shapeAfMatchToFd(af, baseMatch) {
  if (!af) return null;
  const status = (af.fixture && af.fixture.status && af.fixture.status.short) || '';
  let mappedStatus = 'TIMED';
  if (status === '1H' || status === '2H' || status === 'ET' || status === 'BT' || status === 'P' || status === 'LIVE') mappedStatus = 'IN_PLAY';
  else if (status === 'HT') mappedStatus = 'PAUSED';
  else if (status === 'FT' || status === 'AET' || status === 'PEN') mappedStatus = 'FINISHED';
  else if (status === 'NS' || status === 'TBD') mappedStatus = 'TIMED';
  else if (status === 'CANC' || status === 'ABD' || status === 'PST' || status === 'AWD' || status === 'WO') mappedStatus = 'CANCELLED';

  const homeName = af.teams && af.teams.home && af.teams.home.name;
  const awayName = af.teams && af.teams.away && af.teams.away.name;
  const homeGoals = af.goals && af.goals.home != null ? af.goals.home : 0;
  const awayGoals = af.goals && af.goals.away != null ? af.goals.away : 0;
  const htHome = af.score && af.score.halftime && af.score.halftime.home;
  const htAway = af.score && af.score.halftime && af.score.halftime.away;
  const ftHome = af.score && af.score.fulltime && af.score.fulltime.home;
  const ftAway = af.score && af.score.fulltime && af.score.fulltime.away;
  const minute = af.fixture && af.fixture.status && af.fixture.status.elapsed;

  // build goals array from events
  // Critical: must determine if scoring team is home or away on the AF fixture,
  // then attach the FD-style team object so downstream code matches correctly.
  const goals = [];
  const afHomeNorm = canonicalTeamName(homeName || '');
  const afAwayNorm = canonicalTeamName(awayName || '');
  if (af.events) {
    for (const ev of af.events) {
      if (ev.type === 'Goal') {
        const evTeamNorm = canonicalTeamName((ev.team && ev.team.name) || '');
        let attachedTeam = null;
        if (evTeamNorm === afHomeNorm) {
          attachedTeam = (baseMatch && baseMatch.homeTeam) || { id: af.teams && af.teams.home && af.teams.home.id, name: homeName };
        } else if (evTeamNorm === afAwayNorm) {
          attachedTeam = (baseMatch && baseMatch.awayTeam) || { id: af.teams && af.teams.away && af.teams.away.id, name: awayName };
        } else {
          // fallback: raw AF team
          attachedTeam = { name: ev.team && ev.team.name, id: ev.team && ev.team.id };
        }
        goals.push({
          minute: ev.time && ev.time.elapsed,
          extraMinute: ev.time && ev.time.extra,
          scorer: { name: ev.player && ev.player.name },
          team: attachedTeam
        });
      }
    }
  }

  return {
    id: (baseMatch && baseMatch.id) || (af.fixture && af.fixture.id),
    status: mappedStatus,
    utcDate: (baseMatch && baseMatch.utcDate) || (af.fixture && af.fixture.date),
    homeTeam: (baseMatch && baseMatch.homeTeam) || { name: homeName, tla: homeName && homeName.slice(0, 3).toUpperCase() },
    awayTeam: (baseMatch && baseMatch.awayTeam) || { name: awayName, tla: awayName && awayName.slice(0, 3).toUpperCase() },
    score: {
      fullTime: { home: ftHome != null ? ftHome : homeGoals, away: ftAway != null ? ftAway : awayGoals },
      halfTime: { home: htHome, away: htAway }
    },
    goals,
    minute,
    apiSource: 'af',
    _afEvents: (af.events || []) // expose raw events for card/sub detection
  };
}

// ---------- API-Football live cache (PRIMARY live source) ----------
// Fetches /fixtures?live=all and serves all match lookups from it.
// AF detects live status FIRST, before football-data even knows the match is live.
//
// Rate budget at 15s TTL: 240 calls/hour, ~2,880/day for 12hr live window.
// One call serves ALL live matches simultaneously. Safe with PRO tier (7,500/day).
// Safety guard: if key pool runs low, TTL widens to 60s to preserve budget.
let afLiveCache = { data: [], at: 0 };
const AF_LIVE_TTL_MS_DEFAULT = 15000;
const AF_LIVE_TTL_MS_LOW_BUDGET = 60000;

function currentAfLiveTtl() {
  if (!AF_KEYS.length) return AF_LIVE_TTL_MS_DEFAULT;
  const ready = afPool.available();
  // if less than 20% of keys are ready (e.g. 1 of 10), back off
  if (ready < Math.max(2, Math.floor(AF_KEYS.length * 0.2))) {
    return AF_LIVE_TTL_MS_LOW_BUDGET;
  }
  return AF_LIVE_TTL_MS_DEFAULT;
}

async function fetchAfLiveMatches(force) {
  if (!AF_KEYS.length) return [];
  const now = Date.now();
  const ttl = currentAfLiveTtl();
  if (!force && afLiveCache.data.length && now - afLiveCache.at < ttl) {
    return afLiveCache.data;
  }
  if (!force && now - afLiveCache.at < ttl) return afLiveCache.data;
  try {
    const data = await afGet('/fixtures?live=all');
    if (data && data.response) {
      afLiveCache = { data: data.response, at: now };
      return data.response;
    }
  } catch (e) { console.log('af live fetch err:', e.message); }
  return afLiveCache.data; // serve stale if call failed
}

function normalizeTeamName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Team name aliases: maps from variations to a canonical form.
// When matching, we expand both APIs' names through this table.
const TEAM_ALIASES = {
  // Manchester
  manunited: 'manchesterunited', manutd: 'manchesterunited', manchesterutd: 'manchesterunited',
  manchesterunitedfc: 'manchesterunited',
  mancity: 'manchestercity', manchestercityfc: 'manchestercity',
  // Tottenham
  spurs: 'tottenham', tottenhamhotspur: 'tottenham', tottenhamhotspurfc: 'tottenham',
  // PSG / Paris
  psg: 'parissaintgermain', parissg: 'parissaintgermain',
  // Inter
  inter: 'internazionale', intermilan: 'internazionale',
  // Bayern
  bayern: 'bayernmunich', fcbayernmunchen: 'bayernmunich', fcbayern: 'bayernmunich',
  // Real Madrid / Barca
  realmadridcf: 'realmadrid',
  fcbarcelona: 'barcelona', barca: 'barcelona',
  // Atletico
  atleticomadrid: 'atletico', clubatleticodemadrid: 'atletico', atleti: 'atletico',
  // Wolves
  wolverhampton: 'wolves', wolverhamptonwanderers: 'wolves',
  // Newcastle
  newcastleunited: 'newcastle', newcastleunitedfc: 'newcastle', newcastleutd: 'newcastle',
  // Brighton
  brightonandhovealbion: 'brighton', brightonhovealbion: 'brighton',
  // Aston Villa
  astonvillafc: 'astonvilla',
  // West Ham
  westhamunited: 'westham', westhamunitedfc: 'westham',
  // Liverpool / Chelsea / Arsenal
  liverpoolfc: 'liverpool',
  chelseafc: 'chelsea',
  arsenalfc: 'arsenal',
  // Common suffixes
  cf: '', fc: ''
};

function canonicalTeamName(s) {
  const n = normalizeTeamName(s);
  if (!n) return '';
  // Direct alias hit
  if (TEAM_ALIASES[n]) return TEAM_ALIASES[n];
  // Strip trailing fc/cf and try again
  const stripped = n.replace(/(fc|cf)$/, '');
  if (stripped !== n) {
    if (TEAM_ALIASES[stripped]) return TEAM_ALIASES[stripped];
    return stripped;
  }
  return n;
}

// Find AF fixture by home+away team names with alias support
function findAfMatchByTeams(afMatches, homeName, awayName) {
  if (!afMatches || !afMatches.length) return null;
  const hN = canonicalTeamName(homeName);
  const aN = canonicalTeamName(awayName);
  if (!hN || !aN) return null;
  for (const f of afMatches) {
    const fh = canonicalTeamName(f.teams && f.teams.home && f.teams.home.name);
    const fa = canonicalTeamName(f.teams && f.teams.away && f.teams.away.name);
    // exact canonical match, OR bidirectional substring on canonical names
    const homeMatch = fh === hN || fh.includes(hN) || hN.includes(fh);
    const awayMatch = fa === aN || fa.includes(aN) || aN.includes(fa);
    if (homeMatch && awayMatch) return f;
  }
  return null;
}

async function fetchMatchDetail(matchId, force) {
  const now = Date.now();
  const cached = matchCache[matchId];
  const cacheAge = isLikelyLive(cached) ? 8000 : 15000;
  if (!force && cached && now - cached.at < cacheAge) return cached.data;

  // STEP 1: try AF live feed first. We look up the match by team names,
  // not by ID, because FD ids != AF ids. If AF has it, AF is the source of truth.
  // We need the team names - get them from the cached match or from FD's schedule cache.
  let baseMatch = cached && cached.data;
  if (!baseMatch && todayCache.data) {
    baseMatch = todayCache.data.find(m => String(m.id) === String(matchId));
  }
  if (baseMatch && AF_KEYS.length) {
    const homeName = baseMatch.homeTeam && baseMatch.homeTeam.name;
    const awayName = baseMatch.awayTeam && baseMatch.awayTeam.name;
    const afLive = await fetchAfLiveMatches();
    const afMatch = findAfMatchByTeams(afLive, homeName, awayName);
    if (afMatch) {
      const shaped = shapeAfMatchToFd(afMatch, baseMatch);
      if (shaped) {
        matchCache[matchId] = { data: shaped, at: now };
        return shaped;
      }
    }
  }

  // STEP 2: fall back to football-data.org (handles pre-match + finished states + AF gaps)
  const data = await fdGet('/matches/' + matchId);
  if (!data) return cached ? cached.data : null;
  const match = data.match || data;
  match.apiSource = 'fd';
  matchCache[matchId] = { data: match, at: now };
  return match;
}

// kept for compatibility - now uses the cached live feed
async function afVerifyLiveScore(homeName, awayName) {
  const afLive = await fetchAfLiveMatches();
  const f = findAfMatchByTeams(afLive, homeName, awayName);
  if (!f) return null;
  return {
    homeScore: f.goals && f.goals.home,
    awayScore: f.goals && f.goals.away,
    minute: f.fixture && f.fixture.status && f.fixture.status.elapsed,
    events: f.events || null
  };
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

// ---------- Send + Pin helpers ----------
async function sendHTML(chatId, text, opts) {
  const o = Object.assign({ parse_mode: 'HTML', disable_web_page_preview: true }, opts || {});
  // Clean up leftover double-spaces and orphan spaces from removed flags.
  // Only collapses spaces inside lines; preserves line breaks.
  let cleaned = String(text)
    .split('\n')
    .map(line => line.replace(/ {2,}/g, ' ').replace(/\s+$/g, ''))
    .join('\n');
  return bot.telegram.sendMessage(chatId, cleaned, o);
}

async function pinMessage(chatId, messageId, silent) {
  try {
    await bot.telegram.pinChatMessage(chatId, messageId, { disable_notification: !!silent });
    return true;
  } catch (err) { console.log('pin err:', err.message); return false; }
}

// Track a pin so we can unpin it later when the day changes
function trackDailyPin(messageId) {
  if (!messageId) return;
  if (!state.dailyPins) state.dailyPins = [];
  state.dailyPins.push(messageId);
  // keep only last 20 pins tracked to avoid unbounded growth
  if (state.dailyPins.length > 20) state.dailyPins = state.dailyPins.slice(-20);
}

// Unpin everything we tracked from previous days. Called at start of each new day.
async function unpinPreviousDayPins() {
  if (!state.groupId || !state.dailyPins || !state.dailyPins.length) return;
  const toUnpin = [...state.dailyPins];
  state.dailyPins = [];
  saveStateNow();
  for (const msgId of toUnpin) {
    try { await bot.telegram.unpinChatMessage(state.groupId, msgId); } catch (e) {}
  }
}

// ---------- BSC: provider rotation, holder check, send ----------
const BSC_RPCS = [
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc-dataseed3.binance.org',
  'https://bsc-dataseed4.binance.org'
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function symbol() view returns (string)'
];

let bscRpcIdx = 0;
function getProvider() {
  bscRpcIdx = (bscRpcIdx + 1) % BSC_RPCS.length;
  return new ethers.providers.JsonRpcProvider(BSC_RPCS[bscRpcIdx]);
}

function isValidAddress(addr) {
  if (!addr || typeof addr !== 'string') return false;
  try { return ethers.utils.isAddress(addr); } catch (e) { return false; }
}

async function checkFwcHolder(wallet) {
  if (!FWC_CONTRACT || !isValidAddress(wallet)) return { isHolder: false, balance: '0', balanceFwc: 0, balanceUsd: 0 };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const provider = getProvider();
      const contract = new ethers.Contract(FWC_CONTRACT, ERC20_ABI, provider);
      const bal = await contract.balanceOf(wallet);
      const balanceFwc = parseFloat(ethers.utils.formatUnits(bal, FWC_DECIMALS));
      const price = await getFwcPriceUSD();
      const balanceUsd = balanceFwc * price;
      return {
        isHolder: bal.gt(0),
        balance: ethers.utils.formatUnits(bal, FWC_DECIMALS),
        balanceFwc,
        balanceUsd,
        meetsGate: balanceFwc >= MIN_HOLD_FWC
      };
    } catch (err) {
      console.log('holder check attempt ' + attempt + ' err:', err.message);
    }
  }
  return { isHolder: false, balance: '0', balanceFwc: 0, balanceUsd: 0, meetsGate: false };
}

// Calculate bag-size multiplier (sqrt formula, capped) - based on FWC amount ratio
function bagMultiplier(balanceFwc) {
  if (balanceFwc < MIN_HOLD_FWC) return 0;
  const m = Math.sqrt(balanceFwc / MIN_HOLD_FWC);
  return Math.min(BAG_MULTIPLIER_CAP, Math.max(1, m));
}

let rewardWallet = null;
function getRewardWallet() {
  if (rewardWallet) return rewardWallet;
  if (!REWARD_WALLET_KEY) return null;
  try {
    const provider = new ethers.providers.JsonRpcProvider(BSC_RPCS[0]);
    rewardWallet = new ethers.Wallet(REWARD_WALLET_KEY, provider);
    return rewardWallet;
  } catch (err) {
    console.log('reward wallet init err:', err.message);
    return null;
  }
}

async function sendFwcReward(toAddress, amountFwc) {
  if (DRY_RUN) {
    return { dryRun: true, txHash: '0xDRY_RUN_' + Date.now(), to: toAddress, amount: amountFwc };
  }
  const wallet = getRewardWallet();
  if (!wallet) throw new Error('reward wallet not configured');
  if (!isValidAddress(toAddress)) throw new Error('invalid recipient address');
  const contract = new ethers.Contract(FWC_CONTRACT, ERC20_ABI, wallet);
  const amountWei = ethers.utils.parseUnits(String(amountFwc), FWC_DECIMALS);
  // hard safety: refuse to send if amount is huge
  const cap = ethers.utils.parseUnits('10000000', FWC_DECIMALS); // 10M FWC absolute max
  if (amountWei.gt(cap)) throw new Error('amount exceeds safety cap');
  const tx = await contract.transfer(toAddress, amountWei, {
    gasLimit: 80000,
    gasPrice: ethers.utils.parseUnits('0.1', 'gwei')
  });
  await tx.wait(1);
  return { dryRun: false, txHash: tx.hash, to: toAddress, amount: amountFwc };
}

async function getRewardWalletBalance() {
  const wallet = getRewardWallet();
  if (!wallet || !FWC_CONTRACT) return { fwc: '0', bnb: '0' };
  try {
    const contract = new ethers.Contract(FWC_CONTRACT, ERC20_ABI, wallet.provider);
    const [fwcBal, bnbBal] = await Promise.all([
      contract.balanceOf(wallet.address),
      wallet.provider.getBalance(wallet.address)
    ]);
    return {
      fwc: ethers.utils.formatUnits(fwcBal, FWC_DECIMALS),
      bnb: ethers.utils.formatEther(bnbBal),
      address: wallet.address
    };
  } catch (err) {
    console.log('balance err:', err.message);
    return { fwc: '?', bnb: '?' };
  }
}

// ---------- Price lookup (DexScreener) ----------
const priceCache = { price: 0, at: 0, mc: 0 };
async function getFwcPriceUSD() {
  const now = Date.now();
  if (priceCache.price > 0 && now - priceCache.at < 5 * 60 * 1000) return priceCache.price;
  if (!FWC_CONTRACT) return 0;
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + FWC_CONTRACT);
    if (!r.ok) return priceCache.price || 0;
    const data = await r.json();
    if (!data.pairs || !data.pairs.length) return priceCache.price || 0;
    // pick the most liquid BSC pair
    const bscPairs = data.pairs.filter(p => p.chainId === 'bsc');
    bscPairs.sort((a, b) => (b.liquidity && b.liquidity.usd || 0) - (a.liquidity && a.liquidity.usd || 0));
    const top = bscPairs[0] || data.pairs[0];
    const price = parseFloat(top.priceUsd) || 0;
    priceCache.price = price;
    priceCache.at = now;
    priceCache.mc = parseFloat(top.fdv) || parseFloat(top.marketCap) || 0;
    return price;
  } catch (err) {
    console.log('price err:', err.message);
    return priceCache.price || 0;
  }
}

function usdToFwc(usd, price) {
  if (!price || price <= 0) return 0;
  const fwc = usd / price;
  // round to 2 decimals for readability
  return Math.floor(fwc * 100) / 100;
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
const GOAL_OPENERS = ['GOAL ' + E.ball, 'GOOOAL ' + E.ball + E.ball, 'GOAL!! ' + E.fire, 'IN! ' + E.ball, 'GOAL ' + E.ball + E.fire];
const KICKOFF_LINES = [
  'and we are off',
  'ball is rolling',
  'here we go',
  'underway'
];
// Half-time prompts: short, community-focused, rotating
const HT_LINES = [
  "how's everyone seeing this one? " + E.point + "\n15 mins until we are back",
  "second-half prediction? drop it " + E.point + "\nback in 15 mins",
  "what's the vibe? drop a take " + E.point + "\n15 mins to second half",
  "thoughts so far? talk to me " + E.point + "\nsecond half in 15"
];
const FT_LINES = ["that's the final whistle", "match over", "thats it. all done", "full time, see you next match"];
const SH_LINES = ['back underway', 'second half. here we go', 'they are back out', 'second half rolling'];

// ---------- Formatting ----------
function fmtMatchLine(m) {
  const h = m.homeTeam || {}, a = m.awayTeam || {};
  const t = new Date(m.utcDate);
  const time = String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0');
  const hf = teamFlag(h), af = teamFlag(a);
  const hSide = hf ? hf + ' ' + esc(teamName(h)) : esc(teamName(h));
  const aSide = af ? esc(teamName(a)) + ' ' + af : esc(teamName(a));
  return '<b>' + time + ' UTC</b>  ' + hSide + ' vs ' + aSide;
}

function fmtScoreObj(m, detail) {
  // Prefer the detail score if present (this has live data from AF)
  if (detail && detail.score && detail.score.fullTime && detail.score.fullTime.home != null) return detail.score.fullTime;
  if (detail && detail.score && detail.score.halfTime && detail.score.halfTime.home != null) return detail.score.halfTime;
  if (!m || !m.score) return { home: 0, away: 0 };
  if (m.score.fullTime && m.score.fullTime.home != null) return m.score.fullTime;
  if (m.score.halfTime && m.score.halfTime.home != null) return m.score.halfTime;
  return { home: 0, away: 0 };
}

function fmtScore(m, detail) {
  const s = fmtScoreObj(m, detail);
  return (s.home == null ? 0 : s.home) + ' - ' + (s.away == null ? 0 : s.away);
}

function scoreLine(m, detail) {
  const hf = teamFlag(m.homeTeam), af = teamFlag(m.awayTeam);
  const hn = (teamName(m.homeTeam) || '?').toUpperCase();
  const an = (teamName(m.awayTeam) || '?').toUpperCase();
  return (hf ? hf + ' ' : '') + '<b>' + esc(hn) + '</b>  <b>' + fmtScore(m, detail) + '</b>  <b>' + esc(an) + '</b>' + (af ? ' ' + af : '');
}

function scoreLinePlain(m, detail) {
  return teamName(m.homeTeam) + ' ' + fmtScore(m, detail) + ' ' + teamName(m.awayTeam);
}

// Live minute: ALWAYS prefer API-reported minute. Fall back to wall-clock only if absent.
// Cap at 90' to avoid extra-time inflation in user-facing display.
function liveMinute(m) {
  if (m && m.minute != null && m.minute > 0) {
    return Math.min(90, m.minute);
  }
  // wall-clock fallback only when API doesn't give us a minute
  if (!m || !m.utcDate) return null;
  const start = new Date(m.utcDate).getTime();
  const diff = Date.now() - start;
  if (diff < 0) return null;
  let mins = Math.floor(diff / 60000);
  if (mins > 90) mins = 90;
  return mins;
}

// ---------- Match flow ----------
// ---------- Daily voting system ----------
function getDateKey() { return new Date().toISOString().slice(0, 10); }

function howManyToSelect(matchCount) {
  if (matchCount <= 3) return 1;
  return 2;
}

async function postDailyVote() {
  if (!state.groupId) return;
  if (!state.settings.predictions) return;
  const dateKey = getDateKey();
  if (state.dailyVote[dateKey]) return; // already posted today

  // CRITICAL: set sentinel placeholder synchronously BEFORE any await,
  // so concurrent calls (from rapid ticks or restart races) bail at the check above.
  state.dailyVote[dateKey] = { matchIds: [], votes: {}, closed: false, selected: [], _placeholder: true };
  await saveStateNow();

  const matches = await fetchTodayMatches(true);
  // only future matches
  const now = Date.now();
  const upcoming = matches.filter(m => new Date(m.utcDate).getTime() > now + 30 * 60 * 1000); // 30min buffer
  if (!upcoming.length) {
    state.dailyVote[dateKey] = { matchIds: [], votes: {}, closed: true, selected: [], noMatches: true };
    saveStateNow();
    return;
  }

  // new day starting - unpin yesterday's pinned daily messages to keep pin list tidy
  if (state.instructionsPostedOn !== dateKey) {
    await unpinPreviousDayPins().catch(() => {});
  }

  // post instructions FRESH each day so they're always above today's vote/prediction.
  // Guard with both date AND msgId to avoid double-post on restart races.
  if (state.instructionsPostedOn !== dateKey) {
    // mark BEFORE the await so any racing call bails
    state.instructionsPostedOn = dateKey;
    await saveStateNow();
    await postInstructions(state.groupId).catch(() => {});
    await saveStateNow();
  }

  // SHORTCUT: only one match today - skip the vote, auto-select it
  if (upcoming.length === 1) {
    const onlyMatch = upcoming[0];
    state.dailyVote[dateKey] = {
      matchIds: [String(onlyMatch.id)],
      votes: {},
      msgId: null,
      postedAt: Date.now(),
      closed: true,
      selected: [String(onlyMatch.id)],
      selectCount: 1,
      perMatchPool: EASY_POOL_USD + MEDIUM_POOL_USD + HARD_POOL_USD,
      autoSelected: true
    };
    saveStateNow();
    const hf = teamFlag(onlyMatch.homeTeam), af = teamFlag(onlyMatch.awayTeam);
    const hn = teamName(onlyMatch.homeTeam).toUpperCase();
    const an = teamName(onlyMatch.awayTeam).toUpperCase();
    const ko = new Date(onlyMatch.utcDate);
    const tStr = String(ko.getUTCHours()).padStart(2, '0') + ':' + String(ko.getUTCMinutes()).padStart(2, '0');
    const announce = E.trophy + ' <b>TODAY\'S MATCH</b>\n\n' +
      'only one match scheduled. no vote needed.\n\n' +
      (hf ? hf + ' ' : '') + '<b>' + esc(hn) + '</b> vs <b>' + esc(an) + '</b>' + (af ? ' ' + af : '') + '\n' +
      tStr + ' UTC kickoff\n\n' +
      '<b>PREDICTION POOLS</b> open 1 hour before kickoff\n' +
      'pools: $' + EASY_POOL_USD + ' easy / $' + MEDIUM_POOL_USD + ' medium / $' + HARD_POOL_USD + ' hard';
    try {
      const sent = await sendHTML(state.groupId, announce);
      await pinMessage(state.groupId, sent.message_id, false); // loud pin (vote)
      trackDailyPin(sent.message_id);
    } catch (e) {
      console.log('auto-select post err:', e.message);
      // roll back so next tick can retry
      delete state.dailyVote[dateKey];
      saveStateNow();
    }
    return;
  }

  const selectCount = howManyToSelect(upcoming.length);
  const totalPool = EASY_POOL_USD + MEDIUM_POOL_USD + HARD_POOL_USD;
  const perMatchPool = totalPool / selectCount;

  const lines = [
    E.vote + ' <b>TODAY\'S VOTE</b>',
    '',
    upcoming.length + ' matches scheduled. pick ' + (selectCount === 1 ? 'ONE' : 'TWO favorites') + ' for predictions.',
    '',
    '<b>DAILY POOL</b>: $' + totalPool.toFixed(2) + ' total',
    '($' + EASY_POOL_USD + ' easy / $' + MEDIUM_POOL_USD + ' medium / $' + HARD_POOL_USD + ' hard' + (selectCount === 2 ? ', split across selected matches' : '') + ')',
    '',
    'vote closes 2h before earliest kickoff.'
  ].filter(Boolean).join('\n');

  // build buttons per match - capped to 8 to keep keyboard sane
  const buttonMatches = upcoming.slice(0, 8);
  const rows = buttonMatches.map(m => {
    const hf = teamFlag(m.homeTeam), af = teamFlag(m.awayTeam);
    const t = new Date(m.utcDate);
    const tStr = String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0');
    const hn = (teamName(m.homeTeam) || '').toUpperCase();
    const an = (teamName(m.awayTeam) || '').toUpperCase();
    const label = tStr + ' ' + (hf ? hf + ' ' : '') + hn + ' vs ' + an + (af ? ' ' + af : '') + ' (0)';
    return [Markup.button.callback(label.slice(0, 60), 'VOTE_' + m.id)];
  });

  try {
    const sent = await sendHTML(state.groupId, lines, Markup.inlineKeyboard(rows));
    state.dailyVote[dateKey] = {
      matchIds: buttonMatches.map(m => String(m.id)),
      votes: {},
      msgId: sent.message_id,
      postedAt: Date.now(),
      closed: false,
      selected: [],
      selectCount,
      perMatchPool
    };
    // pin the vote post (loud) so everyone knows to vote
    await pinMessage(state.groupId, sent.message_id, false);
    trackDailyPin(sent.message_id);
    saveStateNow();
  } catch (e) {
    console.log('vote post err:', e.message);
    // roll back so next tick can retry
    delete state.dailyVote[dateKey];
    saveStateNow();
  }
}

// re-render vote with updated tallies
async function refreshVoteKeyboard() {
  const dateKey = getDateKey();
  const v = state.dailyVote[dateKey];
  if (!v || v.closed || !v.msgId) return;
  // count votes per match
  const tally = {};
  for (const uid in v.votes) {
    const mid = v.votes[uid];
    tally[mid] = (tally[mid] || 0) + 1;
  }
  const matches = todayCache.data || [];
  const rows = v.matchIds.map(mid => {
    const m = matches.find(x => String(x.id) === mid);
    if (!m) return null;
    const hf = teamFlag(m.homeTeam), af = teamFlag(m.awayTeam);
    const t = new Date(m.utcDate);
    const tStr = String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0');
    const count = tally[mid] || 0;
    const hn = (teamName(m.homeTeam) || '').toUpperCase();
    const an = (teamName(m.awayTeam) || '').toUpperCase();
    const label = tStr + ' ' + (hf ? hf + ' ' : '') + hn + ' vs ' + an + (af ? ' ' + af : '') + ' (' + count + ')';
    return [Markup.button.callback(label.slice(0, 60), 'VOTE_' + mid)];
  }).filter(Boolean);

  // ALSO refresh the body text so total vote count is current.
  // Rebuild same text that postDailyVote / maybeRepostVote use so it's consistent.
  const totalVotes = Object.keys(v.votes).length;
  const totalPool = EASY_POOL_USD + MEDIUM_POOL_USD + HARD_POOL_USD;
  const matchCount = v.matchIds.length;
  const isRepost = (v.repostCount || 0) > 0;
  const text = E.vote + ' <b>TODAY\'S VOTE</b>\n\n' +
    matchCount + ' matches scheduled. pick ' + (v.selectCount === 1 ? 'ONE' : 'TWO favorites') + ' for predictions.\n\n' +
    '<b>DAILY POOL</b>: $' + totalPool.toFixed(2) + ' total\n' +
    '($' + EASY_POOL_USD + ' easy / $' + MEDIUM_POOL_USD + ' medium / $' + HARD_POOL_USD + ' hard' + (v.selectCount === 2 ? ', split across selected matches' : '') + ')\n\n' +
    totalVotes + ' vote' + (totalVotes === 1 ? '' : 's') + ' so far' + (isRepost ? ' <i>(reposted to stay visible)</i>' : '') + '\n' +
    'vote closes 2h before earliest kickoff.';

  try {
    await bot.telegram.editMessageText(state.groupId, v.msgId, undefined, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows.map(r => r.map(b => b)) }
    });
  } catch (e) {
    // if editMessageText fails (e.g. text identical), fall back to keyboard-only edit
    try {
      await bot.telegram.editMessageReplyMarkup(state.groupId, v.msgId, undefined, { inline_keyboard: rows.map(r => r.map(b => b)) });
    } catch (e2) {}
  }
}

// Vote button handler
bot.action(/^VOTE_(.+)$/, async (ctx) => {
  const matchId = ctx.match[1];
  const userId = ctx.from.id;
  const dateKey = getDateKey();
  const v = state.dailyVote[dateKey];
  if (!v || v.closed) return ctx.answerCbQuery('voting closed');
  if (v.matchIds.indexOf(matchId) === -1) return ctx.answerCbQuery('match not in vote');

  // require holder to vote (so randoms don't game it)
  const u = state.userWallets[userId];
  if (!u || !u.wallet) {
    return ctx.answerCbQuery('DM the bot /start to register your wallet first', { show_alert: true });
  }
  const h = await checkFwcHolder(u.wallet);
  if (!h.meetsGate) {
    return ctx.answerCbQuery('need ' + fmtFwc(MIN_HOLD_FWC) + ' FWC to vote (you have ' + fmtFwc(h.balanceFwc) + ')', { show_alert: true });
  }

  const prev = v.votes[userId];
  v.votes[userId] = matchId;
  saveStateNow();
  await ctx.answerCbQuery(prev ? 'vote changed' : 'voted!');
  // throttled refresh
  if (!refreshVoteKeyboard._timer) {
    refreshVoteKeyboard._timer = setTimeout(() => {
      refreshVoteKeyboard._timer = null;
      refreshVoteKeyboard();
    }, 5000);
  }
});

// ---------- Auto-repost active prompts (Raid-bot style) ----------
// Delete old vote/prediction message and repost it as the latest, so it stays visible above buy bots.
// State (votes, predictions) is preserved - we only rebuild the visual message.

async function maybeRepostVote() {
  if (groupMsgCounterSinceVote < REPOST_THRESHOLD) return;
  const dateKey = getDateKey();
  const v = state.dailyVote[dateKey];
  if (!v || v.closed || !v.msgId) return;
  if (!state.settings.predictions) return;
  v.repostCount = v.repostCount || 0;
  if (v.repostCount >= REPOST_MAX) return;

  // delete old
  try { await bot.telegram.deleteMessage(state.groupId, v.msgId); } catch (e) {}

  // rebuild buttons with current tallies
  const matches = todayCache.data || [];
  const tally = {};
  for (const uid in v.votes) { const mid = v.votes[uid]; tally[mid] = (tally[mid] || 0) + 1; }
  const rows = v.matchIds.map(mid => {
    const m = matches.find(x => String(x.id) === mid);
    if (!m) return null;
    const hf = teamFlag(m.homeTeam), af = teamFlag(m.awayTeam);
    const t = new Date(m.utcDate);
    const tStr = String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0');
    const count = tally[mid] || 0;
    const hn = (teamName(m.homeTeam) || '').toUpperCase();
    const an = (teamName(m.awayTeam) || '').toUpperCase();
    const label = tStr + ' ' + (hf ? hf + ' ' : '') + hn + ' vs ' + an + (af ? ' ' + af : '') + ' (' + count + ')';
    return [Markup.button.callback(label.slice(0, 60), 'VOTE_' + mid)];
  }).filter(Boolean);

  const totalVotes = Object.keys(v.votes).length;
  const text = E.vote + ' <b>TODAY\'S VOTE</b>\n\n' +
    'pick the match you want predictions on.\n' +
    totalVotes + ' vote' + (totalVotes === 1 ? '' : 's') + ' so far <i>(reposted to stay visible)</i>';
  try {
    const sent = await sendHTML(state.groupId, text, Markup.inlineKeyboard(rows));
    v.msgId = sent.message_id;
    v.repostCount += 1;
    await pinMessage(state.groupId, sent.message_id, true); // silent repin
    groupMsgCounterSinceVote = 0;
    saveStateNow();
  } catch (e) { console.log('repost vote err:', e.message); }
}

async function maybeRepostPrediction() {
  if (groupMsgCounterSincePrediction < REPOST_THRESHOLD) return;
  const dateKey = getDateKey();
  const v = state.dailyVote[dateKey];
  if (!v || !v.closed || !v.selected.length) return;
  if (!state.settings.predictions) return;
  // only repost for matches that haven't kicked off yet
  const matches = todayCache.data || [];
  for (const mid of v.selected) {
    const m = matches.find(x => String(x.id) === mid);
    if (!m) continue;
    if (m.status !== 'SCHEDULED' && m.status !== 'TIMED') continue; // already started
    const pm = state.predictionMsgs[mid];
    if (!pm || !pm.quickMsgId) continue; // pools not opened yet
    pm.repostCount = pm.repostCount || 0;
    if (pm.repostCount >= REPOST_MAX) continue;

    // delete all three old pool messages
    for (const k of ['quickMsgId', 'proMsgId', 'exactMsgId']) {
      if (pm[k]) {
        try { await bot.telegram.deleteMessage(state.groupId, pm[k]); } catch (e) {}
        pm[k] = null;
      }
    }
    pm.reminderMsgId = null;
    pm.repostCount += 1;
    saveStateNow();

    // ensurePredictionForMatch will recreate them
    await ensurePredictionForMatch(m);
    groupMsgCounterSincePrediction = 0;
    return; // one repost per tick
  }
}

// Close vote 2 hours before earliest match
async function maybeCloseVote() {
  const dateKey = getDateKey();
  const v = state.dailyVote[dateKey];
  if (!v || v.closed) return;
  const matches = todayCache.data || [];
  const todayUpcoming = matches.filter(m => v.matchIds.indexOf(String(m.id)) !== -1);
  if (!todayUpcoming.length) return;
  const earliestKo = Math.min(...todayUpcoming.map(m => new Date(m.utcDate).getTime()));
  const closeAt = earliestKo - VOTE_CLOSE_HOURS_BEFORE * 3600 * 1000;
  if (Date.now() < closeAt) return;

  // tally
  const tally = {};
  for (const uid in v.votes) {
    const mid = v.votes[uid];
    tally[mid] = (tally[mid] || 0) + 1;
  }
  // sort matches by votes desc, then by earliest kickoff
  const ranked = [...v.matchIds].sort((a, b) => {
    const tb = (tally[b] || 0) - (tally[a] || 0);
    if (tb !== 0) return tb;
    const ma = matches.find(x => String(x.id) === a);
    const mb = matches.find(x => String(x.id) === b);
    return new Date(ma.utcDate) - new Date(mb.utcDate);
  });
  const selected = ranked.slice(0, v.selectCount);
  v.selected = selected;
  v.closed = true;
  saveStateNow();

  // close keyboard, then DELETE the vote message entirely - it gets replaced by VOTE ENDED below
  if (v.msgId) {
    try { await bot.telegram.deleteMessage(state.groupId, v.msgId); } catch (e) {}
  }

  // announce: VOTE ENDED with selected matches
  const selectedMatches = selected.map(mid => matches.find(x => String(x.id) === mid)).filter(Boolean);
  const lines = [E.check + ' <b>VOTE ENDED</b>', ''];
  lines.push('<b>PREDICTING TODAY:</b>');
  for (const m of selectedMatches) {
    const hf = teamFlag(m.homeTeam), af = teamFlag(m.awayTeam);
    const hn = (teamName(m.homeTeam) || '?').toUpperCase();
    const an = (teamName(m.awayTeam) || '?').toUpperCase();
    const t = new Date(m.utcDate);
    const tStr = String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0');
    lines.push((hf ? hf + ' ' : '') + '<b>' + esc(hn) + '</b> vs <b>' + esc(an) + '</b>' + (af ? ' ' + af : '') + ' \u2014 ' + tStr + ' UTC');
  }
  lines.push('');
  lines.push('<b>POOL PER MATCH:</b> $' + (v.perMatchPool).toFixed(2));
  lines.push('  easy: $' + (EASY_POOL_USD / v.selectCount).toFixed(2));
  lines.push('  medium: $' + (MEDIUM_POOL_USD / v.selectCount).toFixed(2));
  lines.push('  hard: $' + (HARD_POOL_USD / v.selectCount).toFixed(2));
  lines.push('');
  lines.push('<i>prediction pools open 1h before each kickoff.</i>');
  try {
    const sent = await sendHTML(state.groupId, lines.join('\n'));
    await pinMessage(state.groupId, sent.message_id, true); // silent pin (replaces the vote pin)
    trackDailyPin(sent.message_id);
  } catch (e) {}
}

// only allow ensurePredictionForMatch for SELECTED matches
function isMatchSelectedForPredictions(matchId) {
  const dateKey = getDateKey();
  const v = state.dailyVote[dateKey];
  if (!v || !v.closed) return false;
  return v.selected.indexOf(String(matchId)) !== -1;
}

async function ensurePollForMatch(m) {
  // legacy poll path - kept for back-compat but no longer called when predictions enabled
  if (!state.settings.polls) return;
  if (state.settings.predictions) return ensurePredictionForMatch(m);
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
    const sent = await bot.telegram.sendPoll(state.groupId, q, opts, { is_anonymous: false, allows_multiple_answers: false });
    rec.pollMsgId = sent.message_id;
    rec.pollId = sent.poll && sent.poll.id;
    saveStateNow();
  } catch (e) { console.log('poll err:', e.message); }
}

async function ensurePredictionForMatch(m) {
  if (!state.settings.predictions) return;
  // only run for community-selected matches
  if (!isMatchSelectedForPredictions(m.id)) return;
  const id = String(m.id);
  if (!state.trackedMatches[id]) state.trackedMatches[id] = {};
  if (!state.predictionMsgs[id]) state.predictionMsgs[id] = {};
  if (state.predictionMsgs[id].quickMsgId && state.predictionMsgs[id].proMsgId && state.predictionMsgs[id].exactMsgId) return;
  const ko = new Date(m.utcDate).getTime();
  const diff = ko - Date.now();
  if (diff > 60 * 60 * 1000 || diff < 0) return;

  const h = m.homeTeam || {}, a = m.awayTeam || {};
  const hf = teamFlag(h), af = teamFlag(a);
  const hn = teamName(h), an = teamName(a);
  const hnUp = hn.toUpperCase(), anUp = an.toUpperCase();
  if (!state.predictions[id]) state.predictions[id] = { quick: {}, pro: {}, exact: {} };

  // Pinned-instructions reminder (small)
  if (!state.predictionMsgs[id].reminderMsgId) {
    try {
      const reminder = await sendHTML(state.groupId,
        '<i>new match incoming. need at least ' + fmtFwc(MIN_HOLD_FWC) + ' FWC to predict. see pinned instructions.</i>');
      state.predictionMsgs[id].reminderMsgId = reminder.message_id;
    } catch (e) {}
  }

  // Quick pool
  if (!state.predictionMsgs[id].quickMsgId) {
    const splitNote = (state.dailyVote[getDateKey()] && state.dailyVote[getDateKey()].selectCount > 1) ? ' (split with other match)' : '';
    const quickText = E.trophy + ' <b>EASY: WINNER PICK</b>\n\n' +
      (hf ? hf + ' ' : '') + '<b>' + esc(hnUp) + '</b> vs <b>' + esc(anUp) + '</b>' + (af ? ' ' + af : '') + '\n' +
      'pick who wins\n' +
      'pool: $' + (EASY_POOL_USD / (state.dailyVote[getDateKey()] ? state.dailyVote[getDateKey()].selectCount : 1)).toFixed(2) + splitNote + '\n\n' +
      '<i>split among correct predictors by bag size</i>';
    const quickKb = Markup.inlineKeyboard([
      [Markup.button.callback((hf ? hf + ' ' : '') + hnUp, 'PR_' + id + '_q_H')],
      [Markup.button.callback('DRAW', 'PR_' + id + '_q_D')],
      [Markup.button.callback(anUp + (af ? ' ' + af : ''), 'PR_' + id + '_q_A')]
    ]);
    try {
      const sent = await sendHTML(state.groupId, quickText, quickKb);
      state.predictionMsgs[id].quickMsgId = sent.message_id;
    } catch (e) { console.log('quick pred err:', e.message); }
  }

  // Pro pool
  if (!state.predictionMsgs[id].proMsgId) {
    const splitCount = state.dailyVote[getDateKey()] ? state.dailyVote[getDateKey()].selectCount : 1;
    const proText = E.fire + ' <b>MEDIUM: WINNER + GOALS</b>\n\n' +
      (hf ? hf + ' ' : '') + '<b>' + esc(hnUp) + '</b> vs <b>' + esc(anUp) + '</b>' + (af ? ' ' + af : '') + '\n' +
      'winner + over/under 2.5 goals\n' +
      'pool: $' + (MEDIUM_POOL_USD / splitCount).toFixed(2);
    const homeAbbr3 = ((m.homeTeam && m.homeTeam.tla) || hn || 'HOM').slice(0, 3).toUpperCase();
    const awayAbbr3 = ((m.awayTeam && m.awayTeam.tla) || an || 'AWY').slice(0, 3).toUpperCase();
    const proKb = Markup.inlineKeyboard([
      [Markup.button.callback(homeAbbr3 + '/O', 'PR_' + id + '_p_HO'),
       Markup.button.callback(homeAbbr3 + '/U', 'PR_' + id + '_p_HU')],
      [Markup.button.callback('DRW/O', 'PR_' + id + '_p_DO'),
       Markup.button.callback('DRW/U', 'PR_' + id + '_p_DU')],
      [Markup.button.callback(awayAbbr3 + '/O', 'PR_' + id + '_p_AO'),
       Markup.button.callback(awayAbbr3 + '/U', 'PR_' + id + '_p_AU')]
    ]);
    try {
      const sent = await sendHTML(state.groupId, proText, proKb);
      state.predictionMsgs[id].proMsgId = sent.message_id;
    } catch (e) { console.log('pro pred err:', e.message); }
  }

  // Hard pool: HT/FT prediction, 3x3 grid
  if (!state.predictionMsgs[id].exactMsgId) {
    const splitCount = state.dailyVote[getDateKey()] ? state.dailyVote[getDateKey()].selectCount : 1;
    const homeAbbr = ((m.homeTeam && m.homeTeam.tla) || hn || 'HOM').slice(0, 3).toUpperCase();
    const awayAbbr = ((m.awayTeam && m.awayTeam.tla) || an || 'AWY').slice(0, 3).toUpperCase();
    const exactText = E.trophy + E.fire + ' <b>HARD: HALF/FULL TIME</b>\n\n' +
      (hf ? hf + ' ' : '') + '<b>' + esc(hnUp) + '</b> vs <b>' + esc(anUp) + '</b>' + (af ? ' ' + af : '') + '\n' +
      'pick who leads at half-time AND who wins at full-time\n' +
      'pool: $' + (HARD_POOL_USD / splitCount).toFixed(2) + '\n\n' +
      '<i>buttons: half-time result / full-time result</i>\n' +
      '<i>' + homeAbbr + ' = ' + esc(hn) + ', ' + awayAbbr + ' = ' + esc(an) + ', DRW = draw</i>';
    const lbl = (which) => {
      if (which === 'H') return homeAbbr;
      if (which === 'A') return awayAbbr;
      return 'DRW';
    };
    const btn = (ht, ft) => Markup.button.callback(lbl(ht) + '/' + lbl(ft), 'PR_' + id + '_e_' + ht + ft);
    const rows = [
      [btn('H', 'H'), btn('H', 'D'), btn('H', 'A')],
      [btn('D', 'H'), btn('D', 'D'), btn('D', 'A')],
      [btn('A', 'H'), btn('A', 'D'), btn('A', 'A')]
    ];
    try {
      const sent = await sendHTML(state.groupId, exactText, Markup.inlineKeyboard(rows));
      state.predictionMsgs[id].exactMsgId = sent.message_id;
      // pin the last prediction pool message (loud) - this is your call to predict
      await pinMessage(state.groupId, sent.message_id, false);
      trackDailyPin(sent.message_id);
    } catch (e) { console.log('exact pred err:', e.message); }
  }
  saveStateNow();
}

// Check if a wallet has been used by ANY other tg account in ANY pool for this match
function isWalletAlreadyUsedForMatch(matchId, wallet, excludeUserId) {
  if (!wallet) return false;
  const w = wallet.toLowerCase();
  const pools = state.predictions[matchId];
  if (!pools) return false;
  for (const poolName of ['quick', 'pro', 'exact']) {
    const entries = pools[poolName] || {};
    for (const uid in entries) {
      if (excludeUserId && String(uid) === String(excludeUserId)) continue;
      if ((entries[uid].wallet || '').toLowerCase() === w) return true;
    }
  }
  return false;
}

// Check if any other tg account is using this wallet globally (for first-time submission)
function findWalletOwner(wallet, excludeUserId) {
  if (!wallet) return null;
  const w = wallet.toLowerCase();
  for (const uid in state.userWallets) {
    if (excludeUserId && String(uid) === String(excludeUserId)) continue;
    if ((state.userWallets[uid].wallet || '').toLowerCase() === w) {
      return { userId: uid, username: state.userWallets[uid].username };
    }
  }
  return null;
}

// ---------- Prediction callback handlers ----------
// PR_<matchId>_<pool>_<choice>  where pool = q (quick) | p (pro) | e (exact)
bot.action(/^PR_(.+)_(q|p|e)_(.+)$/, async (ctx) => {
  const matchId = ctx.match[1];
  const poolCode = ctx.match[2];
  const pool = poolCode === 'q' ? 'quick' : poolCode === 'p' ? 'pro' : 'exact';
  const choice = ctx.match[3];
  const userId = ctx.from.id;

  // verify match exists and not started
  const matches = todayCache.data || [];
  const match = matches.find(m => String(m.id) === matchId);
  if (!match) return ctx.answerCbQuery('match not found');
  const status = match.status;
  if (status !== 'SCHEDULED' && status !== 'TIMED') {
    return ctx.answerCbQuery('predictions closed - match started');
  }

  if (!state.predictions[matchId]) state.predictions[matchId] = { quick: {}, pro: {}, exact: {} };

  // one pool only per match
  const otherPools = ['quick', 'pro', 'exact'].filter(p => p !== pool);
  for (const op of otherPools) {
    if (state.predictions[matchId][op] && state.predictions[matchId][op][userId]) {
      return ctx.answerCbQuery('already entered ' + op + ' pool for this match', { show_alert: true });
    }
  }
  if (state.predictions[matchId][pool][userId] && state.predictions[matchId][pool][userId].locked) {
    return ctx.answerCbQuery('your pick is locked');
  }

  // check if user has wallet on file - if yes, check holder gate now
  const u = state.userWallets[userId] = state.userWallets[userId] || {};
  u.username = ctx.from.username || ctx.from.first_name || ('user' + userId);

  if (u.wallet) {
    // sybil check: no other tg account in any pool used this wallet for this match
    if (isWalletAlreadyUsedForMatch(matchId, u.wallet, userId)) {
      return ctx.answerCbQuery('this wallet already entered this match', { show_alert: true });
    }
    // verify still holds enough
    const h = await checkFwcHolder(u.wallet);
    if (!h.meetsGate) {
      try {
        await bot.telegram.sendMessage(userId,
          E.warn + ' your wallet holds <b>' + fmtFwc(h.balanceFwc) + ' FWC</b>.\n' +
          'minimum required: <b>' + fmtFwc(MIN_HOLD_FWC) + ' FWC</b>\n\n' +
          'buy more FWC and try again, or send a different wallet by tapping a prediction again.',
          { parse_mode: 'HTML' });
      } catch (e) {}
      return ctx.answerCbQuery('not enough FWC. check your DM', { show_alert: true });
    }
    // lock the pick directly
    state.predictions[matchId][pool][userId] = {
      choice,
      wallet: u.wallet,
      username: u.username,
      ts: Date.now(),
      locked: true,
      entryBalanceFwc: h.balanceFwc
    };
    saveStateNow();
    try {
      await bot.telegram.sendMessage(userId,
        E.check + ' locked: <b>' + esc(decodeChoice(choice, pool, match)) + '</b>\n' +
        'bag at entry: ' + fmtFwc(h.balanceFwc) + ' FWC (' + bagMultiplier(h.balanceFwc).toFixed(2) + 'x reward)\n' +
        'good luck.',
        { parse_mode: 'HTML' });
    } catch (e) {}
    return ctx.answerCbQuery('locked! check your DM');
  }

  // no wallet yet - request via DM
  u.awaitingFor = { matchId, pool, choice };
  saveStateNow();
  try {
    await bot.telegram.sendMessage(userId,
      'got your pick: <b>' + esc(decodeChoice(choice, pool, match)) + '</b>\n\n' +
      'send your BSC wallet address (0x...) here to lock it in.\n\n' +
      '<i>you must hold at least ' + fmtFwc(MIN_HOLD_FWC) + ' FWC in that wallet.</i>',
      { parse_mode: 'HTML' });
    return ctx.answerCbQuery('check your DM to send wallet');
  } catch (e) {
    return ctx.answerCbQuery('open a DM with me first: tap my name then start, then come back', { show_alert: true });
  }
});

function decodeChoice(code, pool, match) {
  const hn = teamName(match.homeTeam), an = teamName(match.awayTeam);
  if (pool === 'quick') {
    if (code === 'H') return hn;
    if (code === 'A') return an;
    if (code === 'D') return 'Draw';
    return code;
  }
  if (pool === 'pro') {
    const winner = code[0] === 'H' ? hn : code[0] === 'A' ? an : 'Draw';
    const oudir = code[1] === 'O' ? 'Over 2.5' : 'Under 2.5';
    return winner + ' + ' + oudir;
  }
  // HARD pool: HT/FT (e.g. 'HH', 'DA', 'AH')
  if (pool === 'exact' && code && code.length === 2) {
    const lbl = (c) => c === 'H' ? hn : c === 'A' ? an : 'Draw';
    return lbl(code[0]) + ' at HT / ' + lbl(code[1]) + ' at FT';
  }
  return 'unknown';
}

// ---------- DM wallet handler ----------
bot.on('text', async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  if (ctx.message.text.startsWith('/')) return next();
  const userId = ctx.from.id;
  const u = state.userWallets[userId];
  if (!u || !u.awaitingFor) return next();
  const wallet = ctx.message.text.trim();
  if (!isValidAddress(wallet)) {
    return ctx.reply('that does not look like a valid BSC address. paste something like 0xAbC123...');
  }

  // check holder gate
  await ctx.reply('checking your bag...');
  const h = await checkFwcHolder(wallet);
  if (!h.meetsGate) {
    return ctx.reply(
      E.warn + ' this wallet holds <b>' + fmtFwc(h.balanceFwc) + ' FWC</b>.\n' +
      'minimum to predict: <b>' + fmtFwc(MIN_HOLD_FWC) + ' FWC</b>\n\n' +
      'either buy more FWC and try again, or send a wallet that holds enough.',
      { parse_mode: 'HTML' });
  }

  // sybil check: is this wallet already linked to another tg account?
  const existingOwner = findWalletOwner(wallet, userId);
  if (existingOwner) {
    return ctx.reply(
      E.warn + ' this wallet is already linked to another account.\n' +
      'one wallet per telegram account. please use a different wallet.');
  }

  // Branch on flow type
  const awaitingFor = u.awaitingFor;
  u.wallet = wallet.toLowerCase();
  u.lastSet = Date.now();
  u.awaitingFor = null;

  if (awaitingFor.type === 'register') {
    // standalone registration via /start or /wallet
    saveStateNow();
    const mult = bagMultiplier(h.balanceFwc);
    return sendHTML(ctx.chat.id,
      E.check + ' <b>wallet locked in</b>\n\n' +
      'wallet: <code>' + esc(wallet) + '</code>\n' +
      'bag: ' + fmtFwc(h.balanceFwc) + ' FWC (' + mult.toFixed(2) + 'x reward multiplier)\n\n' +
      'you can now vote and predict in the group.\n' +
      '<i>use /wallet here anytime to change it.</i>');
  }

  // prediction-tied flow (legacy path - user tapped a button without prior /start)
  const { matchId, pool, choice } = awaitingFor;
  if (isWalletAlreadyUsedForMatch(matchId, wallet, userId)) {
    return ctx.reply(
      E.warn + ' this wallet has already been used to enter this match.\n' +
      'one entry per wallet per match.');
  }

  // re-verify match still open
  const matches = todayCache.data || [];
  const match = matches.find(m => String(m.id) === matchId);
  if (!match || (match.status !== 'SCHEDULED' && match.status !== 'TIMED')) {
    saveStateNow();
    return ctx.reply('that match has already started. predictions closed. your wallet is saved for next time.');
  }

  if (!state.predictions[matchId]) state.predictions[matchId] = { quick: {}, pro: {}, exact: {} };
  state.predictions[matchId][pool][userId] = {
    choice,
    wallet: wallet.toLowerCase(),
    username: u.username,
    ts: Date.now(),
    locked: true,
    entryBalanceFwc: h.balanceFwc
  };
  saveStateNow();

  const mult = bagMultiplier(h.balanceFwc);
  await ctx.reply(
    E.check + ' <b>locked in</b>\n\n' +
    'pick: ' + esc(decodeChoice(choice, pool, match)) + '\n' +
    'wallet: <code>' + esc(wallet) + '</code>\n' +
    'bag: ' + fmtFwc(h.balanceFwc) + ' FWC (' + mult.toFixed(2) + 'x reward multiplier)\n\n' +
    '<i>watch the match. winners get FWC after full-time.</i>',
    { parse_mode: 'HTML' });
});

// Fetch and post lineup ~10 min before kickoff. Deleted at kickoff time.
async function announceLineup(m) {
  if (!AF_KEYS.length) return;
  const id = String(m.id);
  if (!state.trackedMatches[id]) state.trackedMatches[id] = {};
  const rec = state.trackedMatches[id];
  if (rec.lineupSent) return;
  if (!rec.afFixtureId) {
    console.log('[LINEUP] skip:', teamName(m.homeTeam), 'vs', teamName(m.awayTeam), '- no afFixtureId');
    return;
  }
  const ko = new Date(m.utcDate).getTime();
  const now = Date.now();
  const minsToKo = (ko - now) / 60000;
  // window: between 15 minutes and 1 minute before kickoff
  if (minsToKo > 15 || minsToKo < 1) {
    if (minsToKo > 0 && minsToKo < 30) {
      // log only if we're close but outside window so we know we missed it
      console.log('[LINEUP] outside window:', teamName(m.homeTeam), 'vs', teamName(m.awayTeam), 'mins to ko:', minsToKo.toFixed(1));
    }
    return;
  }
  console.log('[LINEUP] posting:', teamName(m.homeTeam), 'vs', teamName(m.awayTeam), 'mins to ko:', minsToKo.toFixed(1));
  rec.lineupSent = true;
  saveStateNow();

  let data;
  try { data = await afGet('/fixtures/lineups?fixture=' + rec.afFixtureId); }
  catch (e) { return; }
  if (!data || !data.response || !data.response.length) {
    // graceful fallback
    try {
      const sent = await sendHTML(state.groupId,
        E.clipboard + ' <b>LINEUPS</b>\n\n<i>not yet published. check back closer to kickoff.</i>');
      rec.lineupMsgId = sent.message_id;
      saveStateNow();
    } catch (e) {}
    return;
  }

  const lineups = data.response;
  const homeName = teamName(m.homeTeam).toUpperCase();
  const awayName = teamName(m.awayTeam).toUpperCase();
  const hf = teamFlag(m.homeTeam), af = teamFlag(m.awayTeam);

  function renderSide(lu, flagStr, nameUp) {
    const out = [];
    const formation = lu.formation ? ' (' + lu.formation + ')' : '';
    out.push((flagStr ? flagStr + ' ' : '') + '<b>' + esc(nameUp) + '</b>' + formation);
    // Group players: starters by line (GK, DEF, MID, ATT) based on grid
    const starters = (lu.startXI || []).map(p => p.player || p).filter(Boolean);
    if (starters.length) {
      // sort by grid: '1:1' (GK row 1) ... '4:3'
      const byRow = {};
      for (const p of starters) {
        const grid = p.grid || '?:?';
        const row = grid.split(':')[0];
        if (!byRow[row]) byRow[row] = [];
        byRow[row].push(p.name || '?');
      }
      const rowKeys = Object.keys(byRow).sort();
      for (const r of rowKeys) {
        out.push(byRow[r].map(n => esc(n)).join(' \u00b7 '));
      }
    } else {
      out.push('<i>squad not available</i>');
    }
    return out.join('\n');
  }

  const lines = [E.clipboard + ' <b>LINEUP \u2014 ' + esc(homeName) + ' vs ' + esc(awayName) + '</b>', ''];
  // try to match home and away by team name
  const hCanon = canonicalTeamName(teamName(m.homeTeam));
  const aCanon = canonicalTeamName(teamName(m.awayTeam));
  let homeLu = null, awayLu = null;
  for (const lu of lineups) {
    const lc = canonicalTeamName((lu.team && lu.team.name) || '');
    if (!homeLu && (lc === hCanon || hCanon.includes(lc) || lc.includes(hCanon))) homeLu = lu;
    else if (!awayLu && (lc === aCanon || aCanon.includes(lc) || lc.includes(aCanon))) awayLu = lu;
  }
  if (!homeLu && lineups[0]) homeLu = lineups[0];
  if (!awayLu && lineups[1]) awayLu = lineups[1];
  if (homeLu) lines.push(renderSide(homeLu, hf, homeName));
  lines.push('');
  if (awayLu) lines.push(renderSide(awayLu, af, awayName));
  lines.push('');
  lines.push('<i>kickoff in ' + Math.max(1, Math.round(minsToKo)) + ' min ' + E.green + '</i>');

  try {
    const sent = await sendHTML(state.groupId, lines.join('\n'));
    rec.lineupMsgId = sent.message_id;
    saveStateNow();
  } catch (e) { console.log('lineup post err:', e.message); }
}

// Post a card/sub event. Auto-deletes after 5 min to keep chat clean.
async function postEphemeralEvent(text) {
  if (!state.groupId) return;
  try {
    const sent = await sendHTML(state.groupId, text);
    // auto-delete after 5 min
    setTimeout(() => {
      bot.telegram.deleteMessage(state.groupId, sent.message_id).catch(() => {});
    }, 5 * 60 * 1000);
  } catch (e) {}
}

// Detect new cards and subs from AF events, post and auto-delete.
async function checkCardsAndSubs(m, detail) {
  if (!state.settings.goalAlerts) return; // gate on same toggle as goals
  if (!detail || !detail._afEvents) return; // requires AF event data
  const id = String(m.id);
  const rec = state.trackedMatches[id];
  if (rec.fulltimeSent) return;
  if (!rec.announcedEventKeys) rec.announcedEventKeys = {}; // key -> 1

  const events = detail._afEvents;
  for (const ev of events) {
    const tp = ev.type;
    if (tp !== 'Card' && tp !== 'subst') continue;
    const player = (ev.player && ev.player.name) || '?';
    const team = (ev.team && ev.team.name) || '?';
    const minute = (ev.time && ev.time.elapsed) || 0;
    const detail2 = ev.detail || '';
    const key = tp + '|' + player + '|' + team + '|' + minute + '|' + detail2;
    if (rec.announcedEventKeys[key]) continue;
    rec.announcedEventKeys[key] = 1;

    // figure out which side this team is
    const tCanon = canonicalTeamName(team);
    const isHome = canonicalTeamName(teamName(m.homeTeam)) === tCanon;
    const teamObj = isHome ? m.homeTeam : m.awayTeam;
    const tFlag = teamFlag(teamObj);
    const tName = teamName(teamObj).toUpperCase();

    let text = '';
    if (tp === 'Card') {
      const isRed = /red/i.test(detail2);
      if (isRed) {
        text = E.red + ' <b>RED CARD</b>\n\n' +
          (tFlag ? tFlag + ' ' : '') + '<b>' + esc(player.toUpperCase()) + '</b> ' + minute + "'\n" +
          esc(tName) + ' \u2014 down to 10';
      } else {
        text = E.yellow + ' <b>YELLOW</b>\n\n' +
          (tFlag ? tFlag + ' ' : '') + '<b>' + esc(player.toUpperCase()) + '</b> ' + minute + "'\n" +
          esc(tName);
      }
    } else if (tp === 'subst') {
      // ev.player.name is the one coming OFF, ev.assist.name is coming ON (per AF docs)
      const off = player;
      const on = (ev.assist && ev.assist.name) || '?';
      text = E.swap + ' <b>SUB \u2014 ' + esc(tName) + '</b>\n\n' +
        'OUT: ' + esc(off) + '\n' +
        'IN: ' + esc(on) + '\n' +
        minute + "'";
    }
    if (text) await postEphemeralEvent(text);
  }
  saveStateNow();
}

async function announceKickoff(m) {
  const id = String(m.id);
  const rec = state.trackedMatches[id];
  if (rec.kickoffSent) return;
  // close legacy poll
  if (rec.pollMsgId) {
    try { await bot.telegram.stopPoll(state.groupId, rec.pollMsgId); } catch (e) {}
  }
  // close prediction buttons by editing the markup off
  if (state.predictionMsgs[id]) {
    const pm = state.predictionMsgs[id];
    const totalEntries = Object.keys((state.predictions[id] && state.predictions[id].quick) || {}).length +
                         Object.keys((state.predictions[id] && state.predictions[id].pro) || {}).length +
                         Object.keys((state.predictions[id] && state.predictions[id].exact) || {}).length;
    for (const k of ['quickMsgId', 'proMsgId', 'exactMsgId']) {
      if (pm[k]) {
        try {
          await bot.telegram.editMessageReplyMarkup(state.groupId, pm[k], undefined, { inline_keyboard: [] });
        } catch (e) {}
      }
    }
    if (totalEntries > 0) {
      try { await sendHTML(state.groupId, '<b>PREDICTIONS LOCKED</b> <i>' + totalEntries + ' entries across all pools</i>'); } catch (e) {}
    }
  }
  // delete lineup message at kickoff
  if (rec.lineupMsgId) {
    try { await bot.telegram.deleteMessage(state.groupId, rec.lineupMsgId); } catch (e) {}
    rec.lineupMsgId = null;
  }
  if (state.settings.autoLock) await setGroupLocked(state.groupId, true);
  const hf = teamFlag(m.homeTeam), af = teamFlag(m.awayTeam);
  const hn = teamName(m.homeTeam).toUpperCase();
  const an = teamName(m.awayTeam).toUpperCase();
  const text = E.green + ' <b>KICKOFF</b> ' + E.lock + '\n\n' +
    (hf ? hf + ' ' : '') + '<b>' + esc(hn) + '</b> vs <b>' + esc(an) + '</b>' + (af ? ' ' + af : '') + '\n' +
    '<i>' + pick(KICKOFF_LINES) + '</i>';
  try {
    await sendHTML(state.groupId, text);
  } catch (e) {}
  rec.kickoffSent = true;
  saveStateNow();
}

async function announceHalftime(m) {
  const id = String(m.id);
  const rec = state.trackedMatches[id];
  if (rec.halftimeSent) return;
  if (state.settings.autoLock) await setGroupLocked(state.groupId, false);
  // pull cached detail (AF data) for accurate live score
  const cached = matchCache[m.id];
  const detail = cached && cached.data;
  const text = E.pause + ' <b>HALF-TIME</b> ' + E.unlock + '\n\n' +
    scoreLine(m, detail) + '\n\n' +
    pick(HT_LINES);
  try { await sendHTML(state.groupId, text); } catch (e) {}
  rec.halftimeSent = true;
  saveStateNow();
}

async function announceSecondHalf(m) {
  const id = String(m.id);
  const rec = state.trackedMatches[id];
  if (rec.secondHalfSent) return;
  if (state.settings.autoLock) await setGroupLocked(state.groupId, true);
  const cached = matchCache[m.id];
  const detail = cached && cached.data;
  const text = E.play + ' <b>SECOND HALF</b> ' + E.lock + '\n\n' +
    scoreLine(m, detail) + '\n' +
    '<i>' + pick(SH_LINES) + '</i>';
  try { await sendHTML(state.groupId, text); } catch (e) {}
  rec.secondHalfSent = true;
  saveStateNow();
}

async function announceFulltime(m, detail) {
  const id = String(m.id);
  const rec = state.trackedMatches[id];
  if (rec.fulltimeSent) return;
  if (state.settings.autoLock) await setGroupLocked(state.groupId, false);
  const hn = teamName(m.homeTeam).toUpperCase();
  const an = teamName(m.awayTeam).toUpperCase();
  const lines = [E.flag + ' <b>FULL TIME</b> ' + E.party + ' ' + E.unlock, '', scoreLine(m, detail)];
  const goals = (detail && detail.goals) || m.goals || [];
  if (goals.length) {
    const home = [], away = [];
    for (const g of goals) {
      const who = (g.scorer && g.scorer.name) || '?';
      const min = (g.minute != null ? g.minute + "'" : '');
      const line = esc(who) + (min ? ' <i>' + min + '</i>' : '');
      const teamId = g.team && g.team.id;
      const teamN = g.team && g.team.name;
      const isHome = teamId === (m.homeTeam && m.homeTeam.id) || teamN === (m.homeTeam && m.homeTeam.name);
      const isAway = teamId === (m.awayTeam && m.awayTeam.id) || teamN === (m.awayTeam && m.awayTeam.name);
      if (isHome) home.push(line);
      else if (isAway) away.push(line);
    }
    if (home.length || away.length) {
      lines.push('');
      lines.push('<b>' + esc(hn) + '</b>');
      lines.push(home.length ? home.join(', ') : '-');
      lines.push('');
      lines.push('<b>' + esc(an) + '</b>');
      lines.push(away.length ? away.join(', ') : '-');
    }
  }
  lines.push('');
  lines.push('<i>' + pick(FT_LINES) + '</i>');
  try {
    const sent = await sendHTML(state.groupId, lines.join('\n'));
    // loud pin: this is the final result, everyone should see it
    await pinMessage(state.groupId, sent.message_id, false);
    trackDailyPin(sent.message_id);
  } catch (e) {}
  rec.fulltimeSent = true;
  saveStateNow();

  // Trigger prediction winner calculation (async, don't block)
  if (state.settings.predictions) {
    setTimeout(() => calculateWinnersForMatch(m, detail).catch(e => console.log('winner calc err:', e.message)), 5000);
  }
}

// ---------- Prediction winner calculation ----------
function pickFromArray(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function detectHTFTOutcome(htHome, htAway, ftHome, ftAway) {
  const ht = htHome > htAway ? 'H' : htAway > htHome ? 'A' : 'D';
  const ft = ftHome > ftAway ? 'H' : ftAway > ftHome ? 'A' : 'D';
  return ht + ft;
}

async function calculateWinnersForMatch(m, detail) {
  const id = String(m.id);
  if (!state.predictions[id]) return;
  const rec = state.trackedMatches[id];
  if (rec.winnersCalculated) return;
  // only run for community-selected matches
  if (!isMatchSelectedForPredictions(id)) return;
  rec.winnersCalculated = true;

  // determine outcomes
  const score = fmtScoreObj(detail || m);
  const homeScore = score.home || 0;
  const awayScore = score.away || 0;
  const totalGoals = homeScore + awayScore;
  const actualWinner = homeScore > awayScore ? 'H' : awayScore > homeScore ? 'A' : 'D';
  const actualOU = totalGoals > 2.5 ? 'O' : 'U';
  // half-time score for HT/FT prediction
  const htScore = (detail && detail.score && detail.score.halfTime) || (m.score && m.score.halfTime) || { home: 0, away: 0 };
  const htHome = htScore.home != null ? htScore.home : 0;
  const htAway = htScore.away != null ? htScore.away : 0;
  const actualHTFT = detectHTFTOutcome(htHome, htAway, homeScore, awayScore);

  // gather correct predictions per pool
  const quickCorrect = [];
  for (const userId in (state.predictions[id].quick || {})) {
    const p = state.predictions[id].quick[userId];
    if (p.choice === actualWinner) quickCorrect.push({ userId, ...p });
  }
  const proCorrect = [];
  for (const userId in (state.predictions[id].pro || {})) {
    const p = state.predictions[id].pro[userId];
    if (p.choice && p.choice[0] === actualWinner && p.choice[1] === actualOU) {
      proCorrect.push({ userId, ...p });
    }
  }
  const exactCorrect = [];
  for (const userId in (state.predictions[id].exact || {})) {
    const p = state.predictions[id].exact[userId];
    if (p.choice === actualHTFT) exactCorrect.push({ userId, ...p });
  }

  // pool budgets for THIS match (divide daily pool by selection count)
  const dateKey = getDateKey();
  const v = state.dailyVote[dateKey];
  const splitCount = (v && v.selectCount) || 1;
  // Fixed daily pools - no rollover.
  const easyBudget = EASY_POOL_USD / splitCount;
  const mediumBudget = MEDIUM_POOL_USD / splitCount;
  const hardBudget = HARD_POOL_USD / splitCount;

  // helper: split a pool budget among correct predictors, weighted by bag size
  // Unwon money does NOT roll over - it stays in the reward wallet for future use.
  async function splitPool(correctArr, poolName, totalBudget) {
    if (totalBudget <= 0) return [];
    if (!correctArr.length) {
      // nobody won this pool - money stays in reward wallet, no rollover
      return [];
    }
    // re-verify each correct predictor still meets gate
    const eligible = [];
    for (const cand of correctArr) {
      const h = await checkFwcHolder(cand.wallet);
      if (!h.meetsGate) {
        console.log('skipping ' + cand.username + ' - bag ' + fmtFwc(h.balanceFwc) + ' FWC');
        // DM the user so they understand why they didn't get rewarded
        try {
          const poolLabel = poolName === 'quick' ? 'easy' : poolName === 'pro' ? 'medium' : 'hard';
          await bot.telegram.sendMessage(cand.userId,
            E.warn + ' <b>your ' + poolLabel + ' pool prediction was correct!</b>\n\n' +
            'but at full-time your wallet only had <b>' + fmtFwc(h.balanceFwc) + ' FWC</b>.\n' +
            'the minimum to receive rewards is <b>' + fmtFwc(MIN_HOLD_FWC) + ' FWC</b>.\n\n' +
            'keep your bag above the minimum on match days to qualify next time.',
            { parse_mode: 'HTML' });
        } catch (e) {}
        continue;
      }
      eligible.push({ ...cand, balanceFwc: h.balanceFwc, balanceUsd: h.balanceUsd, weight: bagMultiplier(h.balanceFwc) });
    }
    if (!eligible.length) {
      // no one eligible - money stays in reward wallet, no rollover
      return [];
    }
    // share = (their weight / total weight) * totalBudget
    const totalWeight = eligible.reduce((a, e) => a + e.weight, 0);
    const shares = eligible.map(e => {
      let amount = (e.weight / totalWeight) * totalBudget;
      if (amount > PER_WIN_CAP_USD) amount = PER_WIN_CAP_USD;
      return { ...e, amountUsd: amount, pool: poolName };
    });
    return shares;
  }

  const quickWinners = await splitPool(quickCorrect, 'quick', easyBudget);
  const proWinners = await splitPool(proCorrect, 'pro', mediumBudget);
  const exactWinners = await splitPool(exactCorrect, 'exact', hardBudget);
  const allWinners = [...quickWinners, ...proWinners, ...exactWinners];

  // post summary to group
  const hn = teamName(m.homeTeam).toUpperCase();
  const an = teamName(m.awayTeam).toUpperCase();
  const lines = [E.trophy + ' <b>PREDICTION RESULTS</b>', ''];
  lines.push('<b>' + esc(hn) + '</b> vs <b>' + esc(an) + '</b>');
  const winnerLabel = (actualWinner === 'H' ? hn : actualWinner === 'A' ? an : 'DRAW');
  lines.push('final: <b>' + homeScore + '-' + awayScore + '</b> (' + (actualOU === 'O' ? 'over' : 'under') + ' 2.5, HT: ' + htHome + '-' + htAway + ', ' + esc(winnerLabel) + ')');
  lines.push('');

  function poolBlock(headerCaps, entries, correct, winners, budget) {
    const out = ['<b>' + headerCaps + '</b>'];
    out.push(entries + ' entries \u00b7 ' + correct + ' correct');
    if (correct === 0) out.push('<i>no winners \u2014 pool stays in wallet</i>');
    else if (winners.length === 0) out.push('<i>no eligible holders \u2014 pool stays in wallet</i>');
    else if (winners.length === 1) out.push('$' + budget.toFixed(2) + ' to winner');
    else out.push('$' + budget.toFixed(2) + ' split between ' + winners.length + ' winners');
    out.push('');
    return out;
  }
  lines.push(...poolBlock('EASY (winner)', Object.keys(state.predictions[id].quick || {}).length, quickCorrect.length, quickWinners, easyBudget));
  lines.push(...poolBlock('MEDIUM (winner + goals)', Object.keys(state.predictions[id].pro || {}).length, proCorrect.length, proWinners, mediumBudget));
  lines.push(...poolBlock('HARD (HT/FT)', Object.keys(state.predictions[id].exact || {}).length, exactCorrect.length, exactWinners, hardBudget));

  if (allWinners.length) {
    lines.push('<i>winners notified by DM. payouts under review.</i>');
  }
  try { await sendHTML(state.groupId, lines.join('\n')); } catch (e) {}

  // queue pending rewards
  const price = await getFwcPriceUSD();
  const queuedThisMatch = [];
  for (const w of allWinners) {
    const fwc = usdToFwc(w.amountUsd, price);
    const queued = {
      matchId: id,
      matchLabel: teamName(m.homeTeam) + ' vs ' + teamName(m.awayTeam),
      userId: w.userId,
      username: w.username,
      wallet: w.wallet,
      pool: w.pool,
      bagFwc: w.balanceFwc,
      bagUsd: w.balanceUsd,
      shareWeight: w.weight,
      amountUSD: w.amountUsd,
      amountFWC: fwc,
      priceAtCalc: price,
      createdAt: Date.now(),
      status: 'pending'
    };
    state.pendingRewards.push(queued);
    queuedThisMatch.push(queued);
  }

  // DM each winner now that the FWC amount is known
  for (const q of queuedThisMatch) {
    try {
      const poolLabel = q.pool === 'quick' ? 'EASY' : q.pool === 'pro' ? 'MEDIUM' : 'HARD';
      await bot.telegram.sendMessage(q.userId,
        E.trophy + ' <b>YOU WON!</b>\n\n' +
        'pool: <b>' + poolLabel + '</b>\n' +
        'match: ' + esc(q.matchLabel) + '\n' +
        'your prediction was correct ' + E.check + '\n\n' +
        'your share: <b>' + q.amountFWC.toFixed(2) + ' FWC</b> ($' + q.amountUSD.toFixed(2) + ')\n\n' +
        '<i>reward is under review and will be sent shortly. you\'ll get another DM with the transaction once it\'s out.</i>',
        { parse_mode: 'HTML' });
    } catch (e) {}
  }

  if (allWinners.length) {
    if (!state.dailyTotals[dateKey]) state.dailyTotals[dateKey] = { sentUSD: 0, attemptedUSD: 0, matchesPaid: 0 };
    state.dailyTotals[dateKey].matchesPaid += 1;
    // auto-send batch review DM to owner now that winners are queued
    setTimeout(() => sendDailyBatchNow().catch(e => console.log('auto batch err:', e.message)), 2000);
  }
  saveStateNow();
}

// ---------- Daily batch DM to owner for approval ----------
let lastBatchDateKey = '';
async function maybeSendDailyBatch() {
  if (!OWNER_ID) return;
  if (!state.pendingRewards.length) return;
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  // Send batch after 23:00 UTC, only once per day
  if (now.getUTCHours() < 23) return;
  if (lastBatchDateKey === dateKey) return;
  // also check all matches today are FINISHED
  const todayMatches = todayCache.data || [];
  const unfinished = todayMatches.filter(m => m.status !== 'FINISHED' && m.status !== 'AWARDED' && m.status !== 'CANCELLED' && m.status !== 'POSTPONED');
  if (unfinished.length) return;
  lastBatchDateKey = dateKey;
  await sendDailyBatchNow();
}

async function sendDailyBatchNow() {
  if (!OWNER_ID) return;
  const pending = state.pendingRewards.filter(r => r.status === 'pending');
  if (!pending.length) {
    try { await bot.telegram.sendMessage(OWNER_ID, 'no pending rewards.'); } catch (e) {}
    return;
  }
  const totalUsd = pending.reduce((a, r) => a + r.amountUSD, 0);
  const totalFwc = pending.reduce((a, r) => a + r.amountFWC, 0);

  // group by match for clean presentation
  const byMatch = {};
  pending.forEach(r => {
    const key = r.matchLabel || 'match';
    if (!byMatch[key]) byMatch[key] = [];
    byMatch[key].push(r);
  });

  const lines = [E.money + ' <b>REWARD BATCH READY</b>', ''];
  lines.push(pending.length + ' winner' + (pending.length === 1 ? '' : 's') + ' \u00b7 total: ' + totalFwc.toFixed(2) + ' FWC ($' + totalUsd.toFixed(2) + ')');
  lines.push('');

  let i = 1;
  for (const matchKey in byMatch) {
    lines.push('<b>' + esc(matchKey) + '</b>');
    for (const r of byMatch[matchKey]) {
      const poolLabel = (r.pool === 'quick' ? 'EASY' : r.pool === 'pro' ? 'MEDIUM' : 'HARD');
      const wshort = r.wallet ? (r.wallet.slice(0, 6) + '...' + r.wallet.slice(-4)) : '?';
      lines.push((i) + '. <b>' + poolLabel + '</b> \u2014 @' + esc(r.username || 'user'));
      lines.push('   bag: ' + fmtFwc(r.bagFwc || 0) + ' FWC \u00b7 wallet <code>' + esc(wshort) + '</code>');
      lines.push('   pays: <b>' + r.amountFWC.toFixed(2) + ' FWC</b> ($' + r.amountUSD.toFixed(2) + ')');
      i += 1;
    }
    lines.push('');
  }
  lines.push(DRY_RUN ? '<i>DRY RUN mode is ON. transactions will be simulated.</i>' : '<b>LIVE mode.</b> approve will send real FWC.');

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(E.check + ' approve all and send', 'BATCH_APPROVE_ALL')],
    [Markup.button.callback('edit', 'BATCH_EDIT'), Markup.button.callback(E.cross + ' reject all', 'BATCH_REJECT_ALL')]
  ]);
  try {
    await bot.telegram.sendMessage(OWNER_ID, lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb.reply_markup });
  } catch (e) { console.log('batch DM err:', e.message); }
}

// approval handlers
bot.action('BATCH_APPROVE_ALL', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('only owner');
  await ctx.answerCbQuery('processing...');
  await processApprovedBatch(ctx);
});

bot.action('BATCH_REJECT_ALL', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('only owner');
  const pending = state.pendingRewards.filter(r => r.status === 'pending');
  pending.forEach(r => { r.status = 'rejected'; });
  saveStateNow();
  await ctx.answerCbQuery('rejected ' + pending.length);
  try { await ctx.editMessageText('rejected all ' + pending.length + ' rewards.'); } catch (e) {}
});

bot.action('BATCH_EDIT', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('only owner');
  await ctx.answerCbQuery();
  await renderEditBatchView(ctx);
});

async function renderEditBatchView(ctx) {
  const pending = state.pendingRewards.filter(r => r.status === 'pending' || r.status === 'on_hold');
  if (!pending.length) {
    try { await ctx.editMessageText('no pending rewards left.'); } catch (e) {}
    return;
  }

  // text body shows current state of each item
  const lines = [E.money + ' <b>edit reward batch</b>', ''];
  pending.forEach((r, i) => {
    const idx = state.pendingRewards.indexOf(r);
    const poolLabel = r.pool === 'quick' ? 'easy' : r.pool === 'pro' ? 'medium' : 'hard';
    const tag = r.status === 'on_hold' ? ' [ON HOLD]' : '';
    lines.push('<b>#' + (i + 1) + '</b> @' + esc(r.username || 'user') + tag);
    lines.push('  ' + poolLabel + ' pool, match: ' + esc((r.matchLabel || '').slice(0, 40)));
    lines.push('  pays: ' + r.amountFWC.toFixed(2) + ' FWC ($' + r.amountUSD.toFixed(2) + ')');
    lines.push('');
  });
  lines.push('<i>tap a number to edit, then choose action.</i>');

  // build keyboard: one row per item with item number, then global actions
  const rows = [];
  // chunk per-item buttons 3 per row
  let chunk = [];
  pending.forEach((r, i) => {
    const idx = state.pendingRewards.indexOf(r);
    chunk.push(Markup.button.callback('#' + (i + 1), 'EDIT_ITEM_' + idx));
    if (chunk.length === 3) { rows.push(chunk); chunk = []; }
  });
  if (chunk.length) rows.push(chunk);
  rows.push([Markup.button.callback(E.check + ' approve remaining', 'BATCH_APPROVE_ALL')]);
  rows.push([Markup.button.callback(E.cross + ' cancel edits', 'BATCH_EDIT_DONE')]);

  try {
    await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
  } catch (e) {}
}

// tap on an item -> show item actions
bot.action(/^EDIT_ITEM_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('only owner');
  const idx = parseInt(ctx.match[1], 10);
  const r = state.pendingRewards[idx];
  if (!r) return ctx.answerCbQuery('not found');
  await ctx.answerCbQuery();
  const poolLabel = r.pool === 'quick' ? 'easy' : r.pool === 'pro' ? 'medium' : 'hard';
  const text = E.money + ' <b>editing reward</b>\n\n' +
    'user: @' + esc(r.username || 'user') + '\n' +
    'wallet: <code>' + esc(r.wallet) + '</code>\n' +
    'pool: ' + poolLabel + '\n' +
    'match: ' + esc(r.matchLabel || '?') + '\n' +
    'current: <b>' + r.amountFWC.toFixed(2) + ' FWC</b> ($' + r.amountUSD.toFixed(2) + ')\n' +
    'status: <b>' + r.status + '</b>\n\n' +
    '<i>pick an action:</i>';
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('half (50%)', 'ADJ_' + idx + '_50'), Markup.button.callback('double (200%)', 'ADJ_' + idx + '_200')],
    [Markup.button.callback('+25%', 'ADJ_' + idx + '_125'), Markup.button.callback('-25%', 'ADJ_' + idx + '_75')],
    [Markup.button.callback(r.status === 'on_hold' ? 'resume' : 'put on hold', 'HOLD_' + idx)],
    [Markup.button.callback(E.cross + ' reject this one', 'REJ_' + idx)],
    [Markup.button.callback('< back to batch', 'EDIT_BACK')]
  ]);
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb.reply_markup });
  } catch (e) {}
});

// adjust amount by percentage
bot.action(/^ADJ_(\d+)_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('only owner');
  const idx = parseInt(ctx.match[1], 10);
  const pct = parseInt(ctx.match[2], 10);
  const r = state.pendingRewards[idx];
  if (!r) return ctx.answerCbQuery('not found');
  const oldUsd = r.amountUSD;
  const oldFwc = r.amountFWC;
  r.amountUSD = +(oldUsd * pct / 100).toFixed(2);
  r.amountFWC = +(oldFwc * pct / 100).toFixed(2);
  // enforce per-win cap
  if (r.amountUSD > PER_WIN_CAP_USD) {
    r.amountUSD = PER_WIN_CAP_USD;
    r.amountFWC = +(oldFwc * PER_WIN_CAP_USD / oldUsd).toFixed(2);
  }
  saveStateNow();
  await ctx.answerCbQuery('adjusted to ' + r.amountFWC.toFixed(0) + ' FWC');
  await renderEditBatchView(ctx);
});

// toggle hold status
bot.action(/^HOLD_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('only owner');
  const idx = parseInt(ctx.match[1], 10);
  const r = state.pendingRewards[idx];
  if (!r) return ctx.answerCbQuery('not found');
  r.status = r.status === 'on_hold' ? 'pending' : 'on_hold';
  saveStateNow();
  await ctx.answerCbQuery(r.status === 'on_hold' ? 'put on hold' : 'resumed');
  await renderEditBatchView(ctx);
});

bot.action('EDIT_BACK', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('only owner');
  await ctx.answerCbQuery();
  await renderEditBatchView(ctx);
});

bot.action('BATCH_EDIT_DONE', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('only owner');
  await ctx.answerCbQuery('edits saved');
  try { await ctx.editMessageText('edits saved. send /sendbatch again to approve, or wait for reminder.'); } catch (e) {}
});

bot.action(/^REJ_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('only owner');
  const idx = parseInt(ctx.match[1], 10);
  if (state.pendingRewards[idx]) {
    const r = state.pendingRewards[idx];
    r.status = 'rejected';
    saveStateNow();
    await ctx.answerCbQuery('rejected #' + (idx + 1));
    // DM the user explaining their reward was rejected by admin
    try {
      await bot.telegram.sendMessage(r.userId,
        E.warn + ' <b>your reward was not processed</b>\n\n' +
        'match: ' + esc(r.matchLabel || '?') + '\n' +
        'an admin reviewed the batch and removed your entry.\n\n' +
        '<i>this is rare. if you think it was a mistake, dm the admin.</i>',
        { parse_mode: 'HTML' });
    } catch (e) {}
    await renderEditBatchView(ctx);
  } else {
    await ctx.answerCbQuery('not found');
  }
});

async function processApprovedBatch(ctx) {
  const pending = state.pendingRewards.filter(r => r.status === 'pending');
  if (!pending.length) {
    try { await ctx.reply('no pending rewards.'); } catch (e) {}
    return;
  }

  const dateKey = getDateKey();
  if (!state.dailyTotals[dateKey]) state.dailyTotals[dateKey] = { sentUSD: 0, attemptedUSD: 0, matchesPaid: 0 };
  const dt = state.dailyTotals[dateKey];

  let okCount = 0, failCount = 0;
  let sentTotalUsd = 0, sentTotalFwc = 0;
  const results = [];
  for (const r of pending) {
    try {
      if (r.amountUSD > PER_WIN_CAP_USD) {
        r.status = 'rejected_cap';
        results.push('per-win cap reject ' + (r.username || 'user'));
        // DM the user explaining
        try {
          await bot.telegram.sendMessage(r.userId,
            E.warn + ' <b>reward not sent</b>\n\n' +
            'match: ' + esc(r.matchLabel || '?') + '\n' +
            'reason: your calculated share ($' + r.amountUSD.toFixed(2) + ') exceeded the per-win cap ($' + PER_WIN_CAP_USD + ').\n\n' +
            '<i>this is a safety limit. dm the admin if you have questions.</i>',
            { parse_mode: 'HTML' });
        } catch (e) {}
        continue;
      }
      // belt-and-suspenders: re-verify holder one more time before send
      const hCheck = await checkFwcHolder(r.wallet);
      if (!hCheck.meetsGate) {
        r.status = 'rejected_no_hold';
        results.push('no longer holding ' + (r.username || 'user') + ' (' + fmtFwc(hCheck.balanceFwc) + ' FWC)');
        // DM the user explaining
        try {
          await bot.telegram.sendMessage(r.userId,
            E.warn + ' <b>reward not sent</b>\n\n' +
            'match: ' + esc(r.matchLabel || '?') + '\n' +
            'you predicted correctly but at payout time your wallet had only <b>' + fmtFwc(hCheck.balanceFwc) + ' FWC</b>.\n' +
            'the minimum to receive rewards is <b>' + fmtFwc(MIN_HOLD_FWC) + ' FWC</b>.\n\n' +
            'keep your bag above the minimum on match days to qualify for rewards.',
            { parse_mode: 'HTML' });
        } catch (e) {}
        continue;
      }
      const sendRes = await sendFwcReward(r.wallet, r.amountFWC);
      r.status = sendRes.dryRun ? 'dry_sent' : 'sent';
      r.txHash = sendRes.txHash;
      r.sentAt = Date.now();
      dt.sentUSD += r.amountUSD;
      state.approvedRewards.push(r);
      okCount++;
      sentTotalUsd += r.amountUSD;
      sentTotalFwc += r.amountFWC;
      results.push((sendRes.dryRun ? 'DRY ' : '') + 'sent ' + r.amountFWC.toFixed(2) + ' FWC to @' + (r.username || 'user') + ' tx:' + sendRes.txHash.slice(0, 14) + '...');
      // DM the winner with the new premium template
      try {
        const poolLabel = r.pool === 'quick' ? 'EASY' : r.pool === 'pro' ? 'MEDIUM' : 'HARD';
        const scanUrl = 'https://bscscan.com/tx/' + sendRes.txHash;
        await bot.telegram.sendMessage(r.userId,
          (sendRes.dryRun ? '<b>[DRY RUN]</b> ' : '') +
          E.check + ' <b>your reward has been sent successfully</b>\n\n' +
          'amount: <b>' + r.amountFWC.toFixed(2) + ' FWC</b>\n' +
          'pool: ' + poolLabel + '\n' +
          'match: ' + esc(r.matchLabel || '?') + '\n' +
          'tx: <code>' + esc(sendRes.txHash) + '</code>\n\n' +
          (sendRes.dryRun ? '<i>(test mode \u2014 no real funds moved)</i>' : '<a href="' + scanUrl + '">view on BSCScan</a>') + '\n\n' +
          '<i>see you in the next match.</i>',
          { parse_mode: 'HTML', disable_web_page_preview: true });
      } catch (e) {}
    } catch (err) {
      r.status = 'failed';
      r.error = err.message;
      failCount++;
      results.push('FAIL ' + (r.username || 'user') + ': ' + err.message);
    }
  }
  state.pendingRewards = state.pendingRewards.filter(r => r.status === 'pending');
  saveStateNow();

  // owner gets full batch summary in DM
  const summary = '<b>batch result</b>\n\n' +
    okCount + ' sent, ' + failCount + ' failed\n' +
    'sent today: $' + dt.sentUSD.toFixed(2) + '\n\n' +
    '<pre>' + esc(results.join('\n')) + '</pre>';
  try { await ctx.reply(summary, { parse_mode: 'HTML' }); } catch (e) {}

  // group gets a clean, non-spammy announcement - NO usernames
  if (okCount > 0 && state.groupId) {
    try {
      const groupMsg = E.check + ' <b>REWARDS PAID</b>\n\n' +
        okCount + ' winner' + (okCount > 1 ? 's' : '') + ' paid\n' +
        'total distributed: <b>' + sentTotalFwc.toFixed(2) + ' FWC</b>\n\n' +
        'winners \u2014 check your DM and wallet ' + E.money +
        (DRY_RUN ? '\n<i>(dry run mode)</i>' : '');
      await sendHTML(state.groupId, groupMsg);
    } catch (e) { console.log('group announce err:', e.message); }
  }
}

// daily batch check on tick
setInterval(maybeSendDailyBatch, 10 * 60 * 1000); // every 10 min

// Smart goal dedup with 90s correction window
async function checkGoals(m, detail) {
  if (!state.settings.goalAlerts) return;
  const id = String(m.id);
  const rec = state.trackedMatches[id];
  // never post alerts after match finished
  if (rec.fulltimeSent) return;
  // initialize tracking
  if (!rec.announcedScoreStates) rec.announcedScoreStates = {}; // "1-0" -> ts
  if (!rec.announcedGoalKeys) rec.announcedGoalKeys = []; // scorer|team|minute

  const goals = (detail && detail.goals) || m.goals || [];
  if (!goals.length) { saveStateNow(); return; }
  const now = Date.now();

  // sort goals by minute ascending so we announce in order
  const sorted = [...goals].sort((a, b) => (a.minute || 0) - (b.minute || 0));

  // compute running score and announce each NEW goal we haven't seen
  let runHome = 0, runAway = 0;
  for (const g of sorted) {
    const isHome = g.team && m.homeTeam && (g.team.id === m.homeTeam.id || g.team.name === m.homeTeam.name);
    const isAway = g.team && m.awayTeam && (g.team.id === m.awayTeam.id || g.team.name === m.awayTeam.name);
    if (isHome) runHome += 1;
    else if (isAway) runAway += 1;

    const scoreState = runHome + '-' + runAway;
    const scorer = (g.scorer && g.scorer.name) || 'unknown';
    const teamKey = (g.team && (g.team.id || g.team.name)) || '?';
    const goalKey = scorer + '|' + teamKey + '|' + (g.minute || '?');

    // dedup: have we announced THIS scoreline already? skip
    if (rec.announcedScoreStates[scoreState]) continue;
    // dedup: same scorer+minute already done? skip
    if (rec.announcedGoalKeys.indexOf(goalKey) !== -1) continue;

    rec.announcedScoreStates[scoreState] = now;
    rec.announcedGoalKeys.push(goalKey);

    const apiMin = g.minute;
    const min = apiMin != null ? Math.min(90, apiMin) + "'" : (liveMinute(m) ? liveMinute(m) + "'" : "?'");
    let scoringTeam = '';
    let scoringFlag = '';
    if (isHome) { scoringTeam = teamName(m.homeTeam); scoringFlag = teamFlag(m.homeTeam); }
    else if (isAway) { scoringTeam = teamName(m.awayTeam); scoringFlag = teamFlag(m.awayTeam); }

    // Premium presentation: bold caps scorer, team in CAPS
    // Use the running score we just computed (runHome/runAway) - this is accurate
    // even if m.score and detail.score haven't caught up yet.
    const liveScoreLine = (() => {
      const hf = teamFlag(m.homeTeam), af = teamFlag(m.awayTeam);
      const hn = (teamName(m.homeTeam) || '?').toUpperCase();
      const an = (teamName(m.awayTeam) || '?').toUpperCase();
      return (hf ? hf + ' ' : '') + '<b>' + esc(hn) + '</b>  <b>' + runHome + ' - ' + runAway + '</b>  <b>' + esc(an) + '</b>' + (af ? ' ' + af : '');
    })();
    const teamLine = (scoringFlag ? scoringFlag + ' ' : '') + '<i>for ' + esc(scoringTeam.toUpperCase()) + '</i>';
    const text = E.ball + ' <b>GOAL!</b>\n\n' +
      '<b>' + esc(scorer.toUpperCase()) + '</b> <i>' + min + '</i>\n' +
      (scoringTeam ? teamLine + '\n\n' : '\n') +
      liveScoreLine;
    try { await sendHTML(state.groupId, text); } catch (e) {}
  }
  saveStateNow();
}

// ---------- Adaptive polling tick ----------
// Batch is auto-sent to OWNER_ID after each match's winners are queued.
// No reminder DMs - the review message is the only notification.
let tickRunning = false;
let lastFullPoll = 0;

async function runMatchUpdate(m) {
  const id = String(m.id);
  if (!state.trackedMatches[id]) state.trackedMatches[id] = {};
  const rec = state.trackedMatches[id];

  // Within the live window (kickoff +/- buffer), check AF live feed for status override.
  // This means even if FD lags and says TIMED, if AF shows the match live, we treat it as live.
  let status = m.status;
  let liveSource = 'fd';
  if (AF_KEYS.length && m.utcDate && m.homeTeam && m.awayTeam) {
    const ko = new Date(m.utcDate).getTime();
    const now = Date.now();
    // window: from kickoff -10min through kickoff +3hr
    if (now > ko - 10 * 60 * 1000 && now < ko + 3 * 60 * 60 * 1000) {
      const afLive = await fetchAfLiveMatches();
      const afMatch = findAfMatchByTeams(afLive, m.homeTeam.name, m.awayTeam.name);
      if (afMatch) {
        liveSource = 'af';
        rec.afLastSeenLive = now;
        // Cache the AF fixture ID so we can query it directly after match drops from live feed
        if (afMatch.fixture && afMatch.fixture.id) rec.afFixtureId = afMatch.fixture.id;
        const afShort = afMatch.fixture && afMatch.fixture.status && afMatch.fixture.status.short;
        if (afShort === '1H' || afShort === '2H' || afShort === 'ET' || afShort === 'BT' || afShort === 'P' || afShort === 'LIVE') {
          status = 'IN_PLAY';
        } else if (afShort === 'HT') {
          status = 'PAUSED';
        } else if (afShort === 'FT' || afShort === 'AET' || afShort === 'PEN') {
          status = 'FINISHED';
        }
      } else if (rec.afLastSeenLive && !rec.fulltimeSent && rec.afFixtureId) {
        // AF dropped this match from the live feed.
        // If we saw it live before AND not yet marked finished, query AF directly
        // by fixture ID to see if it's now FINISHED (AF removes finished matches from live feed).
        // This catches the "match ended but FD still says IN_PLAY" lag we hit on Newcastle/West Ham.
        try {
          const directData = await afGet('/fixtures?id=' + rec.afFixtureId);
          if (directData && directData.response && directData.response[0]) {
            const directFix = directData.response[0];
            const directShort = directFix.fixture && directFix.fixture.status && directFix.fixture.status.short;
            if (directShort === 'FT' || directShort === 'AET' || directShort === 'PEN') {
              // Match is done. Synthesize a finished detail from AF data so checkGoals + announceFulltime work.
              const finishedDetail = shapeAfMatchToFd(directFix, m);
              if (finishedDetail) {
                liveSource = 'af-direct';
                status = 'FINISHED';
                matchCache[m.id] = { data: finishedDetail, at: now };
              }
            } else if (directShort === '1H' || directShort === '2H' || directShort === 'ET' || directShort === 'BT' || directShort === 'HT' || directShort === 'P') {
              // Still live but missed in the global feed
              liveSource = 'af-direct';
              status = (directShort === 'HT') ? 'PAUSED' : 'IN_PLAY';
              const liveDetail = shapeAfMatchToFd(directFix, m);
              if (liveDetail) matchCache[m.id] = { data: liveDetail, at: now };
            }
          }
        } catch (e) { console.log('af direct fetch err:', e.message); }
      }
      // log live-source every 5 min per match for visibility
      if (!rec.lastLiveLogAt || now - rec.lastLiveLogAt > 5 * 60 * 1000) {
        console.log('[LIVE]', {
          match: (m.homeTeam.name || '?') + ' vs ' + (m.awayTeam.name || '?'),
          fdStatus: m.status,
          resolvedStatus: status,
          source: liveSource,
          afFound: !!afMatch,
          afReady: AF_KEYS.length ? afPool.available() + '/' + afPool.size() : 'none'
        });
        rec.lastLiveLogAt = now;
      }
    }
  }

  if (status === 'SCHEDULED' || status === 'TIMED') {
    await ensurePollForMatch(m);
    // Lineup post 10 min before kickoff. Needs afFixtureId from prior live cycle...
    // since match is SCHEDULED, we need to fetch AF fixture detail proactively.
    // Only do this lookup when match is within 30 min of kickoff to save API budget.
    const koMs = m.utcDate ? new Date(m.utcDate).getTime() : 0;
    const minsToKo = koMs ? (koMs - Date.now()) / 60000 : 9999;
    if (!rec.afFixtureId && AF_KEYS.length && m.homeTeam && m.awayTeam && minsToKo < 30 && minsToKo > 0) {
      // try to find the AF fixture id via direct lookup using date + teams
      const ko = new Date(m.utcDate);
      const dateStr = ko.toISOString().slice(0, 10);
      try {
        const data = await afGet('/fixtures?date=' + dateStr);
        if (data && data.response) {
          const f = findAfMatchByTeams(data.response, m.homeTeam.name, m.awayTeam.name);
          if (f && f.fixture && f.fixture.id) {
            rec.afFixtureId = f.fixture.id;
            console.log('[LINEUP] cached afFixtureId for', teamName(m.homeTeam), 'vs', teamName(m.awayTeam), '=', f.fixture.id);
            saveStateNow();
          } else {
            console.log('[LINEUP] AF schedule lookup: no match found for', teamName(m.homeTeam), 'vs', teamName(m.awayTeam));
          }
        }
      } catch (e) {
        console.log('[LINEUP] AF lookup err:', e.message);
      }
    }
    if (rec.afFixtureId) {
      await announceLineup(m).catch(e => console.log('lineup err:', e.message));
    }
    return;
  }

  if (status === 'LIVE' || status === 'IN_PLAY') {
    if (!rec.kickoffSent) await announceKickoff(m);
    const detail = await fetchMatchDetail(m.id);
    if (detail) {
      await checkGoals(m, detail);
      await checkCardsAndSubs(m, detail).catch(e => console.log('cards err:', e.message));
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
    // do a final fetch to catch any last goal, then announce full-time and freeze
    if (!rec.fulltimeSent) {
      const detail = await fetchMatchDetail(m.id, true);
      if (detail) await checkGoals(m, detail);
      await announceFulltime(m, detail);
    }
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

    // Daily vote: post at VOTE_HOUR_UTC
    if (hourUtc >= VOTE_HOUR_UTC && hourUtc < VOTE_HOUR_UTC + 2) {
      await postDailyVote().catch(e => console.log('vote post err:', e.message));
    }
    // Close vote check
    await maybeCloseVote().catch(e => console.log('vote close err:', e.message));
    // Auto-repost active prompts if buried
    await maybeRepostVote().catch(e => console.log('repost vote err:', e.message));
    await maybeRepostPrediction().catch(e => console.log('repost pred err:', e.message));

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
// counter for repost-after-N-messages
let groupMsgCounterSinceVote = 0;
let groupMsgCounterSincePrediction = 0;
let cachedBotId = null;

bot.on('message', async (ctx, next) => {
  try {
    if (!ctx.chat || (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')) return next();
    if (!state.groupId) { state.groupId = ctx.chat.id; saveStateNow(); }

    // bump counters for repost logic - don't count the bot's own messages
    if (!cachedBotId) {
      try { cachedBotId = (await bot.telegram.getMe()).id; } catch (e) {}
    }
    if (ctx.from && ctx.from.id !== cachedBotId) {
      groupMsgCounterSinceVote += 1;
      groupMsgCounterSincePrediction += 1;
    }

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
  const matches = todayCache.data || await fetchTodayMatches();
  const live = matches.find(m => m.status === 'LIVE' || m.status === 'IN_PLAY' || m.status === 'PAUSED');
  if (!live) {
    return ctx.reply('no match live right now').then(s => {
      setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, s.message_id).catch(() => {}), 30000);
    }).catch(() => {});
  }
  const min = liveMinute(live);
  const text = scoreLine(live) + (min != null ? '\n<i>' + min + "'</i>" : '');
  try { await sendHTML(ctx.chat.id, text); } catch (e) {}
});

bot.command('today', async (ctx) => {
  const matches = todayCache.data || await fetchTodayMatches();
  if (!matches.length) {
    return ctx.reply('nothing on today').then(s => {
      setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, s.message_id).catch(() => {}), 30000);
    }).catch(() => {});
  }
  const lines = ['<b>' + E.ball + ' today</b>', ''];
  for (const m of matches) lines.push(fmtMatchLine(m));
  try { await sendHTML(ctx.chat.id, lines.join('\n')); } catch (e) {}
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
  try { await sendHTML(ctx.chat.id, fmtMatchLine(upcoming[0])); } catch (e) {}
});

// ---------- Admin commands ----------
bot.command('start', async (ctx) => {
  if (ctx.chat.type === 'private') {
    const userId = ctx.from.id;
    const u = state.userWallets[userId] = state.userWallets[userId] || {};
    u.username = ctx.from.username || ctx.from.first_name || ('user' + userId);

    if (u.wallet) {
      // already has wallet on file
      const h = await checkFwcHolder(u.wallet);
      const status = h.meetsGate
        ? E.check + ' you hold <b>' + fmtFwc(h.balanceFwc) + ' FWC</b>. you can vote and predict.'
        : E.warn + ' your wallet has <b>' + fmtFwc(h.balanceFwc) + ' FWC</b>. minimum is <b>' + fmtFwc(MIN_HOLD_FWC) + ' FWC</b>.';
      try {
        await sendHTML(ctx.chat.id,
          'hey ' + esc(ctx.from.first_name || 'there') + '! good to see you.\n\n' +
          'your wallet on file:\n<code>' + esc(u.wallet) + '</code>\n\n' + status + '\n\n' +
          'to change wallet, use /wallet\n' +
          'for commands: /help');
      } catch (e) {}
      return;
    }

    // no wallet yet - prompt for it
    u.awaitingFor = { type: 'register' };
    saveStateNow();
    try {
      await sendHTML(ctx.chat.id,
        'hey ' + esc(ctx.from.first_name || 'there') + '! welcome to FWC predictions.\n\n' +
        '<b>step 1: drop your BSC wallet</b>\n' +
        'paste a 0x... address here that holds at least <b>' + fmtFwc(MIN_HOLD_FWC) + ' FWC</b>.\n\n' +
        '<i>i\'ll check your bag and lock it in. one wallet per account, you can change it later with /wallet.</i>');
    } catch (e) { try { await ctx.reply('welcome. send your 0x... wallet to get started.'); } catch (e2) {} }
  }
});

bot.command('wallet', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try { await ctx.deleteMessage(); } catch (e) {}
    try {
      await bot.telegram.sendMessage(ctx.from.id, 'run /wallet here in DM, not in the group.');
    } catch (e) {}
    return;
  }
  const userId = ctx.from.id;
  const u = state.userWallets[userId] = state.userWallets[userId] || {};
  u.username = ctx.from.username || ctx.from.first_name || ('user' + userId);
  u.awaitingFor = { type: 'register' };
  saveStateNow();
  const current = u.wallet ? '\n\ncurrent wallet:\n<code>' + esc(u.wallet) + '</code>\n\nsending a new one will replace it.' : '';
  await sendHTML(ctx.chat.id,
    'paste a BSC wallet address (0x...) that holds at least <b>' + fmtFwc(MIN_HOLD_FWC) + ' FWC</b>.' + current);
});

bot.command('help', async (ctx) => {
  if (await isAdmin(ctx)) {
    await ctx.reply([
      'admin:',
      '/setup /instructions /settings /status',
      '/lock /unlock /autopilot_on /autopilot_off',
      '/predictions /rewardwallet /sendbatch',
      '/reset_state (DM only, danger)',
      '',
      'community:',
      '/match /today /next /mywallet /wallet'
    ].join('\n'));
  } else {
    await ctx.reply('/match /today /next /mywallet\n\ncheck pinned message for how to predict');
  }
});

function buildInstructionsText(botUsername) {
  const handle = botUsername ? '@' + botUsername : 'me';
  return [
    E.trophy + ' <b>FWC PREDICTIONS</b>',
    '',
    '<b>SETUP</b> (one time):',
    '1. hold <b>' + fmtFwc(MIN_HOLD_FWC) + ' FWC</b>',
    '2. DM ' + handle + ' \u2192 tap <b>Start</b> \u2192 send your wallet',
    '',
    '<b>EACH MATCH DAY:</b>',
    '\u2022 ' + VOTE_HOUR_UTC + 'am UTC \u2014 vote on the match',
    '\u2022 1h before kickoff \u2014 prediction pools open',
    '\u2022 kickoff \u2014 pools close, chat locks',
    '\u2022 full-time \u2014 winners split the pool',
    '',
    '<b>THE 3 POOLS:</b>',
    '\u2022 <b>EASY</b> \u2014 pick the winner',
    '\u2022 <b>MEDIUM</b> \u2014 winner + over/under 2.5 goals',
    '\u2022 <b>HARD</b> \u2014 half-time leader / full-time winner',
    '',
    '<b>DAILY POOL:</b> $' + EASY_POOL_USD + ' / $' + MEDIUM_POOL_USD + ' / $' + HARD_POOL_USD + '. bigger bag = bigger share.',
    '',
    '<i>community token. not affiliated. dyor.</i>'
  ].join('\n');
}

bot.command('reset_state', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return;
  if (ctx.chat.type !== 'private') {
    try { await ctx.deleteMessage(); } catch (e) {}
    try { await bot.telegram.sendMessage(ctx.from.id, 'run /reset_state in DM only'); } catch (e) {}
    return;
  }
  await sendHTML(ctx.chat.id,
    E.warn + ' <b>danger zone</b>\n\n' +
    'this wipes: wallets, predictions, votes, offenses, pending rewards, rollover, daily totals.\n' +
    'keeps: settings, groupId, autopilot flag.\n\n' +
    'a backup is saved to GitHub first.\n\n' +
    'are you sure?',
    Markup.inlineKeyboard([
      [Markup.button.callback(E.warn + ' yes, wipe data', 'RESET_CONFIRM')],
      [Markup.button.callback('cancel', 'RESET_CANCEL')]
    ]));
});

bot.action('RESET_CONFIRM', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('only owner');
  await ctx.answerCbQuery('wiping...');
  // force a backup now
  lastBackupAt = 0;
  await maybeBackup().catch(() => {});
  // wipe
  state.userWallets = {};
  state.predictions = {};
  state.predictionMsgs = {};
  state.pendingRewards = [];
  state.approvedRewards = [];
  state.dailyVote = {};
  state.dailyTotals = {};
  state.offenses = {};
  state.trackedMatches = {};
  state.rollover = { easy: 0, medium: 0, hard: 0 };
  state.schedulePostedFor = '';
  state.instructionsMsgId = null;
  await saveStateNow();
  try { await ctx.editMessageText(E.check + ' state wiped. ready for production.\n\nrun /setup in the new group when ready.'); } catch (e) {}
});

bot.action('RESET_CANCEL', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('only owner');
  await ctx.answerCbQuery('cancelled');
  try { await ctx.editMessageText('cancelled. nothing changed.'); } catch (e) {}
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
    'i need these admin rights: delete messages, restrict members, send messages, pin messages',
    '',
    'env vars on Render:',
    'FOOTBALL_DATA_KEYS, API_FOOTBALL_KEYS, LEAGUE, FWC_CONTRACT, REWARD_WALLET_KEY, DRY_RUN',
    '',
    'pools loaded: fd=' + fdPool.size() + ', af=' + afPool.size(),
    'mode: ' + (DRY_RUN ? 'DRY RUN' : 'LIVE'),
    'league: ' + LEAGUE,
    '',
    'when ready tap below'
  ].join('\n');
  await ctx.reply(text, Markup.inlineKeyboard([
    [Markup.button.callback('turn on autopilot', 'AP_ON')],
    [Markup.button.callback('post instructions', 'POST_INSTRUCTIONS')],
    [Markup.button.callback('settings', 'OPEN_SETTINGS')]
  ]));
});

bot.command('instructions', async (ctx) => {
  if (!await isAdmin(ctx)) return;
  await postInstructions(ctx.chat.id);
});

async function postInstructions(chatId) {
  let botUsername = '';
  try {
    const me = await bot.telegram.getMe();
    botUsername = me.username || '';
  } catch (e) {}
  const text = buildInstructionsText(botUsername);
  try {
    // unpin old instructions if exist
    if (state.instructionsMsgId) {
      try { await bot.telegram.unpinChatMessage(chatId, state.instructionsMsgId); } catch (e) {}
    }
    const sent = await sendHTML(chatId, text);
    state.instructionsMsgId = sent.message_id;
    await pinMessage(chatId, sent.message_id, true); // silent pin
    saveStateNow();
  } catch (e) { console.log('instructions err:', e.message); }
}

bot.action('POST_INSTRUCTIONS', async (ctx) => {
  if (!await isAdmin(ctx)) return ctx.answerCbQuery('admins only');
  await ctx.answerCbQuery('posting...');
  await postInstructions(ctx.chat.id);
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
  const dateKey = getDateKey();
  const dt = state.dailyTotals[dateKey] || { sentUSD: 0, matchesPaid: 0 };
  const price = await getFwcPriceUSD();
  const v = state.dailyVote[dateKey];
  const text = [
    '<b>status</b>',
    '',
    'league: ' + LEAGUE,
    'autopilot: ' + (state.autopilot ? 'on' : 'off'),
    'group: ' + (state.groupId || 'not set'),
    'fd keys: ' + fdPool.size() + ' (' + fdPool.available() + ' ready)',
    'af keys: ' + afPool.size() + ' (' + afPool.available() + ' ready)',
    'live matches: ' + liveMatchCount,
    'tracked: ' + Object.keys(state.trackedMatches).length,
    '',
    '<b>vote</b>',
    'today: ' + (v ? (v.closed ? 'closed, ' + v.selected.length + ' selected' : 'open, ' + Object.keys(v.votes).length + ' votes') : 'not posted yet'),
    '',
    '<b>rewards</b>',
    'mode: ' + (DRY_RUN ? 'DRY RUN' : 'LIVE'),
    'min hold to predict: ' + fmtFwc(MIN_HOLD_FWC) + ' FWC',
    'daily pool: $' + (EASY_POOL_USD + MEDIUM_POOL_USD + HARD_POOL_USD),
    'pending: ' + state.pendingRewards.filter(r => r.status === 'pending').length,
    'sent today: $' + dt.sentUSD.toFixed(2),
    'per-win cap: $' + PER_WIN_CAP_USD,
    'FWC price: $' + (price ? price.toFixed(8) : '?'),
    'contract: ' + (FWC_CONTRACT ? FWC_CONTRACT.slice(0, 10) + '...' : 'not set')
  ].join('\n');
  await sendHTML(ctx.chat.id, text);
});

bot.command('rewardwallet', async (ctx) => {
  if (!await isAdmin(ctx)) return;
  if (ctx.chat.type !== 'private') {
    return ctx.reply('run in DM only');
  }
  const bal = await getRewardWalletBalance();
  const price = await getFwcPriceUSD();
  const usdValue = price && bal.fwc !== '?' ? (parseFloat(bal.fwc) * price).toFixed(2) : '?';
  const text = [
    '<b>reward wallet</b>',
    '',
    'address: <code>' + esc(bal.address || 'not set') + '</code>',
    'FWC: ' + bal.fwc + ' (~$' + usdValue + ')',
    'BNB: ' + bal.bnb,
    'FWC price: $' + (price ? price.toFixed(8) : '?')
  ].join('\n');
  await sendHTML(ctx.chat.id, text);
});

bot.command('sendbatch', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return;
  if (ctx.chat.type !== 'private') return ctx.reply('DM only');
  await sendDailyBatchNow();
});

bot.command('predictions', async (ctx) => {
  if (!await isAdmin(ctx)) return;
  const matches = todayCache.data || [];
  if (!matches.length) return ctx.reply('no matches today');
  const lines = ['<b>predictions today</b>', ''];
  for (const m of matches) {
    const id = String(m.id);
    const p = state.predictions[id] || { quick: {}, pro: {}, exact: {} };
    const q = Object.keys(p.quick).length;
    const pr = Object.keys(p.pro).length;
    const e = Object.keys(p.exact).length;
    lines.push(esc(teamName(m.homeTeam)) + ' vs ' + esc(teamName(m.awayTeam)));
    lines.push('  q:' + q + ' p:' + pr + ' e:' + e);
  }
  await sendHTML(ctx.chat.id, lines.join('\n'));
});

bot.command('mywallet', async (ctx) => {
  const u = state.userWallets[ctx.from.id];
  if (!u || !u.wallet) {
    return ctx.reply('no wallet on file. submit one by tapping a prediction first.');
  }
  if (ctx.chat.type !== 'private') {
    try { await ctx.deleteMessage(); } catch (e) {}
    try { await bot.telegram.sendMessage(ctx.from.id, 'your wallet: <code>' + esc(u.wallet) + '</code>', { parse_mode: 'HTML' }); }
    catch (e) {}
    return;
  }
  await sendHTML(ctx.chat.id, 'your wallet: <code>' + esc(u.wallet) + '</code>');
});

// SIMULATION TEST COMMAND - admin only
// Replays a finished match in fast-forward without touching real state or locking the group
bot.command('test_match', async (ctx) => {
  if (!await isAdmin(ctx)) return;
  const args = ctx.message.text.split(' ').slice(1);
  const groupId = ctx.chat.id;

  // sample match data - real 2022 World Cup Final Argentina vs France
  const sampleMatch = {
    id: 'TEST_DEMO',
    utcDate: new Date(Date.now() - 60000).toISOString(),
    homeTeam: { id: 1, name: 'Argentina', shortName: 'Argentina', tla: 'ARG' },
    awayTeam: { id: 2, name: 'France', shortName: 'France', tla: 'FRA' }
  };
  const sampleGoals = [
    { minute: 23, scorer: { name: 'Lionel Messi' }, team: { id: 1 } },
    { minute: 36, scorer: { name: 'Angel Di Maria' }, team: { id: 1 } },
    { minute: 80, scorer: { name: 'Kylian Mbappe' }, team: { id: 2 } },
    { minute: 81, scorer: { name: 'Kylian Mbappe' }, team: { id: 2 } },
    { minute: 108, scorer: { name: 'Lionel Messi' }, team: { id: 1 } },
    { minute: 118, scorer: { name: 'Kylian Mbappe' }, team: { id: 2 } }
  ];

  await ctx.reply('simulation starting (no group lock, no state writes)');

  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const hf = teamFlag(sampleMatch.homeTeam), af = teamFlag(sampleMatch.awayTeam);
  const hn = teamName(sampleMatch.homeTeam), an = teamName(sampleMatch.awayTeam);

  // schedule preview (silent pin would happen here in real flow)
  await delay(1500);
  await sendHTML(groupId, '<b>' + E.ball + ' coming up</b>\n\n' + hf + ' <b>' + esc(hn) + '</b> vs <b>' + esc(an) + '</b> ' + af);

  // kickoff
  await delay(2500);
  await sendHTML(groupId,
    '<b>' + E.lock + ' KICKOFF</b>\n\n' +
    hf + ' <b>' + esc(hn) + '</b> vs <b>' + esc(an) + '</b> ' + af + '\n' +
    pick(KICKOFF_LINES));

  // goals (compressed timing)
  let runningHome = 0, runningAway = 0;
  for (let i = 0; i < sampleGoals.length; i++) {
    const g = sampleGoals[i];
    if (g.team.id === 1) runningHome++; else runningAway++;

    // halftime check at minute 45+
    if (g.minute > 45 && i > 0 && sampleGoals[i - 1].minute <= 45) {
      await delay(3000);
      await sendHTML(groupId, '<b>' + E.unlock + ' HALF-TIME</b>\n\n' +
        esc(hn) + '  <b>' + runningHome + ' - ' + runningAway + '</b>  ' + esc(an) + '\n' +
        pick(HT_LINES));
      await delay(2500);
      await sendHTML(groupId, '<b>' + E.lock + ' SECOND HALF</b>\n' + pick(SH_LINES));
    }

    await delay(3500);
    const scoringTeam = g.team.id === 1 ? hn : an;
    const scoringFlag = g.team.id === 1 ? hf : af;
    await sendHTML(groupId,
      '<b>' + pick(GOAL_OPENERS) + '</b>\n\n' +
      scoringFlag + ' <b>' + esc(g.scorer.name) + '</b> <i>' + g.minute + "'</i>\n" +
      '<i>for ' + esc(scoringTeam) + '</i>\n\n' +
      esc(hn) + '  <b>' + runningHome + ' - ' + runningAway + '</b>  ' + esc(an));
  }

  // fulltime
  await delay(3000);
  const home = [], away = [];
  for (const g of sampleGoals) {
    const line = esc(g.scorer.name) + ' <i>' + g.minute + "'</i>";
    if (g.team.id === 1) home.push(line); else away.push(line);
  }
  await sendHTML(groupId,
    '<b>' + E.unlock + ' FULL TIME ' + E.party + '</b>\n\n' +
    esc(hn) + '  <b>' + runningHome + ' - ' + runningAway + '</b>  ' + esc(an) + '\n\n' +
    '<b>' + esc(hn) + '</b>\n' + home.join(', ') + '\n\n' +
    '<b>' + esc(an) + '</b>\n' + away.join(', ') + '\n\n' +
    pick(FT_LINES));

  await delay(1500);
  await ctx.reply('simulation done. no state was modified. no api calls used.');
});

async function showSettings(ctx) {
  const s = state.settings;
  const on = v => v ? 'on' : 'off';
  const text = [
    'settings',
    '',
    'autopilot: ' + on(state.autopilot),
    'goal alerts: ' + on(s.goalAlerts),
    'predictions: ' + on(s.predictions),
    'polls (legacy): ' + on(s.polls),
    'auto lock: ' + on(s.autoLock),
    'anti link: ' + on(s.antiLink),
    'anti forward: ' + on(s.antiForward),
    'anti ext tag: ' + on(s.antiExternalTag),
    'allow x links: ' + on(s.allowXLinks)
  ].join('\n');
  const mk = (k, label, val) => Markup.button.callback((val ? '[on]' : '[off]') + ' ' + label, 'T_' + k);
  const kb = Markup.inlineKeyboard([
    [mk('autopilot', 'autopilot', state.autopilot)],
    [mk('goalAlerts', 'goals', s.goalAlerts), mk('predictions', 'predictions', s.predictions)],
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

// ============================================================
// WEBSITE PROXY ENDPOINTS for fifa26.website
// Exposes WC data to the website without leaking API keys.
// Caches aggressively - one fetch serves thousands of visitors.
// ============================================================

// CORS for fifa26.website only (lock down origin)
const SITE_ORIGINS = new Set([
  'https://fifa26.website',
  'https://www.fifa26.website'
]);
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/fwc/')) return next();
  const origin = req.headers.origin || '';
  if (SITE_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// In-memory caches (60s TTL by default, longer for static-ish endpoints)
const proxyCache = {
  matches: { data: null, at: 0, ttl: 60000 },     // all WC matches - 60s
  live: { data: null, at: 0, ttl: 30000 },        // live match - 30s
  champion: { data: null, at: 0, ttl: 300000 }    // champion - 5min
};

function cacheFresh(slot) {
  return slot.data && (Date.now() - slot.at) < slot.ttl;
}

// Pull all WC matches via AF (the $19 plan). Falls back to FD if AF burns.
async function proxyFetchAllMatches() {
  // Try AF first - season 2026, league 1 (FIFA World Cup)
  const af = await afGet('/fixtures?league=1&season=2026');
  if (af && af.response && af.response.length) {
    return af.response.map(f => ({
      id: f.fixture.id,
      utcDate: f.fixture.date,
      status: shapeAfStatus(f.fixture.status.short),
      stage: f.league.round,
      venue: f.fixture.venue && (f.fixture.venue.name + (f.fixture.venue.city ? ' \u00b7 ' + f.fixture.venue.city : '')),
      homeTeam: { name: f.teams.home.name, tla: null },
      awayTeam: { name: f.teams.away.name, tla: null },
      score: {
        fullTime: { home: f.goals.home, away: f.goals.away },
        halfTime: { home: f.score.halftime && f.score.halftime.home, away: f.score.halftime && f.score.halftime.away }
      },
      minute: f.fixture.status.elapsed || null
    }));
  }
  // FD backup
  const fd = await fdGet('/competitions/WC/matches');
  if (fd && fd.matches) return fd.matches;
  return null;
}

// Map AF status codes to website-friendly statuses (matches what loadTournamentData expects)
function shapeAfStatus(short) {
  if (short === '1H' || short === '2H' || short === 'ET' || short === 'BT' || short === 'P' || short === 'LIVE') return 'IN_PLAY';
  if (short === 'HT') return 'PAUSED';
  if (short === 'FT' || short === 'AET' || short === 'PEN') return 'FINISHED';
  if (short === 'NS' || short === 'TBD') return 'SCHEDULED';
  if (short === 'PST' || short === 'CANC' || short === 'SUSP') return 'POSTPONED';
  if (short === 'AWD' || short === 'WO') return 'FINISHED';
  return 'TIMED';
}

// GET /api/fwc/matches - all WC fixtures with live scores
app.get('/api/fwc/matches', async (req, res) => {
  if (cacheFresh(proxyCache.matches)) {
    return res.json({ matches: proxyCache.matches.data, cached: true, age: Math.floor((Date.now() - proxyCache.matches.at) / 1000) });
  }
  const matches = await proxyFetchAllMatches();
  if (matches) {
    proxyCache.matches.data = matches;
    proxyCache.matches.at = Date.now();
    return res.json({ matches, cached: false, age: 0 });
  }
  // Serve stale if both APIs fail
  if (proxyCache.matches.data) {
    return res.json({ matches: proxyCache.matches.data, cached: true, stale: true, age: Math.floor((Date.now() - proxyCache.matches.at) / 1000) });
  }
  res.status(503).json({ error: 'data unavailable' });
});

// GET /api/fwc/live - only the currently live match if any
app.get('/api/fwc/live', async (req, res) => {
  if (cacheFresh(proxyCache.live)) {
    return res.json({ match: proxyCache.live.data, cached: true });
  }
  // Reuse matches cache or fetch fresh
  let matches = cacheFresh(proxyCache.matches) ? proxyCache.matches.data : await proxyFetchAllMatches();
  if (matches) {
    if (!cacheFresh(proxyCache.matches)) {
      proxyCache.matches.data = matches;
      proxyCache.matches.at = Date.now();
    }
    const live = matches.find(m => m.status === 'IN_PLAY' || m.status === 'PAUSED' || m.status === 'LIVE') || null;
    proxyCache.live.data = live;
    proxyCache.live.at = Date.now();
    return res.json({ match: live, cached: false });
  }
  res.status(503).json({ error: 'data unavailable' });
});

// GET /api/fwc/champion - returns winner once final is decided
app.get('/api/fwc/champion', async (req, res) => {
  if (cacheFresh(proxyCache.champion)) {
    return res.json({ champion: proxyCache.champion.data, cached: true });
  }
  let matches = cacheFresh(proxyCache.matches) ? proxyCache.matches.data : await proxyFetchAllMatches();
  if (matches) {
    if (!cacheFresh(proxyCache.matches)) {
      proxyCache.matches.data = matches;
      proxyCache.matches.at = Date.now();
    }
    const finalM = matches.find(m =>
      (m.stage && /final/i.test(m.stage) && !/semi|quarter|3rd|third/i.test(m.stage)) ||
      (m.utcDate && m.utcDate.startsWith('2026-07-19'))
    );
    let champion = null;
    if (finalM && finalM.status === 'FINISHED') {
      const hs = finalM.score && finalM.score.fullTime && finalM.score.fullTime.home;
      const as = finalM.score && finalM.score.fullTime && finalM.score.fullTime.away;
      if (hs != null && as != null) {
        if (hs > as) champion = { name: finalM.homeTeam.name, opponent: finalM.awayTeam.name, score: hs + ' - ' + as };
        else if (as > hs) champion = { name: finalM.awayTeam.name, opponent: finalM.homeTeam.name, score: as + ' - ' + hs };
      }
    }
    proxyCache.champion.data = champion;
    proxyCache.champion.at = Date.now();
    return res.json({ champion, cached: false });
  }
  res.status(503).json({ error: 'data unavailable' });
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
app.use(bot.webhookCallback(SECRET_PATH));

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
