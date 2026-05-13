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
  warn: '\u26A0\uFE0F'
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
const DAILY_REWARD_CAP_USD = parseFloat(process.env.DAILY_REWARD_CAP_USD || '100');
const PER_WIN_CAP_USD = parseFloat(process.env.PER_WIN_CAP_USD || '15');
const QUICK_BASE_USD = parseFloat(process.env.QUICK_BASE_USD || '1');
const PRO_BASE_USD = parseFloat(process.env.PRO_BASE_USD || '3');
const HOLDER_MULTIPLIER = parseFloat(process.env.HOLDER_MULTIPLIER || '2');

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
  predictions: {},    // matchId -> { quick: { userId -> {choice, wallet, ts} }, pro: { userId -> {winner, goals, wallet, ts} } }
  predictionMsgs: {}, // matchId -> { quickMsgId, proMsgId }
  userWallets: {},    // userId -> { wallet, awaitingFor: {matchId, pool, choice}, lastSet }
  pendingRewards: [], // [{matchId, userId, username, wallet, amountUSD, amountFWC, pool, isHolder, status, txHash}]
  approvedRewards: [], // historical sent rewards
  dailyTotals: {}     // dateStr -> {sentUSD, attemptedUSD}
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

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  const data = await fdGet('/competitions/' + LEAGUE + '/matches?dateFrom=' + today + '&dateTo=' + today);
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

// ---------- Send + Pin helpers ----------
async function sendHTML(chatId, text, opts) {
  const o = Object.assign({ parse_mode: 'HTML', disable_web_page_preview: true }, opts || {});
  return bot.telegram.sendMessage(chatId, text, o);
}

async function pinMessage(chatId, messageId, silent) {
  try {
    await bot.telegram.pinChatMessage(chatId, messageId, { disable_notification: !!silent });
    return true;
  } catch (err) { console.log('pin err:', err.message); return false; }
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
  if (!FWC_CONTRACT || !isValidAddress(wallet)) return { isHolder: false, balance: '0' };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const provider = getProvider();
      const contract = new ethers.Contract(FWC_CONTRACT, ERC20_ABI, provider);
      const bal = await contract.balanceOf(wallet);
      const isHolder = bal.gt(0);
      return { isHolder, balance: ethers.utils.formatUnits(bal, FWC_DECIMALS) };
    } catch (err) {
      console.log('holder check attempt ' + attempt + ' err:', err.message);
    }
  }
  return { isHolder: false, balance: '0' };
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
    gasLimit: 100000,
    gasPrice: ethers.utils.parseUnits('3', 'gwei')
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
  'we are underway. chat locked',
  'kickoff! ball is rolling',
  'here we go',
  'underway. talk at half-time',
  'and we are off'
];
const HT_LINES = [
  'half-time. chat is open',
  'break time. take a breather',
  'first half done. talk among yourselves',
  'half-time whistle. chat unlocked'
];
const FT_LINES = ['full time ' + E.party, 'final whistle ' + E.party, 'thats it. all over', 'match over'];
const SH_LINES = ['second half. chat locked again', 'back underway', 'they are back out'];
const PREGOAL_LINES = ['something happened... ' + E.ball, 'goal incoming ' + E.fire, 'score change detected'];

// ---------- Formatting ----------
function fmtMatchLine(m) {
  const h = m.homeTeam || {}, a = m.awayTeam || {};
  const t = new Date(m.utcDate);
  const time = String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0');
  return '<b>' + time + ' UTC</b>  ' + teamFlag(h) + ' ' + esc(teamName(h)) + ' vs ' + esc(teamName(a)) + ' ' + teamFlag(a);
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
  return esc(teamName(m.homeTeam)) + '  <b>' + fmtScore(m) + '</b>  ' + esc(teamName(m.awayTeam));
}

