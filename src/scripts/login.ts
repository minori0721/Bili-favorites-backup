import { TvQrcodeLogin } from "@renmu/bili-api";
import QRCode from "qrcode-terminal";
import fs from "node:fs";
import path from "node:path";
import { ensureAppDirs, dataDir } from "../paths.js";
import { getUserInfo, normalizeTvAuthResult } from "../bili.js";
import { UserStore } from "../users.js";

async function run() {
  ensureAppDirs();
  const login = new TvQrcodeLogin();
  const url = await login.login();
  QRCode.generate(url, { small: true });

  const store = new UserStore();

  login.emitter.on("completed", async (result: any) => {
    const authData = normalizeTvAuthResult(result);
    const info = await getUserInfo(authData.cookie);
    store.upsert({
      id: String(info.uid),
      uid: info.uid,
      name: info.name,
      cookie: authData.cookie,
      favorites: [],
      enabled: true,
      lastLoginAt: new Date().toISOString(),
      rawAuth: authData.rawAuth,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
      expires: authData.expires,
      avatar: info.avatar,
      lastAuthRefreshAt: new Date().toISOString(),
      lastAuthRefreshError: "",
    });
    fs.writeFileSync(path.join(dataDir, "last-login.json"), JSON.stringify({
      uid: info.uid,
      name: info.name,
      time: new Date().toISOString(),
    }, null, 2));
    console.log("Login saved. You can now open the web UI.");
    process.exit(0);
  });

  login.emitter.on("error", (error: any) => {
    console.error("Login failed", error);
    process.exit(1);
  });
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
