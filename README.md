# upstage-solar-npm

Pure **Node.js/NPM** port of the Upstage Solar v3 provider — **clone → install → run**.

```bash
git clone <this-repo>
cd <repo>
npm install
npm start                 # UI → http://127.0.0.1:8486
```

## Connection model — user IP only, zero relay

```
your browser ──loopback──▶ this process (node) ──direct TLS──▶ console.upstage.ai
                                                   └─direct TLS──▶ ap-northeast-2.apistage.ai
```

- **Every** credential + completion call opens a socket **from this machine**
  (your public IP). There is no proxy, no relay, no cloud hop, no middle server.
- The tiny local HTTP listener exists only so your browser can talk to the
  Node process on the same machine (`127.0.0.1` / `localhost`). It is **not**
  an API relay — it never holds Upstage traffic on another IP.
- Same process topology as the original Python provider: one process, direct
  `HTTPS` to Upstage, credentials cached on **your** disk.

## No mock · no offline

Defaults are production URLs. If the network fails you get the real error —
never a canned response.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Local UI + API (loopback; outbound = your IP) |
| `npm test` | Pure-logic tests (no network) |
| `UPSTAGE_LIVE=1 npm run test:live` | Real console + completions from this machine |
| `node bin/upstage.js "hi" --model pro3` | Direct CLI chat |

## UI features

All models (Pro 4 / Pro 3 / Pro 2 / Syn Pro / Mini 4 / Solar Mini) · web search ·
reasoning effort · temperature · max tokens · system prompt · SSE streaming
(thinking / answer / sources) · usage report · credential capture button ·
**shows your egress IP** so you can verify traffic leaves as *you*.

Full design: [architecture.md](./architecture.md)