function scoreLinePlain(m) {
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
  const lines = ['<b>' + E.ball + ' today on the pitch</b>', ''];
  for (const m of matches) lines.push(fmtMatchLine(m));
  try {
    const sent = await sendHTML(state.groupId, lines.join('\n'));
    await pinMessage(state.groupId, sent.message_id, true); // silent pin
  } catch (e) {}
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
  const id = String(m.id);
  if (!state.trackedMatches[id]) state.trackedMatches[id] = {};
  const rec = state.trackedMatches[id];
  if (!state.predictionMsgs[id]) state.predictionMsgs[id] = {};
  if (state.predictionMsgs[id].quickMsgId && state.predictionMsgs[id].proMsgId) return;
  const ko = new Date(m.utcDate).getTime();
  const diff = ko - Date.now();
  if (diff > 60 * 60 * 1000 || diff < 0) return;

  const h = m.homeTeam || {}, a = m.awayTeam || {};
  const hf = teamFlag(h), af = teamFlag(a);
  const hn = teamName(h), an = teamName(a);
  if (!state.predictions[id]) state.predictions[id] = { quick: {}, pro: {} };

  // Quick pool message
  if (!state.predictionMsgs[id].quickMsgId) {
    const quickText = '<b>' + E.trophy + ' QUICK PICK</b>\n\n' +
      hf + ' <b>' + esc(hn) + '</b> vs <b>' + esc(an) + '</b> ' + af + '\n' +
      'pick a winner. correct picks = base reward\n' +
      '<i>holders earn 2x</i>';
    const quickKb = Markup.inlineKeyboard([
      [Markup.button.callback(hf + ' ' + hn, 'PR_' + id + '_q_H')],
      [Markup.button.callback('draw', 'PR_' + id + '_q_D')],
      [Markup.button.callback(an + ' ' + af, 'PR_' + id + '_q_A')]
    ]);
    try {
      const sent = await sendHTML(state.groupId, quickText, quickKb);
      state.predictionMsgs[id].quickMsgId = sent.message_id;
    } catch (e) { console.log('quick pred err:', e.message); }
  }

  // Pro pool message
  if (!state.predictionMsgs[id].proMsgId) {
    const proText = '<b>' + E.fire + ' PRO PICK</b>\n\n' +
      hf + ' <b>' + esc(hn) + '</b> vs <b>' + esc(an) + '</b> ' + af + '\n' +
      'pick a winner AND over/under 2.5 goals\n' +
      'harder. bigger reward. <i>holders earn 2x</i>';
    const proKb = Markup.inlineKeyboard([
      [Markup.button.callback(hf + ' ' + hn + ' + Over', 'PR_' + id + '_p_HO')],
      [Markup.button.callback(hf + ' ' + hn + ' + Under', 'PR_' + id + '_p_HU')],
      [Markup.button.callback('Draw + Over', 'PR_' + id + '_p_DO')],
      [Markup.button.callback('Draw + Under', 'PR_' + id + '_p_DU')],
      [Markup.button.callback(an + ' ' + af + ' + Over', 'PR_' + id + '_p_AO')],
      [Markup.button.callback(an + ' ' + af + ' + Under', 'PR_' + id + '_p_AU')]
    ]);
    try {
      const sent = await sendHTML(state.groupId, proText, proKb);
      state.predictionMsgs[id].proMsgId = sent.message_id;
    } catch (e) { console.log('pro pred err:', e.message); }
  }
  saveStateNow();
}

