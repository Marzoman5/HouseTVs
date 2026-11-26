'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const WebSocket = require('ws');
const upnp = require('./upnp');
const { startAlexaBridge, lanIpForSubnet } = require('./alexa');
const { startHueBridge } = require('./hue');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const TOKEN_FILE = path.join(__dirname, 'token.json');

// ---- Token persistence -----------------------------------------------------
function loadToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).token || null;
  } catch {
    return null;
  }
}
function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, savedAt: new Date().toISOString() }, null, 2));
}

// ---- TV connection ---------------------------------------------------------
const State = {
  ws: null,
  connected: false,        // socket open AND authorized
  connecting: false,
  token: loadToken(),
  lastEvent: null,
  lastError: null,
  reconnectTimer: null,
  reconnectDelay: 2000,
};

const KEY_QUEUE = [];
let draining = false;

function tvUrl() {
  const name = Buffer.from(CONFIG.clientName).toString('base64');
  let url = `wss://${CONFIG.tvIp}:${CONFIG.tvPort}/api/v2/channels/samsung.remote.control?name=${name}`;
  if (State.token) url += `&token=${State.token}`;
  return url;
}

function connectTV({ allowPairing = false } = {}) {
  if (State.connecting || State.connected) return;
  // Never spam the Allow prompt: only connect without a token when the
  // caller explicitly asked to pair.
  if (!State.token && !allowPairing) {
    State.lastError = 'No token yet — pairing required. POST /api/pair to trigger the TV prompt.';
    return;
  }
  State.connecting = true;
  State.lastError = null;

  const ws = new WebSocket(tvUrl(), { rejectUnauthorized: false });
  State.ws = ws;

  ws.on('open', () => {
    console.log('[TV] socket open, waiting for channel.connect...');
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    State.lastEvent = msg.event || null;
    console.log('[TV] event:', msg.event);

    if (msg.event === 'ms.channel.connect') {
      State.connected = true;
      State.connecting = false;
      State.reconnectDelay = 2000;
      if (msg.data && msg.data.token) {
        State.token = String(msg.data.token);
        saveToken(State.token);
        console.log('[TV] token stored.');
      }
      drainQueue();
    } else if (msg.event === 'ms.channel.unauthorized') {
      // On the TV deny-list. Stop; do not retry (would re-prompt forever).
      State.lastError = 'Unauthorized by TV (denied or on deny-list). '
        + 'Check Settings > General > External Device Manager > Device Connection Manager.';
      State.connected = false;
      State.connecting = false;
      try { ws.close(); } catch {}
    } else if (msg.event === 'ms.channel.timeOut') {
      State.lastError = 'Pairing prompt timed out on the TV.';
      State.connecting = false;
      try { ws.close(); } catch {}
    }
  });

  ws.on('close', () => {
    const wasConnected = State.connected;
    State.connected = false;
    State.connecting = false;
    State.ws = null;
    console.log('[TV] socket closed.');
    // Only auto-reconnect once we actually hold a token (avoids prompt spam).
    if (State.token && wasConnected) scheduleReconnect();
  });

  ws.on('error', (err) => {
    State.lastError = 'Socket error: ' + err.message;
    State.connecting = false;
    console.log('[TV] error:', err.message);
  });
}

function scheduleReconnect() {
  if (State.reconnectTimer) return;
  State.reconnectTimer = setTimeout(() => {
    State.reconnectTimer = null;
    State.reconnectDelay = Math.min(State.reconnectDelay * 1.5, 30000);
    connectTV();
  }, State.reconnectDelay);
}

// ---- Key sending (queued ~150ms apart) -------------------------------------
function enqueueKey(key) {
  KEY_QUEUE.push(key);
  drainQueue();
}

function drainQueue() {
  if (draining) return;
  if (!State.connected || !State.ws) return;
  draining = true;
  const step = () => {
    if (!State.connected || !State.ws || KEY_QUEUE.length === 0) {
      draining = false;
      return;
    }
    const key = KEY_QUEUE.shift();
    const payload = JSON.stringify({
      method: 'ms.remote.control',
      params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
    });
    try {
      State.ws.send(payload);
      console.log('[TV] sent', key);
    } catch (e) {
      State.lastError = 'send failed: ' + e.message;
    }
    setTimeout(step, 150);
  };
  step();
}

function sendText(text) {
  if (!State.connected || !State.ws) return false;
  const payload = JSON.stringify({
    method: 'ms.remote.control',
    params: { Cmd: Buffer.from(text).toString('base64'), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' },
  });
  try { State.ws.send(payload); return true; } catch { return false; }
}

// ---- App launch (Samsung REST v2) ------------------------------------------
function launchApp(appId) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: CONFIG.tvIp, port: 8001, path: `/api/v2/applications/${appId}`, method: 'POST', timeout: 8000 },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: d })); }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

