// A checksum-pinned upstream source tree plus this repository's small overlay.
// Generated source/binaries stay ignored. Never operates on a running process/DB.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceHash = '63778c43ce2fc9c117e28aa25f69288f57fbc8012d0066c82962791eb6d940f0';
const upstream = path.join(root, '.local/upstream');
const archive = path.join(upstream, 'tinode-v0.25.3-source.tar.gz');
const source = path.join(upstream, 'chat-0.25.3');
const output = path.join(root, '.local/server');
mkdirSync(upstream, {recursive: true});
mkdirSync(output, {recursive: true});
if (!existsSync(archive)) execFileSync('curl', ['-fL', '--retry', '2', '-o', archive,
  'https://codeload.github.com/tinode/chat/tar.gz/refs/tags/v0.25.3'], {stdio: 'inherit'});
if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== sourceHash) {
  throw new Error('Pinned upstream source checksum mismatch');
}
// Re-extract upstream-owned files before mechanical, asserted patching.
execFileSync('tar', ['-xzf', archive, '-C', upstream]);
function replace(file, before, after) {
  const target = path.join(source, file);
  const original = readFileSync(target, 'utf8');
  if (original.split(before).length !== 2) throw new Error(`Upstream patch context changed: ${file}`);
  writeFileSync(target, original.replace(before, after));
}
replace('server/datamodel.go', 'constMsgMetaAux\n)', 'constMsgMetaAux\n\tconstMsgMetaMedia\n)');
replace('server/datamodel.go', '\t\tcase "data":', '\t\tcase "media":\n\t\t\tbits |= constMsgMetaMedia\n\t\tcase "data":');
replace('server/datamodel.go', 'type MsgGetQuery struct {\n\tWhat string `json:"what"`\n',
  'type MsgGetQuery struct {\n\tWhat string `json:"what"`\n\tMedia *types.MediaQuery `json:"media,omitempty"`\n');
replace('server/datamodel.go', 'type MsgServerMeta struct {',
  'type MsgServerMeta struct {\n\tMedia *types.MediaPage `json:"media,omitempty"`');
replace('server/topic.go', 'func (t *Topic) handleMetaGet(msg *ClientComMessage, asUid types.Uid, asChan bool, authLevel auth.Level) {',
  `func (t *Topic) handleMetaGet(msg *ClientComMessage, asUid types.Uid, asChan bool, authLevel auth.Level) {
 if msg.MetaWhat&constMsgMetaMedia != 0 {
   if msg.Get.What != "media" { msg.sess.queueOut(ErrMalformedReply(msg, types.TimeNow())); return }
   t.replyGetMedia(msg, asUid, asChan); return
 }`);
replace('server/db/postgres/adapter.go', '\n\treturn nil\n}\n\n// Version returns adapter version.',
  '\n\treturn a.ensureMediaSchema()\n}\n\n// Version returns adapter version.');
cpSync(path.join(root, 'overlay'), source, {recursive: true});
function goFiles(dir) {
  return readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? goFiles(file) : file.endsWith('.go') ? [file] : [];
  });
}
const generatedGo = goFiles(path.join(root, 'overlay')).map(file => path.join(source, path.relative(path.join(root, 'overlay'), file)));
execFileSync('gofmt', ['-w', ...generatedGo, path.join(source, 'server/datamodel.go'), path.join(source, 'server/topic.go'), path.join(source, 'server/db/postgres/adapter.go')]);
if (!process.argv.includes('--prepare-only')) {
  execFileSync('go', ['build', '-p=2', '-mod=readonly', '-trimpath', '-tags=postgres', '-ldflags=-X main.buildstamp=0.25.3-collapse-media1',
    '-o', path.join(output, 'tinode'), './server'], {cwd: source, stdio: 'inherit'});
  console.log('Built Tinode 0.25.3 + Collapse media1; no process or database changed.');
}
export {source};
