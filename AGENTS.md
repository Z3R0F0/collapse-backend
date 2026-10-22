# Agent guide

Applies to this repository. Read [ARCHITECTURE.md](ARCHITECTURE.md),
[SETUP.md](SETUP.md), [UPSTREAM.md](UPSTREAM.md), and
[MEDIA_API.md](MEDIA_API.md) before changing behavior. The sibling
`../collapse-client` is the paired Flutter application and has its own guide.

## First steps

1. Confirm `pwd`, then inspect `git status --short --untracked-files=all`.
   A handoff archive may not contain `.git`; do not assume missing history means
   files are disposable or changes are authorized for publication.
2. Locate the relevant files with `rg --files`/`rg`; inspect the full affected
   request path and paired client contract before editing.
3. Preserve unrelated changes. Use patch-based edits; no destructive resets,
   database deletion, secret rotation, commits or pushes without authorization.

## Ownership and invariants

- Keep this a pinned Tinode build plus small overlay, not a new messaging/auth
  service. No legacy product/scenario/bot dependencies or old product credentials.
- Source changes belong in `overlay/` and the asserted insertion points in
  `scripts/build-server.mjs`. Do not hand-edit `.local/upstream/` as a fix;
  those files are generated and rebuilt. Do not upgrade pins incidentally.
- Auth, topic subscriptions, ordinary message history/receipts and uploaded
  file retention remain upstream contracts. Preserve `extra.attachments`.
- `get.media` must run inside the authenticated attached-topic actor, enforce
  effective Read permission, and return correlated `meta.media` only. Never
  emit ordinary `data`, receipt changes or history-coverage changes for it.
- Preserve `(seq, original Drafty entity index)` cursors, page ordering,
  snapshot ceiling, current hard/soft deletion filtering, exact-anchor status,
  bounded metadata and hidden/quote exclusion. Update client and tests together
  for any wire-contract change. See `MEDIA_API.md` before adjusting limits.
- Media indexes are additive and versioned. Never change an existing immutable
  indexed predicate in place; provide a new migration/index version. Never
  reset stock schema/version or rebuild production indexes casually.
- Keep native/PostgreSQL/Compose data separate and loopback bindings intact.
  Preserve process `TZ=UTC`, same-origin web proxying and direct-link fallback.
  Do not start/stop existing services or bind another machine's ports blindly.

## Configuration and secrets

`config/tinode.template.json` is secret-free. `scripts/setup.mjs` generates
`.local/` and `.env`; these contain signing/UID/database secrets and must stay
ignored. Existing keys must remain paired with their database/uploads. Never
print tokens, full auth headers, protocol payloads or generated configuration
to diagnostic output. Do not enable stock packet logging without explicit need
and a safe handling plan. Do not package `.local/`, `.env`, logs or runtime data.

Setup is macOS/Linux only (Windows uses WSL2); even `--docker` executes native
keygen. Network downloads are checksum-pinned. Native build requires Go 1.26+;
do not silently change Go modules or run broad dependency upgrades.

## Verification commands

Run from this repository. Heavy builds/tests should run sequentially on a
shared workstation. First-time setup is an explicit fresh-environment action,
not a prerequisite to repeat against an existing running service.

```sh
# Read-only syntax checks for scripts and shell runner.
node --check scripts/setup.mjs
node --check scripts/build-server.mjs
node --check scripts/smoke.mjs
node --check scripts/test-media.mjs
node --check scripts/web.mjs
sh -n scripts/native.sh

# Rebuild pinned source plus overlay; does not replace a running process.
node scripts/build-server.mjs

# Unit tests in the generated Go module, after the build/preparation above.
(cd .local/upstream/chat-0.25.3 && go test -p=2 -mod=readonly -tags=postgres ./server/db/postgres -run TestCollapseMedia -count=1)

# Isolated synthetic PostgreSQL/Tinode fixture, after setup/build.
# Requires initdb, pg_ctl and psql; never uses live ports or database.
node scripts/test-media.mjs

# Requires the local development Tinode on 6060 and .local/client.json.
# Creates/deletes only its synthetic accounts/group; no existing account edits.
node scripts/smoke.mjs

# Validates proxy config; requires built sibling Flutter web assets.
node scripts/web.mjs --check
```

For client-facing changes, also run relevant Flutter/package tests and the
real-server tests described by the client's `AGENTS.md`/`VERIFICATION.md`.
Treat test execution that creates users as a write, even if cleanup follows;
never aim local smoke/fixture tools at a production environment. A successful
compile is not proof of authorization, cursor or deletion behavior.

## Handoff

Report exact files changed, behavior and client compatibility, commands actually
run, commands not run and why, and any deployment/migration caveat. Distinguish
historical verification from checks performed now. Never claim Docker/native
device validation from a different runtime. Keep `MEDIA_API.md` and architecture
docs aligned with actual source. Do not include private runtime state in a
source handoff; migration of existing data requires a separate authorized backup.
