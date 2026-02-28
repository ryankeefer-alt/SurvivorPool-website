const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

/* ────────────────────────────────
   Data file paths
──────────────────────────────── */
const DATA_DIR = path.join(__dirname, 'data');
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

function isAdminAuthed(req) {
  const config = readJSON(CONFIG_PATH);
  return req.headers['x-admin-password'] === config.adminPassword;
}

/* ────────────────────────────────
   Shared constants & logic
──────────────────────────────── */
const DAY_ORDER = [
  'thursday_r1','friday_r1','saturday_r2','sunday_r2',
  'thursday_s16','friday_s16','saturday_e8','sunday_e8',
  'saturday_ff','monday_champ'
];

function getRequiredPicks(player, day) {
  if (!player.needsBuyback) {
    if (day === 'thursday_r1' || day === 'friday_r1') return 2;
    return 1;
  }
  if (day === 'friday_r1') return 4;
  return 3;
}

/* ══════════════════════════════
   API Routes
══════════════════════════════ */

/* ── GET /api/state ── */
app.get('/api/state', (req, res) => {
  const config = readJSON(CONFIG_PATH);

  if (config.siteLocked && !isAdminAuthed(req)) {
    return res.json({ siteLocked: true, lockMessage: config.lockMessage });
  }

  const { adminPassword, ...safeConfig } = config;
  const players = readJSON(PLAYERS_PATH);
  const games = readJSON(GAMES_PATH);

  res.json({ siteLocked: false, config: safeConfig, players, games });
});

/* ── POST /api/picks ── */
app.post('/api/picks', (req, res) => {
  const config = readJSON(CONFIG_PATH);
  if (config.siteLocked) {
    return res.status(423).json({ error: 'Site is locked for maintenance.' });
  }

  const { playerId, day, picks, isBuyback } = req.body;

  if (!playerId || !day || !Array.isArray(picks) || picks.length === 0) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const players = readJSON(PLAYERS_PATH);
  const player = players.find(p => p.id === playerId);
  if (!player) {
    return res.status(404).json({ error: 'Player not found.' });
  }

  if (player.picks[day]) {
    return res.status(400).json({ error: 'Picks already submitted for this day.' });
  }

  const uniquePicks = [...new Set(picks)];
  if (uniquePicks.length !== picks.length) {
    return res.status(400).json({ error: 'Duplicate teams in picks.' });
  }

  const usedTeams = Object.values(player.picks).flat();
  const reused = picks.filter(t => usedTeams.includes(t));
  if (reused.length > 0) {
    return res.status(400).json({ error: 'Team already used: ' + reused[0] });
  }

  const invalidTeams = picks.filter(t => !config.teams.includes(t));
  if (invalidTeams.length > 0) {
    return res.status(400).json({ error: 'Invalid team: ' + invalidTeams[0] });
  }

  const requiredPicks = getRequiredPicks(player, day);
  if (picks.length !== requiredPicks) {
    return res.status(400).json({ error: 'Exactly ' + requiredPicks + ' pick(s) required for this day.' });
  }

  if (isBuyback) {
    if (player.buybacks >= 3) {
      return res.status(400).json({ error: 'Maximum buybacks (3) reached.' });
    }
    if (!config.buybackDays.includes(day)) {
      return res.status(400).json({ error: 'Buybacks are not available on this day.' });
    }
    player.status = 'alive';
    player.buybacks += 1;
    player.totalSpent += 25;
    player.needsBuyback = false;
  }

  player.picks[day] = picks;
  player.results[day] = 'pending';

  writeJSON(PLAYERS_PATH, players);
  res.json({ ok: true, player: player });
});

/* ── POST /api/admin/auth ── */
app.post('/api/admin/auth', (req, res) => {
  const config = readJSON(CONFIG_PATH);
  if (req.body.password === config.adminPassword) {
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid password.' });
});

/* ── POST /api/admin/config ── */
app.post('/api/admin/config', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const config = readJSON(CONFIG_PATH);
  const { adminPassword, ...updates } = req.body;
  Object.assign(config, updates);

  writeJSON(CONFIG_PATH, config);
  const safeConfig = Object.assign({}, config);
  delete safeConfig.adminPassword;
  res.json({ ok: true, config: safeConfig });
});

