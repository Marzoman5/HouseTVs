# HouseTVs

A tiny, self-hosted **web remote for Samsung Tizen TVs** (tested on a UN58MU6070).
Runs on an always-on house server (any PC on the LAN) and lets anyone on the home
Wi-Fi control the TV from a phone browser — no app, no Samsung account, no IR remote.

## Why it exists

- The physical/IR remote was missing.
- The remote-key path showed **intermittent volume/mute problems** (volume sometimes
  wouldn't change, mute wouldn't unmute). HouseTVs sends volume & mute over the TV's
  **UPnP RenderingControl** service instead, which tested reliably in every trial.
  Navigation, media, power and text use the Samsung WebSocket API.

## What you get

- Mobile-first web remote: D-pad, OK/Back/Menu/Exit, media keys, number pad, power.
- **Reliable volume + mute** with a live readout and slider (UPnP, not remote keys).
- Wake-on-LAN power-on.
- Text entry into TV search boxes.
- One persistent connection to the TV; token cached so it never re-prompts after pairing.

## Quick start (Windows house server)

```powershell
git clone https://github.com/Marzoman5/HouseTVs.git
cd HouseTVs
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

`setup.ps1` installs dependencies, auto-discovers the TV, opens the firewall for the LAN,
registers a boot auto-start task, and starts the server. It will ask for admin rights.

Then open `http://<server-ip>:3000` on any phone, tap **Pair**, and **accept the Allow
prompt on the TV** (jog button under the Samsung logo if you have no remote).

## Manual start (any OS)

```bash
npm install
cp config.example.json config.json   # then set tvIp + tvMac  (or: node scripts/discover.js)
node scripts/discover.js              # auto-detect the TV and write config.json
node server.js
```

## Config (`config.json`)

| key | meaning |
|-----|---------|
| `tvIp` | TV LAN IP |
| `tvMac` | TV MAC (for Wake-on-LAN) |
| `tvPort` | WebSocket remote port (8002) |
| `serverPort` | web UI port (3000) |
| `broadcastIp` | subnet broadcast for WoL |
| `upnpPort` / `renderControlUrl` | UPnP RenderingControl endpoint (9197) |

## API (for automation)

- `GET  /api/status` — connection state
- `POST /api/key` `{ "key": "KEY_HOME" }` — send a remote key (whitelisted)
- `GET  /api/volume` · `POST /api/volume {volume}` · `POST /api/vol/up` · `POST /api/vol/down`
- `POST /api/mute` — toggle (reliable, via UPnP)
- `POST /api/text` `{ "text": "..." }` — type into a TV field
- `POST /api/power-on` — Wake-on-LAN

## Notes

- `config.json` and `token.json` are gitignored (they hold your LAN/TV specifics).
- Pairing requires a one-time **Allow** on the TV screen; it cannot be automated.
- Channel keys only do something when the TV is on its own tuner source.