// ---- Wake-on-LAN -----------------------------------------------------------
function wakeOnLan() {
  return new Promise((resolve) => {
    const mac = CONFIG.tvMac.split(/[:\-]/).map((h) => parseInt(h, 16));
    const packet = Buffer.alloc(102);
    for (let i = 0; i < 6; i++) packet[i] = 0xff;
    for (let i = 0; i < 16; i++) mac.forEach((b, j) => { packet[6 + i * 6 + j] = b; });
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => { try { sock.close(); } catch {}; resolve(false); });
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(packet, 0, packet.length, 9, CONFIG.broadcastIp, (err) => {
        try { sock.close(); } catch {}
        resolve(!err);
      });
    });
  });
}

// ---- Allowed keys (whitelist) ---------------------------------------------
const ALLOWED_KEYS = new Set([
  'KEY_POWER', 'KEY_VOLUP', 'KEY_VOLDOWN', 'KEY_MUTE',
  'KEY_CHUP', 'KEY_CHDOWN', 'KEY_CH_LIST',
  'KEY_UP', 'KEY_DOWN', 'KEY_LEFT', 'KEY_RIGHT', 'KEY_ENTER', 'KEY_RETURN',
  'KEY_HOME', 'KEY_MENU', 'KEY_SOURCE', 'KEY_GUIDE', 'KEY_INFO', 'KEY_EXIT', 'KEY_TOOLS',
  'KEY_PLAY', 'KEY_PAUSE', 'KEY_STOP', 'KEY_REWIND', 'KEY_FF',
  'KEY_0', 'KEY_1', 'KEY_2', 'KEY_3', 'KEY_4', 'KEY_5', 'KEY_6', 'KEY_7', 'KEY_8', 'KEY_9',
  'KEY_HDMI', 'KEY_CONTENTS', 'KEY_MTS', 'KEY_CAPTION',
]);

