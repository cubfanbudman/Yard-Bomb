import { useEffect, useState, useCallback, useMemo, useRef } from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BASE   = 'https://statsapi.mlb.com/api/v1';
const SEASON = new Date().getFullYear();

// Venues where outdoor wind conditions don't apply. Fixed domes always qualify;
// Rogers Centre and loanDepot park are retractable but effectively always closed.
const DOME_VENUES = new Set([
  'Tropicana Field',
  'loanDepot park',
  'Rogers Centre',
]);

// HR park factors — sourced from 2025 data, updated for known 2026 changes.
// Verify venue names match what the MLB Stats API returns (game.venue.name).
// Unrecognized venues fall back to 1.00 (neutral).
const PARK_FACTORS = {
  'Great American Ball Park': 1.27,
  'Guaranteed Rate Field':    1.24,
  'Yankee Stadium':           1.19,
  'Citizens Bank Park':       1.18,
  'American Family Field':    1.14,
  'Dodger Stadium':           1.12,
  'Camden Yards':             1.11,
  'Minute Maid Park':         1.10,
  'Rogers Centre':            1.10,
  'Citi Field':               1.07,
  'Coors Field':              1.06,
  'Globe Life Field':         1.06,
  'Wrigley Field':            1.03,
  'Angel Stadium':            1.02,
  'Petco Park':               1.02,
  'Nationals Park':           0.99,
  'T-Mobile Park':            1.00,
  'Chase Field':              0.98,
  'Comerica Park':            0.96,
  'Truist Park':              0.96,
  // Rays returned to Tropicana Field for 2026 (new roof, same dimensions).
  'Tropicana Field':          0.96,
  // Rays played the entire 2025 season at Steinbrenner Field while Tropicana was repaired.
  'George M. Steinbrenner Field': 0.94,
  'Progressive Field':        0.95,
  'Target Field':             0.94,
  // A's: 6 showcase home games at Las Vegas Ballpark (June 2026); all other home games
  // are played at opponents' parks or neutral sites. Permanent Las Vegas stadium opens 2028.
  'Las Vegas Ballpark':       1.05,
  'Sutter Health Park':       0.90,  // A's 2025 home — kept in case of schedule carryover
  'Busch Stadium':            0.86,
  'loanDepot park':           0.85,
  'Fenway Park':              0.84,
  // Kauffman Stadium: fences moved in 8-10 ft and lowered from 18.5 ft to 8.5 ft for 2026.
  // Royals through ~5 weeks: 18 HR in 16 home games (1.125/g) vs 15 HR in 18 away (0.833/g) → ~1.35 ratio.
  // Bumped 1.02 → 1.10 on 2026-05-04; revisit mid-June with 40+ home games.
  'Kauffman Stadium':         1.10,
  'PNC Park':                 0.83,
  'Oracle Park':              0.76,
};

const GRADE_SCALE = [
  { min: 0.88, grade: 'A+', color: '#00e676' },
  { min: 0.80, grade: 'A',  color: '#00c853' },
  { min: 0.72, grade: 'A-', color: '#69f0ae' },
  { min: 0.64, grade: 'B+', color: '#ffeb3b' },
  { min: 0.56, grade: 'B',  color: '#ffd600' },
  { min: 0.48, grade: 'B-', color: '#ffb300' },
  { min: 0.40, grade: 'C+', color: '#ff9800' },
  { min: 0.32, grade: 'C',  color: '#ff6d00' },
  { min: 0.24, grade: 'C-', color: '#ff5722' },
  { min: 0.16, grade: 'D+', color: '#f44336' },
  { min: 0.00, grade: 'D',  color: '#b71c1c' },
];

// ---------------------------------------------------------------------------
// localStorage cache — same-day TTL
// All keys are suffixed with today's date so they expire automatically.
// ---------------------------------------------------------------------------

