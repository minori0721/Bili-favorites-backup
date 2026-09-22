import fs from "node:fs";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { isRecord } from "./shared/api/value.js";

interface ReplacementRecord { version: 1; id: string; committed: boolean }
const suffixes = ["", "-wal", "-shm"];

export function validateExistingDatabase(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Database integrity check failed");
  } finally { db.close(); }
}

function persist(file: string, record: ReplacementRecord) {
  const staging = `${file}.writing`;
  const fd = fs.openSync(staging, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(staging, file);
}

function paths(file: string, id: string) {
  return { journal: `${file}.replacement.json`, backup: `${file}.before-import-${id}`, next: `${file}.importing-${id}`, displaced: `${file}.displaced-${id}` };
}

function decodeReplacementRecord(value: unknown): ReplacementRecord {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== "string"
    || !/^[a-f0-9]{32}$/.test(value.id) || typeof value.committed !== "boolean") {
    throw new Error("Invalid database replacement record; refusing to create or replace database");
  }
  return { version: 1, id: value.id, committed: value.committed };
}

function cleanup(file: string, record: ReplacementRecord) {
  const p = paths(file, record.id);
  try {
    for (const base of [p.backup, p.next, p.displaced]) for (const suffix of suffixes) fs.rmSync(`${base}${suffix}`, { force: true });
    fs.rmSync(p.journal, { force: true });
  // boundary-critical: replacement is already durable; cleanup failure keeps
  // recovery evidence and is reported without reversing the committed state.
  } catch {
    // boundary-critical: committed database state is retained; cleanup failure cannot roll it back.
    // The commit decision is durable. Cleanup must never reverse it.
    console.warn("[Migration] Database replacement cleanup deferred; recovery files retained.");
  }
}

export function recoverDatabaseReplacement(file: string, commitPending = false) {
  if (file === ":memory:" || !fs.existsSync(`${file}.replacement.json`)) return;
  const record = decodeReplacementRecord(JSON.parse(fs.readFileSync(`${file}.replacement.json`, "utf8")) as unknown);
  const p = paths(file, record.id);
  if (commitPending && !record.committed) {
    validateExistingDatabase(file);
    persist(p.journal, { ...record, committed: true });
    record.committed = true;
  }
  if (!record.committed) {
    // backupTo produced a standalone SQLite snapshot, including committed WAL data.
    validateExistingDatabase(p.backup);
    const restore = `${p.next}.restore`;
    fs.copyFileSync(p.backup, restore);
    for (const suffix of suffixes) fs.rmSync(`${file}${suffix}`, { force: true });
    fs.renameSync(restore, file);
    validateExistingDatabase(file);
    // Recovery is itself restartable until the restored database is validated.
    persist(p.journal, { ...record, committed: true });
  } else validateExistingDatabase(file);
  cleanup(file, record);
}

export async function prepareDatabaseReplacement(file: string, source: string, backup: (destination: string) => Promise<void>) {
  if (fs.existsSync(`${file}.replacement.json`)) throw new Error("Previous database replacement requires recovery before another import");
  validateExistingDatabase(source);
  const record: ReplacementRecord = { version: 1, id: crypto.randomUUID().replace(/-/g, ""), committed: false };
  const p = paths(file, record.id);
  const sourceDb = new Database(source, { readonly: true, fileMustExist: true });
  try { await sourceDb.backup(p.next); } finally { sourceDb.close(); }
  validateExistingDatabase(p.next);
  await backup(p.backup);
  validateExistingDatabase(p.backup);
  for (const file of [p.next, p.backup]) {
    const fd = fs.openSync(file, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  persist(p.journal, record);
  return {
    install() {
      for (const suffix of suffixes) if (fs.existsSync(`${file}${suffix}`)) fs.renameSync(`${file}${suffix}`, `${p.displaced}${suffix}`);
      fs.renameSync(p.next, file);
      validateExistingDatabase(file);
    },
    commit() {
      persist(p.journal, { ...record, committed: true });
      cleanup(file, record);
    },
    rollback() { recoverDatabaseReplacement(file); },
  };
}
