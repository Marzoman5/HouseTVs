'use strict';
// Emulated Philips Hue bridge — the reliable way to give Alexa a real
// "set <light> to N%" control. We expose ONE dimmable light ("TV Volume")
// whose brightness maps to the TV's volume over UPnP.
//
// Alexa's Hue (v1) integration expects the bridge on port 80.
//
// startHueBridge({ hostIp, light })
//   light: { name, setOn(bool), setBrightnessPct(0..100), getState() -> {on, pct} }

const http = require('http');
const dgram = require('dgram');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

// Stable pseudo-identity for the emulated bridge (not the real NIC MAC).
const BRIDGE_MAC = '00:17:88:5e:d3:00';
const BRIDGE_ID = '001788FFFE5ED300';
const UUID = 'uuid:2f402f80-da50-11e1-9b23-001788' + '5ed300';

function descriptionXml(hostIp) {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<URLBase>http://${hostIp}:80/</URLBase>
<device>
<deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType>
<friendlyName>Philips hue (${hostIp})</friendlyName>
<manufacturer>Royal Philips Electronics</manufacturer>
<manufacturerURL>http://www.philips.com</manufacturerURL>
<modelDescription>Philips hue Personal Wireless Lighting</modelDescription>
<modelName>Philips hue bridge 2012</modelName>
<modelNumber>929000226503</modelNumber>
<modelURL>http://www.meethue.com</modelURL>
<serialNumber>${BRIDGE_ID}</serialNumber>
<UDN>${UUID}</UDN>
<presentationURL>index.html</presentationURL>
</device>
</root>`;
}

function lightObj(name, on, bri) {
  return {
    state: { on: !!on, bri, hue: 0, sat: 0, effect: 'none', xy: [0, 0], ct: 0,
      alert: 'none', colormode: 'ct', mode: 'homeautomation', reachable: true },
    swupdate: { state: 'noupdates', lastinstall: null },
    type: 'Dimmable light', name, modelid: 'LWB014', manufacturername: 'Philips',
    productname: 'Hue white lamp', uniqueid: BRIDGE_MAC + ':00:11-0b', swversion: '1.46.13_r26312',
  };
}

function configObj(hostIp, withWhitelist) {
  const c = {
    name: 'HouseTVs', datastoreversion: '3', swversion: '1948086000', apiversion: '1.48.0',
    mac: BRIDGE_MAC, bridgeid: BRIDGE_ID, factorynew: false, replacesbridgeid: null,
    modelid: 'BSB002', starterkitid: '', ipaddress: hostIp, netmask: '255.255.255.0',
    gateway: hostIp.replace(/\.\d+$/, '.1'), dhcp: true, proxyaddress: 'none', proxyport: 0,
    UTC: new Date().toISOString().split('.')[0], localtime: new Date().toISOString().split('.')[0],
    timezone: 'America/New_York', zigbeechannel: 25, linkbutton: false, portalservices: false,
    portalconnection: 'disconnected', swupdate: { updatestate: 0, checkforupdate: false },
  };
  if (withWhitelist) c.whitelist = { hometvuser: { 'last use date': c.UTC, 'create date': c.UTC, name: 'HouseTVs' } };
  return c;
}

function startHueBridge({ hostIp, light }) {
  const LID = '1';

  async function fullState() {
    const st = await light.getState().catch(() => ({ on: true, pct: 0 }));
    const bri = Math.max(1, Math.round((st.pct / 100) * 254));
    return { lights: { [LID]: lightObj(light.name, st.on, bri) } };
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method;
    const url = (req.url || '/').split('?')[0];
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Connection': 'close' }); res.end(JSON.stringify(obj)); };

      try {
        if (method === 'GET' && url === '/description.xml') {
          res.writeHead(200, { 'Content-Type': 'application/xml', 'Connection': 'close' });
          return res.end(descriptionXml(hostIp));
        }
        // Pairing: Alexa POSTs /api -> accept, return a username.
        if (method === 'POST' && (url === '/api' || url === '/api/')) {
          return json(200, [{ success: { username: 'hometvuser' } }]);
        }
        // Unauthenticated config (used during discovery).
        if (method === 'GET' && url === '/api/config') return json(200, configObj(hostIp, false));

        const m = url.match(/^\/api\/([^/]+)(\/.*)?$/);
        if (m) {
          const rest = m[2] || '';
          if (method === 'GET' && (rest === '' || rest === '/')) {
            const fs = await fullState();
            return json(200, { lights: fs.lights, groups: {}, config: configObj(hostIp, true),
              schedules: {}, scenes: {}, rules: {}, sensors: {}, resourcelinks: {} });
          }
          if (method === 'GET' && rest === '/config') return json(200, configObj(hostIp, true));
          if (method === 'GET' && rest === '/lights') { const fs = await fullState(); return json(200, fs.lights); }
          if (method === 'GET' && rest === `/lights/${LID}`) {
            const fs = await fullState(); return json(200, fs.lights[LID]);
          }
          if (method === 'GET' && rest.startsWith('/groups')) return json(200, {});
          // Set state: PUT /api/<user>/lights/1/state  { on, bri }
          if (method === 'PUT' && rest === `/lights/${LID}/state`) {
            let p = {}; try { p = JSON.parse(body || '{}'); } catch {}
            const out = [];
            console.log(`[hue] set ${light.name} <- ${JSON.stringify(p)}`);
            if (Object.prototype.hasOwnProperty.call(p, 'on')) {
              try { await light.setOn(!!p.on); } catch {}
              out.push({ success: { [`/lights/${LID}/state/on`]: !!p.on } });
            }
            if (Object.prototype.hasOwnProperty.call(p, 'bri')) {
              const pct = Math.max(0, Math.min(100, Math.round((p.bri / 254) * 100)));
              try { await light.setBrightnessPct(pct); } catch {}
              out.push({ success: { [`/lights/${LID}/state/bri`]: p.bri } });
            }
            return json(200, out.length ? out : [{ success: {} }]);
          }
        }
        json(200, {});
      } catch (e) { json(200, {}); }
    });
  });
  server.on('error', (e) => console.log('[hue] http error (port 80):', e.message));
  server.listen(80, '0.0.0.0', () => console.log(`[hue] bridge on http://${hostIp}:80  light="${light.name}"`));

  // SSDP: answer Hue discovery (shares UDP 1900 via reuseAddr).
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', (e) => console.log('[hue] ssdp error', e.message));
  sock.on('message', (msg, rinfo) => {
    const s = msg.toString();
    if (!/M-SEARCH/i.test(s) || !/ssdp:discover/i.test(s)) return;
    if (!/(upnp:rootdevice|ssdp:all|device:basic:1|MediaRenderer)/i.test(s)) return;
    const sts = [
      'upnp:rootdevice',
      UUID,
      'urn:schemas-upnp-org:device:basic:1',
    ];
    for (const st of sts) {
      const usn = st === UUID ? UUID : `${UUID}::${st}`;
      const resp = Buffer.from(
        'HTTP/1.1 200 OK\r\n' +
        'HOST: 239.255.255.250:1900\r\n' +
        'EXT:\r\n' +
        'CACHE-CONTROL: max-age=100\r\n' +
        `LOCATION: http://${hostIp}:80/description.xml\r\n` +
        'SERVER: FreeRTOS/7.4.2, UPnP/1.0, IpBridge/1.17.0\r\n' +
        `hue-bridgeid: ${BRIDGE_ID}\r\n` +
        `ST: ${st}\r\n` +
        `USN: ${usn}\r\n\r\n`
      );
      sock.send(resp, 0, resp.length, rinfo.port, rinfo.address);
    }
  });
  sock.bind(SSDP_PORT, () => {
    try { sock.addMembership(SSDP_ADDR); } catch (e) { console.log('[hue] membership', e.message); }
    console.log('[hue] SSDP responder up (bridgeid ' + BRIDGE_ID + ')');
  });
}

module.exports = { startHueBridge };
