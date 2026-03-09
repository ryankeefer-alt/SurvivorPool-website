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
if (!fs.existsSync(CONFIG_PATH)) writeJSON(CONFIG_PATH, { currentDay: 'thursday_r1', closedDays: [], adminPin: '2025', buybackDays: ['friday_r1','saturday_r2','sunday_r2'] });
if (!fs.existsSync(PLAYERS_PATH)) writeJSON(PLAYERS_PATH, []);
if (!fs.existsSync(GAMES_PATH)) writeJSON(GAMES_PATH, { thursday_r1: [
  { id:1, home:'Houston', away:'SIU Edwardsville', homeScore:null, awayScore:null, winner:null, final:false },
  { id:2, home:'Auburn', away:'Alabama State', homeScore:null, awayScore:null, winner:null, final:false },
  { id:3, home:"St. John's", away:'Omaha', homeScore:null, awayScore:null, winner:null, final:false },
  { id:4, home:'Tennessee', away:'Wofford', homeScore:null, awayScore:null, winner:null, final:false },
  { id:5, home:'Wisconsin', away:'Montana', homeScore:null, awayScore:null, winner:null, final:false },
  { id:6, home:'Texas Tech', away:'UNC Wilmington', homeScore:null, awayScore:null, winner:null, final:false },
  { id:7, home:'Purdue', away:'High Point', homeScore:null, awayScore:null, winner:null, final:false },
  { id:8, home:'Texas A&M', away:'Yale', homeScore:null, awayScore:null, winner:null, final:false },
  { id:9, home:'Michigan', away:'UC San Diego', homeScore:null, awayScore:null, winner:null, final:false },
  { id:10, home:'Clemson', away:'McNeese State', homeScore:null, awayScore:null, winner:null, final:false },
  { id:11, home:'BYU', away:'VCU', homeScore:null, awayScore:null, winner:null, final:false },
  { id:12, home:'Missouri', away:'Drake', homeScore:null, awayScore:null, winner:null, final:false },
  { id:13, home:'UCLA', away:'Utah State', homeScore:null, awayScore:null, winner:null, final:false },
  { id:14, home:'Kansas', away:'Arkansas', homeScore:null, awayScore:null, winner:null, final:false },
  { id:15, home:'Gonzaga', away:'Georgia', homeScore:null, awayScore:null, winner:null, final:false },
  { id:16, home:'Louisville', away:'Creighton', homeScore:null, awayScore:null, winner:null, final:false }
]});

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

const TEAMS_BY_DAY = {
  thursday_r1: [
    'Alabama State','Arkansas','Auburn','BYU','Clemson','Creighton','Drake',
    'Georgia','Gonzaga','High Point','Houston','Kansas','Louisville',
    'McNeese State','Michigan','Missouri','Montana','Omaha','Purdue',
    'SIU Edwardsville',"St. John's",'Tennessee','Texas A&M','Texas Tech',
    'UC San Diego','UCLA','UNC Wilmington','Utah State','VCU',
    'Wisconsin','Wofford','Yale'
  ],
  friday_r1: [],
};

/* ══════════════════════════════
   API Routes
══════════════════════════════ */

/* ── GET /api/state ── returns all data for the frontend */
app.get('/api/state', function(req, res) {
  var config = readJSON(CONFIG_PATH);
  var players = readJSON(PLAYERS_PATH);
  var games = readJSON(GAMES_PATH);

  // Don't send the admin PIN to the client
  var safeConfig = Object.assign({}, config);
  delete safeConfig.adminPin;

  res.json({
    config: safeConfig,
    players: players,
    games: games,
    teams: TEAMS_BY_DAY,
    picksPerDay: PICKS_PER_DAY,
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

  if (!name || !day || !Array.isArray(picks) || picks.length === 0) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  // Check if day is closed
  if (config.closedDays && config.closedDays.indexOf(day) !== -1) {
    return res.status(400).json({ error: 'Entries for this day are closed.' });
  }

  var requiredPicks = PICKS_PER_DAY[day] || 1;
  if (picks.length !== requiredPicks) {
    return res.status(400).json({ error: 'Exactly ' + requiredPicks + ' pick(s) required.' });
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
    var existing = players.find(function(p) { return p.name.toLowerCase() === name.trim().toLowerCase(); });
    if (existing) {
      return res.status(400).json({ error: 'That name has already been submitted.' });
    }

    var result = 'pending';
    var status = 'alive';
    if (hasResults) {
      var allWon = picks.every(function(t) { return dayWinners.indexOf(t) !== -1; });
      result = allWon ? 'win' : 'loss';
      status = allWon ? 'alive' : 'eliminated';
    }

    var newPlayer = {
      id: Date.now(),
      name: name.trim(),
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
    if (player.status === 'eliminated') {
      return res.status(400).json({ error: 'You have been eliminated.' });
    }
    if (player.picks[day]) {
      return res.status(400).json({ error: 'You already submitted picks for this day.' });
    }

    var result2 = 'pending';
    if (hasResults) {
      var allWon2 = picks.every(function(t) { return dayWinners.indexOf(t) !== -1; });
      result2 = allWon2 ? 'win' : 'loss';
    }

    player.picks[day] = picks;
    player.results[day] = result2;
    if (result2 === 'loss') {
      player.status = 'eliminated';
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
  } else if (action === 'unlock') {
    config.closedDays = config.closedDays.filter(function(d) { return d !== day; });
  }

  writeJSON(CONFIG_PATH, config);
  res.json({ ok: true, closedDays: config.closedDays });
});

/* ── POST /api/admin/advance-day ── move to next day */
app.post('/api/admin/advance-day', function(req, res) {
  var config = readJSON(CONFIG_PATH);
  var currentIdx = DAY_ORDER.indexOf(config.currentDay);

  if (currentIdx < DAY_ORDER.length - 1) {
    config.currentDay = DAY_ORDER[currentIdx + 1];
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
  var dayWinners = [];
  for (var i = 0; i < games.length; i++) {
    if (games[i].final && games[i].winner) {
      dayWinners.push(games[i].winner);
    }
  }

  if (dayWinners.length > 0) {
    var players = readJSON(PLAYERS_PATH);
    for (var j = 0; j < players.length; j++) {
      var p = players[j];
      if (!p.picks[day]) continue;
      var allWon = p.picks[day].every(function(t) { return dayWinners.indexOf(t) !== -1; });
      p.results[day] = allWon ? 'win' : 'loss';
      if (!allWon && p.status === 'alive') {
        p.status = 'eliminated';
      }
    }
    writeJSON(PLAYERS_PATH, players);
  }

  res.json({ ok: true });
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

  // Import games if provided
  if (req.body.games && typeof req.body.games === 'object') {
    writeJSON(GAMES_PATH, req.body.games);
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
