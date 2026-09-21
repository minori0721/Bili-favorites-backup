import { required } from '../contract-values.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseState, parseItems } from '../../src/web/client/features/path-migration/contract.js';

test('migration boundary supports empty state and refuses malformed data', () => {
  assert.equal(parseState(undefined),null);
  assert.equal(parseState(null),null);
  assert.equal(parseState({id:'migration',status:'ready' as const})?.entryCount,0);
  assert.equal(required(parseState({id:'migration',status:'copying' as const,progress:{completed:2}})?.progress).completed,2);
  for (const value of [[], {}, {id:1,status:'ready' as const}, {id:'migration',status:'ready' as const,entryCount:-1}, {id:'migration',status:'ready' as const,sourceRoot:{}}]) {
    assert.throws(() => parseState(value));
  }
  assert.deepEqual(parseItems([]),[]);
  assert.throws(() => parseItems({items:[]}));
  assert.throws(() => parseItems([null]));
  assert.throws(() => parseItems([{migrationId:'migration',status:'conflict' as const,expectedSize:'123'}]));
});
