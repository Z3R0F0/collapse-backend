#!/bin/sh
# Start only this repository's isolated database and pinned Tinode media overlay.
set -eu
COLLAPSE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
COLLAPSE_LOCAL="$COLLAPSE_ROOT/.local"
COLLAPSE_PGDATA="$COLLAPSE_LOCAL/postgres"
for tool in initdb pg_ctl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing $tool: install PostgreSQL 13+ (14+ recommended)." >&2; exit 1; }
done
test -f "$COLLAPSE_LOCAL/tinode.native.json" || { echo "Run node scripts/setup.mjs first." >&2; exit 1; }
test -x "$COLLAPSE_LOCAL/server/tinode" || { echo "Build the media extension: node scripts/build-server.mjs" >&2; exit 1; }
if [ ! -f "$COLLAPSE_PGDATA/PG_VERSION" ]; then
  initdb -D "$COLLAPSE_PGDATA" -U postgres --auth-host=scram-sha-256 --auth-local=trust \
    --pwfile="$COLLAPSE_LOCAL/postgres-password" --encoding=UTF8 --locale=C
fi
if pg_ctl -D "$COLLAPSE_PGDATA" status >/dev/null 2>&1; then
  echo "This repository's database is already running; stop that native.sh session first." >&2
  exit 1
fi
pg_ctl -D "$COLLAPSE_PGDATA" -l "$COLLAPSE_LOCAL/postgres.log" \
  -o "-h 127.0.0.1 -p 55432 -k $COLLAPSE_LOCAL" -w start
COLLAPSE_SERVER_PID=
cleanup() {
  if [ -n "$COLLAPSE_SERVER_PID" ]; then
    kill "$COLLAPSE_SERVER_PID" 2>/dev/null || true
    wait "$COLLAPSE_SERVER_PID" 2>/dev/null || true
  fi
  pg_ctl -D "$COLLAPSE_PGDATA" -m fast -w stop
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Stock timestamps are UTC without a SQL timezone; GC's local cutoff must match.
TZ=UTC "$COLLAPSE_LOCAL/upstream/init-db" --config="$COLLAPSE_LOCAL/tinode.native.json" --data=
# Stock Tinode logs raw protocol packets (including login secrets). Never retain them.
echo "Starting Tinode at http://127.0.0.1:6060; verify with node scripts/smoke.mjs."
TZ=UTC "$COLLAPSE_LOCAL/server/tinode" --config="$COLLAPSE_LOCAL/tinode.native.json" --static_data=- >/dev/null 2>&1 &
COLLAPSE_SERVER_PID=$!
wait "$COLLAPSE_SERVER_PID"
