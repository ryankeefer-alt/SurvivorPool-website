const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());

/* ────────────────────────────────
   Data file paths
   Store data in home directory so it survives Hostinger deploys.
   The git deploy replaces the app directory, but ~/survivorpool-data persists.
   Override with DATA_DIR env var if needed.
──────────────────────────────── */
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), 'survivorpool-data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const PLAYERS_PATH = path.join(DATA_DIR, 'players.json');
const GAMES_PATH = path.join(DATA_DIR, 'games.json');

/* ────────────────────────────────
   Helpers
──────────────────────────────── */
function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}
function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// Auto-create data files if they don't exist (first deploy)
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CONFIG_PATH)) writeJSON(CONFIG_PATH, { currentDay: 'thursday_r1', pickDay: 'thursday_r1', closedDays: [], adminPin: 'KeeferNet2@3#', buybackDays: ['friday_r1','saturday_r2','sunday_r2'] });
// Update admin PIN if it's still the old default; ensure pickDay exists
var _cfg = readJSON(CONFIG_PATH);
var _cfgChanged = false;
if (_cfg.adminPin === '2025') { _cfg.adminPin = 'KeeferNet2@3#'; _cfgChanged = true; }
if (!_cfg.pickDay) { _cfg.pickDay = _cfg.currentDay || 'thursday_r1'; _cfgChanged = true; }
if (_cfgChanged) writeJSON(CONFIG_PATH, _cfg);
if (!fs.existsSync(PLAYERS_PATH)) writeJSON(PLAYERS_PATH, []);
if (!fs.existsSync(GAMES_PATH)) writeJSON(GAMES_PATH, {});

/* ────────────────────────────────
   Constants
──────────────────────────────── */
const DAY_ORDER = [
  'thursday_r1','friday_r1','saturday_r2','sunday_r2',
  'thursday_s16','friday_s16','saturday_e8','sunday_e8',
  'saturday_ff','monday_champ'
];

const PICKS_PER_DAY = {
  thursday_r1: 2, friday_r1: 2,
  saturday_r2: 1, sunday_r2: 1,
  thursday_s16: 1, friday_s16: 1,
  saturday_e8: 1, sunday_e8: 1,
  saturday_ff: 1, monday_champ: 1,
};

const BUYBACK_PICKS = {
  friday_r1: 4,
  saturday_r2: 3,
  sunday_r2: 3,
};

const TEAMS_BY_DAY = {};

/* ══════════════════════════════
   API Routes
══════════════════════════════ */

