#!/usr/bin/env bash
# Install / update the daily on-cluster D1 backup CronJob.
#
# Creates a ConfigMap from scripts/d1-in-pod.mjs (single source of truth) and
# applies k8s/backup-cronjob.yaml. Safe to re-run: it just updates both.
#
# Usage:
#   scripts/install-backup-cronjob.sh            # install/update
#   scripts/install-backup-cronjob.sh --test     # ...then trigger one job now
# Env overrides: KUBE_CONTEXT (lab), KUBE_NS (money-counter)
set -euo pipefail

CTX="${KUBE_CONTEXT:-lab}"
NS="${KUBE_NS:-money-counter}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

kc() { kubectl --context "$CTX" -n "$NS" "$@"; }

echo ">> updating ConfigMap money-counter-backup-script from scripts/d1-in-pod.mjs"
kc create configmap money-counter-backup-script \
  --from-file=d1-in-pod.mjs="$SCRIPT_DIR/d1-in-pod.mjs" \
  --dry-run=client -o yaml | kc apply -f -

echo ">> applying CronJob"
kc apply -f "$ROOT/k8s/backup-cronjob.yaml"

echo ">> installed:"
kc get cronjob money-counter-backup

if [ "${1:-}" = "--test" ]; then
  JOB="mc-backup-test-$(date +%s)"
  echo ">> triggering a one-off test job: $JOB"
  kc create job --from=cronjob/money-counter-backup "$JOB"
  echo ">> waiting for it to complete (co-mount + backup must both succeed)"
  if kc wait --for=condition=complete "job/$JOB" --timeout=180s; then
    echo ">> test job logs:"
    kc logs "job/$JOB"
    echo ">> SUCCESS — backups now live in /data/backups on the PVC"
  else
    echo "!! test job did NOT complete — inspect it:" >&2
    kc get pods -l "job-name=$JOB" -o wide >&2
    kc describe "job/$JOB" | tail -n 25 >&2
    exit 1
  fi
fi
