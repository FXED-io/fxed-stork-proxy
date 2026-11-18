# fxed-stork-proxy

Small server that keeps the Stork API token off the FXED web app.
The browser calls this proxy without any key; the proxy adds `Authorization: Basic <token>` towards Stork.

- `GET /health` – status and allowed assets
- `GET /v1/prices/latest?assets=XAUUSD_247_STORK,NVDA_247_STORK` – Stork REST (cached 1s)
- `wss://<host>/evm/subscribe` – Stork WebSocket relay; send `{"type":"subscribe","data":["XAUUSD_247_STORK"]}`

Prices are strings scaled by 1e18, exactly as Stork returns them.

## Environment
- `STORK_API_TOKEN` (required, secret – never commit it)
- `ALLOWED_ORIGINS` comma list, e.g. `https://fxed.xyz,https://www.fxed.xyz` (default `*`)
- `ALLOWED_ASSETS` optional override of the asset allowlist

## Run
```
npm install
STORK_API_TOKEN=... npm start
```
Then build the app with `VITE_STORK_PROXY_URL=https://<this-service>.onrender.com`.
