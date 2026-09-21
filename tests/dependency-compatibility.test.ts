import { readField } from './contract-values.js';
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createRequire } from "node:module";
import express from "express";
import { utils } from "@renmu/bili-api";

const { protoBufToXml } = utils;

const require = createRequire(import.meta.url);
const biliRequire = createRequire(require.resolve("@renmu/bili-api"));

async function listen(app: http.RequestListener) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

test("bili-api XML upgrade preserves protobuf danmaku text and escapes markup", async () => {
  const content = "中文😀 <script>&\"' ]]> -->";
  const bytes = Buffer.from(content);
  // DmSegMobileReply.elems: progress=1000ms, mode=1, fontsize=25, content.
  const elem = Buffer.concat([Buffer.from([0x10, 0xe8, 0x07, 0x18, 1, 0x20, 25, 0x3a, bytes.length]), bytes]);
  const xml = await protoBufToXml(Buffer.concat([Buffer.from([0x0a, elem.length]), elem]));
  const { XMLParser } = biliRequire("fast-xml-parser");
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
  assert.equal(parsed.i.d["#text"], content);
  assert.match(parsed.i.d["@_p"], /^1,1,25,/);
  assert.ok(!xml.includes("<script>"));
  assert.match(xml, /&lt;script&gt;/);
  assert.ok(!xml.includes("<![CDATA["));
  assert.ok(!xml.includes("<!--"));
});

test("bili-api axios and retry preserve cookie and encoded query on a transient response", async (t) => {
  const axios = biliRequire("axios");
  const axiosRetry = biliRequire("axios-retry").default;
  const requests: { cookie: string | undefined; title: string | null }[] = [];
  const { server, url } = await listen((req, res) => {
    requests.push({ cookie: req.headers.cookie, title: new URL(req.url!, "http://local").searchParams.get("title") });
    res.writeHead(requests.length === 1 ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0 }));
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));
  const client = axios.create({ proxy: false, timeout: 2000 });
  axiosRetry(client, { retries: 1, retryDelay: () => 0 });
  const response = await client.get(url, { params: { title: "中文 & +" }, headers: { Cookie: "fixture=local-only" } });
  assert.equal(response.data.code, 0);
  assert.deepEqual(requests, Array(2).fill({ cookie: "fixture=local-only", title: "中文 & +" }));
});

test("Express qs override preserves forms and query arrays while body limits still reject oversized JSON", async (t) => {
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  app.use(express.urlencoded({ extended: true }));
  app.post("/", (req, res) => res.json({ body: req.body, query: req.query }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.sendStatus(Number(readField(err, 'status')) || 500));
  const { server, url } = await listen(app);
  t.after(() => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));
  const response = await fetch(`${url}/?ids[]=1&ids[]=2`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "name=%E4%B8%AD%E6%96%87&options[enabled]=true&__proto__[polluted]=yes",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { body: { name: "中文", options: { enabled: "true" } }, query: { ids: ["1", "2"] } });
  assert.equal(readField(({}), 'polluted'), undefined);
  const oversized = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: "x".repeat(2048) }) });
  assert.equal(oversized.status, 413);
});
