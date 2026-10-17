#!/bin/sh
# Nightly dump of the Vantage database (run from /etc/cron.d/vantage-backup).
# Keeps 14 days next to the host's other dumps in /opt/backups. Copy them off the server too.
set -eu
DIR=/opt/backups/vantage
mkdir -p "$DIR"
chmod 700 "$DIR"
STAMP=$(date +%F)
docker exec vantage-postgres-1 pg_dump -U vantage -Fc vantage > "$DIR/vantage-$STAMP.dump.partial"
mv "$DIR/vantage-$STAMP.dump.partial" "$DIR/vantage-$STAMP.dump"
find "$DIR" -name 'vantage-*.dump' -mtime +14 -delete
