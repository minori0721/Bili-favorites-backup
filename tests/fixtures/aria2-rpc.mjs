import http from 'node:http';
import fs from 'node:fs';
const configPath = process.argv[process.argv.indexOf('--conf-path') + 1];
const config = Object.fromEntries(fs.readFileSync(configPath, 'utf8').trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
const transfers = new Map();
let rate = config['max-overall-download-limit'], invalidRows = false;
const server = http.createServer(async (request, response) => {
  let text = ''; for await (const part of request) text += part;
  const body = JSON.parse(text), [token, ...params] = body.params;
  let result, error;
  if (token !== `token:${config['rpc-secret']}`) error = { code: 1, message: 'Unauthorized' };
  else {
    switch (body.method) {
      case 'aria2.getVersion': result = { version: 'fixture' }; break;
      case 'aria2.changeGlobalOption': rate = params[0]['max-overall-download-limit']; result = 'OK'; break;
      case 'aria2.getGlobalOption': result = { 'max-overall-download-limit': rate }; break;
      case 'aria2.addUri': {
        const options = params[1]; transfers.set(options.gid, { gid: options.gid, status: 'active', completedLength: '1234' }); result = options.gid; break;
      }
      case 'aria2.tellActive': result = [...transfers.values()].filter(t => t.status === 'active'); if (invalidRows) result = [{ gid: 4 }]; break;
      case 'aria2.tellWaiting': result = []; break;
      case 'aria2.tellStopped': result = [...transfers.values()].filter(t => t.status !== 'active'); break;
      case 'aria2.tellStatus': result = transfers.get(params[0]); break;
      case 'aria2.forceRemove': transfers.get(params[0]).status = 'removed'; result = params[0]; break;
      case 'aria2.removeDownloadResult': transfers.delete(params[0]); result = 'OK'; break;
      case 'aria2.shutdown': result = 'OK'; setTimeout(() => server.close(), 10); break;
      case 'fixture.invalidRows': invalidRows = true; result = 'OK'; break;
      default: error = { code: 1, message: 'Unsupported method' };
    }
  }
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...(error ? { error } : { result }) }));
});
server.listen(Number(config['rpc-listen-port']), '127.0.0.1');
