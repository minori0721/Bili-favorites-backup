import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveStatusLabel, sourceAvailabilityReasonLabel } from '../../src/web/client/features/archive/status.js';

test('source diagnosis reports only explicit evidence and preserves usable archive priority', () => {
  for (const [reason,label,state] of [
    ['under_review','B站稿件审核中','unknown'],
    ['uploader_only','仅UP主自己可见','unknown'],
    ['submission_invisible','稿件不可见','confirmed_unavailable'],
    ['api_not_found','B站未找到该视频','confirmed_unavailable'],
  ]) {
    const sourceAvailability = {reason,state};
    assert.equal(archiveStatusLabel({sourceAvailability,playback:{available:false}}),label);
    assert.equal(archiveStatusLabel({sourceAvailability,playback:{available:true}}),'可播放');
  }
  assert.equal(sourceAvailabilityReasonLabel({reason:'unrecognized'}),'');
  assert.equal(sourceAvailabilityReasonLabel({reason:'submission_invisible'}),'B站稿件不可见，具体原因未公开');
  assert.equal(archiveStatusLabel({sourceAvailability:{reason:'favorite_flag'},playback:{available:true}}),'已归档 · 收藏夹显示失效');
});

test('deletion and partial archive labels keep their existing precedence', () => {
  assert.equal(archiveStatusLabel({memberships:[{deletionStatus:'failed'},{deletionStatus:'completed'}],playback:{available:true}}),'已手动删除');
  assert.equal(archiveStatusLabel({deletionStatus:'retry_wait',playback:{available:true}}),'清理中');
  assert.equal(archiveStatusLabel({playback:{available:true,partial:true}}),'部分可播放');
  assert.equal(archiveStatusLabel({sourceAvailability:{state:'dormant' as const}}),'B站源长期不可用');
});
