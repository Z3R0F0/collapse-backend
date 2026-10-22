// Isolated real-server acceptance. Never connects to the live 6060/55432 data.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = mkdtempSync(path.join(root, '.local/media-test-'));
const pgdata = path.join(fixture, 'postgres');
const configFile = path.join(fixture, 'tinode.json');
const tools = path.join(root, '.local/upstream');
const peers = [];
let server;
let pgStarted = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
const pgport = await freePort(), port = await freePort();
const dsn = `postgresql://postgres@127.0.0.1:${pgport}/collapse_media_test`;
function sql(query) {
  return execFileSync('psql', ['-XAt', '--set=ON_ERROR_STOP=1', dsn], {input: query, encoding: 'utf8'}).trim();
}
const keygen = execFileSync(path.join(tools, 'keygen'), [], {encoding: 'utf8'});
const apiKey = keygen.match(/\[ordinary\]: (\S+)/)?.[1];
const config = JSON.parse(readFileSync(path.join(root, 'config/tinode.template.json'), 'utf8'));
config.api_key_salt = keygen.match(/HMAC salt: (\S+)/)?.[1];
config.auth_config.token.key = randomBytes(32).toString('base64');
config.store_config.uid_key = randomBytes(16).toString('base64');
config.store_config.adapters.postgres.dsn = dsn;
config.listen = `127.0.0.1:${port}`;
config.media.handlers.fs.upload_dir = path.join(fixture, 'uploads');
mkdirSync(config.media.handlers.fs.upload_dir);
writeFileSync(configFile, JSON.stringify(config), {mode: 0o600});

