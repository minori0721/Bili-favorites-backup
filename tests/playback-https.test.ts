import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const certificate = fileURLToPath(new URL('./fixtures/playback-tls/certificate.pem', import.meta.url));
const privateKey = fileURLToPath(new URL('./fixtures/playback-tls/private-key.pem', import.meta.url));
const moduleUrl = new URL('../src/playback.ts', import.meta.url).href;
const run = promisify(execFile);

// The child uses the actual production HTTPS adapter and Node's normal network
// stack. Only this child's trust anchors include the loopback certificate.
const clientSource = `
  import net from 'node:net';
  import {fetchPinnedHttps} from ${JSON.stringify(moduleUrl)};
  const input = JSON.parse(process.env.BFB_PLAYBACK_HTTPS_CASE);
  net.setDefaultAutoSelectFamily(true);
  const controller = new AbortController();
  const abortTimer = input.abort ? setTimeout(() => controller.abort(), 1500) : null;
  try {
    const response = await fetchPinnedHttps(new URL(input.url), {
      method:input.method || 'GET', headers:input.headers,
      signal:controller.signal,
    }, {address:input.address,family:input.family});
    let body;
    if(input.cancelBody){
      const reader=response.body.getReader();
      const part=await reader.read();
      body=Buffer.from(part.value || []).toString();
      await reader.cancel();
    }else body=await response.text();
    console.log(JSON.stringify({status:response.status,range:response.headers.get('content-range'),body}));
  }catch(error){
    console.log(JSON.stringify({errorName:error.name,errorCode:error.code}));
  }finally{if(abortTimer)clearTimeout(abortTimer);}
`;

async function fixture(host: '127.0.0.1' | '::1' = '127.0.0.1') {
  const seen: {method: string | undefined; range: string | undefined; ifRange: string | string[] | undefined; host: string | undefined; servername: string}[] = [];
  const sockets = new Set<Duplex>();
  let closedResponses = 0;
  const server = https.createServer({key:fs.readFileSync(privateKey),cert:fs.readFileSync(certificate)}, (req, res) => {
    const socket = req.socket;
    seen.push({method:req.method,range:req.headers.range,ifRange:req.headers['if-range'],host:req.headers.host,
      servername:'servername' in socket ? String(socket.servername) : ''});
    res.on('close', () => { closedResponses++; server.emit('fixture-response-closed'); });
    if (req.url === '/delayed') return;
    if (req.url === '/body') {
      res.writeHead(206, {'Content-Type':'video/mp4','Content-Length':'1048576'});
      res.write('first video bytes');
      return;
    }
    res.writeHead(206, {'Content-Type':'video/mp4','Content-Range':'bytes 5-11/128','Content-Length':'7'});
    res.end(req.method === 'HEAD' ? undefined : 'payload');
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  try {
    server.listen(0, host);
    await once(server, 'listening');
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    throw error;
  }
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    seen,
    get closedResponses() { return closedResponses; },
    async waitForClosedResponse() {
      if (closedResponses > 0) return;
      await once(server,'fixture-response-closed',{signal:AbortSignal.timeout(3000)});
    },
    async request(input: {method?:string; hostname?:string; trusted?:boolean; abort?:boolean; cancelBody?:boolean} = {}) {
      const result = await run(process.execPath, ['--import','tsx','--input-type=module','-e',clientSource], {
        cwd:fileURLToPath(new URL('../',import.meta.url)), timeout:15_000, maxBuffer:256*1024,
        env:{...process.env, NODE_TLS_REJECT_UNAUTHORIZED:'1', NODE_EXTRA_CA_CERTS:input.trusted === false ? undefined : certificate,
          BFB_PLAYBACK_HTTPS_CASE:JSON.stringify({url:'https://'+(input.hostname || 'playback.test.invalid')+':'+address.port+
            (input.abort ? '/delayed' : input.cancelBody ? '/body' : '/video'), address:host,family:host === '::1' ? 6 : 4,
            method:input.method,headers:{Range:'bytes=5-11','If-Range':'fixture-etag'},abort:input.abort,cancelBody:input.cancelBody})},
      });
      return JSON.parse(result.stdout.trim()) as {status?:number;range?:string;body?:string;errorName?:string;errorCode?:string};
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

test('native HTTPS proxy pins IPv4 while automatic family selection is enabled and retains Range, Host and TLS SNI', async () => {
  const server = await fixture();
  try {
    assert.deepEqual(await server.request(), {status:206,range:'bytes 5-11/128',body:'payload'});
    assert.equal(server.seen.length,1);
    assert.equal(server.seen[0].range,'bytes=5-11');
    assert.equal(server.seen[0].ifRange,'fixture-etag');
    assert.match(server.seen[0].host!,/^playback\.test\.invalid:/);
    assert.equal(server.seen[0].servername,'playback.test.invalid');
  } finally { await server.close(); }
});

test('native HTTPS proxy preserves HEAD without consuming a media body', async () => {
  const server = await fixture();
  try {
    assert.deepEqual(await server.request({method:'HEAD'}), {status:206,range:'bytes 5-11/128',body:''});
    assert.equal(server.seen[0].method,'HEAD');
  } finally { await server.close(); }
});

test('native HTTPS proxy continues rejecting an untrusted certificate and a mismatched hostname', async () => {
  const server = await fixture();
  try {
    const untrusted = await server.request({trusted:false});
    assert.ok(['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN'].includes(untrusted.errorCode || ''),JSON.stringify(untrusted));
    assert.equal((await server.request({hostname:'wrong.test.invalid'})).errorCode,'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.equal(server.seen.length,0,'TLS rejection must happen before any HTTP request');
  } finally { await server.close(); }
});

test('native HTTPS proxy abort closes the socket while waiting for response headers', async () => {
  const server = await fixture();
  try {
    assert.equal((await server.request({abort:true})).errorName,'AbortError');
    assert.equal(server.seen.length,1);
    await server.waitForClosedResponse();
    assert.equal(server.closedResponses,1);
  } finally { await server.close(); }
});

test('native HTTPS proxy releases a streaming response when the reader cancels', async () => {
  const server = await fixture();
  try {
    const result = await server.request({cancelBody:true});
    assert.equal(result.status,206);
    assert.equal(result.body,'first video bytes');
    await server.waitForClosedResponse();
    assert.equal(server.closedResponses,1);
  } finally { await server.close(); }
});

test('native HTTPS proxy pins IPv6 with the same certificate validation', async t => {
  let server;
  try { server = await fixture('::1'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && ['EADDRNOTAVAIL','EAFNOSUPPORT','EPROTONOSUPPORT'].includes(String(error.code))) {
      t.skip('IPv6 loopback is unavailable on this host'); return;
    }
    throw error;
  }
  try {
    assert.equal((await server.request()).status,206);
    assert.equal(server.seen[0].servername,'playback.test.invalid');
  } finally { await server.close(); }
});
