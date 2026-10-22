// Local tooling only. Authentication and API key generation belong to upstream Tinode.
import {createHash, randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const local = path.join(root, '.local');
const version = '0.25.3';
const platform = {darwin: 'mac', linux: 'linux'}[process.platform];
const arch = {arm64: 'arm64', x64: 'amd64'}[process.arch];
const hashes = {
  'mac-arm64': '039d9f5d0e964ddf8dd8dce0e71624228ea937b03e04a6b88f628b863535c875',
  'mac-amd64': 'cd7459ba7ac465cb512b0f4ca7306a9449a69d4959f8a56a5c42bd53de9fc8bf',
  'linux-arm64': 'c32898c870470ee54de6f3a3acc94142627a2fbc4a9280ace6b17802683f1575',
  'linux-amd64': '566bc813f41f93888c8838ea06fb1069b069f9e807e4db2f28dcaf60d4e96a80',
};
const target = `${platform}-${arch}`;
if (!hashes[target]) throw new Error('Use macOS/Linux arm64/x64 with Node.js 24 or later.');
process.umask(0o077);
const upstream = path.join(local, 'upstream');
mkdirSync(upstream, {recursive: true});
const archiveName = `tinode-postgres.${target}.tar.gz`;
const archive = path.join(upstream, archiveName);
if (!existsSync(archive)) {
  console.log(`Downloading unmodified Tinode v${version} (${target})...`);
  execFileSync('curl', ['-fL', '--retry', '2', '-o', archive,
    `https://github.com/tinode/chat/releases/download/v${version}/${archiveName}`], {stdio: 'inherit'});
}
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
if (digest !== hashes[target]) throw new Error('Upstream archive checksum mismatch; nothing executed.');
// Only executable tools are extracted. Demo data, bots and bundled webapp are not used.
execFileSync('tar', ['-xzf', archive, '-C', upstream, './tinode', './init-db', './keygen']);

const secretsPath = path.join(local, 'secrets.json');
let secrets;
if (existsSync(secretsPath)) {
  secrets = JSON.parse(readFileSync(secretsPath, 'utf8'));
} else {
  const generated = execFileSync(path.join(upstream, 'keygen'), [], {encoding: 'utf8'});
  const apiKey = generated.match(/\[ordinary\]: (\S+)/)?.[1];
  const apiSalt = generated.match(/HMAC salt: (\S+)/)?.[1];
  if (!apiKey || !apiSalt) throw new Error('Unexpected upstream keygen output.');
  secrets = {
    apiKey, apiSalt,
    tokenKey: randomBytes(32).toString('base64'),
    uidKey: randomBytes(16).toString('base64'),
    postgresPassword: randomBytes(32).toString('hex'),
  };
  writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + '\n', {flag: 'wx', mode: 0o600});
}
const save = (name, value) => writeFileSync(path.join(local, name),
  JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
const template = JSON.parse(readFileSync(path.join(root, 'config/tinode.template.json'), 'utf8'));
template.api_key_salt = secrets.apiSalt;
template.auth_config.token.key = secrets.tokenKey;
template.store_config.uid_key = secrets.uidKey;
for (const mode of ['docker', 'native']) {
  const config = structuredClone(template);
  const dbHost = mode === 'docker' ? 'postgres:5432' : '127.0.0.1:55432';
  config.store_config.adapters.postgres.dsn =
    `postgresql://postgres:${secrets.postgresPassword}@${dbHost}/collapse?sslmode=disable&connect_timeout=10`;
  config.media.handlers.fs.upload_dir = mode === 'docker' ? '/var/lib/tinode/uploads' : path.join(local, 'uploads');
  if (mode === 'native') config.listen = '127.0.0.1:6060';
  save(`tinode.${mode}.json`, config);
}
mkdirSync(path.join(local, 'uploads'), {recursive: true});
save('client.json', {TINODE_HOST: '127.0.0.1:6060', TINODE_TLS: false, TINODE_API_KEY: secrets.apiKey});
writeFileSync(path.join(root, '.env'), `POSTGRES_PASSWORD=${secrets.postgresPassword}\n`, {mode: 0o600});
writeFileSync(path.join(local, 'postgres-password'), secrets.postgresPassword + '\n', {mode: 0o600});
if (!process.argv.includes('--docker')) {
  execFileSync(process.execPath, [path.join(root, 'scripts/build-server.mjs')], {stdio: 'inherit'});
}
console.log('Ready: .local/client.json contains the non-root client API key and endpoint.');
console.log('Server secrets stay in ignored .local/ and .env. Existing keys were preserved.');
