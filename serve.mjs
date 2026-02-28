import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

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

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function isAdminAuthed(req) {
  const config = readJSON(CONFIG_PATH);
  return req.headers['x-admin-password'] === config.adminPassword;
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/* ────────────────────────────────
   Shared constants & logic
   (duplicated from frontend for
    server-side validation)
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

/* ────────────────────────────────
   Static file MIME types
──────────────────────────────── */
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
};

/* ────────────────────────────────
   HTTP Server
──────────────────────────────── */
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  /* ── CORS preflight for API ── */
  if (req.method === 'OPTIONS' && urlPath.startsWith('/api/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
    });
    res.end();
    return;
  }

  /* ══════════════════════════════
     API Routes
  ══════════════════════════════ */
  if (urlPath.startsWith('/api/')) {
    try {

      /* ── GET /api/state ── */
      if (req.method === 'GET' && urlPath === '/api/state') {
        const config = readJSON(CONFIG_PATH);

        if (config.siteLocked && !isAdminAuthed(req)) {
          return sendJSON(res, 200, {
            siteLocked: true,
            lockMessage: config.lockMessage
          });
        }

        const { adminPassword, ...safeConfig } = config;
        const players = readJSON(PLAYERS_PATH);
        const games = readJSON(GAMES_PATH);

        return sendJSON(res, 200, {
          siteLocked: false,
          config: safeConfig,
          players,
          games
        });
      }

      /* ── POST /api/picks ── */
      if (req.method === 'POST' && urlPath === '/api/picks') {
        const config = readJSON(CONFIG_PATH);
        if (config.siteLocked) {
          return sendJSON(res, 423, { error: 'Site is locked for maintenance.' });
        }

        const body = await parseBody(req);
        const { playerId, day, picks, isBuyback } = body;

        if (!playerId || !day || !Array.isArray(picks) || picks.length === 0) {
          return sendJSON(res, 400, { error: 'Missing required fields.' });
        }

        const players = readJSON(PLAYERS_PATH);
        const player = players.find(p => p.id === playerId);
        if (!player) {
          return sendJSON(res, 404, { error: 'Player not found.' });
        }

        // Already picked for this day
        if (player.picks[day]) {
          return sendJSON(res, 400, { error: 'Picks already submitted for this day.' });
        }

        // No duplicates within this pick set
        const uniquePicks = [...new Set(picks)];
        if (uniquePicks.length !== picks.length) {
          return sendJSON(res, 400, { error: 'Duplicate teams in picks.' });
        }

        // No team reuse across all previous days
        const usedTeams = Object.values(player.picks).flat();
        const reused = picks.filter(t => usedTeams.includes(t));
        if (reused.length > 0) {
          return sendJSON(res, 400, { error: `Team already used: ${reused[0]}` });
        }

        // All teams must be valid
        const invalidTeams = picks.filter(t => !config.teams.includes(t));
        if (invalidTeams.length > 0) {
          return sendJSON(res, 400, { error: `Invalid team: ${invalidTeams[0]}` });
        }

        // Correct number of picks
        const requiredPicks = getRequiredPicks(player, day);
        if (picks.length !== requiredPicks) {
          return sendJSON(res, 400, { error: `Exactly ${requiredPicks} pick(s) required for this day.` });
        }

        // Handle buyback
        if (isBuyback) {
          if (player.buybacks >= 3) {
            return sendJSON(res, 400, { error: 'Maximum buybacks (3) reached.' });
          }
          if (!config.buybackDays.includes(day)) {
            return sendJSON(res, 400, { error: 'Buybacks are not available on this day.' });
          }
          player.status = 'alive';
          player.buybacks += 1;
          player.totalSpent += 25;
          player.needsBuyback = false;
        }

        // Save picks
        player.picks[day] = picks;
        player.results[day] = 'pending';

        writeJSON(PLAYERS_PATH, players);
        return sendJSON(res, 200, { ok: true, player });
      }

      /* ── POST /api/admin/auth ── */
      if (req.method === 'POST' && urlPath === '/api/admin/auth') {
        const body = await parseBody(req);
        const config = readJSON(CONFIG_PATH);
        if (body.password === config.adminPassword) {
          return sendJSON(res, 200, { ok: true });
        }
        return sendJSON(res, 401, { error: 'Invalid password.' });
      }

      /* ── POST /api/admin/config ── */
      if (req.method === 'POST' && urlPath === '/api/admin/config') {
        if (!isAdminAuthed(req)) return sendJSON(res, 401, { error: 'Unauthorized' });

        const body = await parseBody(req);
        const config = readJSON(CONFIG_PATH);

        // Merge provided fields into config (don't allow overwriting adminPassword via this endpoint)
        const { adminPassword, ...updates } = body;
        Object.assign(config, updates);

        writeJSON(CONFIG_PATH, config);
        const { adminPassword: _, ...safeConfig } = config;
        return sendJSON(res, 200, { ok: true, config: safeConfig });
      }

      /* ── POST /api/admin/player ── */
      if (req.method === 'POST' && urlPath === '/api/admin/player') {
        if (!isAdminAuthed(req)) return sendJSON(res, 401, { error: 'Unauthorized' });

        const body = await parseBody(req);
        const players = readJSON(PLAYERS_PATH);

        if (body.id && players.find(p => p.id === body.id)) {
          // Update existing player
          const idx = players.findIndex(p => p.id === body.id);
          players[idx] = { ...players[idx], ...body };
          writeJSON(PLAYERS_PATH, players);
          return sendJSON(res, 200, { ok: true, player: players[idx] });
        } else {
          // Create new player
          const maxId = players.length > 0 ? Math.max(...players.map(p => p.id)) : 0;
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
          return sendJSON(res, 200, { ok: true, player: newPlayer });
        }
      }

      /* ── DELETE /api/admin/player/:id ── */
      if (req.method === 'DELETE' && urlPath.startsWith('/api/admin/player/')) {
        if (!isAdminAuthed(req)) return sendJSON(res, 401, { error: 'Unauthorized' });

        const id = parseInt(urlPath.split('/').pop(), 10);
        const players = readJSON(PLAYERS_PATH);
        const filtered = players.filter(p => p.id !== id);

        if (filtered.length === players.length) {
          return sendJSON(res, 404, { error: 'Player not found.' });
        }

        writeJSON(PLAYERS_PATH, filtered);
        return sendJSON(res, 200, { ok: true });
      }

      /* ── POST /api/admin/games ── */
      if (req.method === 'POST' && urlPath === '/api/admin/games') {
        if (!isAdminAuthed(req)) return sendJSON(res, 401, { error: 'Unauthorized' });

        const body = await parseBody(req);
        const { day, games } = body;

        if (!day || !Array.isArray(games)) {
          return sendJSON(res, 400, { error: 'Provide day and games array.' });
        }

        const allGames = readJSON(GAMES_PATH);
        allGames[day] = games;
        writeJSON(GAMES_PATH, allGames);
        return sendJSON(res, 200, { ok: true });
      }

      /* ── POST /api/admin/game-result ── */
      if (req.method === 'POST' && urlPath === '/api/admin/game-result') {
        if (!isAdminAuthed(req)) return sendJSON(res, 401, { error: 'Unauthorized' });

        const body = await parseBody(req);
        const { day, gameId, homeScore, awayScore, final: isFinal, winner } = body;

        if (!day || !gameId) {
          return sendJSON(res, 400, { error: 'Provide day and gameId.' });
        }

        const allGames = readJSON(GAMES_PATH);
        const dayGames = allGames[day];
        if (!dayGames) {
          return sendJSON(res, 404, { error: 'Day not found.' });
        }

        const game = dayGames.find(g => g.id === gameId);
        if (!game) {
          return sendJSON(res, 404, { error: 'Game not found.' });
        }

        if (homeScore !== undefined) game.homeScore = homeScore;
        if (awayScore !== undefined) game.awayScore = awayScore;
        if (isFinal !== undefined)   game.final = isFinal;
        if (winner !== undefined)    game.winner = winner;

        writeJSON(GAMES_PATH, allGames);
        return sendJSON(res, 200, { ok: true, game });
      }

      /* ── POST /api/admin/process-day ── */
      if (req.method === 'POST' && urlPath === '/api/admin/process-day') {
        if (!isAdminAuthed(req)) return sendJSON(res, 401, { error: 'Unauthorized' });

        const body = await parseBody(req);
        const { day } = body;

        if (!day) {
          return sendJSON(res, 400, { error: 'Provide day to process.' });
        }

        const config = readJSON(CONFIG_PATH);
        const players = readJSON(PLAYERS_PATH);
        const allGames = readJSON(GAMES_PATH);
        const dayGames = allGames[day] || [];

        // Build set of winners for this day
        const dayWinners = new Set();
        for (const game of dayGames) {
          if (game.final && game.winner) {
            dayWinners.add(game.winner);
          }
        }

        // Evaluate each alive player who has picks for this day
        for (const player of players) {
          if (player.status !== 'alive') continue;
          const playerPicks = player.picks[day];
          if (!playerPicks || playerPicks.length === 0) continue;

          // Check if ALL picked teams won
          const allWon = playerPicks.every(team => dayWinners.has(team));

          if (allWon) {
            player.results[day] = 'win';
          } else {
            player.results[day] = 'loss';

            // Check if buyback is available
            if (config.buybackDays.includes(day) && player.buybacks < 3) {
              player.needsBuyback = true;
              player.status = 'eliminated';
            } else {
              player.status = 'eliminated';
              player.needsBuyback = false;
            }
          }
        }

        // Advance currentDay to next day in order
        const dayIdx = DAY_ORDER.indexOf(day);
        if (dayIdx >= 0 && dayIdx < DAY_ORDER.length - 1) {
          config.currentDay = DAY_ORDER[dayIdx + 1];
        }

        writeJSON(PLAYERS_PATH, players);
        writeJSON(CONFIG_PATH, config);

        return sendJSON(res, 200, {
          ok: true,
          currentDay: config.currentDay,
          summary: players.map(p => ({ id: p.id, name: p.name, status: p.status, result: p.results[day] || null }))
        });
      }

      /* ── 404 for unknown API routes ── */
      return sendJSON(res, 404, { error: 'API endpoint not found.' });

    } catch (err) {
      console.error('API error:', err);
      return sendJSON(res, 500, { error: err.message });
    }
  }

  /* ══════════════════════════════
     Static File Serving
  ══════════════════════════════ */
  let staticPath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(__dirname, staticPath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404); res.end('Not found');
      } else {
        res.writeHead(500); res.end('Server error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Serving at http://localhost:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