/* ── GET /api/state ── returns all data for the frontend */
app.get('/api/state', function(req, res) {
  var config = readJSON(CONFIG_PATH);
  var players = readJSON(PLAYERS_PATH);
  var games = readJSON(GAMES_PATH);

  // Recalculate player statuses based on current game data
  // This ensures statuses are always correct regardless of stale data
  var statusChanged = false;
  for (var si = 0; si < players.length; si++) {
    var sp = players[si];
    // Find the latest day this player has picks for
    var latestDay = null;
    var latestIdx = -1;
    for (var sd = 0; sd < DAY_ORDER.length; sd++) {
      if (sp.picks[DAY_ORDER[sd]]) {
        if (sd > latestIdx) {
          latestIdx = sd;
          latestDay = DAY_ORDER[sd];
        }
      }
    }
    if (!latestDay) continue;

    // Get winners and decided teams for the latest day
    var sdGames = games[latestDay] || [];
    var sdWinners = [];
    var sdDecided = [];
    for (var sg = 0; sg < sdGames.length; sg++) {
      if (sdGames[sg].final && sdGames[sg].winner) {
        sdWinners.push(sdGames[sg].winner);
        sdDecided.push(sdGames[sg].home);
        sdDecided.push(sdGames[sg].away);
      }
    }

    var sdPicks = sp.picks[latestDay];

    // Handle "None" picks — automatic loss once all games are final
    var sdIsNone = sdPicks.length === 1 && sdPicks[0] === 'None';
    var correctStatus, correctResult;
    if (sdIsNone) {
      var sdAllFinal = sdGames.length > 0 && sdGames.every(function(g) { return g.final; });
      correctResult = sdAllFinal ? 'loss' : 'pending';
      correctStatus = sdAllFinal ? 'eliminated' : 'alive';
    } else {
      var sdDecidedPicks = sdPicks.filter(function(t) { return sdDecided.indexOf(t) !== -1; });
      var sdUndecidedPicks = sdPicks.filter(function(t) { return sdDecided.indexOf(t) === -1; });

      if (sdDecidedPicks.length === 0) {
        // No games final for this player's picks — pending, alive
        correctResult = 'pending';
        correctStatus = 'alive';
      } else {
        var sdHasLoss = sdDecidedPicks.some(function(t) { return sdWinners.indexOf(t) === -1; });
        if (sdHasLoss) {
          correctResult = 'loss';
          correctStatus = 'eliminated';
        } else if (sdUndecidedPicks.length === 0) {
          correctResult = 'win';
          correctStatus = 'alive';
        } else {
          correctResult = 'pending';
          correctStatus = 'alive';
        }
      }
    }

    if (sp.results[latestDay] !== correctResult || sp.status !== correctStatus) {
      sp.results[latestDay] = correctResult;
      sp.status = correctStatus;
      statusChanged = true;
    }
  }
  if (statusChanged) {
    writeJSON(PLAYERS_PATH, players);
  }

  // Don't send the admin PIN to the client
  var safeConfig = Object.assign({}, config);
  delete safeConfig.adminPin;

  // Derive teams from games data (so imported games auto-populate team lists)
  var teams = {};
  Object.keys(TEAMS_BY_DAY).forEach(function(day) {
    teams[day] = TEAMS_BY_DAY[day];
  });
  Object.keys(games).forEach(function(day) {
    if (games[day] && games[day].length > 0) {
      var dayTeams = [];
      games[day].forEach(function(g) {
        if (g.home && dayTeams.indexOf(g.home) === -1) dayTeams.push(g.home);
        if (g.away && dayTeams.indexOf(g.away) === -1) dayTeams.push(g.away);
      });
      teams[day] = dayTeams.sort();
    }
  });

  res.json({
    config: safeConfig,
    players: players,
    games: games,
    teams: teams,
    picksPerDay: PICKS_PER_DAY,
    buybackPicks: BUYBACK_PICKS,
    dayOrder: DAY_ORDER
  });
});

