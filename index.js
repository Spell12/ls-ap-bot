const http = require('http');
const { Client, GatewayIntentBits, MessageFlags } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GENERAL_CHANNEL_ID = process.env.ANNOUNCEMENT_CHANNEL_ID || process.env.GENERAL_CHANNEL_ID || '';
const LEADERS_CHANNEL_ID = process.env.LEADERS_CHANNEL_ID || '';
const LS_ID = process.env.LS_ID || '303';
const REFRESH_SECONDS = Number(process.env.REFRESH_SECONDS || 60);
const COOKIE_HEADER = process.env.CATSEYE_COOKIE_HEADER || '';
const BASE_URL = 'https://catseyexi.com';
const WEEKLY_CAP = Number(process.env.WEEKLY_CAP || 70000);
const NEAR_CAP = Number(process.env.NEAR_CAP || 50000);
// Current Summit cycle start date. Fun won Rank #1 on 2026-07-05, so the next week is 25% Farm Week.
// You can override later in Render with SUMMIT_PHASE_START=YYYY-MM-DD or FORCE_PENALTY=25/15/5/0.
const SUMMIT_PHASE_START = process.env.SUMMIT_PHASE_START || '2026-07-05';
const FORCE_PENALTY = process.env.FORCE_PENALTY;

if (!DISCORD_TOKEN || !CHANNEL_ID || !LS_ID) {
  console.error('Missing required env vars: DISCORD_TOKEN, CHANNEL_ID, LS_ID');
  process.exit(1);
}

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LS AP Report Bot is running');
}).listen(process.env.PORT || 10000, () => {
  console.log(`Health server listening on ${process.env.PORT || 10000}`);
});

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
let dashboardMessageId = process.env.DASHBOARD_MESSAGE_ID || null;
let lastContent = '';
let updating = false;
let lastPenaltyNoticeKey = '';
let lastVictoryKey = '';
let lastLeadersReportKey = '';
let lastFinalSnapshot = null;
let previousPenalty = null;
let previousRank = null;
let firstAutomationCheck = true;
const startedAtMs = Date.now();


function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function parseApiPayload(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.members)) return data.members;
  if (Array.isArray(data.data)) return data.data;
  if (data.data && Array.isArray(data.data.members)) return data.data.members;
  if (data.items && Array.isArray(data.items)) return data.items;
  return [];
}

