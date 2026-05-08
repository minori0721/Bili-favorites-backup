#!/usr/bin/env node
/**
 * B站反风控测试脚本
 * 用法: node test-anti-risk.mjs
 *
 * 从 data/users.json 读取第一个启用用户的 cookie 和第一个收藏夹，
 * 用不同配置组合请求 API，看哪些会被 412 风控。
 *
 * 测试矩阵:
 *   - 请求方式: 原生 fetch / biliAPI Client
 *   - WBI 签名: 有 / 无
 *   - dm_* 参数: 有 / 无
 *   - UA: 标准浏览器 / 精简 Mozilla/5.0
 *   - 页间延迟: 0ms / 300ms / 1500ms
 *   - referer: 有 / 无
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============ 读取 cookie ============
async function loadCookie() {
  // 优先从 data/users.json 读取（本地开发）
  const usersPath = path.join(__dirname, "data", "users.json");
  try {
    const users = JSON.parse(readFileSync(usersPath, "utf-8"));
    const user = users.find((u) => u.enabled);
    if (user && user.favorites?.[0]) {
      return {
        cookie: user.cookie,
        cookieString: `SESSDATA=${user.cookie.SESSDATA}; bili_jct=${user.cookie.bili_jct}; DedeUserID=${user.cookie.DedeUserID}`,
        mediaId: user.favorites[0].mediaId,
        userName: user.name,
      };
    }
  } catch (_) { /* fall through to env/interactive */ }

  // 尝试从环境变量读取
  const envSessdata = process.env.BILI_SESSDATA;
  const envJct = process.env.BILI_BILI_JCT;
  const envUid = process.env.BILI_DEDEUSERID;
  const envMediaId = process.env.BILI_MEDIA_ID;
  if (envSessdata && envJct && envUid && envMediaId) {
    return {
      cookie: { SESSDATA: envSessdata, bili_jct: envJct, DedeUserID: envUid },
      cookieString: `SESSDATA=${envSessdata}; bili_jct=${envJct}; DedeUserID=${envUid}`,
      mediaId: Number(envMediaId),
      userName: "env-user",
    };
  }

  // 交互式输入
  console.log("未找到 data/users.json 和环境变量，请手动输入：\n");
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  const SESSDATA = await ask("SESSDATA: ");
  const bili_jct = await ask("bili_jct: ");
  const DedeUserID = await ask("DedeUserID: ");
  const mediaIdStr = await ask("收藏夹 mediaId: ");
  rl.close();

  return {
    cookie: { SESSDATA, bili_jct, DedeUserID },
    cookieString: `SESSDATA=${SESSDATA}; bili_jct=${bili_jct}; DedeUserID=${DedeUserID}`,
    mediaId: Number(mediaIdStr),
    userName: "manual",
  };
}

// ============ WBI 签名 ============
const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

function mixinKey(orig) {
  let temp = "";
  for (const n of mixinKeyEncTab) temp += orig[n] ?? "";
  return temp.slice(0, 32);
}

function md5(input) {
  return createHash("md5").update(input).digest("hex");
}