/* ── POST /api/picks ── submit picks for a player */
app.post('/api/picks', function(req, res) {
  var config = readJSON(CONFIG_PATH);
  var body = req.body;
  var day = body.day;
  var name = body.name;
  var picks = body.picks;
  var email = body.email;

  if (!name || !day || !Array.isArray(picks) || picks.length === 0) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  // Check if day is closed
  if (config.closedDays && config.closedDays.indexOf(day) !== -1) {
    return res.status(400).json({ error: 'Entries for this day are closed.' });
  }

  // Check if the pick day has advanced to this day yet
  var pickDayIdx = DAY_ORDER.indexOf(config.pickDay || config.currentDay);
  var reqDayIdx = DAY_ORDER.indexOf(day);
  if (reqDayIdx > pickDayIdx) {
    return res.status(400).json({ error: 'Picks for this day are not open yet.' });
  }

  // Check for duplicate teams in submission
  var uniquePicks = [];
  for (var i = 0; i < picks.length; i++) {
    if (uniquePicks.indexOf(picks[i]) === -1) uniquePicks.push(picks[i]);
  }
  if (uniquePicks.length !== picks.length) {
    return res.status(400).json({ error: 'You must pick different teams.' });
  }

  var players = readJSON(PLAYERS_PATH);
  var games = readJSON(GAMES_PATH);

  // Compute winners for this day
  var dayGames = games[day] || [];
  var dayWinners = [];
  for (var g = 0; g < dayGames.length; g++) {
    if (dayGames[g].final && dayGames[g].winner) {
      dayWinners.push(dayGames[g].winner);
    }
  }
  var hasResults = dayWinners.length > 0;

  if (day === 'thursday_r1') {
    // Thursday: create new entry
    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email address is required.' });
    }
    var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    var requiredPicks = PICKS_PER_DAY[day] || 2;
    if (picks.length !== requiredPicks) {
      return res.status(400).json({ error: 'Exactly ' + requiredPicks + ' pick(s) required.' });
    }

    var existing = players.find(function(p) { return p.name.toLowerCase() === name.trim().toLowerCase(); });
    if (existing) {
      return res.status(400).json({ error: 'That name has already been submitted.' });
    }

    // Only evaluate picks whose games are actually final
    var decidedTeamsT = [];
    for (var dtT = 0; dtT < dayGames.length; dtT++) {
      if (dayGames[dtT].final && dayGames[dtT].winner) {
        decidedTeamsT.push(dayGames[dtT].home);
        decidedTeamsT.push(dayGames[dtT].away);
      }
    }
    var decidedPicksT = picks.filter(function(t) { return decidedTeamsT.indexOf(t) !== -1; });
    var undecidedPicksT = picks.filter(function(t) { return decidedTeamsT.indexOf(t) === -1; });

    var result = 'pending';
    var status = 'alive';
    if (decidedPicksT.length > 0) {
      var hasPickLossT = decidedPicksT.some(function(t) { return dayWinners.indexOf(t) === -1; });
      if (hasPickLossT) {
        result = 'loss';
        status = 'eliminated';
      } else if (undecidedPicksT.length === 0) {
        result = 'win';
      }
    }

    var newPlayer = {
      id: Date.now(),
      name: name.trim(),
      email: email.trim(),
      status: status,
      buybacks: 0,
      needsBuyback: false,
      totalSpent: 25,
      picks: {},
      results: {}
    };
    newPlayer.picks[day] = picks;
    newPlayer.results[day] = result;
    players.push(newPlayer);
  } else {
    // Later days: update existing entry
    var player = players.find(function(p) { return p.name.toLowerCase() === name.trim().toLowerCase(); });
    if (!player) {
      return res.status(400).json({ error: 'Entry not found. Check your name matches your original entry.' });
    }
    if (player.status === 'eliminated' && !player.needsBuyback) {
      return res.status(400).json({ error: 'You have been eliminated.' });
    }
    if (player.picks[day]) {
      return res.status(400).json({ error: 'You already submitted picks for this day.' });
    }

    // Require previous day's result to be 'win' before picking the next day
    var dayIdx = DAY_ORDER.indexOf(day);
    if (dayIdx > 0 && !player.needsBuyback) {
      var prevDay = DAY_ORDER[dayIdx - 1];
      if (player.picks[prevDay] && player.results[prevDay] !== 'win') {
        return res.status(400).json({ error: 'Your picks for ' + prevDay.replace('_', ' ') + ' are not yet finalized as wins. Check back once results are final.' });
      }
    }

    // Handle "None" pick — player has no available teams, automatic loss when finalized
    var isNonePick = picks.length === 1 && picks[0] === 'None';

    if (!isNonePick) {
      // Determine required picks (buyback players need more)
      var requiredPicks2 = (player.needsBuyback && BUYBACK_PICKS[day])
        ? BUYBACK_PICKS[day]
        : (PICKS_PER_DAY[day] || 1);
      if (picks.length !== requiredPicks2) {
        return res.status(400).json({ error: 'Exactly ' + requiredPicks2 + ' pick(s) required.' });
      }

      // Check for team reuse across all previous days
      var allUsedTeams = [];
      Object.values(player.picks).forEach(function(dayPicks) {
        dayPicks.forEach(function(t) {
          if (allUsedTeams.indexOf(t) === -1) allUsedTeams.push(t);
        });
      });
      var reused = picks.filter(function(t) { return allUsedTeams.indexOf(t) !== -1; });
      if (reused.length > 0) {
        return res.status(400).json({ error: 'Cannot reuse teams: ' + reused.join(', ') });
      }
    }

    // Only evaluate picks whose games are actually final
    var result2 = 'pending';
    if (isNonePick) {
      // "None" stays pending until all games are final, then becomes a loss
      var allFinal = dayGames.length > 0 && dayGames.every(function(g) { return g.final; });
      result2 = allFinal ? 'loss' : 'pending';
    } else {
      var decidedTeamsP = [];
      for (var dt = 0; dt < dayGames.length; dt++) {
        if (dayGames[dt].final && dayGames[dt].winner) {
          decidedTeamsP.push(dayGames[dt].home);
          decidedTeamsP.push(dayGames[dt].away);
        }
      }
      var decidedPicksP = picks.filter(function(t) { return decidedTeamsP.indexOf(t) !== -1; });
      var undecidedPicksP = picks.filter(function(t) { return decidedTeamsP.indexOf(t) === -1; });

      if (decidedPicksP.length > 0) {
        var hasPickLoss = decidedPicksP.some(function(t) { return dayWinners.indexOf(t) === -1; });
        if (hasPickLoss) {
          result2 = 'loss';
        } else if (undecidedPicksP.length === 0) {
          result2 = 'win';
        }
      }
    }

    player.picks[day] = picks;
    player.results[day] = result2;
    if (result2 === 'loss') {
      player.status = 'eliminated';
    }
    // Finalize buyback: resurrect player, charge $25, increment counter
    if (player.needsBuyback) {
      player.needsBuyback = false;
      player.status = result2 === 'loss' ? 'eliminated' : 'alive';
      player.buybacks += 1;
      player.totalSpent += 25;
    }
  }

  writeJSON(PLAYERS_PATH, players);
  res.json({ ok: true });
});

