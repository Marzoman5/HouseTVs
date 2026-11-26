'use strict';
// Local Alexa control via WeMo emulation (no cloud, no skill).
// Each virtual device advertises itself over SSDP as a Belkin WeMo socket and
// serves a tiny HTTP + SOAP endpoint on its own port. Alexa "Discover Devices"
// finds them; "Alexa, turn on <name>" calls the device's on()/off().
//
// startAlexaBridge({ hostIp, firstPort, devices })
//   devices: [{ name, type:'switch'|'momentary', on, off, state }]
//     on()/off(): async actions. state(): optional async () => 0|1 for GetBinaryState.
//     'momentary' devices always report 0 so Alexa can re-trigger "turn on".

const http = require('http');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

function lanIpForSubnet(tvIp) {
  const virt = /vmware|virtualbox|vethernet|hyper-v|loopback|bluetooth|vmnet|docker|wsl/i;
  const ifaces = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (virt.test(name)) continue;
    for (const a of addrs) if (a.family === 'IPv4' && !a.internal) ifaces.push(a);
  }
  if (tvIp) {
    const t = tvIp.split('.').map(Number);
    const m = ifaces.find((a) => {
      const ip = a.address.split('.').map(Number), mk = a.netmask.split('.').map(Number);
      return ip.every((o, i) => (o & mk[i]) === (t[i] & mk[i]));
    });
    if (m) return m.address;
  }
  return ifaces[0] ? ifaces[0].address : '127.0.0.1';
}

function setupXml(dev) {
  const deviceType = dev.type === 'dimmer' ? 'urn:Belkin:device:dimmer:1' : 'urn:Belkin:device:controllee:1';
  return `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>${deviceType}</deviceType>
    <friendlyName>${dev.name}</friendlyName>
    <manufacturer>Belkin International Inc.</manufacturer>
    <modelName>Emulated Socket</modelName>
    <modelNumber>3.1415</modelNumber>
    <UDN>uuid:Socket-1_0-${dev.serial}</UDN>
    <serialNumber>${dev.serial}</serialNumber>
    <binaryState>0</binaryState>
    <serviceList>
      <service>
        <serviceType>urn:Belkin:service:basicevent:1</serviceType>
        <serviceId>urn:Belkin:serviceId:basicevent1</serviceId>
        <controlURL>/upnp/control/basicevent1</controlURL>
        <eventSubURL>/upnp/event/basicevent1</eventSubURL>
        <SCPDURL>/eventservice.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`;
}

const EVENT_XML = `<?xml version="1.0"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>
<actionList><action><name>SetBinaryState</name><argumentList><argument><retval/><name>BinaryState</name>
<relatedStateVariable>BinaryState</relatedStateVariable><direction>in</direction></argument></argumentList></action>
<action><name>GetBinaryState</name><argumentList><argument><retval/><name>BinaryState</name>
<relatedStateVariable>BinaryState</relatedStateVariable><direction>out</direction></argument></argumentList></action></actionList>
<serviceStateTable><stateVariable sendEvents="yes"><name>BinaryState</name><dataType>Boolean</dataType>
<defaultValue>0</defaultValue></stateVariable></serviceStateTable></scpd>`;

