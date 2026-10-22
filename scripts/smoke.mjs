// Standard Tinode protocol integration test; never contacts an external server.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const config = JSON.parse(readFileSync(fileURLToPath(new URL('../.local/client.json', import.meta.url)), 'utf8'));
assert.equal(config.TINODE_HOST, '127.0.0.1:6060', 'Smoke test is restricted to this local development endpoint.');
const base = `http://${config.TINODE_HOST}`;
const sockets = [];
const created = [];
let group;

class Client {
  packets = [];
  listeners = new Set();
  nextId = 0;
  async open() {
    this.ws = new WebSocket(`ws://${config.TINODE_HOST}/v0/channels?apikey=${encodeURIComponent(config.TINODE_API_KEY)}`);
    sockets.push(this);
    this.ws.addEventListener('message', event => {
      const packet = JSON.parse(event.data);
      this.packets.push(packet);
      for (const listener of this.listeners) listener(packet);
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, {once: true});
      this.ws.addEventListener('error', reject, {once: true});
    });
    await this.request('hi', {ver: '0.25.3', ua: 'collapse-local-smoke', lang: 'en'});
    return this;
  }
  wait(predicate, from = this.packets.length) {
    const existing = this.packets.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error('Timed out awaiting a Tinode packet.'));
      }, 10000);
      const listener = packet => {
        if (!predicate(packet)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(packet);
      };
      this.listeners.add(listener);
    });
  }
  async request(kind, payload, response = 'ctrl', extra) {
    const id = String(++this.nextId);
    const pending = this.wait(packet => packet[response]?.id === id || packet.ctrl?.id === id);
    this.ws.send(JSON.stringify({[kind]: {...payload, id}, ...(extra ? {extra} : {})}));
    const packet = await pending;
    if (packet.ctrl) assert.ok(packet.ctrl.code < 400, `${kind}: ${packet.ctrl.code} ${packet.ctrl.text}`);
    return packet[response] ?? packet.ctrl;
  }
  note(topic, what, seq) {
    this.ws.send(JSON.stringify({note: {topic, what, ...(seq === undefined ? {} : {seq})}}));
  }
  async register(label) {
    this.username = `smoke${label}${randomBytes(5).toString('hex')}`;
    this.password = randomBytes(16).toString('hex');
    const ctrl = await this.request('acc', {
      user: 'new', scheme: 'basic', login: true,
      secret: Buffer.from(`${this.username}:${this.password}`).toString('base64'),
      desc: {public: {fn: `Smoke ${label}`}},
    });
    this.uid = ctrl.params.user;
    this.token = ctrl.params.token;
    assert.ok(this.uid.startsWith('usr') && this.token);
    created.push(this);
    await this.request('sub', {topic: 'me', get: {what: 'desc sub'}});
    return this;
  }
  close() { this.ws.close(); }
}

async function upload(client, filename, type, bytes) {
  const form = new FormData();
  form.append('id', 'smoke-upload');
  form.append('file', new Blob([bytes], {type}), filename);
  const result = await fetch(`${base}/v0/file/u/`, {method: 'POST', headers: {
    'X-Tinode-APIKey': config.TINODE_API_KEY,
    'Authorization': `token ${client.token}`,
  }, body: form});
  const packet = await result.json();
  assert.ok(result.ok, `Upload HTTP ${result.status}: ${packet.ctrl?.text}`);
  assert.ok(packet.ctrl.code < 400, 'Upload failed');
  return packet.ctrl.params.url;
}