async function fetchJson(url) {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 LS-AP-Report-Bot',
    'Referer': `${BASE_URL}/linkshell/${LS_ID}`,
  };
  if (COOKIE_HEADER.trim()) headers.Cookie = COOKIE_HEADER.trim();

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Fetch failed ${res.status}: ${url}${body ? ` | ${body.slice(0, 200)}` : ''}`);
  }
  return await res.json();
}

async function fetchOverview() {
  const data = await fetchJson(`${BASE_URL}/api/linkshell/${LS_ID}`);
  return data.linkshell || data;
}

async function fetchMembers() {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= 20; page++) {
    const url = `${BASE_URL}/api/linkshell/${LS_ID}/members?page=${page}&sort=name&order=asc&activeOnly=false`;
    const data = await fetchJson(url);
    const rows = parseApiPayload(data);
    console.log(`Members API page ${page}: ${rows.length} rows`);
    if (!rows.length) break;

    for (const m of rows) {
      const key = m.charid || m.name;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      all.push(m);
    }
    if (rows.length < 50) break;
  }
  return all;
}

function splitMembers(members) {
  const participants = members
    .map(m => ({
      name: String(m.name || 'Unknown'),
      ap: Number(m.activityPoints || 0),
      role: m.role || '',
      online: Boolean(m.isOnline),
    }))
    .filter(m => m.ap > 0)
    .sort((a, b) => b.ap - a.ap || a.name.localeCompare(b.name));

  return {
    participants,
    capped: participants.filter(m => m.ap >= WEEKLY_CAP),
    almost: participants.filter(m => m.ap >= NEAR_CAP && m.ap < WEEKLY_CAP),
    needs: participants.filter(m => m.ap > 0 && m.ap < NEAR_CAP),
  };
}

function nextSundayTimestamp(hour) {
  // UAE is UTC+4; Sunday hour UAE -> UTC hour = hour - 4.
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour - 4, 0, 0));
  const daysUntilSunday = (7 - target.getUTCDay()) % 7;
  target.setUTCDate(target.getUTCDate() + daysUntilSunday);
  if (target <= now) target.setUTCDate(target.getUTCDate() + 7);
  return Math.floor(target.getTime() / 1000);
}

function penaltyFromWins(wins) {
  const n = Number(wins || 0);
  if (n === 1) return 25;
  if (n === 2) return 15;
  if (n === 3) return 5;
  return 0;
}

function penaltyFromCycleDate() {
  if (FORCE_PENALTY !== undefined && FORCE_PENALTY !== '') {
    const forced = Number(FORCE_PENALTY);
    if ([0, 5, 15, 25].includes(forced)) return forced;
  }

  if (!SUMMIT_PHASE_START) return null;

  const start = new Date(`${SUMMIT_PHASE_START}T19:00:00+04:00`).getTime();
  if (!Number.isFinite(start)) return null;

  const now = Date.now();
  if (now < start) return null;

  const week = Math.floor((now - start) / (7 * 24 * 60 * 60 * 1000));

  if (week === 0) return 25;
  if (week === 1) return 15;
  if (week === 2) return 5;
  return 0;
}

function getEffectivePenalty(overview, parts) {
  const summit = (overview || {}).summit || {};
  const cyclePenalty = penaltyFromCycleDate();

  // The website/API can show stale 0%, while the game itself reports the real
  // win-streak penalty. The cycle date keeps the board correct after Rank #1.
  if (cyclePenalty !== null) return cyclePenalty;

  const apiPenalty = penaltyFromWins(summit.wins || 0);
  const rank = Number(summit.rank || 0);
  const raw = Number(summit.points || 0);
  const scaled = Number(summit.scaledPoints || 0);
  const participants = parts ? parts.participants.length : 0;

  // Fallback for the immediate post-reset case.
  if (apiPenalty === 0 && rank === 1 && raw === 0 && scaled === 0 && participants === 0) {
    return 25;
  }

  return apiPenalty;
}

function pushAdvice(penalty, rank) {
  if (penalty === 0) return Number(rank) === 1
    ? 'PUSH WEEK ACTIVE — keep Rank #1 secured.'
    : 'PUSH WEEK ACTIVE — go for Rank #1.';
  if (penalty === 25) return 'FARM WEEK ACTIVE — farm AP for pop items and weekly points.';
  if (penalty === 5) return '5% penalty — next week is Rank #1 Push Week.';
  if (penalty === 15) return 'Penalty week — AP tracking remains active.';
  return 'AP tracking active.';
}

function statusEmoji(ap) {
  if (ap >= WEEKLY_CAP) return '✅';
  if (ap > 0) return '🔶';
  return '⚪';
}

function trimName(name, len = 14) {
  return name.length > len ? name.slice(0, len - 1) + '…' : name;
}

function memberShortLine(m) {
  const name = trimName(m.name, 14).padEnd(14);
  const points = fmt(Math.min(m.ap, WEEKLY_CAP)).padStart(6);
  return `${statusEmoji(m.ap)} ${name} ${points}`;
}

function buildMemberBlock(parts, maxChars) {
  const members = parts.participants.slice();
  if (!members.length) return '_No members with AP yet._';

  // Two-column layout so we can show the full AP list without "...and X more".
  const half = Math.ceil(members.length / 2);
  const left = members.slice(0, half);
  const right = members.slice(half);
  const lines = [];

  for (let i = 0; i < half; i++) {
    const l = memberShortLine(left[i]).padEnd(25);
    const r = right[i] ? memberShortLine(right[i]) : '';
    lines.push(`${l}   ${r}`.trimEnd());
  }

  let block = '```' + lines.join('\n') + '```';

  // If Discord's 2000-character limit is still too tight, fall back to a
  // tighter single-column full list instead of hiding names.
  if (block.length > maxChars) {
    block = '```' + members.map(memberShortLine).join('\n') + '```';
  }

  return block;
}

function centerText(text, width = 44) {
  const cleanLength = [...text].length;
  if (cleanLength >= width) return text;
  const left = Math.floor((width - cleanLength) / 2);
  return ' '.repeat(left) + text;
}

function padStat(label, value, width = 23) {
  const text = `${label} ${value}`;
  return text.padEnd(width);
}

function progressBar(done, total, width = 18) {
  const pct = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const filled = Math.round(pct * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function buildDashboard(overview, members) {
  const ls = overview || {};
  const summit = ls.summit || {};
  const parts = splitMembers(members);
  const reportTs = nextSundayTimestamp(18);
  const resetTs = nextSundayTimestamp(19);
  const updatedTs = Math.floor(Date.now() / 1000);

  const rank = summit.rank ?? '?';
  const scaled = summit.scaledPoints ?? 0;
  const raw = summit.points ?? 0;
  const activeMembersApi = summit.activeMembers ?? parts.participants.length;
  const penalty = getEffectivePenalty(ls, parts);
  const advice = pushAdvice(penalty, rank);
  const pct = parts.participants.length ? Math.round((parts.capped.length / parts.participants.length) * 100) : 0;
  const isEmptyReset = parts.participants.length === 0 && Number(raw || 0) === 0 && Number(scaled || 0) === 0;
  let statusLine = `⚠️ ${penalty}% PENALTY`;
  if (penalty === 25) statusLine = '🌾 FARM WEEK ACTIVE / 25% PENALTY';
  else if (isEmptyReset) statusLine = '🔄 NEW AP WEEK / TRACKING ACTIVE';
  else if (penalty === 0) statusLine = '🔥 PUSH WEEK ACTIVE';

  const header = [
    '🏆 **SUPERNOVA AP BOARD**',
    '```',
    centerText(`RANK #${rank}`, 44),
    centerText(statusLine, 44),
    '────────────────────────────────────────────',
    `${padStat('✅ Capped', `${parts.capped.length}/${parts.participants.length}`)}${padStat('⚠️ Penalty', `${penalty}%`)}`,
    `${padStat('⭐ Scaled', fmt(scaled))}${padStat('💎 Raw', fmt(raw))}`,
    `${padStat('👥 Active', fmt(activeMembersApi))}${padStat('🎯 Goal', `${fmt(WEEKLY_CAP)} AP`)}`,
    `Progress   ${progressBar(parts.capped.length, parts.participants.length)} ${pct}%`,
    '────────────────────────────────────────────',
    '```',
    `🕕 **Final:** <t:${reportTs}:R>   🔄 **Reset:** <t:${resetTs}:R>`,
    `📣 **${isEmptyReset ? 'AP has reset. The board will fill as members earn AP.' : advice}**`,
    '',
    `📋 **Member AP Progress (${parts.participants.length})**`
  ];

  let content = header.join('\n') + '\n' + buildMemberBlock(parts, 1550) + `\nLast updated: <t:${updatedTs}:T>`;
  if (content.length > 2000) {
    content = header.join('\n') + '\n' + buildMemberBlock(parts, 1450) + `\nLast updated: <t:${updatedTs}:T>`;
  }
  return content.slice(0, 1995);
}

