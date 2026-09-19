#!/bin/sh
set -e

# ---------------------------------------------------------------------------
# Applies the schema to the SQLite file on the mounted volume before the server
# starts. `db push` is idempotent, so this is safe on every boot: it creates the
# database on first run and is a no-op afterwards.
# ---------------------------------------------------------------------------

DB_PATH="${DATABASE_URL#file:}"
DB_DIR="$(dirname "$DB_PATH")"

if [ ! -d "$DB_DIR" ]; then
  echo "[automail] creating data directory $DB_DIR"
  mkdir -p "$DB_DIR"
fi

echo "[automail] ensuring database schema at $DB_PATH"
if ! node ./scripts/apply-schema.mjs; then
  echo "[automail] WARNING: schema setup failed. The app will start with history disabled."
fi

echo "[automail] starting server on port ${PORT:-3000}"
exec "$@"
