# Collapse backend setup

A small, standalone deployment repository for **Tinode v0.25.3 plus a narrow
indexed-media extension** and PostgreSQL. Source is pinned upstream with a
reviewable overlay, not vendored here; there is no custom authentication service,
scenario engine, bot, demo account, or product analytics.

Clone the backend and [Flutter client](https://github.com/Z3R0F0/collapse-client)
as sibling directories for the commands below:

```sh
git clone https://github.com/Z3R0F0/collapse-backend.git
git clone https://github.com/Z3R0F0/collapse-client.git
cd collapse-backend
```

## Run locally

Requirements: Node.js 24+, `curl`, `tar`, and either Docker Compose v2 or Go 1.26+
and local
PostgreSQL 13+ (`initdb` and `pg_ctl` on PATH; tested with PostgreSQL 14.22).
macOS/Linux arm64 and amd64 are supported by the setup script.

```sh
node scripts/setup.mjs
```

Setup downloads checksum-verified official release tools into ignored `.local/`,
uses upstream `keygen` to create an ordinary, non-root application API key, and
generates fresh random database, token-signing and UID-encryption keys. Re-running
setup preserves these keys. Native setup also builds pinned source plus `overlay/`
with Go (`-mod=readonly`, no upgrades). Use `node scripts/setup.mjs --docker` to
generate configuration without a host Go build; Docker builds in pinned images.
Do not delete `.local/secrets.json` while retaining
the database: changing the UID key invalidates existing identifiers.

Choose one server runner:

```sh
# Docker: persistent, isolated volumes; database port is not published.
docker compose up -d --build

# OR native: its own PostgreSQL cluster at .local/postgres, port 55432.
# Foreground process; Ctrl-C also stops only this local database.
sh scripts/native.sh
```

Do not run both at once: both use Tinode port 6060. Existing databases and services
are never used by the native runner. Native data remains after shutdown. Docker
data survives `docker compose down`; do not add `--volumes` unless intentionally
deleting all Docker chat data and uploads. Native and Docker data stores are
separate, even though their generated keys match.

Both runners set `TZ=UTC` for Tinode's processes only. The pinned server writes
UTC into timezone-less PostgreSQL timestamps, while its file-GC cutoff uses Go's
local clock; [pgx discards the timezone without converting the wall clock](https://github.com/jackc/pgx/blob/v5.10.0/pgtype/timestamp.go).
On a UTC+3 host, fresh unlinked uploads could otherwise be collected on the next
GC tick. Restart the runner to apply this setting; no database timezone or stored
timestamps are changed, and normal garbage collection remains enabled.

The upstream Docker image is amd64-only. Compose explicitly requests amd64, so
Apple Silicon requires Docker Desktop's x86 emulation; the native runner uses the
actual arm64 release tools and a native source build. PostgreSQL, upstream runtime
and Docker build images are pinned by digest.

## Independent media atlas

The `get.what="media"` extension returns one correlated `meta.media` page, not
ordinary message events. It reuses Tinode's attached-topic reader ACL and topic
actor, supports P2P/group/self topics, and does not mark anything read. PostgreSQL
queries exclude hard-deleted messages and the requesting user's soft deletions.
Other database adapters and gRPC are not extended.

Three additive, versioned partial indexes cover visual (IM/VD), audio (AU) and
file (EX) entities. First start builds them over existing messages in one
transaction without resetting data or changing Tinode schema version 116.
Subsequent starts leave them unchanged. Back up database/uploads/keys together
before deploying. On a large production database, schedule the initial index
build separately with an appropriate database timeout: ordinary index creation
can temporarily block writes. Do not change the v1 predicate in place; changes
require a new version and new indexes.

Requests use `media:{kind,limit,before?,after?,around?,snapshot?}`, where each
cursor is the original `{seq,key}` (Drafty entity index), limit defaults to 24
and is capped at 40. Before/after are exclusive and mutually exclusive with
around. Results are newest first, with `items,hasOlder,hasNewer,snapshot,delId`
and `anchorFound` for around requests. Keep the snapshot when paging; refresh
without one for new uploads. Invalid queries receive correlated errors.

Items contain `{seq,key,type,data,from,ts,inline?,clientId?}`. Binary `val` and
arbitrary message/header data are excluded; previews are at most 4 KiB and other
metadata strings are bounded. An uploaded IM's valid base64 thumbnail in `val`
may instead become `preview` up to 16 KiB; inline-only originals are not copied.
`clientId` is returned only for messages whose
stored sender is the requester. Quoted/hidden-only media and nested hidden
fragments are not indexed. Inline bytes may be loaded with a separate single-
message request when a viewer needs them. The atlas does not change the stock
file-download authorization limitation documented below.

For bounded index maintenance, documents with more than 256 entities or 1024
formats remain ordinary messages but are excluded from the atlas. The predicate
uses two format passes with built-in range-overlap checks, not nested scans of
every entity and format. [MEDIA_API.md](MEDIA_API.md) specifies the wire examples,
snapshot/deletion rules and behavior with an unextended stock server.

Rebuild without touching running services or keys:

```sh
node scripts/build-server.mjs
# Isolated synthetic PostgreSQL/server: never connects to live DB/ports.
node scripts/test-media.mjs
```

## Connect the Flutter repository

```sh
cd ../collapse-client
fvm flutter pub get
fvm flutter run --dart-define-from-file=../collapse-backend/.local/client.json
```

The generated client file contains only `TINODE_HOST` (`127.0.0.1:6060`),
`TINODE_TLS` (`false`), and the non-root `TINODE_API_KEY`. The API key identifies
the application; it is not a user login or a server signing secret.
The companion client pins Flutter 3.41.3 in `.fvmrc`; use FVM or that SDK's
explicit executable instead of an older system Flutter.

### Browser: use one origin

Tinode v0.25.3's filesystem handler sends CORS headers for preflight requests,
but omits them on actual media responses. A separate static server pointed
directly at port 6060 therefore cannot reliably upload/download browser media.
Use the supplied standard Caddy proxy, without modifying Tinode:

```sh
# In the companion client, build with the existing canonical server config:
cd ../collapse-client
fvm flutter build web --profile --no-web-resources-cdn --dart-define-from-file=../collapse-backend/.local/client.json
cd ../collapse-backend

# Keep the ordinary Tinode runner running on 6060.
node scripts/web.mjs --check
node scripts/web.mjs

# Optional isolated staging port and build directory:
COLLAPSE_WEB_PORT=8086 COLLAPSE_WEB_DIR=/absolute/path/to/flutter/build/web node scripts/web.mjs
```

Open `http://127.0.0.1:8085` (or the selected staging port). The client must use
that same origin for HTTP media and WebSocket transport. The companion web
client selects the page's origin automatically; no additional Dart define is
required. Its generated config still identifies the canonical Tinode server
for saved sessions/cache, avoiding an unnecessary account/cache change when
the frontend transport changes. `/v0/*` is proxied unchanged to `127.0.0.1:6060`, including WebSockets,
authorization, uploads, and range downloads. Other requests serve only the
selected Flutter build directory, which defaults to `../collapse-client/build/web`.
Client-owned `/chats`, `/contacts`, `/profile` and `/login` paths (including chat
and contact descendants) rewrite to the Flutter entry point for direct links and
browser reloads. API and static asset paths keep their normal handling. Restart
the web runner after changing this configuration; Tinode need not restart.
Only ports 8085 and 8086 on IPv4 loopback are accepted. An occupied port causes
startup to fail; the runner never stops another process or touches the database.

The helper downloads unmodified Caddy v2.11.4 into ignored `.local/`, verifies
the pinned official SHA-512 checksum before extraction, and validates its
configuration. There is no global install, admin API, TLS certificate setup,
access log, or retained runtime request log. `--check` does not open a listener.
The static responses include COOP/COEP for Drift's web worker and disable caching
for local rebuilds. Ctrl-C stops only this proxy, not Tinode/PostgreSQL.
The same native proxy can front either the native or Compose Tinode runner.

| Operation | Standard Tinode contract |
| --- | --- |
| WebSocket | `ws://127.0.0.1:6060/v0/channels?apikey=<app-key>` |
| Handshake | `{hi: {id, ver: "0.25.3"}}` |
| Registration | `{acc: {user: "new", scheme: "basic", secret: base64(username + ":" + password), login: true}}` |
| Login/reconnect | `{login: {scheme: "basic" or "token", secret: ...}}` |
| Profiles/chats | Subscribe to `me`; use ordinary `get`/`set` metadata |
| Username search | Attach `fnd`, set `desc.public` to `basic:username`, then `get what="sub"`; results use `topic` for the user ID |
| Chat history | Attach the P2P/group topic before requesting its data |
| Receipts | Standard `note what="recv"` and `note what="read"` with server sequence |
| Upload | `POST http://127.0.0.1:6060/v0/file/u/` (trailing slash required), multipart `file` |
| Download | Use the returned `/v0/file/s/...` URL on the same server |
| Media auth | `X-Tinode-APIKey: <app-key>` and `Authorization: token <user-token>` |

Usernames are 4-32 characters and follow upstream basic-auth syntax; passwords
must be at least 8 characters. Tokens last two weeks. Registration does not
require an email, phone, OTP, Google or Apple identity. Password recovery is not
available without configuring new verified email credentials.

Native clients on this Mac and iOS Simulator use `127.0.0.1`. Android Emulator
normally reaches the host through `10.0.2.2`; change only `TINODE_HOST` in a copy
of the client config for that emulator. A physical device needs an intentionally
configured LAN binding and the Mac's LAN address. The supplied defaults expose
Tinode only on loopback. Do not point this development configuration at the
internet or reuse any credentials from another application.

## Verification

While the server is running:

```sh
node scripts/smoke.mjs
```

The test is restricted to the local endpoint. It creates unique temporary users,
checks basic registration/login, profile changes, username discovery, P2P
messages, delivery/read/keystroke notifications, persisted receipts, token
reconnect, unread counters and offline history, image/audio upload and peer
download, Drafty refs, soft/hard deletion, and group creation/invitation/messages.
It deletes only its own temporary users and group afterward. It does not operate
on existing accounts. Unused media is reclaimed by upstream garbage collection.

Verified here on 2026-09-21: the complete test passes against the official
macOS arm64 Tinode release and an isolated PostgreSQL 14.22 cluster. Docker is
not installed in this workspace, so the Compose runtime was not executed here.

## Deployment boundaries

This is a local development baseline, not a production deployment:

- HTTP/WS is intentionally unencrypted on loopback. Use TLS/HTTPS/WSS before any
  non-local deployment, and authenticate the database over its private network.
- The media size limit is 16 MiB; server-side messages are limited to 128 KiB.
  Include uploaded refs in top-level `extra.attachments` for publishes and
  avatar metadata updates; `pub.head.attachments` alone does not retain files.
- The configured media CORS wildcard applies to preflight, but the pinned
  upstream filesystem handler omits CORS on actual responses. Use the same-origin
  web deployment above; changing the allowed-origin list alone does not fix it.
  For production, deploy HTTPS static assets and `/v0/*` behind one TLS origin;
  the supplied Caddyfile is intentionally loopback HTTP only. Never log raw
  token-bearing URLs.
- Upstream Tinode prints raw protocol packets, including authentication secrets.
  The supplied runners suppress server stdout/stderr entirely; they do not write
  packet logs. Use the protocol smoke test for readiness. Exit status and
  PostgreSQL diagnostics remain available. If you explicitly enable server logs
  for debugging, treat them as credentials and private message data.
- Back up PostgreSQL, uploads, and server keys together. Schema upgrades must
  follow the pinned upstream release notes, including explicit `init-db
  --upgrade` after a verified backup. Setup never resets or upgrades an existing
  database automatically.
- Upstream file downloads require authentication but do not enforce per-topic
  authorization: treat opaque attachment URLs as shareable among authenticated
  users, not as per-chat access-control boundaries.
- Push is disabled until a new collapse Firebase project/service account and
  matching iOS/Android app configuration are supplied. Configure Tinode's stock
  `push` FCM handler and mount its credentials read-only; never copy another app's
  Firebase files or signing identities. Background/terminated-app delivery is
  not claimed without that integration. Foreground messages use WebSockets.
- Calls are disabled until a separately configured TURN/STUN service is ready.
  This baseline does not include a new call implementation.

## Upstream and licensing

Tinode is GPL-3.0; this repository's deployment tooling is also GPL-3.0.
See `LICENSE` and `UPSTREAM.md` for source, immutable pins, and provenance.
PostgreSQL has its own permissive PostgreSQL license. No remote repository is
created or pushed by setup.
