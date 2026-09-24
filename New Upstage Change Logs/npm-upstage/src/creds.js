/**
 * creds.js — browser-free credential capture against the REAL
 * console.upstage.ai (pure HTTP via got-scraping: browser TLS
 * fingerprint, no headless browser, no DrissionPage).
 *
 * Pipeline (identical to New Upstage Change Logs v3):
 *   1. load cache/upstage_creds.json
 *   2. verify CSRF token via RSC POST
 *   3. valid?  → instant start
 *   4. invalid → pure-HTTP re-capture:
 *        a. GET /playground/chat           → session cookies
 *        b. GET with RSC:1                 → extra chunk refs
 *        c. scan chunks for createServerReference("…","getConsoleCsrfToken")
 *        d. RSC POST data="[]"             → parse {"token": …}
 *        e. save cookies + action ids
 */
import fs from 'node:fs';
import path from 'node:path';
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';
import {
  ACTION_INIT,
  ACTION_TOKEN,
  CONNECT_TIMEOUT,
  MAX_CHUNK_SCAN,
  UA,
  chatPath,
  consoleUrl,
  credFile,
} from './config.js';

const CHUNK_RE = /static\/chunks\/[^"\s\],]+\.js/g;

/**
 * Extract a Next.js server-action id from a client JS bundle by name.
 * Matches minified:
 *   createServerReference)("002f44cb…d5",x.callServer,void 0,
 *       x.findSourceMapURL,"getConsoleCsrfToken")
 * The id is pinned to its own 3-arg list so co-located actions
 * can't cross-wire. Length-flexible (40→42→… hex).
 */
export function findActionId(jsText, actionName) {
  const re = new RegExp(
    'createServerReference\\)\\("([a-f0-9]{32,80})"(?:,[^,"]+){3},"' +
      actionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '"\\)',
  );
  const m = jsText.match(re);
  return m ? m[1] : null;
}

export class Credentials {
  constructor(filePath = null) {
    this.path = filePath || credFile();
    this.actionInit = null;
    this.actionToken = null;
    this.cookies = {};
    this.sessionId = crypto.randomUUID();
    this.jar = new CookieJar();
    this._lastToken = null;
  }

  // ── load / save / clear ──────────────────────────────────
  async load() {
    if (!fs.existsSync(this.path)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this.actionInit = data.action_init ?? null;
      this.actionToken = data.action_token ?? null;
      this.cookies = data.cookies || {};
      this.sessionId = this.cookies.session_id || crypto.randomUUID();
      await this._jarFromCookies(this.cookies);
      return Boolean(this.actionToken);
    } catch {
      return false;
    }
  }

  async save() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const data = {
      action_init: this.actionInit,
      action_token: this.actionToken,
      cookies: this.cookies,
      saved_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    };
    fs.writeFileSync(this.path, JSON.stringify(data, null, 2));
  }

  async clear() {
    try {
      if (fs.existsSync(this.path)) fs.unlinkSync(this.path);
    } catch {
      /* ignore */
    }
  }

  async _jarFromCookies(cookies) {
    for (const [k, v] of Object.entries(cookies || {})) {
      await this.jar.setCookie(
        `${k}=${v}; Path=/`,
        `${consoleUrl()}/`,
      );
    }
  }

  async _absorbResponseCookies(res) {
    const setCookies = res.headers['set-cookie'];
    if (!setCookies) return;
    const list = Array.isArray(setCookies) ? setCookies : [setCookies];
    for (const sc of list) {
      try {
        await this.jar.setCookie(sc, res.url || `${consoleUrl()}/`);
      } catch {
        /* ignore bad cookie */
      }
    }
    await this._syncCookiesFromJar();
  }

  async _syncCookiesFromJar() {
    const url = `${consoleUrl()}/`;
    const all = await this.jar.getCookies(url);
    for (const c of all) {
      this.cookies[c.key] = c.value;
    }
    if (!this.cookies.session_id) {
      this.cookies.session_id = crypto.randomUUID();
      await this.jar.setCookie(
        `session_id=${this.cookies.session_id}; Path=/`,
        url,
      );
    }
    this.sessionId = this.cookies.session_id;
  }

  async _cookieHeader() {
    const all = await this.jar.getCookies(`${consoleUrl()}/`);
    return all.map((c) => `${c.key}=${c.value}`).join('; ');
  }

  _client() {
    return {
      cookieJar: this.jar,
      timeout: { request: CONNECT_TIMEOUT },
      headers: { 'user-agent': UA },
      https: { rejectUnauthorized: true },
      followRedirect: true,
    };
  }

  // ── verify (one RSC POST) ───────────────────────────────
  async verify() {
    if (!this.actionToken) return null;
    try {
      return await this._tryGetToken();
    } catch {
      return null;
    }
  }

  async _rscPost(actionId) {
    const headers = {
      accept: 'text/x-component',
      'content-type': 'text/plain;charset=UTF-8',
      'next-action': actionId,
      origin: consoleUrl(),
      referer: `${consoleUrl()}${chatPath()}`,
      'user-agent': UA,
    };
    const res = await gotScraping.post(`${consoleUrl()}${chatPath()}`, {
      ...this._client(),
      headers: { ...this._client().headers, ...headers },
      body: '[]',
      throwHttpErrors: false,
    });
    await this._absorbResponseCookies(res);
    if (res.statusCode >= 400) {
      throw new Error(`RSC POST HTTP ${res.statusCode}`);
    }
    return res.body;
  }

  async _tryGetToken() {
    try {
      const body = await this._rscPost(this.actionToken);
      for (const line of body.split(/\r?\n/)) {
        if (line.includes('"token"')) {
          const idx = line.indexOf('{');
          if (idx === -1) continue;
          try {
            const obj = JSON.parse(line.slice(idx));
            if (obj.token) {
              this._lastToken = obj.token;
              return obj.token;
            }
          } catch {
            continue;
          }
        }
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  // ── capture via pure HTTP ───────────────────────────────
  async capture() {
    // 1) page load — sets session cookies
    const page = await gotScraping.get(`${consoleUrl()}${chatPath()}`, {
      ...this._client(),
      throwHttpErrors: false,
    });
    if (page.statusCode >= 400) {
      throw new Error(`GET playground HTTP ${page.statusCode}`);
    }
    await this._absorbResponseCookies(page);
    const html = page.body;

    // 2) merge chunk refs from page + RSC payload
    const chunkRefs = new Set(html.match(CHUNK_RE) || []);
    try {
      const rsc = await gotScraping.get(`${consoleUrl()}${chatPath()}`, {
        ...this._client(),
        headers: { ...this._client().headers, rsc: '1' },
        throwHttpErrors: false,
      });
      if (rsc.statusCode === 200) {
        for (const ref of rsc.body.match(CHUNK_RE) || []) chunkRefs.add(ref);
      }
    } catch {
      /* RSC scan is insurance only */
    }

    // 3) scan chunks for action ids (by name)
    let actionToken = null;
    let actionInit = null;
    let scanned = 0;
    const refs = [...chunkRefs].sort().slice(0, MAX_CHUNK_SCAN);
    for (const ref of refs) {
      scanned += 1;
      let r;
      try {
        r = await gotScraping.get(`${consoleUrl()}/_next/${ref}`, {
          ...this._client(),
          throwHttpErrors: false,
        });
      } catch {
        continue;
      }
      if (r.statusCode !== 200) continue;
      const js = r.body;
      if (!actionToken && js.includes(ACTION_TOKEN)) {
        actionToken = findActionId(js, ACTION_TOKEN);
      }
      if (!actionInit && js.includes(ACTION_INIT)) {
        actionInit = findActionId(js, ACTION_INIT);
      }
      if (actionToken) break;
    }

    if (!actionToken) {
      throw new RuntimeError(
        `Could not find '${ACTION_TOKEN}' action in any of ${scanned} ` +
          `scanned JS chunks — console structure may have changed. ` +
          `Delete ${this.path} and retry.`,
      );
    }

    // 4) prove the action works + harvest a first token
    await this._syncCookiesFromJar();
    this.actionToken = actionToken;
    this.actionInit = actionInit;
    const body = await this._rscPost(actionToken);
    if (!body.includes('"token"')) {
      throw new RuntimeError(
        `Token action '${actionToken.slice(0, 12)}…' answered but no token ` +
          `in response (len=${body.length}).`,
      );
    }

    this.sessionId = this.cookies.session_id || crypto.randomUUID();
    await this.save();
    return this._lastToken;
  }
}

class RuntimeError extends Error {}

export { RuntimeError };
