// Runs INSIDE the money-counter pod (Node 24+, built-in `node:sqlite`).
// Also usable locally for `verify`/`counts` on a downloaded snapshot.
//
// The D1 database is served by wrangler/miniflare in WAL mode, so a plain
// `cp` of the .sqlite file can miss freshly-committed pages that still live
// in the -wal sidecar. `backup` uses SQLite's ONLINE BACKUP API through a
// second connection: it copies a transactionally-consistent snapshot into a
// single fresh file with NO downtime and NO risk of a torn copy.
//
// Usage (inside pod):
//   node d1-in-pod.mjs path                 -> print the live D1 file path
//   node d1-in-pod.mjs backup <out.sqlite>  -> write a consistent snapshot
//   node d1-in-pod.mjs verify <file>        -> integrity_check + row counts
//   node d1-in-pod.mjs counts <file>        -> row counts only
// The last stdout line is always a JSON object for the caller to parse.

import { DatabaseSync, backup } from "node:sqlite";
import { readdirSync } from "node:fs";
import path from "node:path";

const D1_DIR = process.env.D1_DIR
  || "/data/wrangler/v3/d1/miniflare-D1DatabaseObject";

// Tables worth reporting in a health snapshot. Missing ones report as null
// (schema evolves via ensureSchema(); we never want a count to hard-fail).
const TABLES = [
  "accounts", "transactions", "categories", "currencies",
  "exchange_rates", "category_rules", "loans", "monthly_goals",
  "regular_payments",
];

function findDbFile() {
  const files = readdirSync(D1_DIR)
    .filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one D1 sqlite in ${D1_DIR}, found: ${files.join(", ") || "none"}`,
    );
  }
  return path.join(D1_DIR, files[0]);
}

function withDb(file, readOnly, fn) {
  const db = new DatabaseSync(file, { readOnly });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function counts(file) {
  return withDb(file, true, (db) => {
    const out = {};
    for (const t of TABLES) {
      try {
        out[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
      } catch {
        out[t] = null;
      }
    }
    return out;
  });
}

function integrity(file) {
  return withDb(file, true, (db) =>
    db.prepare("PRAGMA integrity_check").get().integrity_check,
  );
}

async function doBackup(out) {
  const src = findDbFile();
  // Read-only source connection: we can never accidentally mutate prod.
  // miniflare keeps the -shm live, so a second read-only WAL reader is fine.
  let db;
  try {
    db = new DatabaseSync(src, { readOnly: true });
  } catch {
    // Fallback for the rare read-only-WAL edge case: open read-write but
    // only ever read from it (backup does not write to the source).
    db = new DatabaseSync(src, { readOnly: false });
  }
  let pages;
  try {
    pages = await backup(db, out);
  } finally {
    db.close();
  }
  const ic = integrity(out);
  return { ok: ic === "ok", src, out, pages, integrity: ic, counts: counts(out) };
}

const [cmd, arg] = process.argv.slice(2);
try {
  let result;
  if (cmd === "path") {
    result = { path: findDbFile() };
  } else if (cmd === "backup") {
    if (!arg) throw new Error("usage: backup <out.sqlite>");
    result = await doBackup(arg);
  } else if (cmd === "verify") {
    if (!arg) throw new Error("usage: verify <file>");
    const ic = integrity(arg);
    result = { ok: ic === "ok", integrity: ic, counts: counts(arg) };
  } else if (cmd === "counts") {
    if (!arg) throw new Error("usage: counts <file>");
    result = { counts: counts(arg) };
  } else {
    throw new Error("usage: d1-in-pod.mjs path|backup <out>|verify <file>|counts <file>");
  }
  console.log(JSON.stringify(result));
  // Fail loudly (non-zero exit) on a bad snapshot so a CronJob / CI marks the
  // run as failed instead of silently shipping a corrupt backup.
  if ((cmd === "backup" || cmd === "verify") && result.ok === false) {
    process.exitCode = 1;
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
}