/* ── POST /api/admin/lock ── verify PIN, lock/unlock a day's entries */
app.post('/api/admin/lock', function(req, res) {
  var config = readJSON(CONFIG_PATH);
  var pin = req.body.pin;
  var day = req.body.day;
  var action = req.body.action; // 'verify', 'lock', or 'unlock'

  // Verify action: just check the PIN
  if (action === 'verify') {
    if (pin !== config.adminPin) {
      return res.status(401).json({ error: 'Incorrect PIN.' });
    }
    return res.json({ ok: true });
  }

  // Lock action: allow if PIN matches or if already authenticated (___admin___)
  if (action === 'lock' && pin !== config.adminPin && pin !== '___admin___') {
    return res.status(401).json({ error: 'Incorrect PIN.' });
  }

  if (!config.closedDays) config.closedDays = [];

  if (action === 'lock') {
    if (config.closedDays.indexOf(day) === -1) {
      config.closedDays.push(day);
    }
    // Auto-advance pickDay to the next day when locking the current pick day
    if (day === config.pickDay) {
      var pickIdx = DAY_ORDER.indexOf(config.pickDay);
      if (pickIdx < DAY_ORDER.length - 1) {
        config.pickDay = DAY_ORDER[pickIdx + 1];
      }
    }
  } else if (action === 'unlock') {
    config.closedDays = config.closedDays.filter(function(d) { return d !== day; });
  }

  writeJSON(CONFIG_PATH, config);
  res.json({ ok: true, closedDays: config.closedDays, pickDay: config.pickDay });
});

/* ── POST /api/admin/advance-day ── move to next day */
app.post('/api/admin/advance-day', function(req, res) {
  var config = readJSON(CONFIG_PATH);
  var currentIdx = DAY_ORDER.indexOf(config.currentDay);

  if (currentIdx < DAY_ORDER.length - 1) {
    config.currentDay = DAY_ORDER[currentIdx + 1];
    // Ensure pickDay is at least as far as currentDay
    var pickDayIdx = DAY_ORDER.indexOf(config.pickDay || config.currentDay);
    if (pickDayIdx < currentIdx + 1) {
      config.pickDay = config.currentDay;
    }
    writeJSON(CONFIG_PATH, config);
    res.json({ ok: true, currentDay: config.currentDay });
  } else {
    res.status(400).json({ error: 'Already on the last day.' });
  }
});