function encWbi(params, img_key, sub_key) {
  const mixin = mixinKey(img_key + sub_key);
  const wts = Math.floor(Date.now() / 1000).toString();
  const merged = { ...params, wts };
  const chr_filter = /[!'()*]/g;
  const sorted = Object.keys(merged)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(merged[k]).replace(chr_filter, ""))}`)
    .join("&");
  return `${sorted}&w_rid=${md5(sorted + mixin)}`;
}

let _wbiKeys = null;
async function getWbiKeys() {
  if (_wbiKeys) return _wbiKeys;
  const resp = await fetch("https://api.bilibili.com/x/web-interface/nav");
  const json = await resp.json();
  const imgUrl = json?.data?.wbi_img?.img_url || "";
  const subUrl = json?.data?.wbi_img?.sub_url || "";
  _wbiKeys = {
    img_key: (imgUrl.split("/").pop() || "").split(".")[0],
    sub_key: (subUrl.split("/").pop() || "").split(".")[0],
  };
  return _wbiKeys;
}

// ============ biliAPI Client (动态 import ESM) ============
async function getBiliClient(cookie) {
  const { Client, Auth } = await import("@renmu/bili-api");
  const { accessToken, ...cookieOnly } = cookie;
  const auth = new Auth();
  auth.setAuth(cookieOnly, Number(cookie.DedeUserID), accessToken || undefined);
  return new Client(auth);
}

// ============ 请求策略 ============
const UAs = {
  standard: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  minimal: "Mozilla/5.0",
};

const DM_PARAMS = {
  dm_img_list: "[]",
  dm_img_str: "V2ViR0wgMS",
  dm_cover_img_str: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0XX)), SwiftShader driver)Google Inc. (Google)",
  dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
};

// ============ 单次请求 ============
async function requestOnce(strategy, cookie, cookieString, mediaId, wbiKeys) {
  const { method, useWbi, useDm, ua, useReferer } = strategy;

  const baseParams = {
    media_id: mediaId,
    pn: 1,
    ps: 20,
    order: "fav_time",
    order_type: "0",
    type: "2",
    tid: "0",
    platform: "web",
    web_location: "1550101",
    ...(useDm ? DM_PARAMS : {}),
  };

  let url;
  if (useWbi) {
    const qs = encWbi(baseParams, wbiKeys.img_key, wbiKeys.sub_key);
    url = `https://api.bilibili.com/x/v3/fav/resource/list?${qs}`;
  } else {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(baseParams).map(([k, v]) => [k, String(v)]))
    ).toString();
    url = `https://api.bilibili.com/x/v3/fav/resource/list?${qs}`;
  }

  const headers = {
    ...(useReferer ? { referer: "https://www.bilibili.com/" } : {}),
    "user-agent": ua,
  };

  if (method === "native") {
    const res = await fetch(url, {
      headers: { ...headers, cookie: cookieString },
    });
    if (!res.ok) return { ok: false, status: res.status, body: await res.text().catch(() => "") };
    const body = await res.json();
    return { ok: body.code === 0, status: res.status, code: body.code, message: body.message, count: body.data?.medias?.length };
  } else {
    // biliAPI Client
    const client = await getBiliClient(cookie);
    try {
      const responseBody = await client.video.request.get(url, {
        headers,
        extra: { rawResponse: true },
      });
      const data = responseBody?.data ?? {};
      return { ok: Number(data.code ?? 0) === 0, status: 200, code: data.code, message: data.message, count: data.data?.medias?.length };
    } catch (err) {
      return { ok: false, status: err?.statusCode || err?.response?.status || 0, body: err?.message || String(err) };
    }
  }
}

// ============ 连续翻页测试 ============
async function testMultiPage(strategy, cookie, cookieString, mediaId, wbiKeys, pageDelay, maxPages) {
  const results = [];
  for (let page = 1; page <= maxPages; page++) {
    // 为每页构建独立参数
    const baseParams = {
      media_id: mediaId,
      pn: page,
      ps: 20,
      order: "fav_time",
      order_type: "0",
      type: "2",
      tid: "0",
      platform: "web",
      web_location: "1550101",
      ...(strategy.useDm ? DM_PARAMS : {}),
    };

    let url;
    if (strategy.useWbi) {
      const qs = encWbi(baseParams, wbiKeys.img_key, wbiKeys.sub_key);
      url = `https://api.bilibili.com/x/v3/fav/resource/list?${qs}`;
    } else {
      const qs = new URLSearchParams(
        Object.fromEntries(Object.entries(baseParams).map(([k, v]) => [k, String(v)]))
      ).toString();
      url = `https://api.bilibili.com/x/v3/fav/resource/list?${qs}`;
    }

    const headers = {
      ...(strategy.useReferer ? { referer: "https://www.bilibili.com/" } : {}),
      "user-agent": strategy.ua,
    };

    let result;
    if (strategy.method === "native") {
      const res = await fetch(url, {
        headers: { ...headers, cookie: cookieString },
      });
      if (!res.ok) {
        result = { ok: false, status: res.status, page };
        results.push(result);
        return results; // 风控了就停
      }
      const body = await res.json();
      result = { ok: body.code === 0, status: res.status, code: body.code, page, count: body.data?.medias?.length };
    } else {
      const client = await getBiliClient(cookie);
      try {
        const responseBody = await client.video.request.get(url, {
          headers,
          extra: { rawResponse: true },
        });
        const data = responseBody?.data ?? {};
        result = { ok: Number(data.code ?? 0) === 0, status: 200, code: data.code, page, count: data.data?.medias?.length };
      } catch (err) {
        result = { ok: false, status: err?.statusCode || err?.response?.status || 0, page, body: err?.message || String(err) };
        results.push(result);
        return results;
      }
    }
    results.push(result);
    if (!result.ok) return results;

    // 检查是否还有更多页
    if (result.count < 20) return results;

    if (pageDelay > 0) {
      await new Promise((r) => setTimeout(r, pageDelay));
    }
  }
  return results;
}

