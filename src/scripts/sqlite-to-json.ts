import fs from "node:fs";
import path from "node:path";
import { StateDatabase } from "../database.js";

const source = path.resolve(process.argv[2] || path.join(process.cwd(), "data", "bfb.sqlite"));
const destination = path.resolve(process.argv[3] || path.join(process.cwd(), "data", "state.rollback.json"));

if (!fs.existsSync(source)) {
  throw new Error(`SQLite database not found: ${source}`);
}

const database = new StateDatabase(source);
try {
  database.integrityCheck();
  const state = database.loadState();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(temporary, destination);
  console.log(`Legacy state JSON exported: ${destination}`);
} finally {
  database.close();
}