/* ── POST /api/admin/games ── update game results for a day */
app.post('/api/admin/games', function(req, res) {
  var config = readJSON(CONFIG_PATH);
  var pin = req.body.pin;

  if (pin !== config.adminPin && pin !== '___admin___') {
    return res.status(401).json({ error: 'Incorrect PIN.' });
  }

  var day = req.body.day;
  var games = req.body.games;

  if (!day || !Array.isArray(games)) {
    return res.status(400).json({ error: 'Provide day and games array.' });
  }

  var allGames = readJSON(GAMES_PATH);
  allGames[day] = games;
  writeJSON(GAMES_PATH, allGames);

  // Process player results based on new game outcomes
  // Collect winners AND all teams from final games (so we know which picks are decided)
  var dayWinners = [];
  var decidedTeams = [];
  for (var i = 0; i < games.length; i++) {
    if (games[i].final && games[i].winner) {
      dayWinners.push(games[i].winner);
      decidedTeams.push(games[i].home);
      decidedTeams.push(games[i].away);
    }
  }

  var players = readJSON(PLAYERS_PATH);
  var changed = false;
  for (var j = 0; j < players.length; j++) {
    var p = players[j];
    if (!p.picks[day]) continue;

    // Handle "None" picks — automatic loss once all games are final
    var isNone = p.picks[day].length === 1 && p.picks[day][0] === 'None';
    if (isNone) {
      var allFinal = games.length > 0 && games.every(function(g) { return g.final; });
      var noneResult = allFinal ? 'loss' : 'pending';
      var noneStatus = allFinal ? 'eliminated' : 'alive';
      if (p.results[day] !== noneResult) { p.results[day] = noneResult; changed = true; }
      if (p.status !== noneStatus) { p.status = noneStatus; changed = true; }
      continue;
    }

    // Only evaluate picks whose games are final
    var decidedPicks = p.picks[day].filter(function(t) { return decidedTeams.indexOf(t) !== -1; });
    var undecidedPicks = p.picks[day].filter(function(t) { return decidedTeams.indexOf(t) === -1; });

    if (decidedPicks.length === 0) {
      // No games final yet for this player's picks — keep result as pending
      if (p.results[day] !== 'pending') {
        p.results[day] = 'pending';
        changed = true;
      }
      // Player has picks for today so they're active — check if they should be alive
      // A player with today's picks is alive unless they have a loss on TODAY
      // (previous-day losses are covered by buyback — they bought back to play today)
      if (p.status === 'eliminated') { p.status = 'alive'; changed = true; }
      continue;
    }

    var hasLoss = decidedPicks.some(function(t) { return dayWinners.indexOf(t) === -1; });

    if (hasLoss) {
      // At least one decided pick lost — eliminated
      if (p.results[day] !== 'loss') { p.results[day] = 'loss'; changed = true; }
      if (p.status === 'alive') { p.status = 'eliminated'; changed = true; }
    } else if (undecidedPicks.length === 0) {
      // All picks decided and all won
      if (p.results[day] !== 'win') { p.results[day] = 'win'; changed = true; }
      // Player won all picks today — they're alive
      if (p.status === 'eliminated') { p.status = 'alive'; changed = true; }
    } else {
      // All decided picks won but some games still pending — keep as pending
      if (p.results[day] !== 'pending') { p.results[day] = 'pending'; changed = true; }
      // Player is still in it — no losses today
      if (p.status === 'eliminated') { p.status = 'alive'; changed = true; }
    }
  }
  if (changed) {
    writeJSON(PLAYERS_PATH, players);
  }

  res.json({ ok: true });
});

