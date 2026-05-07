import { WebQrcodeLogin } from "@renmu/bili-api";
import QRCode from "qrcode-terminal";
import fs from "node:fs";
import path from "node:path";
import { ensureAppDirs, dataDir } from "../paths.js";
import { getUserInfo } from "../bili.js";
import { UserStore } from "../users.js";

async function run() {
  ensureAppDirs();
  const login = new WebQrcodeLogin();
  const url = await login.login();
  QRCode.generate(url, { small: true });

  const store = new UserStore();

  login.on("completed", async (result: any) => {
    const cookie = result.data as { SESSDATA: string; bili_jct: string; DedeUserID: string };
    const info = await getUserInfo(cookie);
    store.upsert({
      id: String(info.uid),
      uid: info.uid,
      name: info.name,
      cookie,
      favorites: [],
      enabled: true,
      lastLoginAt: new Date().toISOString(),
    });
    fs.writeFileSync(path.join(dataDir, "last-login.json"), JSON.stringify({
      uid: info.uid,
      name: info.name,
      time: new Date().toISOString(),
    }, null, 2));
    console.log("Login saved. You can now open the web UI.");
    process.exit(0);
  });

  login.on("error", (error: any) => {
    console.error("Login failed", error);
    process.exit(1);
  });
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