// toISOString() returns UTC, which can be a day ahead in US evening timezones.
// Always use local calendar date when talking to the MLB API or keying the cache.
function localDateStr(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const TODAY = localDateStr();
// Days since April 1 (approximate season start) — drives the accuracy history window
// so it grows naturally with the season rather than being hard-capped.
const SEASON_DAYS_ELAPSED = Math.max(1, Math.ceil((new Date() - new Date(SEASON, 3, 1)) / 86400000));

function cacheSet(key, data) {
  try {
    localStorage.setItem(`yardbomb_${key}_${TODAY}`, JSON.stringify({
      data,
      loadedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }));
  } catch { /* storage full or unavailable */ }
}

// Returns { data, loadedAt } or null
function cacheGetWithMeta(key) {
  try {
    const raw = localStorage.getItem(`yardbomb_${key}_${TODAY}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Handle both old format (plain data) and new format ({ data, loadedAt })
    if (parsed && typeof parsed === 'object' && 'data' in parsed && 'loadedAt' in parsed) {
      return parsed;
    }
    return { data: parsed, loadedAt: null };
  } catch {
    return null;
  }
}

function cacheClear(key) {
  try { localStorage.removeItem(`yardbomb_${key}_${TODAY}`); } catch { /* ignore */ }
}

// Prune keys from previous days so storage doesn't grow indefinitely.
// Keep yesterday's date so the frozen yesterday-results cache survives across the day boundary.
function cachePrune() {
  const dy = new Date();
  dy.setDate(dy.getDate() - 1);
  const YESTERDAY = localDateStr(dy);
  try {
    Object.keys(localStorage)
      .filter((k) =>
        k.startsWith('yardbomb_') &&
        !k.endsWith(TODAY) &&
        !k.endsWith(YESTERDAY) &&
        !k.startsWith('yardbomb_acc_') &&
        !k.startsWith('yardbomb_yday_')
      )
      .forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Rolling accuracy log — one record per day, persists across sessions
// ---------------------------------------------------------------------------
function saveAccuracyRecord(dateStr, data) {
  const key = `yardbomb_acc_${dateStr}`;
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch { /* ignore */ }
}

function loadAccuracyHistory(days = 14) {
  const records = [];
  for (let i = days; i >= 1; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const ds = localDateStr(d);
    try {
      const raw = localStorage.getItem(`yardbomb_acc_${ds}`);
      if (raw) records.push(JSON.parse(raw));
    } catch { /* skip */ }
  }
  return records; // chronological: oldest first, yesterday last
}

function gradeInfo(score) {
  return GRADE_SCALE.find((g) => score >= g.min) ?? GRADE_SCALE[GRADE_SCALE.length - 1];
}

function clamp(val, min = 0, max = 1) {
  return Math.max(min, Math.min(max, val));
}

// ---------------------------------------------------------------------------
// Statcast leaderboard (Baseball Savant CSV, fetched once per session)
// ---------------------------------------------------------------------------
const STATCAST_MIN_PA = 10; // hard floor — ignore truly trivial samples (< 10 PA)
// Above the floor, Statcast weight scales linearly: 10 PA = 0%, 55 PA ≈ 50%, 100+ PA = 100%.
// This gives early-season players partial Statcast credit rather than no credit at all.
function statcastCredibility(pa) {
  return pa == null ? 0 : clamp((pa - STATCAST_MIN_PA) / (100 - STATCAST_MIN_PA));
}

function parseStatcastCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return new Map();
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const idx = (name) => headers.indexOf(name);

  const iId        = idx('player_id');
  const iPa        = idx('pa');
  const iBarrel    = idx('barrel_batted_rate');
  const iHardHit   = idx('hard_hit_percent');
  const iExitVelo  = idx('exit_velocity_avg');
  const iXSlg      = idx('xslg');

  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const id   = parseInt(cols[iId], 10);
    const pa   = parseInt(cols[iPa],  10) || 0;
    if (!id || pa < STATCAST_MIN_PA) continue;
    map.set(id, {
      pa,
      barrelPct:  parseFloat(cols[iBarrel])   || null,
      hardHitPct: parseFloat(cols[iHardHit])  || null,
      exitVelo:   parseFloat(cols[iExitVelo]) || null,
      xSlg:       iXSlg >= 0 ? (parseFloat(cols[iXSlg]) || null) : null,
    });
  }
  return map;
}

async function fetchStatcastLeaderboard() {
  const cached = cacheGetWithMeta('statcast');
  if (cached?.data) return new Map(cached.data); // restore from entries array

  const SAVANT_URL = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${SEASON}&position=&team=&min=1&csv=true`;
  const PROXY_URL  = `https://corsproxy.io/?url=${encodeURIComponent(SAVANT_URL)}`;

  for (const url of [SAVANT_URL, PROXY_URL]) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const text = await res.text();
      // Reject silently if Baseball Savant returned an HTML error page instead of CSV
      if (!text || text.trimStart().startsWith('<')) continue;
      const map = parseStatcastCsv(text);
      if (map.size > 0) {
        cacheSet('statcast', [...map.entries()]);
        return map;
      }
    } catch { /* try next URL */ }
  }

  return new Map(); // both attempts failed — degrade gracefully
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

// Regress a stat toward a league-average prior based on sample size.
// k = number of "phantom AB" worth of prior. At n === k the split is 50/50.
// With k=120: a player with 15 AB is ~11% own stats; 120 AB is 50/50; 500 AB is ~81% own.
// Prior is career baseline when available (not league avg), so regression is player-specific.
// Regress K scales down as the season deepens and sample sizes grow.
// April 1: 120 (heavy regression — tiny samples). June 1+: 80 (data is meaningful).
// Linear ramp between those dates; clamped at both ends.
function computeRegressK() {
  const start = new Date(SEASON, 3, 1); // April 1
  const end   = new Date(SEASON, 5, 1); // June 1
  const now   = new Date();
  if (now <= start) return 120;
  if (now >= end)   return 80;
  const t = (now - start) / (end - start); // 0 → 1
  return Math.round(120 - t * 40);         // 120 → 80
}
const REGRESS_K = computeRegressK();
const LEAGUE_AVG_STAT = 0.250;
const LEAGUE_SLG_STAT = 0.410;
const LEAGUE_HR_AB    = 1 / 33; // ~.030, MLB average
const LEAGUE_AVG_BA   = 0.250;  // used to normalize hot-streak contact score

function regress(stat, n, mean) {
  return (stat * n + mean * REGRESS_K) / (n + REGRESS_K);
}

// Minimum split ABs before we trust the split data at all; credibility then
// scales linearly from 0% at SPLIT_MIN_AB to 100% at 100 AB.
const SPLIT_MIN_AB = 20;

// Minimum career H2H at-bats before the matchup history carries any weight.
// Credibility scales linearly: 0% at H2H_MIN_AB, 100% at 50 AB.
const H2H_MIN_AB = 8;
function computeH2HModifier(h2h, batter) {
  if (!h2h || h2h.atBats < H2H_MIN_AB) return 0;
  const cred       = clamp((h2h.atBats - H2H_MIN_AB) / 42); // 0% → 8 AB, 100% → 50 AB
  const careerSlg  = batter.careerSlg ?? LEAGUE_SLG_STAT;
  const careerHrAb = batter.careerAB > 0 ? batter.careerHR / batter.careerAB : LEAGUE_HR_AB;
  const h2hHrAb    = h2h.homeRuns / h2h.atBats;
  // Blend: H2H SLG vs career SLG (60%) + H2H HR rate vs career HR rate (40%)
  const slgRatio = h2h.slg > 0 && careerSlg > 0 ? h2h.slg / careerSlg : 1;
  const hrRatio  = careerHrAb > 0 ? h2hHrAb / careerHrAb : 1;
  const ratio    = slgRatio * 0.60 + hrRatio * 0.40;
  // ratio=0.80 → ~-0.05, ratio=1.00 → 0, ratio=1.20 → ~+0.05; cap at ±0.05
  return clamp(cred * (ratio - 1.0) * 0.25, -0.05, 0.05);
}

function scoreHRProbability(batter, pitcher = {}, venue = '', statcastMap = null) {
  const ab      = batter.atBats || 0;
  const rawSlg  = parseFloat(batter.slg) || 0;
  const rawAvg  = parseFloat(batter.avg) || 0;
  const rawHrAb = ab > 0 ? batter.homeRuns / ab : LEAGUE_HR_AB;

  // Select the L/R split that matches the opposing pitcher's hand.
  const pitchHand = pitcher.pitchHand ?? 'R';
  const split     = pitchHand === 'L' ? (batter.vsL ?? null) : (batter.vsR ?? null);
  const splitCred = (split?.atBats >= SPLIT_MIN_AB)
    ? clamp((split.atBats - SPLIT_MIN_AB) / 80)  // 20 AB → 0%, 100 AB → 100%
    : 0;

  // Blend split stats into season stats proportional to split credibility.
  // This shifts the power calculation toward how the batter actually performs
  // against this pitcher's handedness rather than using the aggregate season line.
  const splitHrAb     = split?.atBats > 0 ? split.homeRuns / split.atBats : rawHrAb;
  const effectiveSlg  = splitCred > 0 && split.slg  != null ? rawSlg  * (1 - splitCred) + split.slg  * splitCred : rawSlg;
  const effectiveAvg  = splitCred > 0 && split.avg  != null ? rawAvg  * (1 - splitCred) + split.avg  * splitCred : rawAvg;
  const effectiveHrAb = splitCred > 0                       ? rawHrAb * (1 - splitCred) + splitHrAb  * splitCred : rawHrAb;

  // Regress toward the player's own career baseline when available;
  // fall back to league average for rookies or missing data.
  const priorAvg  = batter.careerAvg  ?? LEAGUE_AVG_STAT;
  const priorSlg  = batter.careerSlg  ?? LEAGUE_SLG_STAT;
  const priorHrAb = batter.careerAB > 0 ? batter.careerHR / batter.careerAB : LEAGUE_HR_AB;

  const slg    = regress(effectiveSlg,   ab, priorSlg);
  const avg    = regress(effectiveAvg,   ab, priorAvg);
  const iso    = clamp(slg - avg, 0, 0.400);
  const hrRate = clamp(regress(effectiveHrAb, ab, priorHrAb), 0, 0.12) / 0.12;

  const sc = statcastMap?.get(batter.id) ?? null;

  // Traditional power score — always computed as the baseline
  const traditionalPower = clamp(
    clamp(slg / 0.600) * 0.40 +
    clamp(iso / 0.300) * 0.35 +
    hrRate              * 0.25
  );

  let power, statcastActive;

  if (sc?.barrelPct != null && sc?.hardHitPct != null) {
    // Statcast power score — full Statcast weighting
    const barrelScore  = clamp(sc.barrelPct  / 20);  // ~20% barrel rate = elite
    const hardHitScore = clamp(sc.hardHitPct / 60);  // ~60% hard hit    = elite
    // Prefer xSLG (luck-neutral) over raw SLG when available
    const slgScore = sc.xSlg != null ? clamp(sc.xSlg / 0.600) : clamp(slg / 0.600);
    const statcastPower = clamp(
      slgScore            * 0.25 +
      clamp(iso / 0.300) * 0.20 +
      hrRate              * 0.15 +
      barrelScore         * 0.25 +
      hardHitScore        * 0.15
    );
    // Credibility: scales from 0 at STATCAST_MIN_PA to 1.0 at 100 PA.
    // Early-season players get partial Statcast credit rather than none.
    const cred = statcastCredibility(sc.pa);
    power = clamp(traditionalPower * (1 - cred) + statcastPower * cred);
    statcastActive = cred > 0;
  } else {
    power = traditionalPower;
    statcastActive = false;
  }

  // Blend season ERA (40%) with rolling ERA from last 5 starts (60%) when available.
  // Recent form is a stronger predictor of today's outcome than full-season ERA.
  const seasonEra = pitcher.era ?? 4.20;
  const era = pitcher.recentEra != null
    ? pitcher.recentEra * 0.60 + seasonEra * 0.40
    : seasonEra;
  const batSide = batter.batSide ?? 'R';

  // Select pitcher's split vs this batter's effective hand.
  // Switch hitters bat opposite the pitcher, so resolve to their actual batting side.
  const effectiveBatSide = batSide === 'S' ? (pitchHand === 'R' ? 'L' : 'R') : batSide;
  const pitchSplit = effectiveBatSide === 'L' ? (pitcher.vsL ?? null) : (pitcher.vsR ?? null);
  // Credibility: 0% at 5 IP, 100% at 30 IP — modest early-season floor
  const pitchSplitCred = (pitchSplit?.ip ?? 0) >= 5
    ? clamp((pitchSplit.ip - 5) / 25)
    : 0;

  const seasonHr9 = pitcher.hrPer9 ?? 1.20;
  const seasonK9  = pitcher.kPer9  ?? 9.0;
  // Blend split HR/9 and K/9 toward season totals when split IP is thin
  const hr9 = (pitchSplit?.hrPer9 != null && pitchSplitCred > 0)
    ? pitchSplit.hrPer9 * pitchSplitCred + seasonHr9 * (1 - pitchSplitCred)
    : seasonHr9;
  const k9  = (pitchSplit?.kPer9  != null && pitchSplitCred > 0)
    ? pitchSplit.kPer9  * pitchSplitCred + seasonK9  * (1 - pitchSplitCred)
    : seasonK9;

  const bb9    = pitcher.bbPer9 ?? 3.3;
  const kVuln  = clamp(1 - (k9 - 5) / 10);   // K/9=5 → 1.0, K/9=15 → 0.0
  const bbVuln = clamp((bb9 - 1.5) / 3.5);   // BB/9=1.5 → 0.0, BB/9=5.0 → 1.0
  const pitcherVuln = clamp(
    clamp((era - 1.50) / 4.50) * 0.40 +
    clamp((hr9 - 0.50) / 1.50) * 0.30 +
    kVuln                       * 0.15 +
    bbVuln                      * 0.15
  );

  const pf = PARK_FACTORS[venue] ?? 1.00;
  const parkFactor = clamp((pf - 0.76) / (1.27 - 0.76));

  const hotStreak = batter.hotStreak ?? 0.5;

  // Platoon: prefer actual split SLG ratio when sample is big enough.
  // split SLG / season SLG: 0.85 → 0.40, 1.00 → 0.60, 1.15 → 0.80.
  // Falls back to hand-based defaults when split data is thin or absent.
  let platoon;
  if (split && split.atBats >= 30 && ab >= 30 && split.slg != null && rawSlg > 0) {
    const ratio = split.slg / rawSlg;
    platoon = clamp(0.60 + (ratio - 1.0) * 1.333);
  } else {
    platoon = batSide === 'S' ? 0.65 : batSide !== pitchHand ? 0.80 : 0.40;
  }

  const total = clamp(
    power        * 0.30 +
    pitcherVuln  * 0.25 +
    parkFactor   * 0.20 +
    hotStreak    * 0.15 +
    platoon      * 0.10
  );

  return {
    power, pitcherVuln, parkFactor, hotStreak, platoon, total,
    statcastActive,
    barrelPct:  sc?.barrelPct  ?? null,
    hardHitPct: sc?.hardHitPct ?? null,
    exitVelo:   sc?.exitVelo   ?? null,
    xSlg:       sc?.xSlg       ?? null,
    ...gradeInfo(total),
  };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
const RECENT_STARTS = 5; // pitcher game log window for rolling ERA

async function fetchPitcherStats(pitcherId) {
  if (!pitcherId) return {};
  const [statsRes, bioRes, logRes, splitRes] = await Promise.all([
    fetch(`${BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=${SEASON}`),
    fetch(`${BASE}/people/${pitcherId}`),
    fetch(`${BASE}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${SEASON}`),
    fetch(`${BASE}/people/${pitcherId}/stats?stats=statSplits&group=pitching&season=${SEASON}&sitCodes=vl,vr`),
  ]);
  const statsData = await statsRes.json();
  const bioData   = await bioRes.json();
  const logData   = await logRes.json();
  const splitData = await splitRes.json();

  const stat = statsData.stats?.[0]?.splits?.[0]?.stat ?? {};
  const ip   = parseFloat(stat.inningsPitched) || 0;
  const seasonEra = stat.era != null ? parseFloat(stat.era) : null;

  // Rolling ERA from last RECENT_STARTS outings
  let recentEra = null;
  try {
    const allStarts = logData.stats?.[0]?.splits ?? [];
    const recent    = allStarts.slice(-RECENT_STARTS);
    if (recent.length >= 2) {
      const totalIP = recent.reduce((s, g) => s + (parseFloat(g.stat?.inningsPitched) || 0), 0);
      const totalER = recent.reduce((s, g) => s + (g.stat?.earnedRuns ?? 0), 0);
      if (totalIP > 0) recentEra = (totalER / totalIP) * 9;
    }
  } catch { /* ignore — game log unavailable */ }

  // Parse L/R splits for the pitcher — vl = vs left-handed batters, vr = vs right-handed
  const parsePitchSplit = (code) => {
    const splitGroup = splitData.stats?.find((s) => s.type?.displayName?.toLowerCase().includes('split'));
    const row = splitGroup?.splits?.find((sp) => sp.split?.code === code)?.stat;
    if (!row) return null;
    const sip = parseFloat(row.inningsPitched) || 0;
    return {
      ip:     sip,
      hrPer9: sip > 0 ? ((parseInt(row.homeRuns,   10) || 0) / sip) * 9 : null,
      kPer9:  sip > 0 ? ((parseInt(row.strikeOuts, 10) || 0) / sip) * 9 : null,
    };
  };

  return {
    era:       seasonEra,
    recentEra,
    hrPer9:    ip > 0 ? ((stat.homeRuns   ?? 0) / ip) * 9 : null,
    kPer9:     ip > 0 ? ((stat.strikeOuts ?? 0) / ip) * 9 : null,
    bbPer9:    ip > 0 ? ((stat.baseOnBalls ?? 0) / ip) * 9 : null,
    pitchHand: bioData.people?.[0]?.pitchHand?.code ?? null,
    vsL:       parsePitchSplit('vl'),
    vsR:       parsePitchSplit('vr'),
  };
}


const HOT_STREAK_GAMES  = 15;
const HOT_STREAK_MIN_AB = 15;
const HOT_STREAK_MIN_G  = 5;

// Exponential decay weight — index 0 = oldest, index N-1 = most recent
const STREAK_DECAY = 0.85;

async function fetchHotStreak(playerId) {
  try {
    const res  = await fetch(`${BASE}/people/${playerId}/stats?stats=gameLog&group=hitting&season=${SEASON}`);
    const data = await res.json();
    const allGames = data.stats?.[0]?.splits ?? [];
    const recent   = allGames.slice(-HOT_STREAK_GAMES);

    if (recent.length < HOT_STREAK_MIN_G) return { score: 0.5, recentHR: null, recentGames: null };

    // Apply recency weights: most recent game has weight 1.0, each prior game is ×STREAK_DECAY
    const n = recent.length;
    const weights = recent.map((_, i) => Math.pow(STREAK_DECAY, n - 1 - i));
    const totalWeight  = weights.reduce((s, w) => s + w, 0);
    const weightedHR   = recent.reduce((s, g, i) => s + (g.stat?.homeRuns ?? 0) * weights[i], 0);
    const weightedH    = recent.reduce((s, g, i) => s + (g.stat?.hits     ?? 0) * weights[i], 0);
    const weightedAB   = recent.reduce((s, g, i) => s + (g.stat?.atBats   ?? 0) * weights[i], 0);
    const recentHR     = recent.reduce((s, g) => s + (g.stat?.homeRuns ?? 0), 0); // raw count for display

    if (weightedAB < HOT_STREAK_MIN_AB * (totalWeight / n)) {
      return { score: 0.5, recentHR, recentGames: recent.length };
    }

    // HR component: league-avg pace = 0.5, 2× avg = 1.0, 0 HR = 0
    const hrRate   = weightedHR / weightedAB;
    const hrScore  = clamp(hrRate / (2 * LEAGUE_HR_AB));

    // Contact component: league-avg BA = 0.5, 2× avg (.500) = 1.0, 0 BA = 0
    // A hot bat in general correlates with HR probability even without recent HRs.
    const recentBA = weightedH / weightedAB;
    const avgScore = clamp(recentBA / (2 * LEAGUE_AVG_BA));

    const score = hrScore * 0.65 + avgScore * 0.35;
    return { score, recentHR, recentGames: recent.length };
  } catch {
    return { score: 0.5, recentHR: null, recentGames: null };
  }
}

async function fetchRosterWithStats(teamId) {
  const rosterRes  = await fetch(`${BASE}/teams/${teamId}/roster?rosterType=active&season=${SEASON}&hydrate=person`);
  const rosterData = await rosterRes.json();
  const batters    = (rosterData.roster ?? []).filter((p) => p.position?.type !== 'Pitcher');

  return Promise.all(
    batters.map(async (player) => {
      const id      = player.person.id;
      const batSide = player.person.batSide?.code ?? 'R';
      const [statsRes, streak] = await Promise.all([
        fetch(`${BASE}/people/${id}/stats?stats=season,career,statSplits&group=hitting&season=${SEASON}&sitCodes=vl,vr`).then((r) => r.json()),
        fetchHotStreak(id),
      ]);
      const findStat = (type) =>
        statsRes.stats?.find((s) => s.type?.displayName?.toLowerCase() === type)?.splits?.[0]?.stat ?? {};
      const stat   = findStat('season');
      const career = findStat('career');

      // Parse L/R splits — sitCode 'vl' = vs LHP, 'vr' = vs RHP
      const parseSplit = (code) => {
        const splitGroup = statsRes.stats?.find((s) => s.type?.displayName?.toLowerCase().includes('split'));
        const row = splitGroup?.splits?.find((sp) => sp.split?.code === code)?.stat;
        if (!row) return null;
        return {
          slg:      parseFloat(row.sluggingPercentage ?? row.slg) || null,
          avg:      parseFloat(row.avg)                           || null,
          atBats:   parseInt(row.atBats, 10)                      || 0,
          homeRuns: parseInt(row.homeRuns, 10)                    || 0,
        };
      };

      return {
        id,
        name:        player.person.fullName,
        position:    player.position?.abbreviation ?? '?',
        batSide,
        gamesPlayed: stat.gamesPlayed  ?? 0,
        homeRuns:    stat.homeRuns     ?? 0,
        avg:         stat.avg          ?? '.000',
        obp:         stat.obp          ?? '.000',
        slg:         stat.slg          ?? '.000',
        atBats:      stat.atBats       ?? 0,
        hotStreak:   streak.score,
        recentHR:    streak.recentHR,
        recentGames: streak.recentGames,
        careerAvg:   parseFloat(career.avg)                                   || null,
        careerSlg:   parseFloat(career.sluggingPercentage ?? career.slg)      || null,
        careerHR:    parseInt(career.homeRuns, 10)                             || 0,
        careerAB:    parseInt(career.atBats,   10)                             || 0,
        vsL:         parseSplit('vl'),
        vsR:         parseSplit('vr'),
      };
    })
  );
}

// ---------------------------------------------------------------------------
// Wind — parse MLB weather string into a HR modifier
// Examples: "12 mph, Out to CF"  "8 mph, In from LF"  "5 mph, R to L"  "Calm"
// ---------------------------------------------------------------------------
function parseWind(windStr = '') {
  if (!windStr || windStr.toLowerCase() === 'calm') {
    return { modifier: 0, desc: 'Calm', mph: 0, dirFactor: 0, fieldTarget: null };
  }

  const mphMatch = windStr.match(/(\d+)\s*mph/i);
  const mph      = mphMatch ? parseInt(mphMatch[1], 10) : 0;
  const lower    = windStr.toLowerCase();

  // Direction factor: out = favorable, in = unfavorable, cross = neutral
  let dirFactor = 0;
  if (/out to|blowing out/i.test(lower))       dirFactor =  1;
  else if (/in from|blowing in/i.test(lower))  dirFactor = -1;
  // "R to L", "L to R", "varies" etc. stay at 0

  // Field target: which part of the outfield wind is blowing toward/from
  let fieldTarget = null;
  if      (/\bcf\b|center/i.test(lower))  fieldTarget = 'CF';
  else if (/\blf\b|left/i.test(lower))    fieldTarget = 'LF';
  else if (/\brf\b|right/i.test(lower))   fieldTarget = 'RF';

  // Scale: 0 mph = 0, 20+ mph = full effect, capped at max ±0.08 on total
  const speedScale = clamp(mph / 20);
  const modifier   = dirFactor * speedScale * 0.08;

  const desc = mph === 0 ? 'Calm'
    : dirFactor  >  0 ? `${mph} mph out`
    : dirFactor  <  0 ? `${mph} mph in`
    : `${mph} mph cross`;

  return { modifier, desc, mph, dirFactor, fieldTarget };
}

// Adjust wind modifier based on whether the wind favors the batter's pull field.
// LHB pulls to RF; RHB pulls to LF. CF wind applies equally to both.
// Pull-field wind is amplified (1.3×); opposite-field wind is dampened (0.4×).
function windModifierForBatter(wind, batSide) {
  const { modifier, dirFactor, fieldTarget } = wind;
  if (dirFactor === 0 || !fieldTarget || fieldTarget === 'CF' || batSide === 'S') {
    return modifier; // cross-wind, unknown, CF, or switch hitter: no adjustment
  }
  const pullField = batSide === 'L' ? 'RF' : 'LF';
  const mult      = fieldTarget === pullField ? 1.3 : 0.4;
  return clamp(modifier * mult, -0.10, 0.10);
}

function parseTempModifier(tempStr) {
  const f = parseInt(tempStr, 10);
  if (isNaN(f)) return { tempModifier: 0, tempF: null };
  // Neutral at 72°F. ~±0.02 per 10° difference, capped at ±0.05.
  const tempModifier = clamp((f - 72) / 10 * 0.02, -0.05, 0.05);
  return { tempModifier, tempF: f };
}

async function fetchWeather(gamePk) {
  try {
    const res  = await fetch(`${BASE}/game/${gamePk}/feed/live?fields=gameData,weather`);
    const data = await res.json();
    const w    = data.gameData?.weather ?? {};
    const wind = parseWind(w.wind ?? '');
    const temp = parseTempModifier(w.temp ?? '');
    return { ...wind, ...temp };
  } catch {
    return { modifier: 0, desc: '—', mph: 0, tempModifier: 0, tempF: null };
  }
}

// PA-opportunity multiplier by lineup position.
// Applied to the final score when a confirmed lineup is available.
// Bench players (in roster but not in lineup) get a heavy penalty.
function lineupMultiplier(lineupPos) {
  if (lineupPos <= 4) return 1.00;
  if (lineupPos <= 7) return 0.88;
  return 0.78;
}

async function fetchH2HStats(batterId, pitcherId) {
  if (!batterId || !pitcherId) return null;
  try {
    const res  = await fetch(`${BASE}/people/${batterId}/stats?stats=vsPlayerTotal&group=hitting&opposingPlayerId=${pitcherId}`);
    const data = await res.json();
    const stat = data.stats?.[0]?.splits?.[0]?.stat;
    if (!stat) return null;
    const ab = parseInt(stat.atBats, 10) || 0;
    if (ab === 0) return null;
    return {
      atBats:   ab,
      hits:     parseInt(stat.hits,     10) || 0,
      homeRuns: parseInt(stat.homeRuns, 10) || 0,
      avg:      parseFloat(stat.avg)        || 0,
      slg:      parseFloat(stat.sluggingPercentage ?? stat.slg) || 0,
    };
  } catch {
    return null;
  }
}

async function fetchGameData(game, statcastMap = null) {
  const awayTeamId  = game.teams?.away?.team?.id;
  const homeTeamId  = game.teams?.home?.team?.id;
  const awayPitchId = game.teams?.away?.probablePitcher?.id;
  const homePitchId = game.teams?.home?.probablePitcher?.id;
  const venue       = game.venue?.name ?? '';

  // Build batting-order maps from confirmed lineup data (posted 3-4 hrs pre-game).
  // playerId -> 1-indexed batting position
  const awayLineup = new Map();
  const homeLineup = new Map();
  (game.lineups?.awayPlayers ?? []).forEach((p, i) => awayLineup.set(p.id, i + 1));
  (game.lineups?.homePlayers ?? []).forEach((p, i) => homeLineup.set(p.id, i + 1));

  const neutralWeather = { modifier: 0, desc: '—', mph: 0, dirFactor: 0, fieldTarget: null, tempModifier: 0, tempF: null };
  const [awayRoster, homeRoster, awayPitcherStats, homePitcherStats, wind] = await Promise.all([
    fetchRosterWithStats(awayTeamId),
    fetchRosterWithStats(homeTeamId),
    fetchPitcherStats(awayPitchId),
    fetchPitcherStats(homePitchId),
    DOME_VENUES.has(venue) ? Promise.resolve(neutralWeather) : fetchWeather(game.gamePk),
  ]);

  const score = (roster, oppPitcher, lineupMap, oppPitcherId) =>
    roster
      .map((b) => {
        const base         = scoreHRProbability(b, oppPitcher, venue, statcastMap);
        const lineupPosted = lineupMap.size > 0;
        const lineupPos    = lineupPosted ? (lineupMap.get(b.id) ?? null) : null;
        // Only apply opportunity penalty when we have confirmed lineup data.
        // null lineupPos + posted lineup = confirmed bench — penalize.
        // No lineup posted yet = treat everyone equally.
        const mult         = !lineupPosted ? 1.0
                           : lineupPos != null ? lineupMultiplier(lineupPos)
                           : 0.55;
        const batWind       = windModifierForBatter(wind, b.batSide);
        const adjustedTotal = clamp((base.total + batWind + wind.tempModifier) * mult);
        return {
          ...b, ...base,
          total:        adjustedTotal,
          windModifier: batWind,
          lineupPos,
          lineupPosted,
          oppPitcherId: oppPitcherId ?? null,
          ...gradeInfo(adjustedTotal),
        };
      })
      .sort((a, b) => b.total - a.total);

  return {
    away: score(awayRoster, homePitcherStats, awayLineup, homePitchId),
    home: score(homeRoster, awayPitcherStats, homeLineup, awayPitchId),
    awayPitcherStats,
    homePitcherStats,
    wind,
  };
}

// ---------------------------------------------------------------------------
// UI Components
// ---------------------------------------------------------------------------
const C = {
  bg:      '#0d0d0f',
  surface: '#16181d',
  card:    '#1e2028',
  border:  '#2a2d35',
  muted:   '#6b7280',
  text:    '#e8eaf0',
  accent:  '#f5c518',
};

function GradeChip({ grade, color, size = 'md' }) {
  const sz = size === 'lg' ? { fontSize: '1.4rem', padding: '0.3rem 0.7rem' }
           : size === 'sm' ? { fontSize: '0.7rem', padding: '0.1rem 0.35rem' }
           : { fontSize: '0.9rem', padding: '0.2rem 0.5rem' };
  return (
    <span style={{
      ...sz,
      fontFamily: 'Oswald, sans-serif',
      fontWeight: 700,
      color,
      border: `1.5px solid ${color}`,
      borderRadius: '4px',
      letterSpacing: '0.05em',
      whiteSpace: 'nowrap',
    }}>
      {grade}
    </span>
  );
}

function ScoreBar({ value, color, label, weight }) {
  return (
    <div style={{ marginBottom: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
        <span style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.72rem', color: C.muted }}>
          {label} <span style={{ color: '#444', fontSize: '0.65rem' }}>({Math.round(weight * 100)}%)</span>
        </span>
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem', color: C.text }}>
          {(value * 100).toFixed(0)}
        </span>
      </div>
      <div style={{ height: '4px', background: '#2a2d35', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${value * 100}%`, background: color, borderRadius: '2px', transition: 'width 0.4s ease' }} />
      </div>
    </div>
  );
}

function StatTag({ label, value }) {
  return (
    <span style={{
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: '0.68rem',
      background: '#23262f',
      border: '1px solid #2a2d35',
      borderRadius: '3px',
      padding: '2px 6px',
      color: C.muted,
      whiteSpace: 'nowrap',
    }}>
      <span style={{ color: '#555', marginRight: '3px' }}>{label}</span>{value}
    </span>
  );
}

function BatterCard({ batter, venue, rank, h2hStats = null, h2hModifier = 0 }) {
  const [expanded, setExpanded] = useState(false);
  const { grade, color, total, power, pitcherVuln, parkFactor, hotStreak, platoon } = batter;
  const pf = PARK_FACTORS[venue] ?? 1.00;

  // When H2H data shifts the score, show the adjusted grade/color/total on the card.
  const adjTotal = h2hModifier !== 0 ? clamp(total + h2hModifier) : total;
  const { grade: adjGrade, color: adjColor } = h2hModifier !== 0 ? gradeInfo(adjTotal) : { grade, color };
  const h2hHasData = h2hStats && h2hStats.atBats >= H2H_MIN_AB;

  // Alignment badge: count how many of the 5 scored factors are ≥ 0.60.
  // 3+ signals multiple independent edges pointing the same direction.
  const alignedCount = [power, pitcherVuln, parkFactor, hotStreak, platoon].filter((v) => v >= 0.60).length;
  const isAligned = alignedCount >= 3;

  return (
    <div
      onClick={() => setExpanded((e) => !e)}
      style={{
        background: C.card,
        border: `1px solid ${expanded ? adjColor + '55' : C.border}`,
        borderRadius: '8px',
        padding: '0.9rem 1rem',
        marginBottom: '8px',
        cursor: 'pointer',
        transition: 'border-color 0.2s',
      }}
    >
      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ fontFamily: 'Oswald, sans-serif', fontSize: '0.75rem', color: C.muted, minWidth: '18px' }}>
          #{rank}
        </span>
        <GradeChip grade={adjGrade} color={adjColor} />
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'Oswald, sans-serif', fontWeight: 600, fontSize: '1rem', color: C.text, letterSpacing: '0.02em' }}>
              {batter.name}
            </span>
            {isAligned && (
              <span title={`${alignedCount}/5 factors ≥ 60`} style={{
                fontFamily: 'Oswald, sans-serif', fontWeight: 700,
                fontSize: '0.62rem', letterSpacing: '0.06em',
                padding: '1px 5px', borderRadius: '3px',
                background: '#2a1f00', color: C.accent,
                border: `1px solid ${C.accent}55`,
              }}>
                ★ ALIGNED
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.72rem', color: C.muted, fontFamily: 'Barlow, sans-serif' }}>
            {batter.position}
          </div>
        </div>
        {/* Score circle */}
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '1.3rem', fontWeight: 700, color: adjColor }}>
            {(adjTotal * 100).toFixed(0)}
          </div>
          <div style={{ fontSize: '0.65rem', color: C.muted, fontFamily: 'Barlow, sans-serif' }}>
            {h2hHasData && h2hModifier !== 0 ? (
              <span style={{ color: h2hModifier > 0 ? '#34d399' : '#f87171' }}>
                {h2hModifier > 0 ? `+${(h2hModifier * 100).toFixed(1)} h2h` : `${(h2hModifier * 100).toFixed(1)} h2h`}
              </span>
            ) : 'score'}
          </div>
        </div>
      </div>

      {/* Stat tags */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
        {batter.lineupPosted && (
          <StatTag
            label="BAT"
            value={batter.lineupPos != null ? `#${batter.lineupPos}` : 'bench'}
          />
        )}
        <StatTag label="HR"  value={batter.homeRuns} />
        <StatTag label="AVG" value={batter.avg} />
        <StatTag label="SLG" value={batter.slg} />
        <StatTag label="OBP" value={batter.obp} />
        <StatTag label="AB"  value={batter.atBats} />
        {pf !== 1.00 && (
          <StatTag label="PF" value={pf > 1 ? `+${((pf - 1) * 100).toFixed(0)}%` : `${((pf - 1) * 100).toFixed(0)}%`} />
        )}
        {batter.statcastActive && batter.xSlg       != null && <StatTag label="xSLG" value={batter.xSlg.toFixed(3)} />}
        {batter.statcastActive && batter.barrelPct  != null && <StatTag label="BBL%" value={batter.barrelPct.toFixed(1)  + '%'} />}
        {batter.statcastActive && batter.hardHitPct != null && <StatTag label="HH%"  value={batter.hardHitPct.toFixed(1) + '%'} />}
        {batter.statcastActive && batter.exitVelo   != null && <StatTag label="EV"   value={batter.exitVelo.toFixed(1)   + ' mph'} />}
        {batter.recentGames != null && (
          <StatTag
            label={`L${batter.recentGames}`}
            value={batter.recentHR != null ? `${batter.recentHR} HR` : '—'}
          />
        )}
        {h2hHasData && (
          <>
            <StatTag label="H2H"  value={`${h2hStats.hits}-${h2hStats.atBats}`} />
            <StatTag label="vHR"  value={h2hStats.homeRuns} />
            <StatTag label="vSLG" value={h2hStats.slg.toFixed(3)} />
          </>
        )}
      </div>

      {/* Expanded score bars */}
      {expanded && (
        <div style={{ marginTop: '12px', borderTop: `1px solid ${C.border}`, paddingTop: '10px' }}>
          <ScoreBar value={power}       color="#60a5fa" label="Power"               weight={0.30} />
          <ScoreBar value={pitcherVuln} color="#f97316" label="Pitcher Vulnerability" weight={0.25} />
          <ScoreBar value={parkFactor}  color="#a78bfa" label="Park Factor"          weight={0.20} />
          <ScoreBar value={hotStreak}   color="#34d399" label="Hot Streak"           weight={0.15} />
          <ScoreBar value={platoon}     color="#fbbf24" label="Platoon Advantage"    weight={0.10} />
          {h2hHasData && (
            <div style={{ marginTop: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.72rem', color: C.muted }}>
                H2H vs. Pitcher <span style={{ color: '#444', fontSize: '0.65rem' }}>({h2hStats.atBats} AB career)</span>
              </span>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem',
                color: h2hModifier > 0.005 ? '#34d399' : h2hModifier < -0.005 ? '#f87171' : C.muted }}>
                {h2hModifier > 0.005 ? `+${(h2hModifier * 100).toFixed(1)}` :
                 h2hModifier < -0.005 ? (h2hModifier * 100).toFixed(1) : '—'}
              </span>
            </div>
          )}
          <div style={{ marginTop: '6px', borderTop: `1px solid ${C.border}`, paddingTop: '6px', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.75rem', color: C.muted }}>
              {h2hHasData && h2hModifier !== 0 ? 'Adjusted Score' : 'Composite Score'}
            </span>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.85rem', color: adjColor, fontWeight: 700 }}>
              {(adjTotal * 100).toFixed(1)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function PitcherBadge({ name, stats }) {
  if (!name) return <span style={{ color: C.muted, fontFamily: 'Barlow, sans-serif', fontSize: '0.85rem' }}>TBD</span>;
  return (
    <span style={{ display: 'inline-flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontFamily: 'Oswald, sans-serif', fontWeight: 500, color: C.text }}>{name}</span>
      {stats?.era    != null && <StatTag label="ERA"  value={stats.era.toFixed(2)}    />}
      {stats?.hrPer9 != null && <StatTag label="HR/9" value={stats.hrPer9.toFixed(2)} />}
      {stats?.kPer9  != null && <StatTag label="K/9"  value={stats.kPer9.toFixed(1)}  />}
      {stats?.bbPer9 != null && <StatTag label="BB/9" value={stats.bbPer9.toFixed(1)} />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tab: Top Picks
// ---------------------------------------------------------------------------
function TabTopPicks({ gameResults, games }) {
  const [filterTeam,  setFilterTeam]  = useState('All');
  const [minScore,    setMinScore]    = useState(0);
  const [alignedOnly, setAlignedOnly] = useState(false);
  const [h2hMap,      setH2hMap]      = useState({});
  const fetchedH2H = useRef(new Set());

  const { allBatters, loadedCount, teamNames } = useMemo(() => {
    const batters = [];
    const teams   = new Set();
    let loaded = 0;
    games.forEach((game) => {
      const result = gameResults[game.gamePk];
      if (!result) return;
      loaded++;
      const venue           = game.venue?.name ?? '';
      const awayName        = game.teams?.away?.team?.name ?? '';
      const homeName        = game.teams?.home?.team?.name ?? '';
      const awayPitcherName = game.teams?.away?.probablePitcher?.fullName ?? null;
      const homePitcherName = game.teams?.home?.probablePitcher?.fullName ?? null;
      if (awayName) teams.add(awayName);
      if (homeName) teams.add(homeName);
      result.away.forEach((b) => batters.push({ ...b, venue, teamName: awayName, gamePk: game.gamePk, oppPitcherName: homePitcherName }));
      result.home.forEach((b) => batters.push({ ...b, venue, teamName: homeName, gamePk: game.gamePk, oppPitcherName: awayPitcherName }));
    });
    batters.sort((a, b) => b.total - a.total);
    return { allBatters: batters, loadedCount: loaded, teamNames: [...teams].sort() };
  }, [games, gameResults]);

  const totalCount = games.length;

  // Fetch career H2H stats for the top 20 batters after filters are applied.
  // Uses a ref to avoid re-fetching pairs already in flight or completed.
  // Declared before the early return so the hook call isn't conditional.
  const minScoreNorm = minScore / 100;
  const filtered = allBatters.filter((b) =>
    (filterTeam === 'All' || b.teamName === filterTeam) &&
    b.total >= minScoreNorm &&
    (!alignedOnly || [b.power, b.pitcherVuln, b.parkFactor, b.hotStreak, b.platoon].filter((v) => v >= 0.60).length >= 3)
  );
  useEffect(() => {
    filtered.slice(0, 20).forEach((b) => {
      if (!b.oppPitcherId) return;
      const key = `${b.id}_${b.oppPitcherId}`;
      if (fetchedH2H.current.has(key)) return;
      fetchedH2H.current.add(key);
      fetchH2HStats(b.id, b.oppPitcherId).then((stats) => {
        setH2hMap((prev) => ({ ...prev, [key]: stats }));
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered.slice(0, 20).map((b) => `${b.id}_${b.oppPitcherId}`).join(',')]);

  if (allBatters.length === 0) {
    return (
      <div style={{ color: C.muted, fontFamily: 'Barlow, sans-serif', padding: '2rem 0', textAlign: 'center' }}>
        Load rosters from the By Game tab to populate picks.
        {totalCount > 0 && (
          <div style={{ marginTop: '6px', fontSize: '0.75rem' }}>
            {loadedCount}/{totalCount} games loaded
          </div>
        )}
      </div>
    );
  }

  // Apply H2H modifiers to top 20 and re-sort so H2H can shift rankings.
  const displayBatters = filtered
    .map((b, i) => {
      const h2hKey   = `${b.id}_${b.oppPitcherId}`;
      const h2hStats = i < 20 ? (h2hMap[h2hKey] ?? null) : null;
      const h2hMod   = i < 20 ? computeH2HModifier(h2hStats, b) : 0;
      return { ...b, h2hStats, h2hMod, adjTotal: clamp(b.total + h2hMod) };
    })
    .sort((a, b) => b.adjTotal - a.adjTotal);

  const selectStyle = {
    background: C.surface, color: C.text, border: `1px solid ${C.border}`,
    borderRadius: '4px', padding: '3px 6px',
    fontFamily: 'Barlow, sans-serif', fontSize: '0.75rem', cursor: 'pointer',
  };

  return (
    <div>
      {/* Controls row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={filterTeam} onChange={(e) => setFilterTeam(e.target.value)} style={selectStyle}>
            <option value="All">All Teams</option>
            {teamNames.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <label style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.75rem', color: C.muted, display: 'flex', alignItems: 'center', gap: '5px' }}>
            Min score
            <input
              type="number" min={0} max={99} value={minScore}
              onChange={(e) => setMinScore(Math.max(0, Math.min(99, Number(e.target.value))))}
              style={{ ...selectStyle, width: '48px', textAlign: 'center' }}
            />
          </label>
          <label style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.75rem', color: alignedOnly ? C.accent : C.muted, display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
            <input
              type="checkbox" checked={alignedOnly}
              onChange={(e) => setAlignedOnly(e.target.checked)}
              style={{ accentColor: C.accent }}
            />
            ★ Aligned only
          </label>
          <span style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.75rem', color: C.muted }}>
            {filtered.length} hitter{filtered.length !== 1 ? 's' : ''} · click card to expand
          </span>
        </div>
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem', color: loadedCount < totalCount ? '#fbbf24' : '#34d399' }}>
          {loadedCount}/{totalCount} games loaded
        </span>
      </div>

      {filtered.length === 0 && (
        <div style={{ color: C.muted, fontFamily: 'Barlow, sans-serif', padding: '2rem 0', textAlign: 'center' }}>
          No hitters match the current filters.
        </div>
      )}

      {displayBatters.map((b, i) => (
        <div key={`${b.gamePk}-${b.id}`}>
          <div style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.7rem', color: '#444', marginBottom: '3px' }}>
            {b.teamName} · {b.venue}{b.oppPitcherName ? ` · vs. ${b.oppPitcherName}` : ''}
          </div>
          <BatterCard batter={b} venue={b.venue} rank={i + 1} h2hStats={b.h2hStats} h2hModifier={b.h2hMod} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: By Game
// ---------------------------------------------------------------------------
function ConfirmBadge({ confirmed, label }) {
  const color  = confirmed === true ? '#34d399' : confirmed === false ? '#fbbf24' : '#f87171';
  const bg     = confirmed === true ? '#0d2010'  : confirmed === false ? '#2a1f00'  : '#200d0d';
  const border = confirmed === true ? '#34d39933': confirmed === false ? '#fbbf2433': '#f8717133';
  const symbol = confirmed === true ? '✓'        : confirmed === false ? '?'        : '!';
  return (
    <span style={{
      fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem',
      padding: '1px 5px', borderRadius: '3px',
      background: bg, color, border: `1px solid ${border}`,
      whiteSpace: 'nowrap',
    }}>
      {symbol} {label}
    </span>
  );
}

function GameGroup({ game, result, onLoad, onRefresh, loading }) {
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState({ key: 'total', dir: -1 });
  const away = game.teams?.away;
  const home = game.teams?.home;
  const venue = game.venue?.name ?? '';
  const time  = new Date(game.gameDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function toggleSort(key) {
    setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }));
  }

  const sortRoster = useCallback((roster) => {
    return [...roster].sort((a, b) => {
      const av = typeof a[sort.key] === 'string' ? parseFloat(a[sort.key]) || 0 : (a[sort.key] ?? 0);
      const bv = typeof b[sort.key] === 'string' ? parseFloat(b[sort.key]) || 0 : (b[sort.key] ?? 0);
      return sort.dir * (av - bv);
    });
  }, [sort]);

  const sortedAway = useMemo(() => result ? sortRoster(result.away) : [], [result, sortRoster]);
  const sortedHome = useMemo(() => result ? sortRoster(result.home) : [], [result, sortRoster]);

  const lineupPosted = result?.away?.some((b) => b.lineupPosted) || result?.home?.some((b) => b.lineupPosted);

  const cols = [
    { key: 'name',        label: 'Player'   },
    { key: 'position',    label: 'POS'      },
    ...(lineupPosted ? [{ key: 'lineupPos', label: 'Bat#' }] : []),
    { key: 'total',       label: 'Score'    },
    { key: 'grade',       label: 'Grade'    },
    { key: 'homeRuns',    label: 'HR'       },
    { key: 'avg',         label: 'AVG'      },
    { key: 'slg',         label: 'SLG'      },
    { key: 'power',       label: 'Power'    },
    { key: 'pitcherVuln', label: 'Pit.Vuln' },
    { key: 'parkFactor',  label: 'Park'     },
  ];

  function SortTh({ col }) {
    const active = sort.key === col.key;
    return (
      <th
        onClick={() => toggleSort(col.key)}
        style={{
          padding: '6px 10px',
          fontFamily: 'Barlow, sans-serif',
          fontSize: '0.7rem',
          fontWeight: 600,
          color: active ? C.accent : C.muted,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          borderBottom: `2px solid ${active ? C.accent : C.border}`,
          userSelect: 'none',
        }}
      >
        {col.label} {active ? (sort.dir === -1 ? '↓' : '↑') : ''}
      </th>
    );
  }

  function RosterTable({ rows, label }) {
    return (
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ fontFamily: 'Oswald, sans-serif', fontSize: '0.85rem', color: C.muted, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '6px' }}>
          {label}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr style={{ background: C.surface }}>
                {cols.map((c) => <SortTh key={c.key} col={c} />)}
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const { color } = gradeInfo(b.total);
                return (
                  <tr key={b.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: '7px 10px', fontFamily: 'Barlow, sans-serif', color: C.text, whiteSpace: 'nowrap' }}>{b.name}</td>
                    <td style={{ padding: '7px 10px', color: C.muted, fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem' }}>{b.position}</td>
                    {lineupPosted && (
                      <td style={{ padding: '7px 10px', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem', color: b.lineupPos != null ? C.accent : C.muted }}>
                        {b.lineupPos != null ? `#${b.lineupPos}` : '—'}
                      </td>
                    )}
                    <td style={{ padding: '7px 10px', fontFamily: 'JetBrains Mono, monospace', color, fontWeight: 700 }}>{(b.total * 100).toFixed(1)}</td>
                    <td style={{ padding: '7px 10px' }}><GradeChip grade={b.grade} color={color} size="sm" /></td>
                    <td style={{ padding: '7px 10px', fontFamily: 'JetBrains Mono, monospace', color: C.text }}>{b.homeRuns}</td>
                    <td style={{ padding: '7px 10px', fontFamily: 'JetBrains Mono, monospace', color: C.muted }}>{b.avg}</td>
                    <td style={{ padding: '7px 10px', fontFamily: 'JetBrains Mono, monospace', color: C.muted }}>{b.slg}</td>
                    <td style={{ padding: '7px 10px', fontFamily: 'JetBrains Mono, monospace', color: '#60a5fa' }}>{(b.power * 100).toFixed(0)}</td>
                    <td style={{ padding: '7px 10px', fontFamily: 'JetBrains Mono, monospace', color: '#f97316' }}>{(b.pitcherVuln * 100).toFixed(0)}</td>
                    <td style={{ padding: '7px 10px', fontFamily: 'JetBrains Mono, monospace', color: '#a78bfa' }}>{(b.parkFactor * 100).toFixed(0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: '10px', marginBottom: '10px', overflow: 'hidden' }}>
      {/* Header */}
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ padding: '0.9rem 1.1rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <div>
          <span style={{ fontFamily: 'Oswald, sans-serif', fontWeight: 600, fontSize: '1.05rem', color: C.text }}>
            {away?.team?.name} <span style={{ color: C.muted }}>@</span> {home?.team?.name}
          </span>
          <div style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.78rem', color: C.muted, marginTop: '2px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span>{venue} · {time}</span>
            {result?.wind && result.wind.mph > 0 && (
              <span style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: '0.68rem',
                padding: '1px 6px', borderRadius: '3px',
                background: result.wind.dirFactor > 0 ? '#0d2010' : result.wind.dirFactor < 0 ? '#200d0d' : '#1a1a1a',
                color:      result.wind.dirFactor > 0 ? '#34d399' : result.wind.dirFactor < 0 ? '#f87171' : C.muted,
                border:     `1px solid ${result.wind.dirFactor > 0 ? '#34d39933' : result.wind.dirFactor < 0 ? '#f8717133' : C.border}`,
              }}>
                {result.wind.dirFactor > 0 ? '↑' : result.wind.dirFactor < 0 ? '↓' : '→'} {result.wind.desc}
              </span>
            )}
            {result?.wind?.tempF != null && (
              <span style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: '0.68rem',
                padding: '1px 6px', borderRadius: '3px',
                background: result.wind.tempF < 55 ? '#200d0d' : result.wind.tempF > 80 ? '#0d2010' : '#1a1a1a',
                color:      result.wind.tempF < 55 ? '#f87171' : result.wind.tempF > 80 ? '#34d399' : C.muted,
                border:     `1px solid ${result.wind.tempF < 55 ? '#f8717133' : result.wind.tempF > 80 ? '#34d39933' : C.border}`,
              }}>
                {result.wind.tempF}°F
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '5px', flexWrap: 'wrap', alignItems: 'center' }}>
            <PitcherBadge name={away?.probablePitcher?.fullName ?? null} stats={result?.awayPitcherStats ?? null} />
            <ConfirmBadge
              confirmed={away?.probablePitcher ? game.lineups?.awayPlayers?.length > 0 : null}
              label={game.lineups?.awayPlayers?.length > 0 ? 'lineup in' : away?.probablePitcher ? 'probable' : 'TBD'}
            />
            <span style={{ color: C.border }}>vs</span>
            <PitcherBadge name={home?.probablePitcher?.fullName ?? null} stats={result?.homePitcherStats ?? null} />
            <ConfirmBadge
              confirmed={home?.probablePitcher ? game.lineups?.homePlayers?.length > 0 : null}
              label={game.lineups?.homePlayers?.length > 0 ? 'lineup in' : home?.probablePitcher ? 'probable' : 'TBD'}
            />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {!result && (
            <button
              onClick={(e) => { e.stopPropagation(); onLoad(); }}
              disabled={loading}
              style={{
                background: loading ? '#1e2028' : C.accent,
                color: loading ? C.muted : '#000',
                border: 'none',
                borderRadius: '5px',
                padding: '0.3rem 0.8rem',
                fontFamily: 'Oswald, sans-serif',
                fontWeight: 600,
                fontSize: '0.8rem',
                cursor: loading ? 'default' : 'pointer',
                letterSpacing: '0.05em',
              }}
            >
              {loading ? 'Loading…' : 'LOAD'}
            </button>
          )}
          {result && (
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px' }}>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: '#34d399' }}>
                ✓ {result.loadedAt ?? 'loaded'}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); onRefresh(); }}
                disabled={loading}
                style={{
                  background: 'none', border: `1px solid ${C.border}`,
                  borderRadius: '3px', color: C.muted,
                  fontFamily: 'Barlow, sans-serif', fontSize: '0.65rem',
                  padding: '1px 6px', cursor: loading ? 'default' : 'pointer',
                }}
              >
                {loading ? '…' : 'refresh'}
              </button>
            </span>
          )}
          <span style={{ color: C.muted, fontSize: '1.1rem' }}>{open ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Body */}
      {open && result && (
        <div style={{ padding: '0 1.1rem 1.1rem' }}>
          <RosterTable
            rows={sortedAway}
            label={`${away?.team?.name} batters — vs ${home?.probablePitcher?.fullName ?? 'TBD'}`}
          />
          <RosterTable
            rows={sortedHome}
            label={`${home?.team?.name} batters — vs ${away?.probablePitcher?.fullName ?? 'TBD'}`}
          />
        </div>
      )}
      {open && !result && !loading && (
        <div style={{ padding: '1rem 1.1rem', color: C.muted, fontFamily: 'Barlow, sans-serif', fontSize: '0.85rem' }}>
          Click LOAD to fetch rosters and scores.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Yesterday's Results  (placeholder)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Yesterday's results — data fetching
// ---------------------------------------------------------------------------

// Subtract this game's batting line from season totals to get pre-game stats.
// The boxscore's seasonStats are post-game cumulative, so scoring with them
// would retroactively inflate (or deflate) scores based on that day's performance.
function computePreGameStats(season, game) {
  const sAB  = parseInt(season.atBats,      10) || 0;
  const gAB  = parseInt(game.atBats,        10) || 0;
  const sH   = parseInt(season.hits,        10) || 0;
  const gH   = parseInt(game.hits,          10) || 0;
  const sTB  = parseInt(season.totalBases,  10) || 0;
  const gHR  = parseInt(game.homeRuns,      10) || 0;
  const g2B  = parseInt(game.doubles,       10) || 0;
  const g3B  = parseInt(game.triples,       10) || 0;
  const gTB  = (gH - g2B - g3B - gHR) + g2B * 2 + g3B * 3 + gHR * 4;

  const sHR  = parseInt(season.homeRuns,    10) || 0;
  const sBB  = parseInt(season.baseOnBalls, 10) || 0;
  const gBB  = parseInt(game.baseOnBalls,   10) || 0;
  const sHBP = parseInt(season.hitByPitch,  10) || 0;
  const gHBP = parseInt(game.hitByPitch,    10) || 0;
  const sSF  = parseInt(season.sacFlies,    10) || 0;
  const gSF  = parseInt(game.sacFlies,      10) || 0;

  const preAB  = Math.max(0, sAB  - gAB);
  const preH   = Math.max(0, sH   - gH);
  const preTB  = Math.max(0, sTB  - gTB);
  const preHR  = Math.max(0, sHR  - gHR);
  const preBB  = Math.max(0, sBB  - gBB);
  const preHBP = Math.max(0, sHBP - gHBP);
  const preSF  = Math.max(0, sSF  - gSF);

  const avg      = preAB > 0 ? preH / preAB : 0;
  const slg      = preAB > 0 ? preTB / preAB : 0;
  const obpDenom = preAB + preBB + preHBP + preSF;
  const obp      = obpDenom > 0 ? (preH + preBB + preHBP) / obpDenom : 0;

  return {
    homeRuns: preHR,
    atBats:   preAB,
    avg:      avg.toFixed(3),
    slg:      slg.toFixed(3),
    obp:      obp.toFixed(3),
  };
}

async function fetchYesterdayResults(statcastMap = null, onProgress = null, daysAgo = 1) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const dateStr = localDateStr(d);

  // Yesterday's results are immutable once the day ends — freeze them on first load
  // so grades don't drift as pitcher stats and Statcast data update over subsequent days.
  const ydayCacheKey = `yardbomb_yday_${dateStr}`;
  try {
    const raw = localStorage.getItem(ydayCacheKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...parsed, hrIds: new Set(parsed.hrIds) };
    }
  } catch { /* ignore — fall through to fetch */ }

  onProgress?.('Fetching schedule…');
  const schedRes  = await fetch(`${BASE}/schedule?sportId=1&date=${dateStr}&hydrate=team,venue,probablePitcher`);
  const schedData = await schedRes.json();
  const allGames  = schedData.dates?.[0]?.games ?? [];
  const completed = allGames.filter((g) => g.status?.abstractGameState === 'Final');

  if (completed.length === 0) return { dateStr, picks: [], hrIds: new Set(), gameCount: 0 };

  // Fetch all boxscores in parallel
  onProgress?.(`Fetching ${completed.length} boxscores…`);
  const boxscores = await Promise.all(
    completed.map((game) =>
      fetch(`${BASE}/game/${game.gamePk}/boxscore`)
        .then((r) => r.json())
        .then((bs) => ({ game, bs }))
    )
  );

  // Collect the primary pitcher ID for each team — the pitcher with the most innings
  // pitched rather than pitchers[0], which may be an opener who threw only 1 inning.
  function primaryPitcherId(teamData) {
    const pitchers = teamData?.pitchers ?? [];
    if (pitchers.length === 0) return null;
    let bestId = pitchers[0];
    let bestIP = 0;
    for (const pid of pitchers) {
      const player = teamData?.players?.[`ID${pid}`];
      const ip     = parseFloat(player?.stats?.pitching?.inningsPitched ?? 0);
      if (ip > bestIP) { bestIP = ip; bestId = pid; }
    }
    return bestId;
  }

  const pitcherIds = new Set();
  for (const { bs } of boxscores) {
    for (const side of ['away', 'home']) {
      const id = primaryPitcherId(bs.teams?.[side]);
      if (id) pitcherIds.add(id);
    }
  }

  // Fetch all starter stats in parallel
  onProgress?.(`Fetching stats for ${pitcherIds.size} pitchers…`);
  const pitcherStatsMap = new Map();
  await Promise.all(
    [...pitcherIds].map(async (id) => {
      const stats = await fetchPitcherStats(id);
      pitcherStatsMap.set(id, stats);
    })
  );

  // Collect all batter IDs so we can batch-fetch career stats
  const allBatterIds = new Set();
  for (const { bs } of boxscores) {
    for (const side of ['away', 'home']) {
      const td = bs.teams?.[side];
      if (!td) continue;
      for (const rawId of (td.battingOrder ?? [])) {
        const nid = parseInt(rawId, 10);
        if (nid) allBatterIds.add(nid);
      }
    }
  }

  onProgress?.(`Fetching career/split stats for ${allBatterIds.size} batters…`);
  const careerStatsMap = new Map();
  const splitsMap      = new Map();
  await Promise.all(
    [...allBatterIds].map(async (id) => {
      try {
        const res  = await fetch(`${BASE}/people/${id}/stats?stats=career,statSplits&group=hitting&sitCodes=vl,vr`);
        const data = await res.json();
        const career = data.stats?.find((s) =>
          s.type?.displayName?.toLowerCase() === 'career'
        )?.splits?.[0]?.stat ?? {};
        careerStatsMap.set(id, {
          careerAvg: parseFloat(career.avg)                              || null,
          careerSlg: parseFloat(career.sluggingPercentage ?? career.slg) || null,
          careerHR:  parseInt(career.homeRuns, 10)                        || 0,
          careerAB:  parseInt(career.atBats,   10)                        || 0,
        });
        const splitGroup = data.stats?.find((s) => s.type?.displayName?.toLowerCase().includes('split'));
        const parseSplit = (code) => {
          const row = splitGroup?.splits?.find((sp) => sp.split?.code === code)?.stat;
          if (!row) return null;
          return {
            slg:      parseFloat(row.sluggingPercentage ?? row.slg) || null,
            avg:      parseFloat(row.avg)                           || null,
            atBats:   parseInt(row.atBats,   10)                    || 0,
            homeRuns: parseInt(row.homeRuns, 10)                    || 0,
          };
        };
        splitsMap.set(id, { vsL: parseSplit('vl'), vsR: parseSplit('vr') });
      } catch {
        careerStatsMap.set(id, {});
        splitsMap.set(id, {});
      }
    })
  );

  onProgress?.('Scoring batters…');

  // Build scored picks from every batter in every batting order
  const hrIds   = new Set();
  const allRows = [];

  for (const { game, bs } of boxscores) {
    const venue    = game.venue?.name ?? '';
    const awayName = game.teams?.away?.team?.name ?? '';
    const homeName = game.teams?.home?.team?.name ?? '';

    for (const side of ['away', 'home']) {
      const teamData  = bs.teams?.[side];
      if (!teamData) continue;

      // Opposing primary pitcher = highest-IP pitcher from the other side
      const oppSide      = side === 'away' ? 'home' : 'away';
      const oppStarterId = primaryPitcherId(bs.teams?.[oppSide]);
      const oppPitcher   = oppStarterId ? (pitcherStatsMap.get(oppStarterId) ?? {}) : {};

      const battingOrder = teamData.battingOrder ?? [];

      for (let bi = 0; bi < battingOrder.length; bi++) {
        const rawId  = battingOrder[bi];
        // battingOrder entries are like "123456001"; player keys are "ID123456"
        const numericId = parseInt(rawId, 10);
        const playerKey = `ID${numericId}`;
        const player    = teamData.players?.[playerKey];
        if (!player) continue;

        const gameStat   = player.stats?.batting ?? {};
        const seasonStat = player.seasonStats?.batting ?? {};
        const gameHR     = parseInt(gameStat.homeRuns, 10) || 0;

        if (gameHR > 0) hrIds.add(numericId);

        const pre     = computePreGameStats(seasonStat, gameStat);
        const batSide = player.person.batSide?.code ?? 'R';
        const career  = careerStatsMap.get(numericId) ?? {};
        const splits  = splitsMap.get(numericId) ?? {};
        // Cap at 9 so late substitutes don't get bench-slot treatment
        const lineupPos = Math.min(bi + 1, 9);

        const batter = {
          id:        numericId,
          homeRuns:  pre.homeRuns,
          avg:       pre.avg,
          slg:       pre.slg,
          obp:       pre.obp,
          atBats:    pre.atBats,
          hotStreak: 0.5,
          batSide,
          ...career,
          ...splits,
        };

        const base          = scoreHRProbability(batter, oppPitcher, venue, statcastMap);
        const mult          = lineupMultiplier(lineupPos);
        const adjustedTotal = clamp(base.total * mult);

        allRows.push({
          id:        numericId,
          name:      player.person.fullName,
          position:  player.position?.abbreviation ?? '?',
          teamName:  teamData.team?.name ?? '',
          awayName,
          homeName,
          venue,
          gameHR,
          ...batter,
          ...base,
          total:     adjustedTotal,
          ...gradeInfo(adjustedTotal),
        });
      }
    }
  }

  allRows.sort((a, b) => b.total - a.total);

  // Hit rate by grade across all scored batters (not just top 25) for calibration tracking
  const byGrade = {};
  for (const row of allRows) {
    if (!row.grade) continue;
    if (!byGrade[row.grade]) byGrade[row.grade] = { picks: 0, hits: 0 };
    byGrade[row.grade].picks++;
    if (hrIds.has(row.id)) byGrade[row.grade].hits++;
  }

  // Save today's accuracy record to the rolling log
  const top25acc      = allRows.slice(0, 25);
  const hitsAcc       = top25acc.filter((r) => hrIds.has(r.id)).length;
  saveAccuracyRecord(dateStr, {
    dateStr,
    precision:   top25acc.length > 0 ? Math.round((hitsAcc / top25acc.length) * 100) : null,
    recall:      hrIds.size   > 0 ? Math.round((hitsAcc / hrIds.size)    * 100) : null,
    totalHRs:    hrIds.size,
    hitsInTop25: hitsAcc,
    top25Count:  top25acc.length,
    gameCount:   completed.length,
    byGrade,
  });

  // Persist to localStorage so grades are frozen for the rest of today and beyond
  try {
    localStorage.setItem(ydayCacheKey, JSON.stringify({
      dateStr,
      picks: allRows,
      hrIds: [...hrIds],
      gameCount: completed.length,
    }));
  } catch { /* storage full or unavailable */ }

  return { dateStr, picks: allRows, hrIds, gameCount: completed.length };
}

// ---------------------------------------------------------------------------
// Tab: Yesterday's Results
// ---------------------------------------------------------------------------
const YESTERDAY_VIEWS = ['Top Picks', 'HR Hitters'];

function TabYesterday({ statcastMap }) {
  const [state,       setState]       = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);
  const [view,        setView]        = useState('Top Picks');
  const [progressMsg,     setProgressMsg]     = useState('');
  const [accuracyHistory, setAccuracyHistory] = useState([]);

  useEffect(() => {
    setLoading(true);
    setProgressMsg('');
    fetchYesterdayResults(statcastMap, setProgressMsg)
      .then((data) => {
        setState(data);
        setAccuracyHistory(loadAccuracyHistory(SEASON_DAYS_ELAPSED));
        setLoading(false);
        setProgressMsg('');
      })
      .catch((err) => { setError(err.message); setLoading(false); setProgressMsg(''); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // After yesterday loads, backfill accuracy records for any older days we're missing.
  // Fetches sequentially (days 2–7) to avoid hammering the API; skips days already cached.
  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    async function backfill() {
      for (let i = 2; i <= 7; i++) {
        if (cancelled) return;
        const d = new Date();
        d.setDate(d.getDate() - i);
        const ds = localDateStr(d);
        if (!localStorage.getItem(`yardbomb_acc_${ds}`)) {
          try {
            await fetchYesterdayResults(statcastMap, null, i);
            if (!cancelled) setAccuracyHistory(loadAccuracyHistory(SEASON_DAYS_ELAPSED));
          } catch { /* ignore — day may have no games */ }
        }
      }
    }
    backfill();
    return () => { cancelled = true; };
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return (
    <div style={{ color: C.muted, fontFamily: 'Barlow, sans-serif', padding: '1rem 0' }}>
      <p style={{ margin: 0 }}>Loading yesterday's results…</p>
      {progressMsg && (
        <p style={{ margin: '6px 0 0', fontSize: '0.75rem', fontFamily: 'JetBrains Mono, monospace', color: C.accent }}>
          {progressMsg}
        </p>
      )}
    </div>
  );
  if (error)   return <p style={{ color: '#f55',  fontFamily: 'Barlow, sans-serif' }}>Error: {error}</p>;
  if (!state)  return null;

  const { dateStr, picks, hrIds, gameCount } = state;
  const formattedDate = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const totalHRs    = [...hrIds].length;
  const top25       = picks.slice(0, 25);
  const hitsInTop25 = top25.filter((p) => hrIds.has(p.id)).length;
  const precision   = top25.length > 0 ? Math.round((hitsInTop25 / top25.length) * 100) : null;
  const recall      = totalHRs > 0 ? Math.round((hitsInTop25 / totalHRs) * 100) : null;
  const hrHitters   = picks.filter((p) => hrIds.has(p.id));

  function ResultRow({ p, rank }) {
    const hit        = hrIds.has(p.id);
    const { color }  = gradeInfo(p.total ?? 0);
    return (
      <div style={{
        background: hit ? '#0d1f0f' : C.card,
        border: `1px solid ${hit ? '#34d39944' : C.border}`,
        borderRadius: '8px', padding: '0.7rem 1rem',
        marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '10px',
      }}>
        {/* Rank */}
        <span style={{ fontFamily: 'Oswald, sans-serif', fontSize: '0.75rem', color: C.muted, minWidth: '22px' }}>
          #{rank}
        </span>

        {/* Hit / miss indicator */}
        <div style={{
          minWidth: '32px', textAlign: 'center',
          fontFamily: 'JetBrains Mono, monospace', fontSize: '1rem',
        }}>
          {hit
            ? <span style={{ color: '#34d399' }}>{p.gameHR > 1 ? `${p.gameHR}⚾` : '⚾'}</span>
            : <span style={{ color: '#374151' }}>—</span>
          }
        </div>

        {/* Name + context */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'Oswald, sans-serif', fontWeight: 600, fontSize: '0.95rem', color: hit ? '#d1fae5' : C.text }}>
            {p.name}
          </div>
          <div style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.7rem', color: C.muted, marginTop: '1px' }}>
            {p.teamName} · {p.position} · {p.awayName} @ {p.homeName}
          </div>
        </div>

        {/* Season stats */}
        <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
          <StatTag label="HR"  value={p.homeRuns} />
          <StatTag label="SLG" value={p.slg} />
        </div>

        {/* Grade + score */}
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <GradeChip grade={p.grade ?? '?'} color={color} size="sm" />
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem', color: C.muted, marginTop: '3px' }}>
            {(p.total * 100).toFixed(1)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Date + summary */}
      <div style={{ marginBottom: '1.1rem' }}>
        <h2 style={{ fontFamily: 'Oswald, sans-serif', color: C.accent, letterSpacing: '0.05em', margin: 0 }}>
          {formattedDate}
        </h2>
        <div style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.8rem', color: C.muted, marginTop: '3px' }}>
          {gameCount} completed games
        </div>
      </div>

      {/* Stats bar */}
      <div style={{
        display: 'flex', gap: '1.5rem', flexWrap: 'wrap',
        background: C.card, border: `1px solid ${C.border}`,
        borderRadius: '8px', padding: '0.9rem 1.1rem', marginBottom: '1.1rem',
      }}>
        <div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '1.4rem', fontWeight: 700, color: C.accent }}>{totalHRs}</div>
          <div style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.72rem', color: C.muted }}>HR hitters yesterday</div>
        </div>
        <div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '1.4rem', fontWeight: 700, color: C.text }}>{hitsInTop25}/{top25.length}</div>
          <div style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.72rem', color: C.muted }}>HR hitters in top 25 picks</div>
        </div>
        {precision != null && (
          <div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '1.4rem', fontWeight: 700, color: '#60a5fa' }}>{precision}%</div>
            <div style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.72rem', color: C.muted }}>precision (top 25)</div>
          </div>
        )}
        {recall != null && (
          <div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '1.4rem', fontWeight: 700, color: '#a78bfa' }}>{recall}%</div>
            <div style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.72rem', color: C.muted }}>recall (HR hitters found)</div>
          </div>
        )}
      </div>

      {/* Rolling accuracy history */}
      {accuracyHistory.length > 0 && (() => {
        const withPrecision = accuracyHistory.filter((r) => r.precision != null);
        const withRecall    = accuracyHistory.filter((r) => r.recall    != null);
        const avgPrecision  = withPrecision.length > 0
          ? Math.round(withPrecision.reduce((s, r) => s + r.precision, 0) / withPrecision.length)
          : null;
        const avgRecall     = withRecall.length > 0
          ? Math.round(withRecall.reduce((s, r) => s + r.recall, 0) / withRecall.length)
          : null;
        return (
          <div style={{
            background: C.card, border: `1px solid ${C.border}`,
            borderRadius: '8px', padding: '0.9rem 1.1rem', marginBottom: '1.1rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', marginBottom: '10px', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'Oswald, sans-serif', fontSize: '0.72rem', color: C.muted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Rolling Accuracy — {accuracyHistory.length} day{accuracyHistory.length !== 1 ? 's' : ''}
              </span>
              {avgPrecision != null && (
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem', color: '#60a5fa' }}>
                  avg precision <strong>{avgPrecision}%</strong>
                </span>
              )}
              {avgRecall != null && (
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem', color: '#a78bfa' }}>
                  avg recall <strong>{avgRecall}%</strong>
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {accuracyHistory.map((r) => {
                const pct   = r.precision ?? null;
                const color = pct == null ? C.muted : pct >= 36 ? '#34d399' : pct >= 24 ? '#fbbf24' : '#f87171';
                const label = new Date(r.dateStr + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                return (
                  <div key={r.dateStr} title={`${r.hitsInTop25}/${r.top25Count} HR hitters in top 25 · recall ${r.recall ?? '—'}%`} style={{
                    background: C.surface, border: `1px solid ${C.border}`,
                    borderRadius: '5px', padding: '5px 8px', textAlign: 'center', minWidth: '50px',
                  }}>
                    <div style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.62rem', color: C.muted, marginBottom: '2px' }}>{label}</div>
                    <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.82rem', fontWeight: 700, color }}>
                      {pct != null ? `${pct}%` : '—'}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Grade calibration — aggregate hit rate per grade across all history days */}
            {(() => {
              const agg = {};
              for (const r of accuracyHistory) {
                if (!r.byGrade) continue;
                for (const [grade, { picks, hits }] of Object.entries(r.byGrade)) {
                  if (!agg[grade]) agg[grade] = { picks: 0, hits: 0 };
                  agg[grade].picks += picks;
                  agg[grade].hits  += hits;
                }
              }
              const grades = GRADE_SCALE.map((g) => g.grade).filter((g) => agg[g]?.picks > 0);
              if (grades.length === 0) return null;
              return (
                <div style={{ marginTop: '14px', borderTop: `1px solid ${C.border}`, paddingTop: '12px' }}>
                  <div style={{ fontFamily: 'Oswald, sans-serif', fontSize: '0.72rem', color: C.muted, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '8px' }}>
                    Grade Calibration
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    {grades.map((grade) => {
                      const { picks, hits } = agg[grade];
                      const rate  = picks > 0 ? hits / picks : 0;
                      const { color } = GRADE_SCALE.find((g) => g.grade === grade) ?? {};
                      return (
                        <div key={grade} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{ minWidth: '32px' }}>
                            <GradeChip grade={grade} color={color} size="sm" />
                          </div>
                          <div style={{ flex: 1, height: '6px', background: '#2a2d35', borderRadius: '3px', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${rate * 100}%`, background: color, borderRadius: '3px', transition: 'width 0.4s ease' }} />
                          </div>
                          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.70rem', color: C.text, minWidth: '34px', textAlign: 'right' }}>
                            {Math.round(rate * 100)}%
                          </span>
                          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: C.muted, minWidth: '48px' }}>
                            {hits}/{picks}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })()}

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '1rem', borderBottom: `1px solid ${C.border}`, paddingBottom: '0' }}>
        {YESTERDAY_VIEWS.map((v) => (
          <button key={v} onClick={() => setView(v)} style={{
            background: 'none', border: 'none',
            borderBottom: `2px solid ${view === v ? C.accent : 'transparent'}`,
            color: view === v ? C.accent : C.muted,
            fontFamily: 'Oswald, sans-serif', fontWeight: 600,
            fontSize: '0.8rem', letterSpacing: '0.06em',
            padding: '0.5rem 0.9rem', cursor: 'pointer',
            transition: 'color 0.15s',
          }}>
            {v.toUpperCase()}
            {v === 'HR Hitters' && <span style={{ marginLeft: '6px', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem' }}>({hrHitters.length})</span>}
          </button>
        ))}
      </div>

      {picks.length === 0 && (
        <div style={{ color: C.muted, fontFamily: 'Barlow, sans-serif', padding: '2rem 0', textAlign: 'center' }}>
          No completed games found for yesterday.
        </div>
      )}

      {/* Top Picks view — full sorted list with hit/miss */}
      {view === 'Top Picks' && picks.length > 0 && (
        <>
          <div style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.75rem', color: C.muted, marginBottom: '0.75rem' }}>
            All batters from yesterday's games, sorted by model score · green rows = actual HR · hot streak defaulted to neutral
          </div>
          {picks.map((p, i) => <ResultRow key={`${p.id}-${i}`} p={p} rank={i + 1} />)}
        </>
      )}

      {/* HR Hitters view — only players who actually homered */}
      {view === 'HR Hitters' && (
        <>
          {hrHitters.length === 0 ? (
            <div style={{ color: C.muted, fontFamily: 'Barlow, sans-serif', padding: '2rem 0', textAlign: 'center' }}>
              No home runs recorded in yesterday's completed games.
            </div>
          ) : (
            <>
              <div style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.75rem', color: C.muted, marginBottom: '0.75rem' }}>
                Players who hit at least one HR yesterday, sorted by model score
              </div>
              {hrHitters.map((p, i) => <ResultRow key={`${p.id}-${i}`} p={p} rank={picks.findIndex((x) => x.id === p.id) + 1} />)}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Methodology
// ---------------------------------------------------------------------------
function TabMethodology() {
  const factors = [
    { name: 'Power', weight: '30%', color: '#60a5fa', desc: 'Derived from SLG, Isolated Power (SLG − AVG), and HR/AB rate. Elite ceiling is .600 SLG / .300 ISO.' },
    { name: 'Pitcher Vulnerability', weight: '25%', color: '#f97316', desc: 'Four components: ERA (40%), HR/9 (30%), K/9 (15%), BB/9 (15%). ERA is blended 60% last-5-starts + 40% season — recent form matters more than the full-year line. K/9 inverted so high strikeout pitchers score less vulnerable. BB/9 captures control: a walk-prone pitcher is more hittable. Scales: ERA 1.50–6.00, HR/9 0.50–2.00, K/9 5–15 (inverted), BB/9 1.5–5.0.' },
    { name: 'Park Factor', weight: '20%', color: '#a78bfa', desc: 'Per-stadium HR index sourced from 2025 data. Great American Ball Park (+27%) is most hitter-friendly; Oracle Park (−24%) is least.' },
    { name: 'Hot Streak', weight: '15%', color: '#34d399', desc: `Recency-weighted form score over the last ${HOT_STREAK_GAMES} games. Each game is weighted by ${STREAK_DECAY}^(games ago), so the most recent game counts ~2× more than game 10. Blends HR rate (65%) with batting average (35%) — a player on a hot hitting streak gets credit even without recent HRs. HR component: league-avg pace = 0.50, 2× avg = 1.0. AVG component: .250 = 0.50, .500 = 1.0. Requires at least ${HOT_STREAK_MIN_G} games — players below that threshold default to 0.50 (neutral).` },
    { name: 'Platoon Advantage', weight: '10%', color: '#fbbf24', desc: 'Opposite-hand matchup (0.80) > switch hitter (0.65) > same-hand (0.40). Bat side fetched live from the MLB Stats API.' },
    { name: 'Wind Adjustment', weight: 'modifier', color: '#94a3b8', desc: 'Applied on top of the composite score after weighting. Wind out (any direction) adds up to +0.08; wind in subtracts up to −0.08; crosswind is neutral. Scaled linearly by speed — 20 mph = full effect. Sourced from the MLB live game feed at load time.' },
  ];

  const grades = GRADE_SCALE.map((g) => ({ ...g }));

  return (
    <div style={{ fontFamily: 'Barlow, sans-serif', maxWidth: '700px' }}>
      <h2 style={{ fontFamily: 'Oswald, sans-serif', color: C.accent, letterSpacing: '0.05em', marginBottom: '1.2rem' }}>
        How Scores Are Calculated
      </h2>
      <p style={{ color: C.muted, fontSize: '0.9rem', marginBottom: '1.5rem', lineHeight: '1.6' }}>
        Each batter receives a composite score from 0–100 weighted across five factors. All factor scores are normalized to [0, 1] before weighting.
      </p>

      {factors.map((f) => (
        <div key={f.name} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '1rem', marginBottom: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <span style={{ fontFamily: 'Oswald, sans-serif', fontWeight: 600, color: f.color, fontSize: '1rem' }}>{f.name}</span>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.85rem', color: C.accent }}>{f.weight}</span>
          </div>
          <p style={{ color: C.muted, fontSize: '0.83rem', lineHeight: '1.55', margin: 0 }}>{f.desc}</p>
        </div>
      ))}

      <h3 style={{ fontFamily: 'Oswald, sans-serif', color: C.text, marginTop: '2rem', marginBottom: '0.8rem', letterSpacing: '0.05em' }}>
        Grade Scale
      </h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {grades.map((g) => (
          <div key={g.grade} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <GradeChip grade={g.grade} color={g.color} size="sm" />
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem', color: C.muted }}>
              ≥ {(g.min * 100).toFixed(0)}
            </span>
          </div>
        ))}
      </div>

      <h3 style={{ fontFamily: 'Oswald, sans-serif', color: C.text, marginTop: '2rem', marginBottom: '0.8rem', letterSpacing: '0.05em' }}>
        Data Sources
      </h3>
      <ul style={{ color: C.muted, fontSize: '0.83rem', lineHeight: '2', paddingLeft: '1.2rem' }}>
        <li>MLB Stats API — live schedule, rosters, season batting/pitching stats, bat/pitch hand</li>
        <li>Park factors — 2025 HR index updated for 2026 changes (Kauffman fence changes, Rays back at Tropicana, A's at Las Vegas Ballpark)</li>
        <li>Hot streak — recency-weighted HR rate over the last {HOT_STREAK_GAMES} games via MLB Stats API game log</li>
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const TABS = ['Top Picks', 'By Game', "Yesterday's Results", 'Methodology'];

export default function App() {
  const [games,       setGames]       = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [tab,         setTab]         = useState('By Game');
  const [gameResults,   setGameResults]   = useState({});
  const [loadingPks,    setLoadingPks]    = useState({});
  const [statcastMap,   setStatcastMap]   = useState(null);
  const [statcastReady, setStatcastReady] = useState(false); // true = fetch attempted

  useEffect(() => {
    cachePrune();

    const cachedSched = cacheGetWithMeta('schedule');
    if (cachedSched) {
      setGames([...cachedSched.data].sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate)));
      setLoading(false);
    } else {
      const today = localDateStr();
      fetch(`${BASE}/schedule?sportId=1&date=${today}&hydrate=team,venue,probablePitcher(note),lineups`)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((d) => {
          const games = (d.dates?.[0]?.games ?? [])
            .filter((g) => g.status?.detailedState !== 'Postponed')
            .sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));
          cacheSet('schedule', games);
          setGames(games);
          setLoading(false);
        })
        .catch((e) => { setError(e.message); setLoading(false); });
    }

    fetchStatcastLeaderboard().then((map) => {
      setStatcastMap(map);
      setStatcastReady(true);
    }).catch(() => {
      setStatcastReady(true); // mark as attempted even on failure
    });

    // Restore any previously loaded game results from cache
    const prefix = `yardbomb_game_`;
    try {
      const restored = {};
      Object.keys(localStorage)
        .filter((k) => k.startsWith(prefix) && k.endsWith(TODAY))
        .forEach((k) => {
          try {
            const pk     = k.replace(prefix, '').replace(`_${TODAY}`, '');
            const cached = cacheGetWithMeta(`game_${pk}`);
            if (cached) restored[pk] = { ...cached.data, loadedAt: cached.loadedAt };
          } catch { /* skip corrupted entry */ }
        });
      if (Object.keys(restored).length > 0) setGameResults(restored);
    } catch { /* ignore */ }
  }, []);

  const handleLoad = useCallback((game) => {
    const pk = game.gamePk;
    setLoadingPks((s) => ({ ...s, [pk]: true }));
    fetchGameData(game, statcastMap)
      .then((result) => {
        const loadedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        cacheSet(`game_${pk}`, result);
        setGameResults((s) => ({ ...s, [pk]: { ...result, loadedAt } }));
        setLoadingPks((s) => ({ ...s, [pk]: false }));
      })
      .catch((err) => {
        console.error('fetchGameData failed:', err);
        setLoadingPks((s) => ({ ...s, [pk]: false }));
      });
  }, [statcastMap]);

  const handleRefresh = useCallback((game) => {
    const pk = game.gamePk;
    cacheClear(`game_${pk}`);
    // Keep the stale result visible while re-fetching — only swap it out when
    // the new data arrives so the loadedAt timestamp always reflects this fetch.
    setLoadingPks((s) => ({ ...s, [pk]: true }));
    fetchGameData(game, statcastMap)
      .then((result) => {
        const loadedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        cacheSet(`game_${pk}`, result);
        setGameResults((s) => ({ ...s, [pk]: { ...result, loadedAt } }));
        setLoadingPks((s) => ({ ...s, [pk]: false }));
      })
      .catch((err) => {
        console.error('fetchGameData refresh failed:', err);
        setLoadingPks((s) => ({ ...s, [pk]: false }));
      });
  }, [statcastMap]);

  const handleLoadAll = useCallback(() => {
    games
      .filter((g) => !gameResults[g.gamePk] && !loadingPks[g.gamePk])
      .forEach((g) => handleLoad(g));
  }, [games, gameResults, loadingPks, handleLoad]);

  // Bust the schedule cache and re-fetch lineups, then re-fetch all already-loaded
  // games so scores reflect updated lineup positions and timestamps refresh.
  const handleRefreshLineups = useCallback(() => {
    cacheClear('schedule');
    setLoading(true);
    const today = localDateStr();
    fetch(`${BASE}/schedule?sportId=1&date=${today}&hydrate=team,venue,probablePitcher(note),lineups`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => {
        const newGames = (d.dates?.[0]?.games ?? [])
          .filter((g) => g.status?.detailedState !== 'Postponed')
          .sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));
        cacheSet('schedule', newGames);
        setGames(newGames);
        setLoading(false);

        // Re-fetch every game that was already loaded so scores and timestamps update.
        const loadedPks = new Set(Object.keys(gameResults));
        newGames
          .filter((g) => loadedPks.has(String(g.gamePk)))
          .forEach((g) => {
            const pk = g.gamePk;
            cacheClear(`game_${pk}`);
            setLoadingPks((s) => ({ ...s, [pk]: true }));
            fetchGameData(g, statcastMap)
              .then((result) => {
                const loadedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                cacheSet(`game_${pk}`, result);
                setGameResults((s) => ({ ...s, [pk]: { ...result, loadedAt } }));
                setLoadingPks((s) => ({ ...s, [pk]: false }));
              })
              .catch(() => setLoadingPks((s) => ({ ...s, [pk]: false })));
          });
      })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [gameResults, statcastMap]);

  return (
    <div style={{ background: C.bg, minHeight: '100vh', color: C.text }}>
      {/* Header */}
      <div style={{ background: C.surface, borderBottom: `2px solid ${C.accent}`, padding: '0.9rem 1.5rem', display: 'flex', alignItems: 'baseline', gap: '12px' }}>
        <h1 style={{ fontFamily: 'Oswald, sans-serif', fontWeight: 700, fontSize: '1.7rem', color: C.accent, margin: 0, letterSpacing: '0.08em' }}>
          YARD BOMB
        </h1>
        <span style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.8rem', color: C.muted }}>
          MLB HR Probability Dashboard
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }}>
          {statcastReady && (
            <span style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: '0.68rem',
              padding: '2px 7px',
              borderRadius: '3px',
              background: statcastMap?.size > 0 ? '#1a3a2a' : '#2a1a1a',
              color:      statcastMap?.size > 0 ? '#34d399'  : '#f87171',
              border:     `1px solid ${statcastMap?.size > 0 ? '#34d39944' : '#f8717144'}`,
            }}>
              {statcastMap?.size > 0 ? `SC ✓ ${statcastMap.size} players` : 'SC unavailable'}
            </span>
          )}
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem', color: '#444' }}>
            {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        </span>
      </div>

      {/* Tabs */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, display: 'flex', padding: '0 1.5rem' }}>
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: `2px solid ${tab === t ? C.accent : 'transparent'}`,
              color: tab === t ? C.accent : C.muted,
              fontFamily: 'Oswald, sans-serif',
              fontWeight: 600,
              fontSize: '0.85rem',
              letterSpacing: '0.06em',
              padding: '0.75rem 1rem',
              cursor: 'pointer',
              transition: 'color 0.15s',
              whiteSpace: 'nowrap',
            }}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ maxWidth: '960px', margin: '0 auto', padding: '1.5rem' }}>
        {loading && <p style={{ color: C.muted, fontFamily: 'Barlow, sans-serif' }}>Loading today's schedule…</p>}
        {error   && <p style={{ color: '#f55',  fontFamily: 'Barlow, sans-serif' }}>Error: {error}</p>}

        {tab === 'Top Picks' && (
          <TabTopPicks gameResults={gameResults} games={games} />
        )}

        {tab === 'By Game' && !loading && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '8px' }}>
              <span style={{ fontFamily: 'Barlow, sans-serif', fontSize: '0.8rem', color: C.muted }}>
                {games.length} games today · Click a game to expand
              </span>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  onClick={handleRefreshLineups}
                  title="Re-fetch lineups and refresh all loaded games"
                  style={{
                    background: 'none', border: `1px solid ${C.border}`,
                    borderRadius: '5px', color: C.muted,
                    fontFamily: 'Barlow, sans-serif', fontSize: '0.75rem',
                    padding: '0.3rem 0.7rem', cursor: 'pointer',
                  }}
                >
                  ↻ lineups
                </button>
                {games.some((g) => !gameResults[g.gamePk]) && (
                  <button
                    onClick={handleLoadAll}
                    disabled={games.every((g) => gameResults[g.gamePk] || loadingPks[g.gamePk])}
                    style={{
                      background: C.accent, color: '#000',
                      border: 'none', borderRadius: '5px',
                      padding: '0.35rem 1rem',
                      fontFamily: 'Oswald, sans-serif', fontWeight: 700,
                      fontSize: '0.82rem', letterSpacing: '0.06em',
                      cursor: 'pointer',
                    }}
                  >
                    LOAD ALL GAMES
                  </button>
                )}
              </div>
            </div>
            {games.map((game) => (
              <GameGroup
                key={game.gamePk}
                game={game}
                result={gameResults[game.gamePk] ?? null}
                loading={!!loadingPks[game.gamePk]}
                onLoad={() => handleLoad(game)}
                onRefresh={() => handleRefresh(game)}
              />
            ))}
          </div>
        )}

        {tab === "Yesterday's Results" && <TabYesterday statcastMap={statcastMap} />}
        {tab === 'Methodology'         && <TabMethodology />}
      </div>
    </div>
  );
}
