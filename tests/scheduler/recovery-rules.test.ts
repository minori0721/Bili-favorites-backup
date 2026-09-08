import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAccessProbeIntents, isSourceUnavailableFailure, normalizeSourceAvailabilityReason } from '../../src/scheduler/access-rules.js';
import { parseEncodingRetryContext, parseQualityEncodingOverride, parseStrictMediaTarget } from '../../src/scheduler/recovery-context.js';

test('persisted access intents retain compatibility without duplicate probe purposes', () => {
  assert.deepEqual(normalizeAccessProbeIntents({intents:['availability','charging','availability','invalid']}),['availability','charging']);
  assert.deepEqual(normalizeAccessProbeIntents({purpose:'legacy_failure_classification'}),['legacy_classification','availability']);
  assert.equal(isSourceUnavailableFailure(new Error('temporary network failure')),false);
  assert.equal(isSourceUnavailableFailure({downloadFailureCategory:'source_unavailable'}),true);
  assert.equal(normalizeSourceAvailabilityReason('favorite_unavailable'),'favorite_flag');
  assert.equal(normalizeSourceAvailabilityReason('empty_response'),'temporary_error');
});

test('recovery context requires generation and both local copies before restoring retry work', () => {
  const saved={parentJobId:'parent',generation:2,candidateLocalDir:'candidate',originalLocalDir:'original',priority:['AVC','HEVC','AV1'],state:'verifying'};
  const context=parseEncodingRetryContext(saved);
  assert.equal(context?.state,'verifying');
  assert.equal(context?.originalLocalDir,'original');
  assert.equal(parseEncodingRetryContext({...saved,generation:0}),null);
  assert.equal(parseEncodingRetryContext({...saved,originalLocalDir:''}),null);
  assert.equal(parseEncodingRetryContext({...saved,priority:['AVC','AVC','AV1']}),null);
  assert.equal(parseQualityEncodingOverride({...saved,strict:false})?.strict,false);
  assert.deepEqual(parseStrictMediaTarget({quality:' 1080P ',encoding:'avc'}),{quality:'1080P',encoding:'AVC'});
});
