import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { createCompanion } from './server';

const port = Number(process.env.MERCURY_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('MERCURY_PORT must be a port from 1 to 65535.');
  process.exit(1);
}

const companion = await createCompanion({ port });
console.log(`\nMercury is running on this computer: ${companion.url}`);
console.log('The dedicated Chrome window visits chat.inceptionlabs.ai directly from your connection.');
console.log('If Inception shows a security check, complete it in that window.');
console.log('No official API key, browser extension, or intermediary server is used.\n');

if (process.env.MERCURY_NO_OPEN !== '1') {
  try {
    const os = platform();
    const cmd = os === 'win32' ? 'cmd' : os === 'darwin' ? 'open' : 'xdg-open';
    const args = os === 'win32' ? ['/c', 'start', '', companion.url] : [companion.url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // headless machine: the printed link still works
    child.unref();
  } catch {
    // No desktop opener; the printed link still works.
  }
}

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  console.log('\nShutting down Mercury and its dedicated Chrome window…');
  void companion.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