// ---- HTTP server -----------------------------------------------------------
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  if (Buffer.isBuffer(body) || typeof body === 'string') res.end(body);
  else res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    return send(res, 200, html, 'text/html');
  }

  if (req.method === 'GET' && p === '/api/status') {
    return send(res, 200, {
      connected: State.connected,
      connecting: State.connecting,
      hasToken: !!State.token,
      tvIp: CONFIG.tvIp,
      lastEvent: State.lastEvent,
      lastError: State.lastError,
      queue: KEY_QUEUE.length,
    });
  }

  if (req.method === 'POST' && p === '/api/pair') {
    State.token = null;            // force a fresh prompt
    try { fs.unlinkSync(TOKEN_FILE); } catch {}
    connectTV({ allowPairing: true });
    return send(res, 200, { ok: true, message: 'Pairing started — accept the prompt on the TV.' });
  }

  if (req.method === 'POST' && p === '/api/connect') {
    connectTV();
    return send(res, 200, { ok: true, connecting: State.connecting, connected: State.connected });
  }

  if (req.method === 'POST' && p === '/api/key') {
    const body = await readBody(req);
    const key = String(body.key || '');
    if (!ALLOWED_KEYS.has(key)) return send(res, 400, { ok: false, error: 'unknown key' });
    if (!State.connected) return send(res, 409, { ok: false, error: 'not connected to TV' });
    enqueueKey(key);
    return send(res, 200, { ok: true, key });
  }

  // ---- UPnP volume/mute (reliable path, bypasses flaky remote keys) ----
  if (req.method === 'GET' && p === '/api/volume') {
    const v = await upnp.getVolume();
    const m = await upnp.getMute();
    return send(res, 200, {
      volume: v.volume != null ? Number(v.volume) : null,
      mute: m.mute === '1',
      err: v.err || m.err || null,
    });
  }
  if (req.method === 'POST' && p === '/api/volume') {
    const body = await readBody(req);
    let v = parseInt(body.volume, 10);
    if (isNaN(v)) return send(res, 400, { ok: false, error: 'bad volume' });
    v = Math.max(0, Math.min(100, v));
    const r = await upnp.setVolume(v);
    return send(res, 200, { ok: !r.err && !r.fault, volume: v, fault: r.fault || null, err: r.err || null });
  }
  if (req.method === 'POST' && (p === '/api/vol/up' || p === '/api/vol/down')) {
    const cur = await upnp.getVolume();
    if (cur.err || cur.volume == null) return send(res, 502, { ok: false, error: cur.err || 'read failed' });
    const body = await readBody(req);
    const step = Math.max(1, Math.min(10, parseInt(body.step, 10) || 1));
    let v = Number(cur.volume) + (p.endsWith('up') ? step : -step);
    v = Math.max(0, Math.min(100, v));
    const r = await upnp.setVolume(v);
    return send(res, 200, { ok: !r.err && !r.fault, volume: v, fault: r.fault || null, err: r.err || null });
  }
  if (req.method === 'POST' && p === '/api/mute') {
    const cur = await upnp.getMute();
    if (cur.err || cur.mute == null) return send(res, 502, { ok: false, error: cur.err || 'read failed' });
    const next = cur.mute === '1' ? 0 : 1;
    const r = await upnp.setMute(next);
    return send(res, 200, { ok: !r.err && !r.fault, mute: next === 1, fault: r.fault || null, err: r.err || null });
  }

  if (req.method === 'POST' && p === '/api/app/launch') {
    const body = await readBody(req);
    const appId = String(body.appId || '').trim();
    if (!/^[A-Za-z0-9._]{3,40}$/.test(appId)) return send(res, 400, { ok: false, error: 'bad appId' });
    const r = await launchApp(appId);
    return send(res, r.ok ? 200 : 502, r);
  }

  if (req.method === 'POST' && p === '/api/text') {
    const body = await readBody(req);
    const text = String(body.text || '').slice(0, 200);
    if (!State.connected) return send(res, 409, { ok: false, error: 'not connected to TV' });
    return send(res, 200, { ok: sendText(text) });
  }

  if (req.method === 'POST' && p === '/api/power-on') {
    const ok = await wakeOnLan();
    return send(res, 200, { ok, message: ok ? 'Magic packet sent.' : 'WoL send failed.' });
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(CONFIG.serverPort, '0.0.0.0', () => {
  console.log(`HomeTV controller on http://0.0.0.0:${CONFIG.serverPort}`);
  console.log(`TV target: ${CONFIG.tvIp}:${CONFIG.tvPort}  token: ${State.token ? 'yes' : 'none'}`);
  if (State.token) connectTV();
  else console.log('No token yet — open the page and press "Pair with TV".');

  if (CONFIG.alexaEnabled !== false) startAlexa();
  if (CONFIG.hueEnabled !== false) startHue();
});

// ---- Hue bridge (reliable "set TV volume to N") ----------------------------
function startHue() {
  const hostIp = lanIpForSubnet(CONFIG.tvIp);
  startHueBridge({
    hostIp,
    light: {
      name: 'TV Volume',
      setOn: async (on) => { await upnp.setMute(on ? 0 : 1); },
      setBrightnessPct: async (pct) => { await upnp.setMute(0); await upnp.setVolume(pct); },
      getState: async () => {
        const v = await upnp.getVolume();
        const m = await upnp.getMute();
        return { on: m.mute !== '1', pct: v.volume != null ? Number(v.volume) : 0 };
      },
    },
  });
  console.log(`Hue bridge: "TV Volume" dimmable light advertised as ${hostIp}:80.`);
}

// ---- Alexa (WeMo emulation) ------------------------------------------------
async function volBump(delta) {
  const cur = await upnp.getVolume();
  if (cur.volume == null) return;
  const v = Math.max(0, Math.min(100, Number(cur.volume) + delta));
  await upnp.setVolume(v);
}
function startAlexa() {
  const hostIp = lanIpForSubnet(CONFIG.tvIp);
  const launch = (appId) => () => launchApp(appId);
  // Names avoid Alexa's reserved words (Netflix/Hulu/"volume up" are built-ins).
  // 'slot' = stable port/identity. Never reuse or renumber a slot once devices
  // are discovered; only append new slots. (Reshuffling breaks Alexa's cache.)
  const devices = [
    { slot: 0, name: 'Main TV', type: 'switch', on: () => wakeOnLan(), off: () => enqueueKey('KEY_POWER'),
      state: async () => (State.connected ? 1 : 0) },
    { slot: 1, name: 'TV Flix',     type: 'momentary', on: launch('11101200001') },   // Netflix
    { slot: 2, name: 'TV Tube',     type: 'momentary', on: launch('111299001912') },  // YouTube
    { slot: 3, name: 'TV Hulu Show',type: 'momentary', on: launch('3201601007625') }, // Hulu
    { slot: 4, name: 'TV Disney',   type: 'momentary', on: launch('3201901017640') },
    { slot: 5, name: 'TV Tunes',    type: 'momentary', on: launch('3201606009684') }, // Spotify
    { slot: 6, name: 'TV Mute', type: 'switch', on: () => upnp.setMute(1), off: () => upnp.setMute(0),
      state: async () => ((await upnp.getMute()).mute === '1' ? 1 : 0) },
    { slot: 7, name: 'TV Louder',  serial: 'HTV2007', type: 'momentary', on: () => volBump(3) },
    { slot: 8, name: 'TV Quieter', serial: 'HTV2008', type: 'momentary', on: () => volBump(-3) },
    { slot: 9, name: 'Movie Night', type: 'momentary', on: async () => { await launchApp('11101200001'); await upnp.setVolume(18); } },
    { slot: 10, name: 'Bedtime',    type: 'momentary', on: async () => { await upnp.setMute(1); enqueueKey('KEY_POWER'); } },
  ];
  startAlexaBridge({ hostIp, firstPort: CONFIG.alexaFirstPort || 4000, devices });
  console.log(`Alexa bridge: ${devices.length} devices advertised as ${hostIp}. Say "Alexa, discover devices".`);
}
