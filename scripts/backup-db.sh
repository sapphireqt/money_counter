#!/usr/bin/env bash
# Zero-downtime backup of the production Money Counter D1 (SQLite) database.
#
# The DB runs under wrangler/miniflare in WAL mode, so we do NOT copy the raw
# file. Instead we run SQLite's online-backup API inside the pod (Node 24's
# built-in node:sqlite) to produce a transactionally-consistent single-file
# snapshot, then pull it down with `kubectl cp` and gzip it.
#
# Usage:
#   scripts/backup-db.sh [OUTDIR]        # default OUTDIR=./backups
# Env overrides: KUBE_CONTEXT (lab), KUBE_NS (money-counter)
set -euo pipefail

CTX="${KUBE_CONTEXT:-lab}"
NS="${KUBE_NS:-money-counter}"
SELECTOR="app.kubernetes.io/name=money-counter"
OUTDIR="${1:-./backups}"
HELPER="$(cd "$(dirname "$0")" && pwd)/d1-in-pod.mjs"
SNAP="/tmp/mc-d1-snapshot.sqlite"

kc() { kubectl --context "$CTX" -n "$NS" "$@"; }

mkdir -p "$OUTDIR"

POD="$(kc get pod -l "$SELECTOR" --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}')"
[ -n "$POD" ] || { echo "ERROR: no running money-counter pod" >&2; exit 1; }
echo ">> pod: $POD"

echo ">> uploading helper"
kc cp "$HELPER" "$POD:/tmp/d1-in-pod.mjs"

echo ">> creating consistent snapshot inside pod (online backup, no downtime)"
kc exec "$POD" -- sh -c "rm -f '$SNAP'"
RESULT="$(kc exec "$POD" -- node /tmp/d1-in-pod.mjs backup "$SNAP" | tail -n1)"
echo "   $RESULT"
case "$RESULT" in
  *'"ok":true'*) : ;;
  *) echo "ERROR: snapshot integrity check failed — aborting" >&2; exit 1 ;;
esac

TS="$(date +%Y%m%d-%H%M%S)"
LOCAL="$OUTDIR/money-counter-d1-$TS.sqlite"
echo ">> downloading snapshot -> $LOCAL"
kc cp "$POD:$SNAP" "$LOCAL"

echo ">> cleaning up pod tmp"
kc exec "$POD" -- sh -c "rm -f '$SNAP' /tmp/d1-in-pod.mjs"

gzip -f "$LOCAL"
SIZE="$(du -h "$LOCAL.gz" | cut -f1)"
echo ">> DONE: $LOCAL.gz ($SIZE)"