class Client {
  serial = 0; pending = new Map(); data = 0; received = new Set();
  async open() {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/v0/channels?apikey=${encodeURIComponent(apiKey)}`);
    peers.push(this);
    this.socket.addEventListener('message', ({data}) => {
      const packet = JSON.parse(data);
      if (packet.data) {
        this.data++;
        this.received.add(`${packet.data.topic}:${packet.data.seq}`);
      }
      const reply = packet.ctrl ?? packet.meta;
      const pending = this.pending.get(reply?.id);
      if (pending) { this.pending.delete(reply.id); pending(reply); }
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, {once: true});
      this.socket.addEventListener('error', () => reject(new Error('Synthetic socket failed')), {once: true});
    });
    await this.request('hi', {ver: '0.25.3', ua: 'collapse-media-test'});
    return this;
  }
  async request(kind, body, expectedCode) {
    const id = String(++this.serial);
    let timer;
    const pending = new Promise((resolve, reject) => {
      timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Synthetic ${kind} timed out`)); }, 10000);
      this.pending.set(id, resolve);
    });
    this.socket.send(JSON.stringify({[kind]: {...body, id}}));
    const reply = await pending.finally(() => clearTimeout(timer));
    if (expectedCode) assert.equal(reply.code, expectedCode);
    else assert.ok(!reply.code || reply.code < 400, `Synthetic ${kind} failed: ${reply.code}`);
    return reply;
  }
  async account(label) {
    const name = `atlas${label}${randomBytes(4).toString('hex')}`;
    const reply = await this.request('acc', {user: 'new', scheme: 'basic', login: true,
      secret: Buffer.from(`${name}:${randomBytes(12).toString('hex')}`).toString('base64'), desc: {public: {fn: `Synthetic ${label}`}}});
    this.uid = reply.params.user;
    await this.request('sub', {topic: 'me'});
    return this;
  }
  async page(topic, media = {}) {
    const before = this.data;
    const reply = await this.request('get', {topic, what: 'media', media: {kind: 'visual', limit: 24, ...media}});
    assert.equal(this.data, before, 'atlas response must not emit ordinary data');
    return reply.media;
  }
  async receivedMessage(topic, seq) {
    const deadline = Date.now() + 10000;
    while (!this.received.has(`${topic}:${seq}`)) {
      assert.ok(Date.now() < deadline, 'synthetic live message was not delivered');
      await pause(5);
    }
  }
}
const item = (type, label) => ({tp: type, data: {ref: `/v0/file/s/${label}`, mime: type === 'IM' ? 'image/png' : 'application/octet-stream', name: label, val: 'never-in-page'}});
const content = entries => ({txt: ' '.repeat(entries.length), fmt: entries.map((_, key) => ({at: key, len: 1, key})), ent: entries});
const cursor = entry => ({seq: entry.seq, key: entry.key});
try {
  execFileSync('initdb', ['-D', pgdata, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C'], {stdio: 'ignore'});
  execFileSync('pg_ctl', ['-D', pgdata, '-l', path.join(fixture, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${pgport} -k ${fixture}`, '-w', 'start'], {stdio: 'ignore'});
  pgStarted = true;
  execFileSync(path.join(tools, 'init-db'), [`--config=${configFile}`, '--data='], {stdio: 'ignore', env: {...process.env, TZ: 'UTC'}});
  // An existing stock database must be indexed without rewriting its messages.
  sql(`INSERT INTO messages(createdat,updatedat,seqid,topic,"from",content)
    VALUES(now(),now(),1,'sys',0,
      '{"txt":" ","fmt":[{"at":0,"len":1,"key":0}],"ent":[{"tp":"IM","data":{"ref":"/v0/file/s/preexisting"}}]}'::json);`);
  const originalContent = sql("SELECT md5(content::text) FROM messages WHERE topic='sys' AND seqid=1");
  server = spawn(path.join(root, '.local/server/tinode'), [`--config=${configFile}`, '--static_data=-'], {stdio: 'ignore', env: {...process.env, TZ: 'UTC'}});
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode != null) throw new Error('Synthetic Tinode exited before readiness');
    try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await pause(100); }
  }
  assert.equal(sql("SELECT md5(content::text) FROM messages WHERE topic='sys' AND seqid=1"), originalContent);
  assert.equal(sql("SELECT count(*) FROM messages WHERE topic='sys' AND public.collapse_media_has_v1(content::jsonb,'visual')"), '1');
  assert.equal(sql("SELECT count(*) FROM pg_indexes WHERE indexname IN ('collapse_media_visual_v1','collapse_media_audio_v1','collapse_media_files_v1')"), '3');
  const structureCount = (entities, formats) => sql(`SELECT count(*) FROM public.collapse_media_items_v1(
    jsonb_build_object('ent',(SELECT jsonb_agg('{"tp":"IM","data":{"ref":"/v0/file/s/bounded"}}'::jsonb) FROM generate_series(1,${entities})),
      'fmt',(SELECT jsonb_agg('{"at":0,"len":1,"key":0}'::jsonb) FROM generate_series(1,${formats}))))`);
  assert.equal(structureCount(256, 1024), '1', 'duplicate references emit one original key');
  assert.equal(structureCount(257, 1), '0', 'oversized entity structure is not indexed');
  assert.equal(structureCount(1, 1025), '0', 'oversized format structure is not indexed');
  const alice = await (await new Client().open()).account('alice');
  const bob = await (await new Client().open()).account('bob');
  const outsider = await (await new Client().open()).account('outsider');
  const anonymous = await new Client().open();
  await alice.request('sub', {topic: bob.uid});
  await bob.request('sub', {topic: alice.uid});
  await anonymous.request('get', {topic: alice.uid, what: 'media', media: {kind: 'visual'}}, 401);
  await outsider.request('get', {topic: bob.uid, what: 'media', media: {kind: 'visual'}}, 403);
  const sent = [];
  for (let n = 0; n < 33; n++) {
    const reply = await alice.request('pub', {topic: bob.uid, head: {'mime': 'text/x-drafty', 'x-client-id': `synthetic-${n}`},
      content: content([item('IM', `image-${n}`), item('VD', `video-${n}`), item('AU', `voice-${n}`), item('EX', `file-${n}`)])});
    sent.push(reply.params.seq);
  }
  await alice.receivedMessage(bob.uid, sent.at(-1));
  await bob.receivedMessage(alice.uid, sent.at(-1));
  // Plain history is intentionally much larger than the atlas.
  const p2p = sql("SELECT name FROM topics WHERE name LIKE 'p2p%' LIMIT 1");
  sql(`INSERT INTO messages(createdat,updatedat,seqid,topic,"from",content)
    SELECT now(),now(),seq, '${p2p}',0,'"synthetic text"'::json FROM generate_series(1000,8000) seq; ANALYZE messages;`);
  let page = await alice.page(bob.uid), all = [...page.items];
  assert.equal(page.items.length, 24); assert.equal(page.snapshot, 33); assert.equal(page.hasNewer, false);
  assert.ok(page.items.every(entry => entry.inline && !('val' in entry.data) && entry.clientId?.startsWith('synthetic-')));
  while (page.hasOlder) {
    page = await alice.page(bob.uid, {before: cursor(page.items.at(-1)), snapshot: page.snapshot});
    assert.ok(page.items.length > 0); all.push(...page.items);
  }
  assert.equal(all.length, 66); assert.equal(new Set(all.map(entry => `${entry.seq}:${entry.key}`)).size, 66);
  const near = await alice.page(bob.uid, {around: {seq: 15, key: 1}});
  assert.equal(near.anchorFound, true); assert.equal(near.hasOlder, true); assert.equal(near.hasNewer, true);
  assert.ok(near.items.some(entry => entry.seq === 15 && entry.key === 1));
  const forward = await alice.page(bob.uid, {after: {seq: 1, key: 0}, limit: 2});
  assert.deepEqual(forward.items.map(cursor), [{seq: 2, key: 0}, {seq: 1, key: 1}]);
  const peerPage = await bob.page(alice.uid);
  assert.ok(peerPage.items.every(entry => !('clientId' in entry)));
  assert.equal((await bob.page(alice.uid, {kind: 'audio'})).items.length, 24);
  assert.equal((await bob.page(alice.uid, {kind: 'files'})).items.length, 24);
  await bob.request('del', {topic: alice.uid, what: 'msg', delseq: [{low: 33}], hard: false});
  assert.ok((await bob.page(alice.uid)).items.every(entry => entry.seq !== 33));
  assert.ok((await alice.page(bob.uid)).items.some(entry => entry.seq === 33));
  await alice.request('del', {topic: bob.uid, what: 'msg', delseq: [{low: 32}], hard: true});
  assert.ok((await bob.page(alice.uid)).items.every(entry => entry.seq !== 32));
  const missing = await bob.page(alice.uid, {around: {seq: 32, key: 0}});
  assert.equal(missing.anchorFound, false);
  assert.ok(missing.delId > 0);
  const freshAck = await alice.request('pub', {topic: bob.uid, content: content([item('IM', 'new-after-snapshot')])});
  await alice.receivedMessage(bob.uid, freshAck.params.seq);
  assert.equal((await alice.page(bob.uid, {snapshot: 33})).snapshot, 33);
  assert.ok((await alice.page(bob.uid, {snapshot: 33})).items.every(entry => entry.seq <= 33));
  assert.equal((await alice.page(bob.uid)).items[0].seq, 34);
  const quote = content([item('IM', 'quote-only')]);
  quote.fmt.push({at: 0, len: 1, tp: 'QQ'});
  await alice.request('pub', {topic: bob.uid, content: quote});
  const hidden = content([item('IM', 'hidden-only')]);
  hidden.fmt.push({at: 0, len: 1, tp: 'HD'});
  const hiddenAck = await alice.request('pub', {topic: bob.uid, content: hidden});
  await alice.receivedMessage(bob.uid, hiddenAck.params.seq);
  assert.ok((await alice.page(bob.uid)).items.every(entry => entry.seq <= 34));
  const thumb = item('IM', 'bounded-thumbnail');
  thumb.data.val = 'aGVsbG8=';
  const thumbAck = await alice.request('pub', {topic: bob.uid, content: content([thumb])});
  // Wait for the real peer arrival, which is unrelated to the following atlas
  // request; then the no-data-emission assertion has a quiescent baseline.
  await bob.receivedMessage(alice.uid, thumbAck.params.seq);
  const thumbPage = await bob.page(alice.uid, {around: {seq: thumbAck.params.seq, key: 0}, limit: 1});
  assert.equal(thumbPage.items[0].data.preview, thumb.data.val);
  assert.ok(!('val' in thumbPage.items[0].data));
  const malformed = sql(`SELECT count(*) FROM public.collapse_media_items_v1('{"ent":{},"fmt":[]}'::jsonb)`);
  assert.equal(malformed, '0');
  const plan = sql(`EXPLAIN SELECT m.seqid,e.key FROM messages m
    CROSS JOIN LATERAL public.collapse_media_items_v1(m.content::jsonb) e
    WHERE m.topic='${p2p}' AND m.delid=0 AND m.seqid<=8000
    AND public.collapse_media_has_v1(m.content::jsonb,'visual') AND e.kind='visual'
    AND (m.seqid,e.key)<(8000,1)
    AND NOT EXISTS(SELECT 1 FROM dellog d WHERE d.topic=m.topic AND d.deletedfor=-1
      AND m.seqid>=d.low AND m.seqid<d.hi)
    ORDER BY m.seqid DESC,e.key DESC LIMIT 24`);
  assert.ok(plan.includes('collapse_media_visual_v1'), 'sparse history must use the category index');
  const group = await alice.request('sub', {topic: 'new', set: {desc: {public: {fn: 'Synthetic atlas group'}}}});
  const groupAck = await alice.request('pub', {topic: group.topic, content: content([item('IM', 'group-image')])});
  await alice.receivedMessage(group.topic, groupAck.params.seq);
  assert.equal((await alice.page(group.topic)).items.length, 1);
  await outsider.request('get', {topic: group.topic, what: 'media', media: {kind: 'visual'}}, 403);
  await alice.request('set', {topic: group.topic, sub: {user: bob.uid, mode: 'JRP'}});
  await bob.request('sub', {topic: group.topic});
  assert.equal((await bob.page(group.topic)).items.length, 1);
  await alice.request('set', {topic: group.topic, sub: {user: bob.uid, mode: 'JP'}});
  await bob.request('get', {topic: group.topic, what: 'media', media: {kind: 'visual'}}, 403);
  await alice.request('get', {topic: bob.uid, what: 'media', media: {kind: 'visual', limit: 41}}, 400);
  console.log('PASS: existing-message index installation, isolated atlas ACL, exact entity cursors, around/forward/back, metadata bounds, own identity, categories, deletions, hidden/quote exclusion and sparse index plan');
} finally {
  for (const peer of peers) peer.socket.close();
  if (server && server.exitCode == null) {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
  }
  if (pgStarted) execFileSync('pg_ctl', ['-D', pgdata, '-m', 'fast', '-w', 'stop'], {stdio: 'ignore'});
  if (fixture.startsWith(path.join(root, '.local/media-test-'))) rmSync(fixture, {recursive: true});
}
