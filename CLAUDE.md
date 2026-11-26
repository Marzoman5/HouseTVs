# HouseTVs — agent install guide

You are setting up HouseTVs on a **house server** (an always-on PC on the home LAN) so
phones on the Wi-Fi can control a Samsung Tizen TV. Follow these steps. Two steps need a
human at the TV; everything else you can do.

## Facts about this project
- Node app. One dependency (`ws`). Volume/mute go over the TV's **UPnP RenderingControl**
  (reliable); everything else over the Samsung WebSocket remote API (`wss` :8002, token auth).
- `config.json` and `token.json` are per-install and gitignored — you create them here.

## Steps

1. **Install deps:** `npm install`

2. **Find the TV and write config:** `node scripts/discover.js`
   - This SSDP-scans the LAN, confirms the Samsung TV via `http://<ip>:8001/api/v2/`,
     and writes `config.json` (tvIp, tvMac, broadcast).
   - If it finds none: the TV must be ON and on the same subnet. As a fallback, copy
     `config.example.json` to `config.json` and fill `tvIp` + `tvMac` (MAC is on the TV at
     Settings → Support → About This TV → Wired/Wireless MAC).

3. **Open the firewall (Windows, needs admin):** allow inbound TCP on `serverPort`
   (default 3000) scoped to `LocalSubnet`. On Windows the simplest path is to run
   `setup.ps1`, which self-elevates and also does steps 1–2 and 4–5. Non-Windows: open the
   port in the OS firewall yourself.

4. **Auto-start at boot:** register the server to run on startup so the house server always
   serves it. Windows: a Scheduled Task running `node server.js` at boot (setup.ps1 does
   this). Linux/mac: a systemd unit / launchd plist / pm2.

5. **Start it:** `node server.js` (listens on `0.0.0.0:<serverPort>`).

6. **Pair (needs a human at the TV):** have the user open `http://<server-ip>:<port>` and
   tap **Pair**, OR `POST /api/pair`. An **Allow this device?** prompt appears ON THE TV and
   must be accepted there within ~30s (jog button under the Samsung logo if there's no
   remote). The token is then cached to `token.json`; no further prompts. Do not loop
   `/api/pair` — each call re-prompts.

## Verify
- `GET /api/status` → `connected: true`.
- `GET /api/volume` returns a number; `POST /api/vol/up` changes it. That confirms the TV
  link end-to-end (a key press returns no ack, so use volume to verify).

## Don't
- Don't commit `config.json` or `token.json`.
- Don't retry pairing in a loop. Don't assume a key worked without a visible/volume change.
