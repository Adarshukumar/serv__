#!/usr/bin/env node
/**
 * bin/upstage.js — CLI: chat against the REAL Upstage API from this machine.
 *
 *   npx upstage-solar "What is 2+2?" --model solar-pro3 --search
 *   npx upstage-solar --connect-only
 */
import readline from 'node:readline';
import { UpstageProvider } from '../src/provider.js';

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else flags[key] = true;
  } else positional.push(a);
}

const up = new UpstageProvider({
  model: flags.model,
  search: Boolean(flags.search),
  system: flags.system,
});

const color = process.stdout.isTTY;
const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
const yellow = (s) => (color ? `\x1b[33m${s}\x1b[0m` : s);

async function connect() {
  process.stderr.write(dim('connecting (real console.upstage.ai)…\n'));
  await up.connect();
  const token = await up._creds.verify();
  process.stderr.write(dim(token ? `✓ csrf ok\n` : `✗ csrf failed\n`));
}

async function oneShot(prompt) {
  process.stdout.write('assistant ▸ ');
  for await (const ev of up.stream({
    data: prompt,
    search: up.search,
    maxTokens: flags['max-tokens'] ? Number(flags['max-tokens']) : 512,
    reasoning: flags.reasoning,
  })) {
    if (ev.kind === 'thinking') process.stdout.write(dim(ev.text));
    else if (ev.kind === 'content') process.stdout.write(ev.text);
    else if (ev.kind === 'sources') process.stdout.write(dim('\n[📚 sources]\n'));
  }
  process.stdout.write('\n');
  if (up.last_usage) process.stdout.write(dim(`   ${up.last_usage.formatLine()}\n`));
}

async function repl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => {
    rl.question('you ▸ ', async (line) => {
      const t = line.trim();
      if (!t) return ask();
      if (t === '/quit' || t === '/exit') {
        rl.close();
        return;
      }
      if (t === '/usage') {
        console.log(up.session_usage.formatReport());
        return ask();
      }
      if (t.startsWith('/model ')) {
        up.setModel(t.slice(7).trim());
        console.log(`  model → ${up.model}`);
        return ask();
      }
      try {
        await oneShot(t);
      } catch (e) {
        console.error(`\n⚠ ${e.message}`);
      }
      ask();
    });
  };
  console.log('Upstage Solar REPL — /model <name> · /usage · /quit');
  ask();
}

try {
  if (flags['connect-only']) {
    await connect();
    process.exit(0);
  }
  await connect();
  if (positional.length) await oneShot(positional.join(' '));
  else if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const prompt = Buffer.concat(chunks).toString('utf8').trim();
    if (prompt) await oneShot(prompt);
  } else await repl();
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
}