function soapResp(action, fields) {
  const inner = Object.entries(fields).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action}Response xmlns:u="urn:Belkin:service:basicevent:1">${inner}</u:${action}Response></s:Body></s:Envelope>`;
}

function startAlexaBridge({ hostIp, firstPort = 4000, devices }) {
  const nls = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');

  devices.forEach((dev, i) => {
    const slot = dev.slot != null ? dev.slot : i; // stable identity, independent of list order
    dev.port = firstPort + slot;
    dev.serial = 'HTV' + String(1000 + slot);
    dev.reported = 0;

    http.createServer(async (req, res) => {
      const url = req.url || '/';
      if (req.method === 'GET' && url.startsWith('/setup.xml')) {
        res.writeHead(200, { 'Content-Type': 'text/xml', 'Connection': 'close' });
        return res.end(setupXml(dev));
      }
      if (req.method === 'GET' && url.startsWith('/eventservice.xml')) {
        res.writeHead(200, { 'Content-Type': 'text/xml', 'Connection': 'close' });
        return res.end(EVENT_XML);
      }
      if (req.method === 'SUBSCRIBE' || req.method === 'UNSUBSCRIBE') {
        res.writeHead(200, { 'Connection': 'close' });
        return res.end();
      }
      if (req.method === 'POST' && url.includes('basicevent')) {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
        req.on('end', async () => {
          const action = (req.headers['soapaction'] || '').replace(/["']/g, '');
          if (dev.type === 'dimmer') console.log(`[alexa][dimmer] ${dev.name} action=${action} body=${body.replace(/\s+/g, ' ').trim()}`);
          try {
            if (/SetBinaryState/i.test(body) || /SetBinaryState/i.test(action)) {
              const on = /<BinaryState>\s*1/i.test(body);
              const bm = body.match(/<brightness>\s*(\d+)/i);
              dev.reported = on ? 1 : 0;
              try {
                if (dev.type === 'dimmer' && bm && dev.onBrightness) { await dev.onBrightness(Number(bm[1])); dev.reported = 1; }
                else if (on && dev.on) await dev.on();
                else if (!on && dev.off) await dev.off();
              } catch (e) { console.log('[alexa]', dev.name, 'action error', e.message); }
              if (dev.type === 'momentary') dev.reported = 0;
              res.writeHead(200, { 'Content-Type': 'text/xml', 'Connection': 'close' });
              return res.end(soapResp('SetBinaryState', { BinaryState: dev.reported }));
            }
            if (/GetBinaryState/i.test(body) || /GetBinaryState/i.test(action)) {
              let s = dev.reported, bri = null;
              if (dev.type === 'dimmer' && dev.level) { try { bri = await dev.level(); s = bri > 0 ? 1 : 0; } catch {} }
              else if (dev.type !== 'momentary' && dev.state) { try { s = await dev.state(); } catch {} }
              const fields = { BinaryState: s };
              if (bri != null) fields.brightness = bri;
              res.writeHead(200, { 'Content-Type': 'text/xml', 'Connection': 'close' });
              return res.end(soapResp('GetBinaryState', fields));
            }
          } catch {}
          res.writeHead(200, { 'Connection': 'close' }); res.end();
        });
        return;
      }
      res.writeHead(404, { 'Connection': 'close' }); res.end();
    }).listen(dev.port, '0.0.0.0', () => console.log(`[alexa] "${dev.name}" on :${dev.port}`));
  });

  // SSDP responder (shares UDP 1900 with the OS via reuseAddr + multicast membership).
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', (e) => console.log('[alexa] ssdp error', e.message));
  sock.on('message', (msg, rinfo) => {
    const s = msg.toString();
    if (!/M-SEARCH/i.test(s) || !/ssdp:discover/i.test(s)) return;
    if (!/(urn:Belkin:device|ssdp:all|upnp:rootdevice)/i.test(s)) return;
    for (const dev of devices) {
      const usn = `uuid:Socket-1_0-${dev.serial}`;
      const resp = Buffer.from(
        'HTTP/1.1 200 OK\r\n' +
        'CACHE-CONTROL: max-age=86400\r\n' +
        'EXT:\r\n' +
        `LOCATION: http://${hostIp}:${dev.port}/setup.xml\r\n` +
        'OPT: "http://schemas.upnp.org/upnp/1/0/"; ns=01\r\n' +
        `01-NLS: ${nls}\r\n` +
        'SERVER: Unspecified, UPnP/1.0, Unspecified\r\n' +
        'ST: urn:Belkin:device:controllee:1\r\n' +
        `USN: ${usn}::urn:Belkin:device:controllee:1\r\n` +
        'X-User-Agent: redsonic\r\n\r\n'
      );
      sock.send(resp, 0, resp.length, rinfo.port, rinfo.address);
    }
  });
  sock.bind(SSDP_PORT, () => {
    try { sock.addMembership(SSDP_ADDR); } catch (e) { console.log('[alexa] membership', e.message); }
    console.log(`[alexa] SSDP responder up; advertising ${devices.length} device(s) as ${hostIp}`);
  });

  return { devices };
}

module.exports = { startAlexaBridge, lanIpForSubnet };
