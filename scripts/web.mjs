// Optional local same-origin web runner. No global install or Tinode changes.
import {createHash} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = '2.11.4';
const platform = {darwin: 'mac', linux: 'linux'}[process.platform];
const arch = {arm64: 'arm64', x64: 'amd64'}[process.arch];
// SHA-512 digests from the official, versioned caddy_2.11.4_checksums.txt.
const hashes = {
  'mac_arm64': '3190ae0df98b59ab4b6021556fa35adc3c526a4f3e138776b0eaec8a037cc26121cbbb1ad53453f565551b47d37d5ba4755e2c2c3652256737fe2ce9e53c8ec0',
  'mac_amd64': 'e04eb10f9ce7e2e079bc9bff1bd5d3a3164888d1edbb1a49e5d15be4eab691b57e89ed36bb29c65ba43f1ba8d9279e0967b1003991c13fe4cb78384c3caf25de',
  'linux_arm64': 'd5a7c423853c24a799765e0e8210d5c7c22a8f56ed37a3cae2fb9f58be138853c02b4efd6b59d576e6d8c7c0d30b9c1592deeaa6a536ff69bcca23b8c1ea709c',
  'linux_amd64': '8220d1f013b6f27510247b2360c9e0ca9f018feebd82515f07635318b34ff9777ccc8fd0b6e6f2486ce3a33fe389fbb7db12d05baa474f4587509fb4f5ebf1c9',
};
const target = `${platform}_${arch}`;
if (!hashes[target]) throw new Error('Use macOS/Linux arm64/x64 with Node.js 24 or later.');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: node scripts/web.mjs [--check]');
const port = process.env.COLLAPSE_WEB_PORT || '8085';
if (!['8085', '8086'].includes(port)) throw new Error('COLLAPSE_WEB_PORT must be 8085 or 8086.');
const web = realpathSync(process.env.COLLAPSE_WEB_DIR || path.join(root, '../collapse-client/build/web'));
if (!existsSync(path.join(web, 'index.html')) || !existsSync(path.join(web, 'flutter_bootstrap.js'))) {
  throw new Error('COLLAPSE_WEB_DIR must point to a built Flutter web directory.');
}
process.umask(0o077);
const local = path.join(root, '.local', `caddy-${version}`);
mkdirSync(local, {recursive: true});
const archiveName = `caddy_${version}_${target}.tar.gz`;
const archive = path.join(local, archiveName);
if (!existsSync(archive)) {
  console.log(`Downloading unmodified Caddy v${version} (${target})...`);
  execFileSync('curl', ['-fL', '--retry', '2', '-o', archive,
    `https://github.com/caddyserver/caddy/releases/download/v${version}/${archiveName}`], {stdio: 'inherit'});
}
const digest = createHash('sha512').update(readFileSync(archive)).digest('hex');
if (digest !== hashes[target]) throw new Error('Caddy archive checksum mismatch; nothing executed.');
// Keep the upstream license with the local executable; do not install globally.
const executable = path.join(local, 'caddy');
// A second staging/live runner may already be executing this pinned binary.
if (!existsSync(executable)) execFileSync('tar', ['-xzf', archive, '-C', local, 'caddy', 'LICENSE']);
const env = {...process.env, COLLAPSE_WEB_PORT: port, COLLAPSE_WEB_DIR: web,
  COLLAPSE_CADDY_DATA: path.join(local, 'data')};
const args = ['--config', path.join(root, 'config', 'Caddyfile'), '--adapter', 'caddyfile'];
execFileSync(executable, ['validate', ...args], {env, stdio: 'inherit'});
if (!process.argv.includes('--check')) {
  console.log(`collapse web: http://127.0.0.1:${port} (same-origin Tinode; Ctrl-C stops only this proxy)`);
  const child = spawn(executable, ['run', ...args], {env, stdio: 'inherit'});
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('Caddy could not start.'); process.exitCode = 1; });
  child.on('exit', code => {
    if (code) console.error(`Caddy exited (${code}); check that port ${port} is free and the web directory is readable.`);
    process.exitCode = code ?? 1;
  });
}
