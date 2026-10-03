import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { LogManager, type LogEntry } from '../src/logger.js';
import { JsonFileDecodeError, readJsonFileDecoded } from '../src/storage.js';
import { createTestDir, removeTestDir } from './helpers.js';

const entry: LogEntry = { timestamp: '2026-10-03T00:00:00Z', type: 'system', level: 'info', summary: 'new event', raw: 'new event' };

test('log read I/O failure cannot authorize overwriting existing history', async t => {
  const directory = await createTestDir('log-read-failure');
  const file = path.join(directory, 'logs.json');
  try {
    fs.writeFileSync(file, JSON.stringify([entry]));
    const read = t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('read denied'), { code: 'EACCES' }); });
    const logs = new LogManager(file);
    read.mock.restore(); logs.push(entry); logs.flush(); logs.close();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [entry]);
    assert.deepEqual(fs.readdirSync(directory), ['logs.json']);
  } finally { t.mock.restoreAll(); await removeTestDir(directory); }
});

test('failed corrupt-log backup preserves the sole original through push, flush and close', async t => {
  const directory = await createTestDir('log-backup-failure');
  const file = path.join(directory, 'logs.json');
  try {
    fs.writeFileSync(file, '{broken');
    t.mock.method(fs, 'copyFileSync', () => { throw new Error('backup denied'); });
    assert.throws(() => readJsonFileDecoded(file, [], value => value), error => error instanceof JsonFileDecodeError && error.preservedAt === null);
    const logs = new LogManager(file);
    logs.push(entry); logs.flush(); logs.close();
    assert.equal(logs.getAll()[0].summary, entry.summary);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    assert.deepEqual(fs.readdirSync(directory), ['logs.json']);
  } finally { t.mock.restoreAll(); await removeTestDir(directory); }
});

test('successful preservation permits a new log while retaining the corrupt original', async () => {
  const directory = await createTestDir('log-backup-success');
  const file = path.join(directory, 'logs.json');
  try {
    fs.writeFileSync(file, '{broken');
    const logs = new LogManager(file); logs.push(entry); logs.close();
    const backup = fs.readdirSync(directory).find(name => name.startsWith('logs.json.corrupt-'));
    assert.ok(backup); assert.equal(fs.readFileSync(path.join(directory, backup), 'utf8'), '{broken');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].summary, entry.summary);
  } finally { await removeTestDir(directory); }
});

test('reload cancels pending writes when preservation fails', async t => {
  const directory = await createTestDir('log-reload');
  const file = path.join(directory, 'logs.json');
  const logs = new LogManager(file);
  try {
    logs.push(entry); fs.writeFileSync(file, '{broken');
    t.mock.method(fs, 'copyFileSync', () => { throw new Error('backup denied'); });
    logs.reload(); logs.push(entry);
    await new Promise(resolve => setTimeout(resolve, 350));
    logs.flush(); logs.close(); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally { logs.close(); t.mock.restoreAll(); await removeTestDir(directory); }
});

test('persistence failure is observable and disables retries without stopping in-memory logging', async t => {
  const directory = await createTestDir('log-write-failure');
  const file = path.join(directory, 'logs.json');
  const logs = new LogManager(file);
  try {
    const warning = t.mock.method(console, 'warn', () => {});
    const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('disk write denied'); });
    logs.push(entry); assert.doesNotThrow(() => logs.flush());
    logs.push(entry); logs.flush(); logs.close();
    assert.equal(rename.mock.callCount(), 1); assert.equal(warning.mock.callCount(), 1);
    assert.equal(logs.getEntryCount(), 2); assert.equal(fs.readFileSync(file, 'utf8'), '[]');
  } finally { t.mock.restoreAll(); logs.close(); await removeTestDir(directory); }
});