async function findExistingDashboard(channel) {
  if (dashboardMessageId) {
    try { return await channel.messages.fetch(dashboardMessageId); } catch (_) { dashboardMessageId = null; }
  }

  // Search recent bot messages and keep the newest dashboard. This prevents duplicate spam after redeploys.
  const messages = await channel.messages.fetch({ limit: 100 });
  const dashboards = messages
    .filter(m => m.author.id === client.user.id && m.content.includes('SUPERNOVA AP BOARD'))
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  const newest = dashboards.first();
  if (newest) {
    dashboardMessageId = newest.id;
    // Clean up older duplicate dashboards if the bot has permission.
    for (const old of dashboards.filter(m => m.id !== newest.id).values()) {
      old.delete().catch(() => {});
    }
  }
  return newest || null;
}


function isSundayOneHourBeforeReset(date = new Date()) {
  const p = getUaeNowParts(date);
  // Sunday 18:00-18:59 UAE, one hour before the 19:00 weekly reset.
  return p.weekday === 0 && p.hour === 18;
}

function buildLeadersReport(overview, parts) {
  const summit = (overview || {}).summit || {};
  const key = weeklyResultKey();
  const penalty = getEffectivePenalty(overview, parts);
  const remaining = parts.participants.filter(m => m.ap < WEEKLY_CAP);
  const capped = parts.capped;
  const totalNeeded = remaining.reduce((sum, m) => sum + Math.max(0, WEEKLY_CAP - m.ap), 0);

  const rows = parts.participants
    .slice()
    .sort((a, b) => a.ap - b.ap || a.name.localeCompare(b.name))
    .map(m => {
      const left = Math.max(0, WEEKLY_CAP - m.ap);
      const icon = m.ap >= WEEKLY_CAP ? '✅' : (m.ap >= NEAR_CAP ? '🟡' : '🔴');
      const name = trimName(m.name, 16).padEnd(16);
      const points = `${fmt(m.ap)} / ${fmt(WEEKLY_CAP)}`.padEnd(18);
      return `${icon} ${name} ${points}${left ? ` left ${fmt(left)}` : ''}`;
    });

  const header = [
    '📋 **LEADERS AP FINAL CHECK**',
    `Week Result Check: ${key}`,
    '',
    '⏰ **1 hour before Sunday reset**',
    `🥇 Rank: **#${summit.rank ?? '?'}**   ⚠️ Penalty: **${penalty}%**`,
    `⭐ Scaled AP: **${fmt(summit.scaledPoints || 0)}**   💎 Raw AP: **${fmt(summit.points || 0)}**`,
    `✅ Capped: **${capped.length}/${parts.participants.length}**   🟡 Remaining: **${remaining.length}**`,
    `📌 Total AP still needed: **${fmt(totalNeeded)}**`,
    '',
    '**Members with AP:**'
  ];

  let body = '```' + rows.join('\n') + '```';
  let content = header.join('\n') + '\n' + body;
  if (content.length > 1900) {
    const compactRows = parts.participants
      .slice()
      .sort((a, b) => a.ap - b.ap || a.name.localeCompare(b.name))
      .map(m => `${m.ap >= WEEKLY_CAP ? '✅' : '🟡'} ${trimName(m.name, 18).padEnd(18)} ${fmt(m.ap)}`);
    body = '```' + compactRows.slice(0, 70).join('\n') + (compactRows.length > 70 ? `\n...and ${compactRows.length - 70} more` : '') + '```';
    content = header.join('\n') + '\n' + body;
  }
  return content.slice(0, 1995);
}

