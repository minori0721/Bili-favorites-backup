import fs from "node:fs";
import path from "node:path";
import { dataDir, tempDir, databasePath } from "./paths.js";
import { recoverDatabaseReplacement } from "./database-replacement.js";
import { isRecord } from "./shared/api/value.js";

interface ImportFile { target: string; staged: string; backup: string; existed: boolean }
interface ImportRecord { version: 1; id: string; committed: boolean; rolledBack?: boolean; files: ImportFile[] }
const journal = path.join(dataDir, "import-transaction.json");

function decodeImportRecord(value: unknown): ImportRecord {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== "string"
    || !/^[a-f0-9]{32}$/.test(value.id) || typeof value.committed !== "boolean"
    || (value.rolledBack !== undefined && typeof value.rolledBack !== "boolean") || !Array.isArray(value.files)) {
    throw new Error("Invalid import recovery record; refusing startup");
  }
  const files: ImportFile[] = [];
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.target !== "string" || typeof file.staged !== "string"
      || typeof file.backup !== "string" || typeof file.existed !== "boolean") {
      throw new Error("Invalid import recovery record; refusing startup");
    }
    files.push({ target: file.target, staged: file.staged, backup: file.backup, existed: file.existed });
  }
  return { version: 1, id: value.id, committed: value.committed,
    ...(value.rolledBack === undefined ? {} : { rolledBack: value.rolledBack }), files };
}
function save(record: ImportRecord) {
  const fd = fs.openSync(`${journal}.writing`, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(`${journal}.writing`, journal);
}
export function beginImportTransaction(id: string) {
  if (fs.existsSync(journal)) throw Object.assign(new Error("Previous import requires recovery"), { recoveryRequired: true });
  const record: ImportRecord = { version: 1, id, committed: false, files: [] };
  save(record);
  return {
    add(file: Omit<ImportFile, "existed">) { record.files.push({ ...file, existed: fs.existsSync(file.target) }); save(record); },
    commit() { save({ ...record, committed: true }); record.committed = true; },
    finish() {
      if (!record.committed) {
        try { save({ ...record, committed: true, rolledBack: true }); record.committed = true; record.rolledBack = true; }
        catch (error) { throw Object.assign(new Error("Import recovery decision could not be persisted"), { cause: error, recoveryRequired: true }); }
      }
      try { fs.rmSync(journal, { force: true }); }
      catch { console.warn("[Migration] Import recovery record cleanup deferred."); }
    },
    get pending() { return fs.existsSync(journal); },
  };
}
// Run before opening config/users/state. Never guess when a journal is malformed.
export function recoverImportTransaction() {
  if (!fs.existsSync(journal)) return;
  const record = decodeImportRecord(JSON.parse(fs.readFileSync(journal, "utf8")) as unknown);
  const allowed = new Set(["config.json", "users.json", "logs.json", "covers", "debug", "bfb.sqlite"].map(n => path.resolve(dataDir, n)));
  allowed.add(path.resolve(tempDir));
  if (record.version !== 1 || !/^[a-f0-9]{32}$/.test(record.id) || typeof record.committed !== "boolean" || (record.rolledBack !== undefined && typeof record.rolledBack !== "boolean") || !Array.isArray(record.files)
    || record.files.some(f => !allowed.has(path.resolve(f.target)) || f.staged !== `${f.target}.migration-${record.id}` || f.backup !== `${f.target}.before-migration-${record.id}` || typeof f.existed !== "boolean")) {
    throw new Error("Invalid import recovery record; refusing startup");
  }
  recoverDatabaseReplacement(databasePath, record.committed);
  if (record.committed && record.files.some(file => (!record.rolledBack || file.existed) && !fs.existsSync(file.target))) {
    throw new Error("Committed import file is missing; refusing startup with defaults");
  }
  if (!record.committed) {
    for (const file of [...record.files].reverse()) {
      if (fs.existsSync(file.backup)) {
        // Copy instead of consuming the backup: another crash can repeat recovery.
        fs.rmSync(file.target, { recursive: true, force: true });
        fs.cpSync(file.backup, file.target, { recursive: true });
      } else if (!file.existed) fs.rmSync(file.target, { recursive: true, force: true });
      else if (!fs.existsSync(file.staged) || !fs.existsSync(file.target)) throw new Error("Import backup is missing; refusing ambiguous recovery");
    }
  }
  // Files are now consistent. Cleanup failure retains the durable decision.
  save({ ...record, committed: true, rolledBack: record.rolledBack || !record.committed });
  for (const file of record.files) {
    fs.rmSync(file.staged, { recursive: true, force: true });
    fs.rmSync(file.backup, { recursive: true, force: true });
  }
  fs.rmSync(journal, { force: true });
}