/* ── POST /api/buyback ── player buys back into the pool */
app.post('/api/buyback', function(req, res) {
  var config = readJSON(CONFIG_PATH);
  var name = req.body.name;

  if (!name) return res.status(400).json({ error: 'Name is required.' });

  var players = readJSON(PLAYERS_PATH);
  var player = players.find(function(p) { return p.name.toLowerCase() === name.trim().toLowerCase(); });

  if (!player) return res.status(404).json({ error: 'Player not found.' });
  if (player.status !== 'eliminated') return res.status(400).json({ error: 'You are not eliminated.' });
  if (player.needsBuyback) return res.status(400).json({ error: 'You already initiated a buyback. Submit your picks to complete it.' });
  if (player.buybacks >= 3) return res.status(400).json({ error: 'Maximum buybacks (3) reached.' });

  var activePickDay = config.pickDay || config.currentDay;
  var buybackDays = config.buybackDays || ['friday_r1', 'saturday_r2', 'sunday_r2'];
  if (buybackDays.indexOf(activePickDay) === -1) {
    return res.status(400).json({ error: 'No buybacks allowed for this round.' });
  }

  if (config.closedDays && config.closedDays.indexOf(activePickDay) !== -1) {
    return res.status(400).json({ error: 'Entries are closed. Cannot buy back right now.' });
  }

  // Only allow buyback on the day immediately after elimination
  var currentIdx = DAY_ORDER.indexOf(activePickDay);
  var eliminatedDay = null;
  for (var d = DAY_ORDER.length - 1; d >= 0; d--) {
    if (player.results[DAY_ORDER[d]] === 'loss') {
      eliminatedDay = DAY_ORDER[d];
      break;
    }
  }
  if (!eliminatedDay) {
    return res.status(400).json({ error: 'Cannot determine elimination day.' });
  }
  var elimIdx = DAY_ORDER.indexOf(eliminatedDay);
  if (currentIdx !== elimIdx + 1) {
    return res.status(400).json({ error: 'Buyback window has passed. You can only buy back the round after you were eliminated.' });
  }

  // Don't change status yet — player stays eliminated until they submit picks
  player.needsBuyback = true;

  writeJSON(PLAYERS_PATH, players);
  res.json({ ok: true, buybacks: player.buybacks, totalSpent: player.totalSpent });
});

/* ── POST /api/admin/edit-picks ── admin edits a player's picks for a specific day */
app.post('/api/admin/edit-picks', function(req, res) {
  var config = readJSON(CONFIG_PATH);
  var pin = req.body.pin;

  if (pin !== config.adminPin && pin !== '___admin___') {
    return res.status(401).json({ error: 'Incorrect PIN.' });
  }

  var playerId = req.body.playerId;
  var day = req.body.day;
  var picks = req.body.picks;

  if (!playerId || !day || !Array.isArray(picks) || picks.length === 0) {
    return res.status(400).json({ error: 'Missing playerId, day, or picks.' });
  }

  var players = readJSON(PLAYERS_PATH);
  var player = players.find(function(p) { return p.id === playerId; });
  if (!player) {
    return res.status(404).json({ error: 'Player not found.' });
  }

  // Check for duplicate teams in submission
  var uniquePicks = [];
  for (var i = 0; i < picks.length; i++) {
    if (uniquePicks.indexOf(picks[i]) === -1) uniquePicks.push(picks[i]);
  }
  if (uniquePicks.length !== picks.length) {
    return res.status(400).json({ error: 'Duplicate teams in picks.' });
  }

  // Update picks for that day
  player.picks[day] = picks;

  // Re-evaluate result for that day based on current game data
  var games = readJSON(GAMES_PATH);
  var dayGames = games[day] || [];
  var dayWinners = [];
  for (var g = 0; g < dayGames.length; g++) {
    if (dayGames[g].final && dayGames[g].winner) {
      dayWinners.push(dayGames[g].winner);
    }
  }

  if (dayWinners.length > 0) {
    var allWon = picks.every(function(t) { return dayWinners.indexOf(t) !== -1; });
    player.results[day] = allWon ? 'win' : 'loss';
    // Update status based on results across all days
    var hasLoss = false;
    Object.values(player.results).forEach(function(r) {
      if (r === 'loss') hasLoss = true;
    });
    player.status = hasLoss ? 'eliminated' : 'alive';
  } else {
    player.results[day] = 'pending';
  }

  writeJSON(PLAYERS_PATH, players);
  res.json({ ok: true, player: player });
});

/* ── POST /api/admin/delete-player ── remove a player entry */
app.post('/api/admin/delete-player', function(req, res) {
  var config = readJSON(CONFIG_PATH);
  var pin = req.body.pin;

  if (pin !== config.adminPin && pin !== '___admin___') {
    return res.status(401).json({ error: 'Incorrect PIN.' });
  }

  var playerId = req.body.playerId;
  if (!playerId) {
    return res.status(400).json({ error: 'Missing playerId.' });
  }

  var players = readJSON(PLAYERS_PATH);
  var before = players.length;
  players = players.filter(function(p) { return p.id !== playerId; });

  if (players.length === before) {
    return res.status(404).json({ error: 'Player not found.' });
  }

  writeJSON(PLAYERS_PATH, players);
  res.json({ ok: true, remaining: players.length });
});

