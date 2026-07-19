#!/usr/bin/env bash
# Restore the production Money Counter D1 (SQLite) database from a snapshot
# produced by scripts/backup-db.sh.
#
# WAL note: you cannot just overwrite the live .sqlite while miniflare holds it
# open — the stale -wal/-shm sidecars would be replayed on top and corrupt it.
# So we STOP the app, swap the file on the PVC (deleting -wal/-shm), and start
# it again. The PVC is RWO local-path, so the swap runs in a short-lived helper
# pod that mounts the same volume once the app has released it.
#
# Flow (brief downtime, ~30-90s):
#   1. take a safety backup of the CURRENT db (unless --no-pre-backup)
#   2. upload + integrity-check the restore file onto the PVC
#   3. scale app to 0  ->  swap in helper pod  ->  scale app to 1
#   4. verify row counts on the live db
#
# Usage:
#   scripts/restore-db.sh <backup.sqlite|backup.sqlite.gz> [--yes] [--no-pre-backup]
# Env overrides: KUBE_CONTEXT (lab), KUBE_NS (money-counter)
set -euo pipefail

CTX="${KUBE_CONTEXT:-lab}"
NS="${KUBE_NS:-money-counter}"
DEPLOY="money-counter"
SELECTOR="app.kubernetes.io/name=money-counter"
PVC="money-counter-data"
PULL_SECRET="ghcr-creds"
HELPER_POD="mc-restore-helper"
PENDING="/data/_restore-pending.sqlite"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER="$SCRIPT_DIR/d1-in-pod.mjs"

kc() { kubectl --context "$CTX" -n "$NS" "$@"; }

FILE=""
ASSUME_YES=0
PRE_BACKUP=1
for a in "$@"; do
  case "$a" in
    --yes|-y) ASSUME_YES=1 ;;
    --no-pre-backup) PRE_BACKUP=0 ;;
    -*) echo "unknown flag: $a" >&2; exit 2 ;;
    *) FILE="$a" ;;
  esac
done
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "ERROR: give a backup file (.sqlite or .sqlite.gz)" >&2; exit 2; }

# Decompress .gz into a scratch file.
WORK="$FILE"
TMP=""
if [ "${FILE##*.}" = "gz" ]; then
  TMP="$(mktemp -t mc-restore-XXXXXX.sqlite)"
  echo ">> decompressing $FILE"
  gunzip -c "$FILE" > "$TMP"
  WORK="$TMP"
fi

cleanup() {
  rc=$?
  [ -n "$TMP" ] && rm -f "$TMP" 2>/dev/null || true
  kc delete pod "$HELPER_POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  if [ "$rc" -ne 0 ]; then
    echo "!! restore failed (rc=$rc) — making sure the app is scaled back up" >&2
    kc scale deploy "$DEPLOY" --replicas=1 >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

POD="$(kc get pod -l "$SELECTOR" --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}')"
[ -n "$POD" ] || { echo "ERROR: no running money-counter pod" >&2; exit 1; }
IMAGE="$(kc get deploy "$DEPLOY" -o jsonpath='{.spec.template.spec.containers[0].image}')"
echo ">> pod=$POD  image=$IMAGE"

kc cp "$HELPER" "$POD:/tmp/d1-in-pod.mjs"
DBFILE="$(kc exec "$POD" -- node /tmp/d1-in-pod.mjs path | tail -n1 | sed 's/.*"path":"//; s/".*//')"
[ -n "$DBFILE" ] || { echo "ERROR: could not locate live D1 file" >&2; exit 1; }
echo ">> live D1 file: $DBFILE"

if [ "$PRE_BACKUP" -eq 1 ]; then
  echo ">> taking a safety backup of the CURRENT database first"
  "$SCRIPT_DIR/backup-db.sh" ./backups
  # backup-db.sh removes /tmp/d1-in-pod.mjs on its way out — re-upload it.
  kc cp "$HELPER" "$POD:/tmp/d1-in-pod.mjs"
fi

echo ">> uploading restore file onto the PVC"
kc cp "$WORK" "$POD:$PENDING"
echo ">> verifying the uploaded restore file"
VERIFY="$(kc exec "$POD" -- node /tmp/d1-in-pod.mjs verify "$PENDING" | tail -n1)"
echo "   $VERIFY"
case "$VERIFY" in
  *'"ok":true'*) : ;;
  *) echo "ERROR: restore file failed integrity check — aborting" >&2; exit 1 ;;
esac

echo ""
echo "About to REPLACE the live database with the file above (brief downtime)."
if [ "$ASSUME_YES" -ne 1 ]; then
  printf "Type 'yes' to proceed: "
  read -r ans < /dev/tty || ans=""
  [ "$ans" = "yes" ] || { echo "aborted"; exit 1; }
fi

echo ">> scaling app to 0"
kc scale deploy "$DEPLOY" --replicas=0
kc wait --for=delete pod -l "$SELECTOR" --timeout=120s || true

echo ">> starting helper pod to swap the file"
OVERRIDES="$(cat <<JSON
{"apiVersion":"v1","spec":{"restartPolicy":"Never","imagePullSecrets":[{"name":"$PULL_SECRET"}],"containers":[{"name":"$HELPER_POD","image":"$IMAGE","command":["sh","-c","sleep 900"],"volumeMounts":[{"name":"data","mountPath":"/data"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"$PVC"}}]}}
JSON
)"
kc run "$HELPER_POD" --image="$IMAGE" --restart=Never --overrides="$OVERRIDES" >/dev/null
kc wait --for=condition=Ready "pod/$HELPER_POD" --timeout=180s

echo ">> swapping file + removing stale WAL sidecars"
kc exec "$HELPER_POD" -- sh -c \
  "cp -f '$PENDING' '$DBFILE' && rm -f '$DBFILE-wal' '$DBFILE-shm' && rm -f '$PENDING' && echo OK"

kc delete pod "$HELPER_POD" --wait=true

echo ">> scaling app back to 1"
kc scale deploy "$DEPLOY" --replicas=1
kc rollout status deploy "$DEPLOY" --timeout=180s

NEWPOD="$(kc get pod -l "$SELECTOR" --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}')"
kc cp "$HELPER" "$NEWPOD:/tmp/d1-in-pod.mjs"
echo ">> restored database row counts:"
kc exec "$NEWPOD" -- node /tmp/d1-in-pod.mjs counts "$DBFILE" | tail -n1
kc exec "$NEWPOD" -- sh -c "rm -f /tmp/d1-in-pod.mjs" || true

echo ">> DONE"