// ============ 主测试流程 ============
async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     B站反风控测试脚本 — 找出不被 412 的配置      ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const { cookie, cookieString, mediaId, userName } = await loadCookie();
  console.log(`用户: ${userName}`);
  console.log(`收藏夹 ID: ${mediaId}`);
  console.log(`Cookie: SESSDATA=${cookie.SESSDATA?.slice(0, 8)}...\n`);

  const wbiKeys = await getWbiKeys();
  console.log(`WBI Keys: img_key=${wbiKeys.img_key}, sub_key=${wbiKeys.sub_key}\n`);

  // ====== Phase 1: 单次请求矩阵 ======
  console.log("━".repeat(54));
  console.log("Phase 1: 单次请求矩阵 (page=1, 每个策略请求 1 次)");
  console.log("━".repeat(54));

  const strategies = [
    { name: "native + WBI + referer + standard UA",     method: "native", useWbi: true,  useDm: false, ua: UAs.standard, useReferer: true },
    { name: "native + WBI + referer + minimal UA",      method: "native", useWbi: true,  useDm: false, ua: UAs.minimal,  useReferer: true },
    { name: "native + no WBI + referer + standard UA",  method: "native", useWbi: false, useDm: false, ua: UAs.standard, useReferer: true },
    { name: "native + no WBI + no referer + standard UA", method: "native", useWbi: false, useDm: false, ua: UAs.standard, useReferer: false },
    { name: "native + WBI + dm + referer + standard UA", method: "native", useWbi: true,  useDm: true,  ua: UAs.standard, useReferer: true },
    { name: "biliAPI + WBI + referer + standard UA",    method: "biliAPI", useWbi: true,  useDm: false, ua: UAs.standard, useReferer: true },
    { name: "biliAPI + WBI + dm + referer + standard UA", method: "biliAPI", useWbi: true,  useDm: true,  ua: UAs.standard, useReferer: true },
  ];

  const singleResults = [];
  for (const s of strategies) {
    const r = await requestOnce(s, cookie, cookieString, mediaId, wbiKeys);
    const status = r.ok ? "✅ OK" : `❌ ${r.status}${r.code ? ` code=${r.code}` : ""}`;
    const detail = r.ok ? `${r.count} videos` : (r.message || r.body || "").slice(0, 60);
    console.log(`  ${status}  ${detail}`);
    console.log(`       ${s.name}`);
    singleResults.push({ strategy: s.name, ...r });
    // 请求间隔
    await new Promise((r) => setTimeout(r, 500));
  }

  // ====== Phase 2: 连续翻页测试 ======
  console.log("\n" + "━".repeat(54));
  console.log("Phase 2: 连续翻页测试 (选择 Phase 1 中 OK 的策略)");
  console.log("━".repeat(54));

  const okStrategies = singleResults.filter((r) => r.ok);
  if (okStrategies.length === 0) {
    console.log("  ⚠️  没有策略通过 Phase 1，跳过翻页测试");
  } else {
    const delays = [0, 300, 1500];
    for (const sr of okStrategies) {
      const s = strategies.find((x) => x.name === sr.strategy);
      if (!s) continue;
      for (const delay of delays) {
        process.stdout.write(`  Testing: ${s.name} | delay=${delay}ms ... `);
        const pages = await testMultiPage(s, cookie, cookieString, mediaId, wbiKeys, delay, 5);
        const failedPage = pages.find((p) => !p.ok);
        if (failedPage) {
          console.log(`❌ 风控在 page ${failedPage.page} (status=${failedPage.status})`);
        } else {
          console.log(`✅ ${pages.length} 页全部通过`);
        }
        // 测试间隔
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // ====== Phase 3: 最佳策略完整翻页 ======
  console.log("\n" + "━".repeat(54));
  console.log("Phase 3: 最佳策略完整翻页 (最多 50 页，delay=300ms)");
  console.log("━".repeat(54));

  // 优先选 native + WBI + referer + standard UA
  const bestStrategy = strategies.find((s) => s.name === "native + WBI + referer + standard UA") || strategies[0];
  console.log(`  使用策略: ${bestStrategy.name}`);
  const fullPages = await testMultiPage(bestStrategy, cookie, cookieString, mediaId, wbiKeys, 300, 50);
  const failedPage = fullPages.find((p) => !p.ok);
  if (failedPage) {
    console.log(`  ❌ 风控在 page ${failedPage.page} (status=${failedPage.status})`);
  } else {
    const totalVideos = fullPages.reduce((sum, p) => sum + (p.count || 0), 0);
    console.log(`  ✅ ${fullPages.length} 页全部通过，共 ${totalVideos} 个视频`);
  }

  console.log("\n测试完成！");
}

main().catch((err) => {
  console.error("测试脚本出错:", err);
  process.exit(1);
});
