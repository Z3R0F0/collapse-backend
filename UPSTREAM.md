# Upstream provenance

- Server: [tinode/chat v0.25.3](https://github.com/tinode/chat/releases/tag/v0.25.3).
- Source: https://github.com/tinode/chat/tree/v0.25.3
- Corresponding source archive: https://github.com/tinode/chat/archive/refs/tags/v0.25.3.tar.gz
- Installation: https://github.com/tinode/chat/blob/v0.25.3/INSTALL.md
- Docker: https://github.com/tinode/chat/blob/v0.25.3/docker/README.md
- Protocol: https://github.com/tinode/chat/blob/v0.25.3/docs/API.md
- Configuration: https://github.com/tinode/chat/blob/v0.25.3/server/tinode.conf
- License: https://github.com/tinode/chat/blob/v0.25.3/LICENSE (GPL-3.0)

Version and artifacts checked 2026-09-21. `scripts/setup.mjs` pins SHA-256 digests
published with the official GitHub release for all four supported native
artifacts. It extracts only `tinode`, `init-db`, and `keygen`; sample data and
the upstream web client are not deployed. `init-db` and `keygen` remain upstream
executables. Tinode itself is now rebuilt from checksum-pinned v0.25.3 source
with this repository's small `overlay/` plus asserted mechanical insertions in
`scripts/build-server.mjs`. The extension adds `get.media`, using existing topic
authentication/access checks and additive PostgreSQL category indexes; it does
not alter ordinary history, message storage, receipts or auth.

Source archive SHA-256:
`63778c43ce2fc9c117e28aa25f69288f57fbc8012d0066c82962791eb6d940f0`.
Generated source remains in ignored `.local/upstream/chat-0.25.3`; overlay source,
SQL and tests are distributed here under GPL-3.0 with the reproduction script.
The binary goes to `.local/server/tinode`. The build uses upstream go.mod/go.sum
without upgrades; Go 1.26+ is required (tested SDK 1.26.5).

`Dockerfile` pins the official Tinode runtime, Go 1.26.5 and Node 24 build images
by registry digest, while `compose.yaml` pins PostgreSQL 17-bookworm. Existing
volume names are unchanged. No secrets or generated `.local/` files enter the
Docker build context.

The optional browser runner uses unmodified
[Caddy v2.11.4](https://github.com/caddyserver/caddy/releases/tag/v2.11.4), licensed
under [Apache-2.0](https://github.com/caddyserver/caddy/blob/v2.11.4/LICENSE).
`scripts/web.mjs` pins the four supported archive SHA-512 values published in
[the official checksum file](https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_checksums.txt)
and retains the upstream license beside its ignored local binary. No Caddy
source or binary is modified. The Caddyfile uses standard
[mutually exclusive handlers](https://caddyserver.com/docs/caddyfile/directives/handle)
and [reverse proxying](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
Same-origin serving avoids the pinned Tinode filesystem handler's
[GET/POST CORS omission](https://github.com/tinode/chat/blob/v0.25.3/server/media/fs/filesys.go#L69),
without adding a server fork or weakening authentication.

The previous read-only backend at commit `5dcbb16` was inspected only to identify
the custom identity/scenario boundary. None of its source, database contents,
configuration, API keys, signing keys, Firebase files, bots or scenario data were
copied. This repository does not preserve that fork's Git history or remote.

When updating: review upstream compatibility and security notes, replace the
release version, native checksums and Compose image digests together, then run
the protocol test and the Flutter client's real-server test before adopting it.
