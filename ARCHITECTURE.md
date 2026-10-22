# Backend architecture

Current handoff: 2026-09-25. This repository is the backend of the sibling
`collapse-client` repository. It is a small deployment/build layer around
Tinode v0.25.3, with one narrowly scoped media-metadata extension. There are no
bots, scenarios, custom identity services or copied production accounts.

## Boundaries and source ownership

| Location | Responsibility |
| --- | --- |
| `config/tinode.template.json` | Secret-free local Tinode defaults. |
| `scripts/setup.mjs` | Verified upstream tools, fresh keys, local configuration. |
| `scripts/build-server.mjs` | Checksum-pinned source download, asserted integration edits, overlay, Go build. |
| `overlay/server/topic_media.go` | Media request validation and existing topic-actor authorization. |
| `overlay/server/store/` | Media types and optional adapter capability; no upstream adapter-interface replacement. |
| `overlay/server/db/postgres/` | Media query, bounded metadata projection, versioned functions/indexes and tests. |
| `scripts/native.sh`, `compose.yaml`, `Dockerfile` | Alternative isolated local server/database runners. |
| `config/Caddyfile`, `scripts/web.mjs` | Same-origin Flutter assets and Tinode reverse proxy. |
| `scripts/smoke.mjs`, `scripts/test-media.mjs` | Ordinary protocol and isolated media acceptance checks. |

Upstream auth, topics, history, subscriptions, receipts, attachments and normal
message persistence stay in Tinode. Do not modify generated upstream files as
the source of truth: a rebuild re-extracts upstream-owned files. Put maintained
additions in `overlay/` and small asserted integration edits in the build script.
See [UPSTREAM.md](UPSTREAM.md) for immutable pins and GPL-3.0 provenance.

## Runtime and client contract

The client authenticates with Tinode basic/token auth, subscribes to `me` and
chat topics, and sends ordinary Drafty messages. Upload references must be
included in top-level `extra.attachments`; message headers alone do not retain
uploaded files. Tinode owns server sequence numbers and read/receive receipts.

For web, Caddy serves the Flutter build and proxies `/v0/*` to Tinode. This
avoids stock filesystem-response CORS limitations while preserving API-key and
user-token authorization. Frontend routes fall back to `index.html`; API/static
requests retain their normal handling. The client uses the page origin for web
transport but the generated canonical Tinode configuration for session/cache
identity. Do not replace that configuration with the proxy port.

Local defaults are loopback only: Tinode `6060`, native PostgreSQL `55432`, web
`8085` (optional staging `8086`). Compose does not publish PostgreSQL. The web
runner is optional and is not a separate backend service. Native and Compose
databases/uploads are separate stores; run only one Tinode runner at a time.

## Independent media pagination

The client atlas is intentionally independent of its chat-history sliding
window. `get.what="media"` is handled inside the existing attached-topic actor:

1. Validate effective Read permission and category/cursor/limit.
2. Query existing PostgreSQL messages and deletion records.
3. Return one correlated `meta.media`, not ordinary `data` packets.

Consequently, browsing media does not mark chat messages read, emit receive
receipts, extend chat-history coverage, or load the whole chat into the client.
There is no new endpoint, auth system, media service or duplicate message table.

Cursor identity is `(seq, key)`, where `key` is the original Drafty entity index.
Wire order is descending in both components. `before`/`after` are exclusive;
`around` is an inclusive anchor with an explicit `anchorFound`. The sequence
`snapshot` is an upper boundary, not a historical deletion snapshot: current
hard deletions and the requesting user's soft deletions always apply. One
repeatable-read transaction computes rows and page edges. Read access loss is
handled through the ordinary topic actor. Categories are IM/VD, AU and EX.

Metadata is bounded and allowlisted. Original `val` bytes and arbitrary headers
are not returned; only a bounded referenced-image thumbnail may become
`preview`. Inline-only originals can be fetched by the client with one exact
message request when opened. Hidden/quote-only entities are excluded. The
client must retain original entity keys and treat local cache as potentially
partial, not as authoritative server history.

See [MEDIA_API.md](MEDIA_API.md) for exact envelopes, bounds and fallback rules.
The extension supports PostgreSQL and JSON transport only; it does not add
gRPC support or other database adapters. An unextended server must fail visibly
or use an explicitly partial local atlas, not trigger a full-history scan.

## Persistence and upgrades

Tinode's standard PostgreSQL tables remain authoritative. Three partial indexes
cover media categories over existing message content. Versioned immutable SQL
functions define index predicates. First patched startup installs them together
in an advisory-lock-protected transaction; it neither resets messages nor
changes stock Tinode schema version 116.

Never alter a deployed v1 predicate in place: introduce a new function/index
version and a migration. Initial ordinary index creation may block writes and
must be scheduled with a suitable timeout for large databases. Back up database,
uploads and keys together before an existing deployment is upgraded.

Both runners set process `TZ=UTC` to keep stock timezone-less timestamps and
file-GC cutoffs consistent. Preserve this even on hosts in another timezone.
Preserve `secrets.json` with an existing database: changing UID encryption keys
breaks identifiers, and changing token keys invalidates sessions.

## Clean-machine handoff

The source ZIP is not a live-service backup. `.local/`, `.env`, databases,
uploads, sessions, signing credentials, downloaded tools and build output must
not be transferred. Setup creates a new empty environment and new keys on the
destination. Existing users/messages are not migrated. Relative sibling layout
is required for the default Flutter/web commands.

Use Node.js 24+, `curl`, `tar`, and either Go 1.26+ with PostgreSQL 13+ tools or
Docker Compose v2. Native helpers support macOS/Linux arm64/x64; on Windows use
WSL2/Linux, including for `setup.mjs --docker` (setup executes a native keygen).
First setup/build requires internet for pinned upstream artifacts, Go modules
and container images. Use Flutter 3.41.3 from the client `.fvmrc`.

Follow [SETUP.md](SETUP.md) for exact native, Docker and web commands. Never
copy host-generated absolute paths or old client configuration into a new setup.

## Deliberate limitations

- Development HTTP/WS and loopback defaults are not a production deployment.
- Push, calls and password recovery are not configured; fresh service
  credentials and platform integration are separate tasks.
- Stock attachment downloads require login but do not enforce per-topic ACL.
  Opaque attachment URLs are not a per-chat security boundary.
- Stock Tinode protocol logs can contain credentials and private content; the
  supplied runners suppress server output. Do not publish raw debug logs.
- The Docker path is defined but was not executed on the source workstation.
  Native and isolated acceptance results do not imply Docker validation.
