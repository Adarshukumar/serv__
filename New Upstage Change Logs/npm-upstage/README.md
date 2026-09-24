# upstage-solar-npm

Pure **Node.js/NPM** port of `New Upstage Change Logs` (Python v3 provider).

- ✅ Real `console.upstage.ai` credential extraction (pure HTTP, no browser)
- ✅ Real SSE streaming from `ap-northeast-2.apistage.ai`
- ✅ Outbound traffic = **your machine's IP** (no proxy/relay)
- ✅ Web UI: all models, search, reasoning, sources, usage
- ❌ No mock server · no offline mode · no canned responses

```bash
npm install
npm start          # → http://localhost:8486
npm test           # pure-logic tests
UPSTAGE_LIVE=1 npm run test:live   # hits the real API
```

See [architecture.md](./architecture.md) for the full system design.