/* ── POST /api/admin/import ── bulk import players and/or games data */
app.post('/api/admin/import', function(req, res) {
  var config = readJSON(CONFIG_PATH);
  var pin = req.body.pin;

  if (pin !== config.adminPin && pin !== '___admin___') {
    return res.status(401).json({ error: 'Incorrect PIN.' });
  }

  var imported = { players: false, games: false, config: false };

  // Import players if provided
  if (req.body.players && Array.isArray(req.body.players)) {
    writeJSON(PLAYERS_PATH, req.body.players);
    imported.players = true;
  }

  // Import games if provided (merge with existing, don't overwrite other days)
  if (req.body.games && typeof req.body.games === 'object') {
    var existingGames = readJSON(GAMES_PATH);
    Object.keys(req.body.games).forEach(function(day) {
      existingGames[day] = req.body.games[day];
    });
    writeJSON(GAMES_PATH, existingGames);
    imported.games = true;
  }

  // Import config if provided (merge with existing, preserve adminPin)
  if (req.body.config && typeof req.body.config === 'object') {
    var newConfig = Object.assign({}, config, req.body.config);
    newConfig.adminPin = config.adminPin; // never overwrite PIN from import
    writeJSON(CONFIG_PATH, newConfig);
    imported.config = true;
  }

  res.json({ ok: true, imported: imported });
});

/* ── POST /api/admin/reset ── reset all data for a fresh pool */
app.post('/api/admin/reset', function(req, res) {
  var config = readJSON(CONFIG_PATH);
  var pin = req.body.pin;

  if (pin !== config.adminPin && pin !== '___admin___') {
    return res.status(401).json({ error: 'Incorrect PIN.' });
  }

  // Reset config: back to thursday_r1, clear closed days, preserve PIN
  var freshConfig = {
    currentDay: 'thursday_r1',
    pickDay: 'thursday_r1',
    closedDays: [],
    adminPin: config.adminPin,
    buybackDays: ['friday_r1', 'saturday_r2', 'sunday_r2']
  };
  writeJSON(CONFIG_PATH, freshConfig);

  // Reset players: empty list
  writeJSON(PLAYERS_PATH, []);

  // Reset games: empty (import games via admin console)
  var freshGames = {
    friday_r1: [],
    saturday_r2: [],
    sunday_r2: [],
    thursday_s16: [],
    friday_s16: [],
    saturday_e8: [],
    sunday_e8: [],
    saturday_ff: [],
    monday_champ: []
  };
  writeJSON(GAMES_PATH, freshGames);

  res.json({ ok: true, message: 'Pool has been reset to Thursday Round 1.' });
});

/* ── POST /api/admin/export ── export all data for backup */
app.post('/api/admin/export', function(req, res) {
  var config = readJSON(CONFIG_PATH);
  var pin = req.body.pin;

  if (pin !== config.adminPin && pin !== '___admin___') {
    return res.status(401).json({ error: 'Incorrect PIN.' });
  }

  var players = readJSON(PLAYERS_PATH);
  var games = readJSON(GAMES_PATH);

  // Strip adminPin from export
  var safeConfig = Object.assign({}, config);
  delete safeConfig.adminPin;

  res.json({
    players: players,
    games: games,
    config: safeConfig,
    exportedAt: new Date().toISOString()
  });
});

/* ══════════════════════════════
   Static File Serving (AFTER api routes)
══════════════════════════════ */
app.use(express.static(__dirname, {
  extensions: ['html'],
  index: 'index.html',
}));

app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ══════════════════════════════
   Start Server
══════════════════════════════ */
app.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
  console.log('Data directory: ' + DATA_DIR);
  console.log('App directory: ' + __dirname);
  console.log('Home directory: ' + os.homedir());
  // Log whether data files existed or were freshly created
  console.log('Config exists: ' + fs.existsSync(CONFIG_PATH));
  console.log('Players exists: ' + fs.existsSync(PLAYERS_PATH));
  console.log('Games exists: ' + fs.existsSync(GAMES_PATH));
});
