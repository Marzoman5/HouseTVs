'use strict';
// Auto-discover a Samsung Tizen TV on the LAN and write config.json.
// Strategy: SSDP M-SEARCH -> confirm each responder via :8001/api/v2/ ->
// read model + MAC -> derive WoL broadcast from this host's subnet -> write config.
//
//   node scripts/discover.js            # pick the first TV found
//   node scripts/discover.js --list     # just list candidates, don't write

const dgram = require('dgram');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function httpGet(url, timeout = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function ssdpSearch(ms = 3000) {
  return new Promise((resolve) => {
    const ips = new Set();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n' +
      'MAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n'
    );
    sock.on('message', (_buf, rinfo) => ips.add(rinfo.address));
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch {}
      sock.send(msg, 0, msg.length, 1900, '239.255.255.250');
    });
    setTimeout(() => { try { sock.close(); } catch {}; resolve([...ips]); }, ms);
  });
}

function broadcastForHost() {
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal && a.address.startsWith('192.168.')) {
        const ip = a.address.split('.').map(Number);
        const mask = a.netmask.split('.').map(Number);
        const bc = ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255));
        return bc.join('.');
      }
    }
  }
  return '255.255.255.255';
}

async function confirmTV(ip) {
  const body = await httpGet(`http://${ip}:8001/api/v2/`);
  if (!body) return null;
  let j; try { j = JSON.parse(body); } catch { return null; }
  const d = j.device;
  if (!d || !/Samsung/i.test(d.type || '')) return null;
  return { ip, name: d.name, model: d.modelName, mac: d.wifiMac, os: d.OS };
}

(async () => {
  const listOnly = process.argv.includes('--list');
  process.stdout.write('Scanning LAN for Samsung TVs (SSDP)…\n');
  const candidates = await ssdpSearch();

  const tvs = [];
  for (const ip of candidates) {
    const tv = await confirmTV(ip);
    if (tv) tvs.push(tv);
  }
  // Fallback: nothing via SSDP, try a light sweep of the local /24.
  if (tvs.length === 0) {
    const bc = broadcastForHost();
    if (bc !== '255.255.255.255') {
      const prefix = bc.split('.').slice(0, 3).join('.');
      process.stdout.write(`No SSDP hits; sweeping ${prefix}.0/24 on :8001…\n`);
      const checks = [];
      for (let i = 1; i < 255; i++) checks.push(confirmTV(`${prefix}.${i}`));
      for (const tv of await Promise.all(checks)) if (tv) tvs.push(tv);
    }
  }

  if (tvs.length === 0) {
    process.stderr.write('No Samsung TV found. Ensure the TV is ON and on the same network.\n');
    process.exit(2);
  }

  process.stdout.write(`\nFound ${tvs.length} TV(s):\n`);
  tvs.forEach((t, i) => process.stdout.write(`  [${i}] ${t.name}  ${t.model}  ${t.ip}  ${t.mac}\n`));
  if (listOnly) return;

  const tv = tvs[0];
  const examplePath = path.join(ROOT, 'config.example.json');
  const base = fs.existsSync(examplePath) ? JSON.parse(fs.readFileSync(examplePath, 'utf8')) : {};
  const cfg = {
    ...base,
    tvIp: tv.ip,
    tvMac: tv.mac,
    tvPort: base.tvPort || 8002,
    serverPort: base.serverPort || 3000,
    clientName: base.clientName || 'HouseTVs Web Controller',
    broadcastIp: broadcastForHost(),
    upnpPort: base.upnpPort || 9197,
    renderControlUrl: base.renderControlUrl || '/upnp/control/RenderingControl1',
  };
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  process.stdout.write(`\nWrote config.json -> ${tv.ip} (${tv.model}), broadcast ${cfg.broadcastIp}\n`);
})();
