import { appInfo } from '../../src/app-info.js';
import { releaseNotes } from '../../src/update-release.js';
import type { UpdatesResponse } from '../../src/shared/api/updates.js';

export type UpdateScenario = 'current' | 'dev-update' | 'stable-available' | 'stable-update' | 'both' | 'offline';
export function isUpdateScenario(value: unknown): value is UpdateScenario {
  return typeof value === 'string' && ['current', 'dev-update', 'stable-available', 'stable-update', 'both', 'offline'].includes(value);
}

export function updatesFixture(mode: UpdateScenario = 'current', now = Date.now()): UpdatesResponse {
  const revision = appInfo.revision || '6cc55e659f1e9394d3c15228e9ba6b036f8c16b6';
  const stable = mode === 'stable-update';
  const current = { ...appInfo, version: stable ? '2.6.5' : appInfo.version, buildRef: stable ? 'main' : 'dev', revision,
    versionLabel: stable ? 'v2.6.5 · 正式版' : appInfo.versionLabel };
  const disclaimer = '隔离预览数据，不代表 GitHub 实时发布状态。';
  const notes = disclaimer + '\n\n### 发布摘要\n- 版本信息与发布说明清楚展示。\n- 现有归档、账号和下载任务保持不变。\n\n### 升级提醒\n通过宝塔更新镜像；切换通道时需要修改镜像标签。';
  const currentRelease = releaseNotes(stable ? 'stable' : 'dev', 'v' + current.version, revision, '',
    '### 当前构建摘要\n\n- UP 主订阅与归档管理。\n- 当前镜像保留自己的说明，不会被滚动发布覆盖。\n\n' + notes);
  currentRelease.url = 'https://github.com/minori0721/Bili-favorites-backup/commit/' + revision;
  const devUpdated = mode === 'dev-update' || mode === 'both';
  const official = mode === 'stable-available' || mode === 'both' || stable;
  const development = releaseNotes('dev', 'v2.7.0-dev', devUpdated ? 'b'.repeat(40) : revision, new Date(now - 120000).toISOString(),
    '**累计范围：v2.6.5 → 当前开发版**\n\n### 发布摘要\n\n- **版本与更新**支持当前和最新说明切换。\n- 更新提示仅出现一次，页头标记持续保留。\n- 开发版和正式版分别检查，避免通道混淆。\n\n### 新增\n- UP 订阅支持只归档选中的视频、持久排除和共享文件保护。\n\n### 变更\n- 弹窗和内容工作区统一主题。\n\n### 修复\n- 旧请求不能覆盖新账号的结果。\n\n### 升级提醒\n继续更新 `:dev` 镜像会保持开发通道。\n\n' + disclaimer);
  const release = releaseNotes('stable', official ? 'v2.7.0' : 'v2.6.5', '', new Date(now - 86400000).toISOString(),
    '### 正式版发布摘要\n\n- 正式发布已验收的改动。\n\n### 升级与回滚\n保留 data 与 temp 挂载，使用宝塔更新镜像。\n\n' + notes);
  const checkedAt = new Date(now).toISOString();
  return { current, channel: stable ? 'stable' : 'dev', currentRelease,
    channels: {
      stable: { release, comparison: official ? 'update_available' : stable ? 'up_to_date' : 'ahead', checkedAt, error: null },
      dev: stable ? null : { release: development, comparison: devUpdated ? 'update_available' : 'up_to_date', checkedAt,
        error: mode === 'offline' ? '暂时无法连接更新源，请稍后重试' : null },
    },
    notification: devUpdated ? { id: 'dev:' + development.revision, channel: 'dev', kind: 'update', label: '有新的版本！v2.7.0-dev' }
      : official ? { id: 'stable:v2.7.0', channel: 'stable', kind: stable ? 'update' : 'stable_available', label: stable ? '有新的版本！v2.7.0' : '正式版已发布！v2.7.0' } : null,
    nextRefreshAt: new Date(now).toISOString(), checkAfter: new Date(now + (stable ? 6 * 3600000 : 30 * 60000)).toISOString(),
    releasesUrl: 'https://github.com/minori0721/Bili-favorites-backup/releases',
  };
}
