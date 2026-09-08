import { requireElement } from '../../shared/dom.js';
export function createSyncHelp(dependencies:{root:ParentNode;open(modal:HTMLElement,trigger:HTMLElement):void}) {
  const {root}=dependencies;
  const button=requireElement(root,'#syncHelpBtn',HTMLButtonElement);
  const modal=requireElement(root,'#syncHelpModal',HTMLElement);
  const content=requireElement(root,'#syncHelpContent',HTMLElement);
  const simple=requireElement(root,'#syncHelpSimpleBtn',HTMLButtonElement);
  const detail=requireElement(root,'#syncHelpDetailBtn',HTMLButtonElement);
  let syncHelpMode:'simple'|'detail'='simple';
  let initialized=false;
    function renderSyncHelp() {

      simple.classList.toggle('active', syncHelpMode === 'simple');
      detail.classList.toggle('active', syncHelpMode === 'detail');
      if (syncHelpMode === 'simple') {
        content.innerHTML = '<div class="help-card-grid">' +
          '<div class="help-card"><strong>立即同步</strong><div>现在就看一眼你选中的收藏夹，有新视频就放进下载和上传队列。适合平时日常更新。</div></div>' +
          '<div class="help-card"><strong>状态对账（仅远端存储）</strong><div>不重新翻 B 站收藏夹，主要检查程序记录过的网盘文件还在不在。适合怀疑网盘文件被移动或删除时使用。</div></div>' +
          '<div class="help-card"><strong>全量扫描并对账</strong><div>从头更完整地扫描收藏夹，并检查 AList / OpenList 远端状态。最全面但更慢，请求也更多。</div></div>' +
          '</div>';
        return;
      }
      content.innerHTML = '<div class="help-card-grid">' +
        '<div class="help-card"><strong>立即同步</strong><ul><li>按当前调度策略扫描热门页和部分历史页。</li><li>发现未备份视频后进入下载队列。</li><li>适合日常增量同步，成本最低。</li></ul></div>' +
         '<div class="help-card"><strong>状态对账（仅远端存储）</strong><ul><li>跳过 B 站收藏夹全量扫描。</li><li>根据本地 SQLite 中的远端文件记录检查实际文件。</li><li>发现缺失后按补传上限重新排队。</li></ul></div>' +
        '<div class="help-card"><strong>全量扫描并对账</strong><ul><li>尽可能重新扫描收藏夹所有页面。</li><li>同时执行远端文件校验，适合首次补齐或迁移目录后使用。</li><li>请求量更大，可能触发 412、登录校验或风控。</li></ul></div>' +
        '</div>';
    }

    function openSyncHelp() {
      syncHelpMode = 'simple';
      renderSyncHelp();
      dependencies.open(modal,button);
    }

  const showSimple=()=>{syncHelpMode='simple';renderSyncHelp();};
  const showDetail=()=>{syncHelpMode='detail';renderSyncHelp();};
  return {init(){if(initialized)return;initialized=true;button.addEventListener('click',openSyncHelp);simple.addEventListener('click',showSimple);detail.addEventListener('click',showDetail);},
  destroy(){if(!initialized)return;initialized=false;button.removeEventListener('click',openSyncHelp);simple.removeEventListener('click',showSimple);detail.removeEventListener('click',showDetail);}};
}