async function maybeSendLeadersReport(overview, parts) {
  if (!LEADERS_CHANNEL_ID) return;
  if (!isSundayOneHourBeforeReset()) return;

  const summit = (overview || {}).summit || {};
  const penalty = getEffectivePenalty(overview, parts);
  // Only send this during push week / #1 push cycle. Penalty 0 means this is the efficient push week.
  if (penalty !== 0) return;

  const key = `leaders-${weeklyResultKey()}`;
  if (key === lastLeadersReportKey) return;

  try {
    const ch = await client.channels.fetch(LEADERS_CHANNEL_ID);
    const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
    if (recent && recent.some(m => m.author.id === client.user.id && m.content.includes(`Week Result Check: ${weeklyResultKey()}`))) {
      lastLeadersReportKey = key;
      return;
    }

    await ch.send({ content: buildLeadersReport(overview, parts), allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications });
    lastLeadersReportKey = key;
    console.log(`Leaders AP final check sent for ${weeklyResultKey()}.`);
  } catch (e) {
    console.error('Could not send leaders AP final check:', e.message || e);
  }
}

function latestSundayKey(date = new Date()) {
  const p = getUaeNowParts(date);
  const uaeMiddayUtc = new Date(Date.UTC(p.year, p.month - 1, p.day, 8, 0, 0));
  const daysSinceSunday = uaeMiddayUtc.getUTCDay();
  uaeMiddayUtc.setUTCDate(uaeMiddayUtc.getUTCDate() - daysSinceSunday);
  return `${uaeMiddayUtc.getUTCFullYear()}-${pad2(uaeMiddayUtc.getUTCMonth() + 1)}-${pad2(uaeMiddayUtc.getUTCDate())}`;
}

