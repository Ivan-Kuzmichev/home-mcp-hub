#!/bin/sh
# Starts as root only to fix ownership of the data volume, then drops to the app user.
# Bind mounts on a NAS are usually created by root, and SQLite needs to write there.
# PUID/PGID (like linuxserver images) make the files belong to your NAS account instead.
set -e

DATA_DIR="$(dirname "${DATABASE_PATH:-/data/hub.db}")"
RUN_UID="${PUID:-1001}"
RUN_GID="${PGID:-1001}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u:%g "$DATA_DIR")" != "$RUN_UID:$RUN_GID" ]; then
    echo "Setting owner of $DATA_DIR to $RUN_UID:$RUN_GID"
    chown -R "$RUN_UID:$RUN_GID" "$DATA_DIR"
  fi
  exec su-exec "$RUN_UID:$RUN_GID" "$@"
fi

exec "$@"
