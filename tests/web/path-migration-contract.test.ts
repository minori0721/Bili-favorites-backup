import assert from 'node:assert/strict';
import test from 'node:test';
import { parseState, parseItems } from '../../src/web/client/features/path-migration/contract.js';

test('migration boundary supports empty state and refuses malformed data', () => {
  assert.equal(parseState(undefined),null);
  assert.equal(parseState(null),null);
  assert.equal(parseState({id:'migration',status:'ready'})?.entryCount,0);
  assert.equal(parseState({id:'migration',status:'copying',progress:{completed:2}})?.progress.completed,2);
  for (const value of [[], {}, {id:1,status:'ready'}, {id:'migration',status:'ready',entryCount:-1}, {id:'migration',status:'ready',sourceRoot:{}}]) {
    assert.throws(() => parseState(value));
  }
  assert.deepEqual(parseItems([]),[]);
  assert.throws(() => parseItems({items:[]}));
  assert.throws(() => parseItems([null]));
  assert.throws(() => parseItems([{migrationId:'migration',status:'conflict',expectedSize:'123'}]));
});