/* ── POST /api/admin/player ── */
app.post('/api/admin/player', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body;
  const players = readJSON(PLAYERS_PATH);

  if (body.id && players.find(p => p.id === body.id)) {
    const idx = players.findIndex(p => p.id === body.id);
    players[idx] = Object.assign({}, players[idx], body);
    writeJSON(PLAYERS_PATH, players);
    return res.json({ ok: true, player: players[idx] });
  } else {
    const maxId = players.length > 0 ? Math.max.apply(null, players.map(p => p.id)) : 0;
    const newPlayer = {
      id: maxId + 1,
      name: body.name || 'New Player',
      status: body.status || 'alive',
      buybacks: body.buybacks || 0,
      needsBuyback: body.needsBuyback || false,
      totalSpent: body.totalSpent || 25,
      picks: body.picks || {},
      results: body.results || {},
    };
    players.push(newPlayer);
    writeJSON(PLAYERS_PATH, players);
    res.json({ ok: true, player: newPlayer });
  }
});

/* ── DELETE /api/admin/player/:id ── */
app.delete('/api/admin/player/:id', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const id = parseInt(req.params.id, 10);
  const players = readJSON(PLAYERS_PATH);
  const filtered = players.filter(p => p.id !== id);

  if (filtered.length === players.length) {
    return res.status(404).json({ error: 'Player not found.' });
  }

  writeJSON(PLAYERS_PATH, filtered);
  res.json({ ok: true });
});

/* ── POST /api/admin/games ── */
app.post('/api/admin/games', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { day, games } = req.body;
  if (!day || !Array.isArray(games)) {
    return res.status(400).json({ error: 'Provide day and games array.' });
  }

  const allGames = readJSON(GAMES_PATH);
  allGames[day] = games;
  writeJSON(GAMES_PATH, allGames);
  res.json({ ok: true });
});

/* ── POST /api/admin/game-result ── */
app.post('/api/admin/game-result', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { day, gameId, homeScore, awayScore, winner } = req.body;
  const isFinal = req.body.final;
  if (!day || !gameId) {
    return res.status(400).json({ error: 'Provide day and gameId.' });
  }

  const allGames = readJSON(GAMES_PATH);
  const dayGames = allGames[day];
  if (!dayGames) {
    return res.status(404).json({ error: 'Day not found.' });
  }

  const game = dayGames.find(g => g.id === gameId);
  if (!game) {
    return res.status(404).json({ error: 'Game not found.' });
  }

  if (homeScore !== undefined) game.homeScore = homeScore;
  if (awayScore !== undefined) game.awayScore = awayScore;
  if (isFinal !== undefined)   game.final = isFinal;
  if (winner !== undefined)    game.winner = winner;

  writeJSON(GAMES_PATH, allGames);
  res.json({ ok: true, game: game });
});

/* ── POST /api/admin/process-day ── */
app.post('/api/admin/process-day', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { day } = req.body;
  if (!day) {
    return res.status(400).json({ error: 'Provide day to process.' });
  }

  const config = readJSON(CONFIG_PATH);
  const players = readJSON(PLAYERS_PATH);
  const allGames = readJSON(GAMES_PATH);
  const dayGames = allGames[day] || [];

  const dayWinners = new Set();
  for (var i = 0; i < dayGames.length; i++) {
    if (dayGames[i].final && dayGames[i].winner) {
      dayWinners.add(dayGames[i].winner);
    }
  }

  for (var j = 0; j < players.length; j++) {
    var player = players[j];
    if (player.status !== 'alive') continue;
    var playerPicks = player.picks[day];
    if (!playerPicks || playerPicks.length === 0) continue;

    var allWon = playerPicks.every(function(team) { return dayWinners.has(team); });

    if (allWon) {
      player.results[day] = 'win';
    } else {
      player.results[day] = 'loss';
      if (config.buybackDays.includes(day) && player.buybacks < 3) {
        player.needsBuyback = true;
        player.status = 'eliminated';
      } else {
        player.status = 'eliminated';
        player.needsBuyback = false;
      }
    }
  }

  var dayIdx = DAY_ORDER.indexOf(day);
  if (dayIdx >= 0 && dayIdx < DAY_ORDER.length - 1) {
    config.currentDay = DAY_ORDER[dayIdx + 1];
  }

  writeJSON(PLAYERS_PATH, players);
  writeJSON(CONFIG_PATH, config);

  res.json({
    ok: true,
    currentDay: config.currentDay,
    summary: players.map(function(p) { return { id: p.id, name: p.name, status: p.status, result: p.results[day] || null }; })
  });
});

/* ══════════════════════════════
   Static File Serving
══════════════════════════════ */
app.use(express.static(__dirname, {
  extensions: ['html'],
  index: 'index.html',
}));

/* ══════════════════════════════
   Start Server
══════════════════════════════ */
app.listen(PORT, function() {
  console.log('Serving at http://localhost:' + PORT);
  console.log('Data directory: ' + DATA_DIR);
});