try {
  const alice = await (await new Client().open()).register('alice');
  const bob = await (await new Client().open()).register('bob');
  console.log('PASS: two basic registrations and automatic token login');

  const basic = await new Client().open();
  const login = await basic.request('login', {scheme: 'basic',
    secret: Buffer.from(`${alice.username}:${alice.password}`).toString('base64')});
  assert.equal(login.params.user, alice.uid);
  basic.close();
  await alice.request('set', {topic: 'me', desc: {public: {fn: 'Smoke Alice updated'}}});
  await alice.request('sub', {topic: 'fnd'});
  await alice.request('set', {topic: 'fnd', desc: {public: `basic:${bob.username}`}});
  const found = await alice.request('get', {topic: 'fnd', what: 'sub'}, 'meta');
  assert.ok(found.sub?.some(item => (item.topic ?? item.user) === bob.uid), 'Username discovery failed');
  console.log('PASS: basic login, profile update, and standard username discovery');

  await alice.request('sub', {topic: bob.uid, get: {what: 'desc sub data'}});
  await bob.request('sub', {topic: alice.uid, get: {what: 'desc sub data'}});
  const received = bob.wait(packet => packet.data?.content === 'collapse smoke message');
  const published = await alice.request('pub', {topic: bob.uid, content: 'collapse smoke message'});
  const message = (await received).data;
  assert.equal(message.seq, published.params.seq);
  const recv = alice.wait(packet => packet.info?.what === 'recv' && packet.info.seq === message.seq);
  bob.note(alice.uid, 'recv', message.seq);
  await recv;
  const read = alice.wait(packet => packet.info?.what === 'read' && packet.info.seq === message.seq);
  bob.note(alice.uid, 'read', message.seq);
  await read;
  const keystroke = alice.wait(packet => packet.info?.what === 'kp');
  bob.note(alice.uid, 'kp');
  await keystroke;
  const subscriptions = await alice.request('get', {topic: bob.uid, what: 'sub'}, 'meta');
  assert.ok(subscriptions.sub.some(item => item.user === bob.uid && item.read >= message.seq && item.recv >= message.seq));
  console.log('PASS: P2P publish, server sequence, live delivery/read/keystroke, persisted receipts');

  bob.close();
  const offline = await alice.request('pub', {topic: bob.uid, content: 'offline smoke message'});
  const resumed = await new Client().open();
  resumed.uid = bob.uid;
  resumed.token = bob.token;
  const tokenLogin = await resumed.request('login', {scheme: 'token', secret: bob.token});
  assert.equal(tokenLogin.params.user, bob.uid);
  await resumed.request('sub', {topic: 'me'});
  const chats = await resumed.request('get', {topic: 'me', what: 'sub'}, 'meta');
  assert.ok(chats.sub.some(item => item.topic === alice.uid && item.seq === offline.params.seq && item.read < item.seq));
  const history = resumed.wait(packet => packet.data?.seq === offline.params.seq && packet.data.content === 'offline smoke message');
  await resumed.request('sub', {topic: alice.uid, get: {what: 'desc data', data: {limit: 24}}});
  await history;
  console.log('PASS: token reconnect, unread counters, and persisted offline history');

  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1cAAAAASUVORK5CYII=', 'base64');
  const audio = Buffer.alloc(2044);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(2000, 40);
  for (const [filename, mime, bytes, type] of [['smoke.png', 'image/png', image, 'IM'], ['smoke.wav', 'audio/wav', audio, 'AU']]) {
    const ref = await upload(alice, filename, mime, bytes);
    const media = resumed.wait(packet => packet.data?.content?.ent?.[0]?.data?.ref === ref);
    await alice.request('pub', {topic: bob.uid, head: {mime: 'text/x-drafty', attachments: [ref]},
      content: {txt: ' ', fmt: [{at: 0, len: 1, key: 0}], ent: [{tp: type, data: {mime, name: filename, ref, size: bytes.length}}]}},
      'ctrl', {attachments: [ref]});
    await media;
    const downloaded = await fetch(new URL(ref, base), {headers: {
      'X-Tinode-APIKey': config.TINODE_API_KEY, 'Authorization': `token ${bob.token}`,
    }});
    assert.ok(downloaded.ok);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
    const anonymous = await fetch(new URL(ref, base), {headers: {'X-Tinode-APIKey': config.TINODE_API_KEY}});
    assert.equal(anonymous.status, 401, 'Media download must require user authentication');
  }
  console.log('PASS: authenticated image/audio upload, Drafty refs, and peer downloads');

  await alice.request('del', {topic: bob.uid, what: 'msg', hard: false, delseq: [{low: message.seq}]});
  await alice.request('del', {topic: bob.uid, what: 'msg', hard: true, delseq: [{low: offline.params.seq}]});
  const deleted = await resumed.request('get', {topic: alice.uid, what: 'del'}, 'meta');
  assert.ok(deleted.del?.delseq?.some(range => range.low <= offline.params.seq && (!range.hi || range.hi > offline.params.seq)));
  console.log('PASS: local deletion and P2P deletion for both users');

  const groupTag = `collapsesmoke${randomBytes(5).toString('hex')}`;
  const createdGroup = await alice.request('sub', {topic: 'new', set: {desc: {
    public: {fn: 'Collapse smoke group'}, defacs: {auth: 'JRWP', anon: 'N'}}, tags: [groupTag]}});
  group = createdGroup.topic;
  assert.ok(group.startsWith('grp'));
  await alice.request('set', {topic: 'fnd', desc: {public: groupTag}});
  const foundGroups = await alice.request('get', {topic: 'fnd', what: 'sub'}, 'meta');
  assert.ok(foundGroups.sub?.some(item => item.topic === group));
  await alice.request('set', {topic: group, sub: {user: bob.uid, mode: 'JRWP'}});
  await resumed.request('sub', {topic: group, get: {what: 'desc sub data'}});
  const groupReceived = alice.wait(packet => packet.data?.topic === group && packet.data.content === 'group smoke message');
  await resumed.request('pub', {topic: group, content: 'group smoke message'});
  await groupReceived;
  await alice.request('del', {topic: group, what: 'topic'});
  group = undefined;
  console.log('PASS: group creation, discovery, invitation, membership, messaging, and owner deletion');
  console.log('All local Tinode integration checks passed.');
} finally {
  let cleanupFailed = false;
  for (const account of created) {
    try {
      const cleanup = await new Client().open();
      await cleanup.request('login', {scheme: 'token', secret: account.token});
      if (group && account === created[0]) await cleanup.request('del', {topic: group, what: 'topic'});
      await cleanup.request('del', {what: 'user', user: account.uid, hard: true});
    } catch {
      cleanupFailed = true;
      console.error('Could not clean up one temporary smoke-test account; no existing user data was changed.');
    }
  }
  for (const client of sockets) client.close();
  if (cleanupFailed) process.exitCode = 1;
}