function nextSundayKey(date = new Date()) {
  const ts = nextSundayTimestamp(19) * 1000;
  const d = new Date(ts + 4 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

async function generalAlreadyHasMarker(channel, marker) {
  try {
    const messages = await channel.messages.fetch({ limit: 75 });
    return messages.some(m => m.author.id === client.user.id && m.content.includes(marker));
  } catch (_) {
    return false;
  }
}

async function sendGeneralOnce(marker, content) {
  if (!GENERAL_CHANNEL_ID) return false;
  const ch = await client.channels.fetch(GENERAL_CHANNEL_ID);
  if (await generalAlreadyHasMarker(ch, marker)) return false;
  await ch.send({ content: `${content}\n\n${marker}`, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications });
  return true;
}

async function maybeSendPhaseAnnouncement(overview, parts) {
  if (!GENERAL_CHANNEL_ID) return;
  const summit = (overview || {}).summit || {};
  const penalty = getEffectivePenalty(overview, parts);

  // IMPORTANT: never announce purely because the bot restarted/redeployed.
  // Announcements only happen after the bot observes a real penalty transition while running.
  if (previousPenalty === null) {
    previousPenalty = penalty;
    previousRank = Number(summit.rank || 0);
    console.log(`Automation baseline set: rank=${previousRank || '?'}, penalty=${penalty}%`);
    return;
  }

  const oldPenalty = previousPenalty;
  previousPenalty = penalty;
  previousRank = Number(summit.rank || 0);

  if (oldPenalty === penalty) return;

  try {
    // 5% means next Sunday will be 0%; remind everyone once.
    if (penalty === 5) {
      const key = `Push Week Reminder: ${nextSundayKey()}`;
      if (key === lastPenaltyNoticeKey) return;
      const sent = await sendGeneralOnce(key, [
        '📢 **PUSH WEEK REMINDER**',
        '',
        'SuperNova is currently at **5% penalty**.',
        '',
        'After the next Sunday reset, our penalty will become **0%**.',
        '',
        '🔥 **Next week is Rank #1 Push Week.**',
        'Please be ready to push your **70,000 AP**.',
        '',
        "Let's bring Rank #1 home! ❤️"
      ].join('\n'));
      if (sent) {
        lastPenaltyNoticeKey = key;
        console.log(`5% push reminder sent for ${nextSundayKey()}.`);
      }
      return;
    }

    // Only announce Push Week when we actually observe 5% -> 0%.
    // This prevents repeated Push Week messages every time Render restarts.
    if (oldPenalty === 5 && penalty === 0) {
      const key = `Push Week Active: ${latestSundayKey()}`;
      if (key === lastPenaltyNoticeKey) return;
      const sent = await sendGeneralOnce(key, [
        '🔥 **PUSH WEEK ACTIVE!**',
        '',
        'Penalty is now **0%**.',
        '',
        'This is our **Rank #1 Push Week**.',
        '',
        '🎯 Goal: **70,000 AP**',
        '',
        'Good luck everyone — let\'s push for Rank #1! 🏆'
      ].join('\n'));
      if (sent) {
        lastPenaltyNoticeKey = key;
        console.log(`0% push week announcement sent for ${latestSundayKey()}.`);
      }
    }
  } catch (e) {
    console.error('Could not send phase announcement:', e.message || e);
  }
}

function getUaeNowParts(date = new Date()) {
  const uae = new Date(date.getTime() + 4 * 60 * 60 * 1000);
  return {
    year: uae.getUTCFullYear(),
    month: uae.getUTCMonth() + 1,
    day: uae.getUTCDate(),
    hour: uae.getUTCHours(),
    minute: uae.getUTCMinutes(),
    weekday: uae.getUTCDay(),
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }

function weeklyResultKey(date = new Date()) {
  const p = getUaeNowParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function isAfterSundayResetWindow(date = new Date()) {
  const p = getUaeNowParts(date);
  // Wait a few minutes after the 19:00 UAE reset so CatsEye has time to finalize results.
  return (p.weekday === 0 && (p.hour > 19 || (p.hour === 19 && p.minute >= 3))) || (p.weekday === 1 && p.hour < 4);
}

async function channelAlreadyHasWeeklyResult(channel, key) {
  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    return messages.some(m => m.author.id === client.user.id && m.content.includes('🏆 **WE DID IT, SUPERNOVA!** 🏆') && m.content.includes(`📅 ${key}`));
  } catch (_) {
    return false;
  }
}

async function maybeSendVictoryMessage(overview, parts) {
  if (!GENERAL_CHANNEL_ID) return;
  if (!isAfterSundayResetWindow()) return;

  const summit = (overview || {}).summit || {};
  const rank = Number(summit.rank || 0);
  const penalty = getEffectivePenalty(overview, parts);

  // Only announce the official #1 result after a completed winning week.
  // On CatsEye, a #1 weekly win starts the next cycle at 25% penalty.
  // This prevents the bot from sending both "Push Week Active" and "We Did It"
  // when the current week is simply a 0% push week.
  if (rank !== 1 || penalty !== 25) return;

  const key = weeklyResultKey();
  if (key === lastVictoryKey) return;

  try {
    const ch = await client.channels.fetch(GENERAL_CHANNEL_ID);
    if (await channelAlreadyHasWeeklyResult(ch, key)) {
      lastVictoryKey = key;
      return;
    }

    const msg = [
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '🏆 **WE DID IT, SUPERNOVA!** 🏆',
      `📅 ${key}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '🥇 Rank #1 has been secured!',
      '',
      '💰 Weekly Summit reward secured!',
      '',
      'Thank you to everyone who contributed this week.',
      '',
      '❤️ Congratulations, everyone!',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
    ].join('\n');

    await ch.send({ content: msg, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications });
    lastVictoryKey = key;
    console.log(`Weekly #1 result message sent for ${key}.`);
  } catch (e) {
    console.error('Could not send weekly result message:', e.message || e);
  }
}


function getSnapshotKeyForCurrentWeek() {
  return nextSundayKey();
}

function updateFinalSnapshot(overview, parts) {
  const summit = (overview || {}).summit || {};
  const raw = Number(summit.points || 0);
  const scaled = Number(summit.scaledPoints || 0);
  if (raw <= 0 && scaled <= 0) return;

  lastFinalSnapshot = {
    key: getSnapshotKeyForCurrentWeek(),
    rank: Number(summit.rank || 0),
    scaledPoints: scaled,
    rawPoints: raw,
    capped: parts.capped.length,
    participants: parts.participants.length,
    activeMembers: Number(summit.activeMembers || parts.participants.length),
    capturedAt: Math.floor(Date.now() / 1000),
  };
}

function getVictorySnapshot(overview, parts, key) {
  const summit = (overview || {}).summit || {};
  const currentRaw = Number(summit.points || 0);
  const currentScaled = Number(summit.scaledPoints || 0);

  // Before reset or if CatsEye still exposes final numbers, use the live values.
  if (currentRaw > 0 || currentScaled > 0) {
    return {
      key,
      rank: Number(summit.rank || 0),
      scaledPoints: currentScaled,
      rawPoints: currentRaw,
      capped: parts.capped.length,
      participants: parts.participants.length,
      activeMembers: Number(summit.activeMembers || parts.participants.length),
    };
  }

  // After reset, CatsEye member AP becomes 0. Use the last non-zero snapshot captured before reset.
  if (lastFinalSnapshot && lastFinalSnapshot.key === key) return lastFinalSnapshot;
  return null;
}

async function updateDashboard() {
  if (updating) return;
  updating = true;
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    const [overview, members] = await Promise.all([fetchOverview(), fetchMembers()]);
    const parts = splitMembers(members);
    updateFinalSnapshot(overview, parts);
    const content = buildDashboard(overview, members);

    if (content !== lastContent) {
      let msg = await findExistingDashboard(channel);
      if (msg) {
        await msg.edit({ content, allowedMentions: { parse: [] } });
        console.log(`Dashboard message edited: ${msg.id}`);
      } else {
        msg = await channel.send({ content, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications });
        dashboardMessageId = msg.id;
        console.log(`Dashboard message created: ${msg.id}`);
      }
      lastContent = content;
    } else {
      console.log('No dashboard changes.');
    }

    // Scheduled automations still run even when the dashboard content did not change.
    await maybeSendPhaseAnnouncement(overview, parts);
    await maybeSendLeadersReport(overview, parts);
    await maybeSendVictoryMessage(overview, parts);
  } catch (err) {
    console.error(err);
  } finally {
    updating = false;
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`LS_ID=${LS_ID}, refresh=${REFRESH_SECONDS}s, cookies=${COOKIE_HEADER ? 'yes' : 'no'}, general=${GENERAL_CHANNEL_ID ? 'yes' : 'no'}, leaders=${LEADERS_CHANNEL_ID ? 'yes' : 'no'}`);
  await updateDashboard();
  setInterval(updateDashboard, Math.max(30, REFRESH_SECONDS) * 1000);
});

client.login(DISCORD_TOKEN);
