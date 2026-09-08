import type { ApiClient } from '../../shared/api.js';
import { parseVideoDetailItem, type VideoDetailItem } from '../../../../shared/api/video-detail.js';
import { sourceAvailabilityReasonLabel } from './status.js';

export function createVideoCards(dependencies: {root:Document;api:ApiClient;formatDateTime(value:string):string;notify(message:string,kind?:string):void}) {
  const {root:document,api,formatDateTime}=dependencies;
  const requests=new Map<string,{controller:AbortController;owner:HTMLElement}>();
  const buttons=new Map<HTMLButtonElement,{bvid:string;owner:HTMLElement}>();
  let initialized=false;
  const safeText=(value:unknown,fallback:string)=>String(value??'').trim()||fallback;
  const localCoverUrl=(item:VideoDetailItem)=>item.coverLocalPath ? '/'+item.coverLocalPath.split('/').filter(Boolean).join('/') : '';
  function sync(bvid:string,label:string,disabled:boolean){for(const [button,item] of buttons){if(item.bvid===bvid){button.textContent=label;button.disabled=disabled;}}}
  async function recheckAvailability(bvid:string,owner:HTMLElement){
    if(!initialized||requests.has(bvid))return;
    const controller=new AbortController();const entry={controller,owner};requests.set(bvid,entry);sync(bvid,'正在加入...',true);
    try{
      await api.silent('/api/videos/'+encodeURIComponent(bvid)+'/availability-recheck',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:controller.signal});
      if(controller.signal.aborted||requests.get(bvid)!==entry)return;
      sync(bvid,'已加入复核',true);dependencies.notify('已加入一次后台复核','success');
    }catch(error){if(!controller.signal.aborted&&requests.get(bvid)===entry){sync(bvid,'立即复核',false);dependencies.notify(error instanceof Error?error.message:String(error),'error');}}
    finally{if(requests.get(bvid)===entry)requests.delete(bvid);}
  }
  function release(owner:HTMLElement){
    for(const [button,item] of buttons)if(item.owner===owner)buttons.delete(button);
    for(const [bvid,entry] of requests)if(entry.owner===owner){entry.controller.abort();requests.delete(bvid);sync(bvid,'立即复核',false);}
  }
    function appendVideoDetailCover(container: HTMLElement, item: VideoDetailItem) {
      const wrap = document.createElement('div');
      wrap.className = 'video-cover-wrap';
      const cachedCoverUrl = localCoverUrl(item);
      const remoteCoverUrl = item.cover ? String(item.cover).replace('http://', 'https://') : '';
      const candidates = (item.unavailable ? [cachedCoverUrl, remoteCoverUrl] : [remoteCoverUrl, cachedCoverUrl])
        .filter((value, index, all) => value && all.indexOf(value) === index);
      if (!candidates.length) {
        const placeholder = document.createElement('div');
        placeholder.className = 'video-cover';
        wrap.appendChild(placeholder);
      } else {
        const img = document.createElement('img');
        img.className = 'video-cover';
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        let candidateIndex = 0;
        img.src = candidates[candidateIndex];
        img.addEventListener('error', () => {
          candidateIndex += 1;
          if (candidateIndex < candidates.length) {
            img.src = candidates[candidateIndex];
            return;
          }
          const placeholder = document.createElement('div');
          placeholder.className = 'video-cover';
          img.replaceWith(placeholder);
        });
        wrap.appendChild(img);
      }
      if (item.playback && item.playback.available) {
        const affordance = document.createElement('span');
        affordance.className = 'video-play-affordance';
        affordance.setAttribute('aria-hidden', 'true');
        affordance.textContent = '▶';
        wrap.appendChild(affordance);
      }
      container.appendChild(wrap);
    }

    function renderVideoDetailItem(value: unknown, owner: HTMLElement) {
      const item = parseVideoDetailItem(value);
      const div = document.createElement('div');
      let stateClass = '';
      let badgeClass = '';
      let badgeText = '';
      const sourceState = item?.sourceAvailability?.state;
      const confirmedSourceUnavailable = item.unavailable && (!sourceState || ['confirmed_unavailable', 'dormant'].includes(sourceState));
      if (item.backupStatus === 'uploaded') {
        stateClass = item.unavailable ? 'unavailable-uploaded' : 'processed';
        badgeClass = 'upload-pending';
        badgeText = item.unavailable ? '失效·确认中' : '上传确认中';
      } else if (item.backupStatus === 'partial_verified') {
        stateClass = 'processed';
        badgeClass = 'partial';
        badgeText = '部分备份';
      } else if ((item.archivedSourceUnavailable ?? item.unavailable) && item.processed) {
        stateClass = 'unavailable-uploaded';
        badgeClass = 'removed-uploaded';
        badgeText = confirmedSourceUnavailable ? '已归档 · B站源不可用' : '已归档 · 收藏夹显示失效';
      } else if (item.unavailable && !item.processed) {
        stateClass = 'unavailable-missing';
        badgeClass = 'removed-missing';
        badgeText = sourceState === 'dormant' ? '长期不可用' : 'B站源不可用';
      } else if (item.processed) {
        stateClass = 'processed';
        badgeClass = 'done';
        badgeText = '已备份';
      } else if (item.backupStatus === 'upload_failed') {
        stateClass = '';
        badgeClass = 'upload-pending';
        badgeText = '待补传';
      } else if (item.backupStatus === 'charging_restricted') {
        stateClass = '';
        badgeClass = 'pending';
        badgeText = '充电视频';
      } else if (item.backupStatus === 'downloading') {
        badgeClass = 'pending';
        badgeText = '下载中';
      } else if (item.backupStatus === 'downloaded') {
        badgeClass = 'pending';
        badgeText = '待上传';
      } else if (item.backupStatus === 'uploading') {
        badgeClass = 'upload-pending';
        badgeText = '上传中';
      } else if (item.backupStatus === 'queued') {
        badgeClass = 'pending';
        badgeText = '已排队';
      } else if (item.backupStatus === 'missing') {
        badgeClass = 'removed-missing';
        badgeText = '远端缺失';
      } else if (sourceState === 'pending_confirmation') {
        badgeClass = 'pending';
        badgeText = '状态待确认';
      } else if (sourceState === 'unknown') {
        badgeClass = 'pending';
        badgeText = sourceAvailabilityReasonLabel(item.sourceAvailability, true) || '状态暂未确认';
      } else if (sourceState === 'confirmed_unavailable') {
        stateClass = 'unavailable-missing';
        badgeClass = 'removed-missing';
        badgeText = sourceAvailabilityReasonLabel(item.sourceAvailability, true) || 'B站源不可用';
      } else if (sourceState === 'dormant') {
        stateClass = 'unavailable-missing';
        badgeClass = 'removed-missing';
        badgeText = '长期不可用';
      } else if (item.failed) {
        stateClass = 'unavailable-missing';
        badgeClass = 'removed-missing';
        badgeText = '下载失败';
      } else {
        stateClass = '';
        badgeClass = 'pending';
        badgeText = '待备份';
      }

      const canPlay = Boolean(item.playback && item.playback.available);
      div.className = 'video-item ' + stateClass + (canPlay ? ' playable' : '');
      if (canPlay) {
        div.tabIndex = 0;
        div.setAttribute('role', 'button');
        div.setAttribute('aria-label', '播放 ' + safeText(item.title || item.bvid, '归档视频'));
        div.dataset.playbackBvid = String(item.bvid || '');
      }
      appendVideoDetailCover(div, item);

      const info = document.createElement('div');
      info.className = 'video-info';
      const titleEl = document.createElement('div');
      titleEl.className = 'video-title';
      titleEl.title = safeText(item.title || item.bvid, '未知视频');
      titleEl.textContent = safeText(item.title || item.bvid, '未知视频');
      const meta = document.createElement('div');
      meta.className = 'video-meta';
      const chargingCheck = item.accessRestriction && item.accessRestriction.nextCheckAt
        ? ' | 下次检查：' + formatDateTime(item.accessRestriction.nextCheckAt)
        : '';
      const playbackMeta = canPlay ? ' | 可播放 ' + Number(item.playback?.partCount || 1) + ' 个分P' : '';
      meta.textContent = 'UP: ' + safeText(item.upperName || item.ownerName, '未知UP') + ' | ' + safeText(item.bvid, '-') + chargingCheck + playbackMeta;
      info.appendChild(titleEl);
      info.appendChild(meta);
      if (!canPlay && item.playback && item.playback.reason) {
        const reason = document.createElement('span');
        reason.className = 'video-play-reason';
        reason.textContent = item.playback.reason === 'awaiting_verification'
          ? '远端仍在确认，确认完成后可播放'
          : item.playback.reason === 'no_playable_media'
            ? '归档容器暂不支持浏览器直接播放'
            : '尚未形成可播放的已验证归档';
        info.appendChild(reason);
      }
      if (sourceState || item.archivedSourceUnavailable) {
        const source = document.createElement('div');
        source.className = 'video-source-availability';
        const copy = document.createElement('span');
        const sourceMessages: Record<string,string> = {
          pending_confirmation:'收藏夹显示失效，尚未确认B站源状态',
          unknown:'暂时无法确认B站源状态',
          confirmed_unavailable:'B站源目前不可用，系统已停止重复下载',
          dormant:'B站源长期不可用，无需处理；重新可见后会自动恢复'
        };
        const specificReason = sourceAvailabilityReasonLabel(item.sourceAvailability);
        const archivedMessage = item.processed
          ? (specificReason && sourceState !== 'pending_confirmation' ? specificReason
            : confirmedSourceUnavailable ? 'B站源目前不可用' : '收藏夹标记失效，尚未确认B站源状态')
            + '；已有归档和封面不受影响'
          : '';
        copy.textContent = archivedMessage || (specificReason && sourceState !== 'pending_confirmation'
          ? specificReason + (sourceState === 'dormant' ? '；已休眠，无需处理，重新可见后会自动恢复'
            : sourceState === 'confirmed_unavailable' ? '；已停止重复下载，系统会低频复核' : '；系统会稍后复核')
          : sourceMessages[sourceState || ""] || 'B站状态尚未确认')
          + (canPlay || item.processed ? '；已有归档和封面不受影响' : '');
        source.appendChild(copy);
        if (item.bvid) {
          const recheck = document.createElement('button');
          recheck.type = 'button';
          recheck.textContent = requests.has(item.bvid) ? '正在加入...' : '立即复核';
          recheck.disabled = requests.has(item.bvid);
          buttons.set(recheck, {bvid:item.bvid,owner});
          recheck.addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation();
            void recheckAvailability(item.bvid, owner);
          });
          source.appendChild(recheck);
        }
        info.appendChild(source);
      }
      div.appendChild(info);

      const badges = document.createElement('div');
      badges.className = 'video-badges';
      const badge = document.createElement('span');
      badge.className = 'video-badge ' + badgeClass;
      badge.textContent = badgeText;
      badges.appendChild(badge);
      if (item.activeInFavorite === false) {
        const historyBadge = document.createElement('span');
        historyBadge.className = 'video-badge history';
        historyBadge.textContent = '历史记录';
        badges.appendChild(historyBadge);
      }
      div.appendChild(badges);
      return div;
    }

return {render:renderVideoDetailItem,release,init(){initialized=true;},destroy(){initialized=false;for(const entry of requests.values())entry.controller.abort();requests.clear();buttons.clear();}};
}