// ---------- Prediction callback handlers ----------
// PR_<matchId>_<pool>_<choice>
bot.action(/^PR_(.+)_(q|p)_(.+)$/, async (ctx) => {
  const matchId = ctx.match[1];
  const pool = ctx.match[2] === 'q' ? 'quick' : 'pro';
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

  // ensure user not already entered in other pool for this match
  if (!state.predictions[matchId]) state.predictions[matchId] = { quick: {}, pro: {} };
  const otherPool = pool === 'quick' ? 'pro' : 'quick';
  if (state.predictions[matchId][otherPool] && state.predictions[matchId][otherPool][userId]) {
    return ctx.answerCbQuery('you already entered the ' + otherPool + ' pool for this match');
  }
  // ensure not already locked in this pool
  if (state.predictions[matchId][pool][userId] && state.predictions[matchId][pool][userId].locked) {
    return ctx.answerCbQuery('your pick is locked');
  }

  // save pending pick, request wallet via DM
  state.userWallets[userId] = state.userWallets[userId] || {};
  state.userWallets[userId].awaitingFor = { matchId, pool, choice };
  state.userWallets[userId].username = ctx.from.username || ctx.from.first_name || ('user' + userId);
  saveStateNow();

  // try DM
  try {
    await bot.telegram.sendMessage(userId,
      'got your pick: <b>' + esc(decodeChoice(choice, pool, match)) + '</b>\n\n' +
      'now send me your BSC wallet address (0x...) to lock it in.\n' +
      '<i>same wallet for future matches too</i>',
      { parse_mode: 'HTML' });
    return ctx.answerCbQuery('check your DM to send wallet');
  } catch (e) {
    return ctx.answerCbQuery('open a DM with me first, then tap again', { show_alert: true });
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
  // pro: 2-char like HO, AU, DO
  const winner = code[0] === 'H' ? hn : code[0] === 'A' ? an : 'Draw';
  const oudir = code[1] === 'O' ? 'Over 2.5' : 'Under 2.5';
  return winner + ' + ' + oudir;
}

// ---------- DM wallet handler ----------
bot.on('text', async (ctx, next) => {
  // private chat wallet submission
  if (ctx.chat.type !== 'private') return next();
  if (ctx.message.text.startsWith('/')) return next();
  const userId = ctx.from.id;
  const u = state.userWallets[userId];
  if (!u || !u.awaitingFor) return next();
  const wallet = ctx.message.text.trim();
  if (!isValidAddress(wallet)) {
    return ctx.reply('that does not look like a valid BSC wallet address. paste a 0x address like 0xAbC...');
  }
  const { matchId, pool, choice } = u.awaitingFor;
  if (!state.predictions[matchId]) state.predictions[matchId] = { quick: {}, pro: {} };
  state.predictions[matchId][pool][userId] = {
    choice,
    wallet: wallet.toLowerCase(),
    username: u.username,
    ts: Date.now(),
    locked: true
  };
  u.wallet = wallet.toLowerCase();
  u.lastSet = Date.now();
  u.awaitingFor = null;
  saveStateNow();
  await ctx.reply(E.check + ' locked in.\nwallet: <code>' + esc(wallet) + '</code>', { parse_mode: 'HTML' });
});

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
                         Object.keys((state.predictions[id] && state.predictions[id].pro) || {}).length;
    if (pm.quickMsgId) {
      try {
        await bot.telegram.editMessageReplyMarkup(state.groupId, pm.quickMsgId, undefined, { inline_keyboard: [] });
      } catch (e) {}
    }
    if (pm.proMsgId) {
      try {
        await bot.telegram.editMessageReplyMarkup(state.groupId, pm.proMsgId, undefined, { inline_keyboard: [] });
      } catch (e) {}
    }
    if (totalEntries > 0) {
      try { await sendHTML(state.groupId, '<b>predictions locked.</b> <i>' + totalEntries + ' entries</i>'); } catch (e) {}
    }
  }
  if (state.settings.autoLock) await setGroupLocked(state.groupId, true);
  const hf = teamFlag(m.homeTeam), af = teamFlag(m.awayTeam);
  const text = '<b>' + E.lock + ' KICKOFF</b>\n\n' +
    hf + ' <b>' + esc(teamName(m.homeTeam)) + '</b> vs <b>' + esc(teamName(m.awayTeam)) + '</b> ' + af + '\n' +
    pick(KICKOFF_LINES);
  try {
    const sent = await sendHTML(state.groupId, text);
    await pinMessage(state.groupId, sent.message_id, false);
  } catch (e) {}
  rec.kickoffSent = true;
  saveStateNow();
}

async function announceHalftime(m) {
  const id = String(m.id);
  const rec = state.trackedMatches[id];
  if (rec.halftimeSent) return;
  if (state.settings.autoLock) await setGroupLocked(state.groupId, false);
  const text = '<b>' + E.unlock + ' HALF-TIME</b>\n\n' + scoreLine(m) + '\n' + pick(HT_LINES);
  try { await sendHTML(state.groupId, text); } catch (e) {}
  rec.halftimeSent = true;
  saveStateNow();
}

async function announceSecondHalf(m) {
  const id = String(m.id);
  const rec = state.trackedMatches[id];
  if (rec.secondHalfSent) return;
  if (state.settings.autoLock) await setGroupLocked(state.groupId, true);
  const text = '<b>' + E.lock + ' SECOND HALF</b>\n' + pick(SH_LINES);
  try { await sendHTML(state.groupId, text); } catch (e) {}
  rec.secondHalfSent = true;
  saveStateNow();
}

