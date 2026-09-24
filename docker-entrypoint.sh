#!/bin/sh
# Starts as root only to fix ownership of the data volume, then drops to the app user.
# Bind mounts on a NAS are usually created by root, and SQLite needs to write there.
# PUID/PGID (like linuxserver images) make the files belong to your NAS account instead.
set -e

DATA_DIR="$(dirname "${DATABASE_PATH:-/data/hub.db}")"
RUN_UID="${PUID:-1001}"
RUN_GID="${PGID:-1001}"

echo "home-mcp-hub ${HUB_VERSION:-?} (${HUB_GIT_SHA:-dev}) · data: $DATA_DIR · user $RUN_UID:$RUN_GID"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u:%g "$DATA_DIR")" != "$RUN_UID:$RUN_GID" ]; then
    echo "Setting owner of $DATA_DIR to $RUN_UID:$RUN_GID"
    chown -R "$RUN_UID:$RUN_GID" "$DATA_DIR" || echo "WARNING: chown failed"
  fi
  # The folder may come without the write bit (seen on Synology: dr-xr-xr-x): the owner needs rwx.
  if [ ! -w "$DATA_DIR" ] || [ "$(stat -c %A "$DATA_DIR" | cut -c3)" != "w" ]; then
    echo "Adding write permission for the owner of $DATA_DIR"
    chmod -R u+rwX "$DATA_DIR" || echo "WARNING: chmod failed"
  fi
  # chown is not enough where ACLs rule (Synology shares): check that writing really works.
  if ! su-exec "$RUN_UID:$RUN_GID" sh -c "touch '$DATA_DIR/.write-test' && rm -f '$DATA_DIR/.write-test'" 2>/dev/null; then
    echo "ERROR: user $RUN_UID:$RUN_GID cannot write to $DATA_DIR ($(stat -c '%U:%G %A' "$DATA_DIR"))."
    echo "On Synology the share ACL usually overrides the owner. Either:"
    echo "  - set PUID/PGID to your NAS user (run 'id' over SSH) and give that user write access to the folder, or"
    echo "  - reset the folder ACL: sudo synoacltool -del <folder> && sudo chmod 755 <folder>"
    exit 1
  fi
  exec su-exec "$RUN_UID:$RUN_GID" "$@"
fi

exec "$@"
