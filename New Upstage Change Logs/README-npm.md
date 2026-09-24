# New Upstage Change Logs → NPM

The entire v3 Python provider was converted to a pure Node.js/NPM project:

- **`npm-upstage/`** — full package (provider, credential capture, HTTP API, web UI, CLI)
- **`npm-upstage/architecture.md`** — explanation of the entire system

```bash
cd npm-upstage && npm install && npm start   # → http://localhost:8486
```

No mocks. No offline mode. Real console.upstage.ai + apistage.ai from your IP.