async function announceFulltime(m, detail) {
  const id = String(m.id);
  const rec = state.trackedMatches[id];
  if (rec.fulltimeSent) return;
  if (state.settings.autoLock) await setGroupLocked(state.groupId, false);
  const lines = ['<b>' + E.unlock + ' FULL TIME ' + E.party + '</b>', '', scoreLine(m)];
  const goals = (detail && detail.goals) || m.goals || [];
  if (goals.length) {
    const home = [], away = [];
    for (const g of goals) {
      const who = (g.scorer && g.scorer.name) || '?';
      const min = (g.minute != null ? g.minute + "'" : '');
      const line = esc(who) + (min ? ' <i>' + min + '</i>' : '');
      const teamId = g.team && g.team.id;
      if (teamId === (m.homeTeam && m.homeTeam.id)) home.push(line);
      else if (teamId === (m.awayTeam && m.awayTeam.id)) away.push(line);
    }
    if (home.length || away.length) {
      lines.push('');
      lines.push('<b>' + esc(teamName(m.homeTeam)) + '</b>');
      lines.push(home.join(', ') || '-');
      lines.push('');
      lines.push('<b>' + esc(teamName(m.awayTeam)) + '</b>');
      lines.push(away.join(', ') || '-');
    }
  }
  lines.push('');
  lines.push(pick(FT_LINES));
  try {
    const sent = await sendHTML(state.groupId, lines.join('\n'));
    await pinMessage(state.groupId, sent.message_id, false); // loud pin
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

async function calculateWinnersForMatch(m, detail) {
  const id = String(m.id);
  if (!state.predictions[id]) return;
  const rec = state.trackedMatches[id];
  if (rec.winnersCalculated) return;
  rec.winnersCalculated = true;

  // determine actual outcome
  const score = fmtScoreObj(detail || m);
  const homeScore = score.home || 0;
  const awayScore = score.away || 0;
  const totalGoals = homeScore + awayScore;
  const actualWinner = homeScore > awayScore ? 'H' : awayScore > homeScore ? 'A' : 'D';
  const actualOU = totalGoals > 2.5 ? 'O' : 'U';

  // find correct quick predictions
  const quickCorrect = [];
  for (const userId in (state.predictions[id].quick || {})) {
    const p = state.predictions[id].quick[userId];
    if (p.choice === actualWinner) quickCorrect.push({ userId, ...p });
  }
  // find correct pro predictions
  const proCorrect = [];
  for (const userId in (state.predictions[id].pro || {})) {
    const p = state.predictions[id].pro[userId];
    if (p.choice && p.choice[0] === actualWinner && p.choice[1] === actualOU) {
      proCorrect.push({ userId, ...p });
    }
  }

  // pick winners (one per pool if any correct)
  const winners = [];
  if (quickCorrect.length) winners.push({ pool: 'quick', winner: pickFromArray(quickCorrect) });
  if (proCorrect.length) winners.push({ pool: 'pro', winner: pickFromArray(proCorrect) });

  // post summary to group
  const lines = ['<b>' + E.trophy + ' prediction results</b>', ''];
  lines.push('outcome: ' + (actualWinner === 'H' ? teamName(m.homeTeam) : actualWinner === 'A' ? teamName(m.awayTeam) : 'Draw') +
    ' (' + (actualOU === 'O' ? 'over' : 'under') + ' 2.5)');
  lines.push('');
  lines.push('quick pool: ' + Object.keys(state.predictions[id].quick || {}).length + ' entries, ' + quickCorrect.length + ' correct');
  lines.push('pro pool: ' + Object.keys(state.predictions[id].pro || {}).length + ' entries, ' + proCorrect.length + ' correct');
  if (winners.length) {
    lines.push('');
    for (const w of winners) {
      const name = w.winner.username ? '@' + w.winner.username : 'user';
      lines.push('<b>' + (w.pool === 'quick' ? 'quick' : 'pro') + ' winner:</b> ' + esc(name));
    }
    lines.push('');
    lines.push('<i>rewards pending review</i>');
  } else {
    lines.push('');
    lines.push('<i>no correct predictions this match</i>');
  }
  try { await sendHTML(state.groupId, lines.join('\n')); } catch (e) {}

  // build pending rewards entries
  const price = await getFwcPriceUSD();
  for (const w of winners) {
    const base = w.pool === 'quick' ? QUICK_BASE_USD : PRO_BASE_USD;
    const holderInfo = await checkFwcHolder(w.winner.wallet);
    const multiplier = holderInfo.isHolder ? HOLDER_MULTIPLIER : 1;
    let usd = base * multiplier;
    if (usd > PER_WIN_CAP_USD) usd = PER_WIN_CAP_USD;
    const fwc = usdToFwc(usd, price);
    state.pendingRewards.push({
      matchId: id,
      matchLabel: teamName(m.homeTeam) + ' vs ' + teamName(m.awayTeam),
      userId: w.winner.userId,
      username: w.winner.username,
      wallet: w.winner.wallet,
      pool: w.pool,
      isHolder: holderInfo.isHolder,
      holderBalance: holderInfo.balance,
      amountUSD: usd,
      amountFWC: fwc,
      priceAtCalc: price,
      createdAt: Date.now(),
      status: 'pending'
    });
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
  const lines = ['<b>' + E.money + ' reward batch</b>', ''];
  lines.push(pending.length + ' winners | total $' + totalUsd.toFixed(2) + ' | ' + totalFwc.toFixed(2) + ' FWC');
  lines.push('');
  pending.forEach((r, i) => {
    lines.push('<b>' + (i + 1) + '. ' + esc(r.matchLabel) + '</b>');
    lines.push('  pool: ' + r.pool + (r.isHolder ? ' | holder ' + E.check : ''));
    lines.push('  winner: @' + esc(r.username || ('user' + r.userId)));
    lines.push('  wallet: <code>' + esc(r.wallet) + '</code>');
    lines.push('  reward: $' + r.amountUSD.toFixed(2) + ' = ' + r.amountFWC.toFixed(2) + ' FWC');
    lines.push('');
  });
  lines.push(DRY_RUN ? '<i>DRY RUN mode is ON. transactions will be simulated.</i>' : '<b>LIVE mode.</b> approve will send real FWC.');

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(E.check + ' approve all', 'BATCH_APPROVE_ALL')],
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
  // list with per-item reject buttons
  const pending = state.pendingRewards.filter(r => r.status === 'pending');
  if (!pending.length) return;
  const rows = pending.map((r, i) => ([
    Markup.button.callback(E.cross + ' #' + (i + 1) + ' ' + (r.username || 'user'), 'REJ_' + (state.pendingRewards.indexOf(r)))
  ]));
  rows.push([Markup.button.callback(E.check + ' approve remaining', 'BATCH_APPROVE_ALL')]);
  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: rows.map(r => r.map(b => b)) });
  } catch (e) {}
});

