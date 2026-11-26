'use strict';
// Direct UPnP RenderingControl client for the TV — reads/sets volume & mute,
// bypassing the IR/remote-key path. Useful both to diagnose the volume bug and
// as a possible workaround.
//
// Usage:
//   node upnp.js get              -> current volume + mute
//   node upnp.js set <0-100>      -> SetVolume
//   node upnp.js mute <0|1>       -> SetMute
//   node upnp.js watch            -> poll volume/mute every 700ms (Ctrl+C to stop)

const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const TV = CONFIG.tvIp;
const PORT = CONFIG.upnpPort || 9197;
const CTRL = CONFIG.renderControlUrl || '/upnp/control/RenderingControl1';
const SVC = 'urn:schemas-upnp-org:service:RenderingControl:1';

function soap(action, inner) {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${SVC}">` +
    `<InstanceID>0</InstanceID>${inner}` +
    `</u:${action}></s:Body></s:Envelope>`;
  return new Promise((resolve) => {
    const req = http.request({
      host: TV, port: PORT, path: CTRL, method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPACTION': `"${SVC}#${action}"`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 4000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ err: 'timeout' }); });
    req.end(body);
  });
}

function pick(xml, tag) {
  const m = xml && xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
  return m ? m[1] : null;
}
function faultOf(xml) {
  const m = xml && xml.match(/<errorDescription>([^<]*)<\/errorDescription>/i);
  return m ? m[1] : null;
}

async function getVolume() {
  const r = await soap('GetVolume', '<Channel>Master</Channel>');
  if (r.err) return { err: r.err };
  return { status: r.status, volume: pick(r.body, 'CurrentVolume'), fault: faultOf(r.body), raw: r.body };
}
async function getMute() {
  const r = await soap('GetMute', '<Channel>Master</Channel>');
  if (r.err) return { err: r.err };
  return { status: r.status, mute: pick(r.body, 'CurrentMute'), fault: faultOf(r.body), raw: r.body };
}
async function setVolume(v) {
  const r = await soap('SetVolume', `<Channel>Master</Channel><DesiredVolume>${v}</DesiredVolume>`);
  return { status: r.status, fault: faultOf(r.body), err: r.err, raw: r.body };
}
async function setMute(on) {
  const r = await soap('SetMute', `<Channel>Master</Channel><DesiredMute>${on}</DesiredMute>`);
  return { status: r.status, fault: faultOf(r.body), err: r.err, raw: r.body };
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'set') { console.log(await setVolume(parseInt(arg, 10))); return; }
  if (cmd === 'mute') { console.log(await setMute(parseInt(arg, 10))); return; }
  if (cmd === 'watch') {
    let last = '';
    setInterval(async () => {
      const v = await getVolume(); const m = await getMute();
      const line = `vol=${v.volume} mute=${m.mute}` + (v.fault ? ` fault="${v.fault}"` : '') + (v.err ? ` err=${v.err}` : '');
      if (line !== last) { console.log(new Date().toLocaleTimeString(), line); last = line; }
    }, 700);
    return;
  }
  // default: get
  console.log('GetVolume:', await getVolume());
  console.log('GetMute  :', await getMute());
}
main();

module.exports = { getVolume, getMute, setVolume, setMute };