bot.action(/^REJ_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('only owner');
  const idx = parseInt(ctx.match[1], 10);
  if (state.pendingRewards[idx]) {
    state.pendingRewards[idx].status = 'rejected';
    saveStateNow();
    await ctx.answerCbQuery('rejected #' + (idx + 1));
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

  // daily cap check
  const dateKey = new Date().toISOString().slice(0, 10);
  if (!state.dailyTotals[dateKey]) state.dailyTotals[dateKey] = { sentUSD: 0, attemptedUSD: 0 };
  let projected = state.dailyTotals[dateKey].sentUSD;
  for (const r of pending) projected += r.amountUSD;
  if (projected > DAILY_REWARD_CAP_USD) {
    try { await ctx.reply(E.warn + ' daily cap $' + DAILY_REWARD_CAP_USD + ' would be exceeded ($' + projected.toFixed(2) + '). aborting batch.'); } catch (e) {}
    return;
  }

  let okCount = 0, failCount = 0;
  const results = [];
  for (const r of pending) {
    try {
      // per-win cap belt-and-suspenders
      if (r.amountUSD > PER_WIN_CAP_USD) {
        r.status = 'rejected_cap';
        results.push('cap reject ' + (r.username || 'user'));
        continue;
      }
      const sendRes = await sendFwcReward(r.wallet, r.amountFWC);
      r.status = sendRes.dryRun ? 'dry_sent' : 'sent';
      r.txHash = sendRes.txHash;
      r.sentAt = Date.now();
      state.dailyTotals[dateKey].sentUSD += r.amountUSD;
      state.approvedRewards.push(r);
      okCount++;
      results.push((sendRes.dryRun ? 'DRY ' : '') + 'sent ' + r.amountFWC.toFixed(2) + ' FWC to @' + (r.username || 'user') + ' tx:' + sendRes.txHash.slice(0, 14) + '...');
      // notify winner in DM
      try {
        await bot.telegram.sendMessage(r.userId,
          (sendRes.dryRun ? '<b>[DRY RUN]</b> ' : '') +
          'congrats! ' + r.amountFWC.toFixed(2) + ' FWC sent to your wallet\n' +
          'tx: <code>' + esc(sendRes.txHash) + '</code>',
          { parse_mode: 'HTML' });
      } catch (e) {}
    } catch (err) {
      r.status = 'failed';
      r.error = err.message;
      failCount++;
      results.push('FAIL ' + (r.username || 'user') + ': ' + err.message);
    }
  }
  // remove processed from pending
  state.pendingRewards = state.pendingRewards.filter(r => r.status === 'pending');
  saveStateNow();

  const summary = '<b>batch result</b>\n\n' +
    okCount + ' sent, ' + failCount + ' failed\n\n' +
    '<pre>' + esc(results.join('\n')) + '</pre>';
  try { await ctx.reply(summary, { parse_mode: 'HTML' }); } catch (e) {}
}

// daily batch check on tick
setInterval(maybeSendDailyBatch, 10 * 60 * 1000); // every 10 min

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
    let scoringFlag = '';
    if (g.team && g.team.id === (m.homeTeam && m.homeTeam.id)) { scoringTeam = teamName(m.homeTeam); scoringFlag = teamFlag(m.homeTeam); }
    else if (g.team && g.team.id === (m.awayTeam && m.awayTeam.id)) { scoringTeam = teamName(m.awayTeam); scoringFlag = teamFlag(m.awayTeam); }

    const text = '<b>' + pick(GOAL_OPENERS) + '</b>\n\n' +
      scoringFlag + ' <b>' + esc(scorer) + '</b> <i>' + min + '</i>' +
      (scoringTeam ? '\n<i>for ' + esc(scoringTeam) + '</i>' : '') + '\n\n' +
      scoreLine(m);
    try { await sendHTML(state.groupId, text); } catch (e) {}
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
      const text = '<b>' + pick(PREGOAL_LINES) + '</b>\n\n' + scoreLine(detail || m) + (min ? '\n<i>' + min + "'</i>" : '');
      try { await sendHTML(state.groupId, text); } catch (e) {}
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
    await ctx.reply('add me to your group, make me admin, then /setup');
  }
});

bot.command('help', async (ctx) => {
  if (await isAdmin(ctx)) {
    await ctx.reply([
      'admin:',
      '/setup /settings /status /lock /unlock',
      '/autopilot_on /autopilot_off',
      '/predictions /rewardwallet /sendbatch',
      '',
      'community:',
      '/match /today /next /mywallet'
    ].join('\n'));
  } else {
    await ctx.reply('/match /today /next /mywallet');
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
  const dateKey = new Date().toISOString().slice(0, 10);
  const dailySent = (state.dailyTotals[dateKey] && state.dailyTotals[dateKey].sentUSD) || 0;
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
    '<b>rewards</b>',
    'mode: ' + (DRY_RUN ? 'DRY RUN' : 'LIVE'),
    'pending: ' + state.pendingRewards.filter(r => r.status === 'pending').length,
    'sent today: $' + dailySent.toFixed(2) + ' / $' + DAILY_REWARD_CAP_USD,
    'per-win cap: $' + PER_WIN_CAP_USD,
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
    const p = state.predictions[id] || { quick: {}, pro: {} };
    const q = Object.keys(p.quick).length;
    const pro = Object.keys(p.pro).length;
    lines.push(esc(teamName(m.homeTeam)) + ' vs ' + esc(teamName(m.awayTeam)) + ' - quick ' + q + ', pro ' + pro);
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
