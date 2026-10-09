export function renderUpSubscriptionSection() {
  return `<section class="card up-home" id="upSubscriptionsSection">
    <div class="up-section-heading"><div><div class="up-section-title"><h2>UP 订阅</h2><button class="help-icon-btn" id="upHelpBtn" type="button" title="UP 订阅使用说明" aria-label="查看 UP 订阅说明" aria-haspopup="dialog">?</button></div><p class="muted">把喜欢的 UP 投稿，持续留在你的归档库。</p></div><div class="row"><button id="upAddBtn" type="button">＋ 添加订阅</button><button id="upRefreshBtn" class="ghost" type="button" aria-label="刷新订阅列表">刷新</button></div></div>
    <div id="upHomeStatus" role="status" aria-live="polite"></div><div id="upHomeList" class="up-home-list"></div>
    <div id="upRemovalOperations" class="up-removal-operations" aria-label="订阅归档清理任务" hidden></div>
  </section>`;
}
export function renderUpSubscriptionModals() {
  return `<div class="modal" id="upHelpModal" aria-labelledby="upHelpTitle"><div class="panel panel-lg up-help">
    <h2 id="upHelpTitle">UP 订阅怎么用？</h2>
    <div class="up-help-body">
      <h3>怎么添加</h3>
      <ol><li>点击“添加订阅”，选择一个已登录的 B站账号。</li><li>从“我的关注”选择 UP，也可以搜索未关注的 UP，或输入 UID / B站主页链接。</li><li>选择归档范围，再点击“建立订阅”。</li></ol>
      <h3>哪些视频会归档</h3>
      <ul><li><strong>全部投稿：</strong>扫描历史投稿，并持续归档之后的新视频。</li><li><strong>从现在 / 日期 / 视频开始：</strong>归档起点之后的投稿；日期包含当天，从视频开始也包含所选视频及同一发布时间的投稿。</li><li><strong>只归档我选中的：</strong>在“投稿选择”里勾选视频，再点“归档选中”；新投稿不会自动下载。</li></ul>
      <h3>程序怎么备份</h3>
      <p>启用的订阅会随自动同步分批检查投稿，符合规则的视频进入下载、上传和核验队列。“发现投稿”不等于已经备份，完成后才计入“已归档”。同一 BV 已有完整、有效的归档时会复用。</p>
      <p>浏览、搜索和筛选投稿目录只读取本地数据；“刷新投稿”会安排后台扫描。B站请求依次执行，历史视频会分批出现。</p>
      <h3>怎样删除或不再归档</h3>
      <p>在视频卡片上点“管理视频”，选择操作方式和影响范围：</p>
      <ul><li><strong>不再归档：</strong>保存排除规则，保留现有归档；已经能播放的视频仍能播放。</li><li><strong>删除归档，并不再归档：</strong>先核对涉及的来源和文件，再确认删除，同时保存排除规则。其他来源仍使用的文件会保留。</li><li><strong>仅当前 UP 订阅：</strong>只处理这个订阅，收藏夹和其他订阅照常工作。</li><li><strong>所有来源：</strong>也影响该 BV 的收藏夹、手动归档和其他订阅；若同时选择删除，也会涉及这些来源的归档。</li></ul>
      <p>排除可在“已排除”列表中解除。全局排除与某个订阅自己的排除独立生效，需要分别解除。</p>
      <p>卡片右上角的“×”用于移除订阅。默认保留归档；也可以选择“移除订阅，并删除本订阅的归档”，核对数量和预计释放空间后确认。其他来源仍使用的文件会保留，清理进度和失败重试显示在首页。</p>
      <p class="muted">暂停订阅不会删除已有归档。选择删除时，已发现的视频会保留排除记录；重新添加后不会自动下载回来，可在“已排除”中主动恢复。“取消单独选择”只撤销额外选择、不删文件；视频仍在原归档范围内时，还会按原规则归档。</p>
    </div>
    <div class="row modal-actions"><button type="button" class="ghost" data-up-close="upHelpModal">知道了</button></div>
  </div></div>
  <div class="modal" id="upAddModal" aria-labelledby="upAddTitle"><div class="panel panel-lg up-dialog" role="document">
    <div class="section-title-row up-dialog-heading"><div><span class="up-eyebrow">UP 订阅</span><h3 id="upAddTitle">找到你想留存的创作者</h3></div><button type="button" class="ghost up-close" data-up-close="upAddModal" aria-label="关闭添加订阅">×</button></div>
    <div class="up-dialog-body">
    <ol class="up-steps" aria-label="添加步骤"><li id="upStepOne" class="active">1 · 选择 UP</li><li id="upStepTwo">2 · 归档范围</li></ol>
    <div id="upDiscoverStep"><label for="upDiscoveryAccount">使用账号</label><select id="upDiscoveryAccount"></select>
      <div class="up-tabs" role="tablist" aria-label="查找 UP"><button type="button" data-up-tab="followings" role="tab" aria-selected="true">我的关注</button><button type="button" data-up-tab="search" role="tab" aria-selected="false">搜索 UP</button><button type="button" data-up-tab="resolve" role="tab" aria-selected="false">UID / 链接</button></div>
      <form id="upSearchForm" class="up-search-row"><input id="upDiscoveryQuery" type="search" placeholder="搜索我的关注" aria-label="查找 UP" maxlength="100" autocomplete="off"><button class="ghost" type="submit" id="upDiscoverySearchBtn">查找</button></form>
      <div id="upDiscoveryStatus" class="up-notice" role="status" aria-live="polite"></div><div id="upDiscoveryList" class="up-discovery-list"></div>
      <div class="up-pagination"><button class="ghost" id="upDiscoveryPrev" type="button">上一页</button><span id="upDiscoveryPage"></span><button class="ghost" id="upDiscoveryNext" type="button">下一页</button></div>
    </div>
    <form id="upRulesStep" hidden><div id="upPickedSummary" class="up-picked-summary"></div><fieldset class="up-rule-options"><legend>从哪里开始归档？</legend>
      <label><input type="radio" name="upMode" value="all" checked><span><strong>全部投稿</strong><small>逐页扫描历史投稿，并持续归档新视频</small></span></label>
      <label><input type="radio" name="upMode" value="from_now"><span><strong>从现在开始</strong><small>只归档订阅之后发布的视频</small></span></label>
      <label><input type="radio" name="upMode" value="from_date"><span><strong>从某个日期开始</strong><small>包含所选日期当天及之后的投稿</small></span></label>
      <label><input type="radio" name="upMode" value="from_video"><span><strong>从某个视频开始</strong><small>包含该视频，以及同一时间或之后的投稿</small></span></label>
      <label><input type="radio" name="upMode" value="selected"><span><strong>只归档我选中的</strong><small>先建立投稿目录，之后手动选择；新视频不会自动下载</small></span></label>
    </fieldset><label id="upSinceField" hidden>起始日期<input id="upSinceDate" type="date"></label>
    <div id="upAnchorField" hidden><label for="upAnchorVideo">选择起始视频（一次选择一位 UP）</label><select id="upAnchorVideo"></select><button class="ghost" id="upAnchorMore" type="button">加载更早投稿</button></div>
    <div id="upRulesStatus" class="up-notice" role="status" aria-live="polite"></div></form></div>
    <div class="modal-actions up-dialog-footer"><span id="upPickedCount">已选 0 位 UP</span><button class="up-primary" id="upToRulesBtn" type="button" disabled>下一步 →</button><button class="ghost" id="upBackBtn" type="button" hidden>← 返回选择</button><button class="up-primary" id="upCreateBtn" type="submit" form="upRulesStep" hidden>建立订阅</button></div>
  </div></div>
  <div class="modal" id="upWorkspaceModal" aria-labelledby="upWorkspaceTitle" aria-describedby="upWorkspaceMeta"><div class="panel panel-xl up-workspace">
    <div class="section-title-row up-dialog-heading"><div class="up-profile-heading"><span id="upWorkspaceAvatar" class="up-avatar"></span><div><span class="up-eyebrow">UP 订阅</span><h3 id="upWorkspaceTitle"></h3><p id="upWorkspaceMeta" class="muted"></p></div></div><button type="button" class="ghost up-close" data-up-close="upWorkspaceModal" aria-label="关闭 UP 订阅">×</button></div>
    <div class="up-workspace-body">
    <div class="up-workspace-actions"><button class="ghost" id="upOpenArchiveBtn" type="button">打开归档库 ↗</button><button class="ghost" id="upScanBtn" type="button">刷新投稿</button><button class="ghost" id="upPauseBtn" type="button">暂停订阅</button></div>
    <details class="up-settings"><summary>归档规则与授权账号</summary><form id="upUpdateForm" class="up-update-grid"><label>授权账号<select id="upUpdateAccount"></select></label><label>归档范围<select id="upUpdateMode"><option value="all">全部投稿</option><option value="from_now">从现在开始</option><option value="from_date">从日期开始</option><option value="from_video">从视频开始</option><option value="selected">只归档选中的</option></select></label><label id="upUpdateDateField" hidden>起始日期<input id="upUpdateDate" type="date"></label><label id="upUpdateAnchorField" hidden>起始视频<select id="upUpdateAnchor"></select></label><button class="ghost" type="submit" id="upUpdateBtn">保存规则</button><button class="ghost up-danger" id="upRemoveBtn" type="button">移除订阅</button></form></details>
    <div class="up-catalog-toolbar"><form id="upCatalogSearchForm" class="up-search-row"><input type="search" id="upCatalogQuery" placeholder="搜索投稿标题或 BV 号" aria-label="搜索投稿"><button type="submit" class="ghost">搜索</button></form><div class="up-tabs up-filter-tabs" aria-label="投稿筛选"><button type="button" data-up-filter="all" aria-pressed="true">全部投稿</button><button type="button" data-up-filter="selected" aria-pressed="false">将要归档</button><button type="button" data-up-filter="excluded" aria-pressed="false">已排除</button></div></div>
    <div id="upWorkspaceStatus" class="up-notice" role="status" aria-live="polite"></div>
    <div class="up-selection-bar"><label><input id="upSelectPage" type="checkbox">选择本页</label><span id="upCatalogPicked">已选 0 个</span><button type="button" class="ghost" id="upIncludeBtn" disabled>归档选中</button><button type="button" class="ghost" id="upClearChoiceBtn" disabled>取消单独选择</button><button type="button" class="ghost" id="upClearPickedBtn">清空选择</button></div>
    <div id="upCatalogList" class="up-catalog-list"></div><div class="up-pagination"><span id="upCatalogTotal"></span><button class="ghost" type="button" id="upCatalogMore" hidden>加载更多投稿</button></div></div>
  </div></div>
  <div class="modal" id="upRemovalModal" aria-labelledby="upRemovalTitle"><div class="panel panel-md up-removal-dialog">
    <div class="section-title-row up-dialog-heading"><h2 id="upRemovalTitle">移除 UP 订阅</h2><button type="button" class="ghost up-close" data-up-close="upRemovalModal" aria-label="关闭移除订阅">×</button></div>
    <div class="up-dialog-body"><p id="upRemovalName"></p>
      <fieldset class="up-rule-options"><legend>怎样处理已有归档？</legend>
        <label><input type="radio" name="upRemovalEffect" value="retain" checked><span><strong>移除订阅，保留归档</strong><small>停止后续订阅，已经备份的视频仍可播放</small></span></label>
        <label><input type="radio" name="upRemovalEffect" value="delete"><span><strong>移除订阅，并删除本订阅的归档</strong><small>只清理这个订阅；收藏夹等其他来源仍使用的文件会保留</small></span></label>
      </fieldset><p class="muted">选择删除后，已发现的视频会保留排除记录。重新添加同一 UP 时不会自动下载回来，可以主动解除排除。</p>
      <div id="upRemovalStatus" class="up-notice" role="status" aria-live="polite"></div>
    </div><div class="modal-actions"><button type="button" class="ghost" data-up-close="upRemovalModal">取消</button><button type="button" class="up-primary" id="upRemovalReviewBtn">确认移除</button></div>
  </div></div>
  <div class="modal" id="upActionModal" aria-label="管理视频与归档范围"><div class="panel panel-md up-action-dialog"><div class="section-title-row up-dialog-heading"><h3>管理这个视频</h3><button type="button" class="ghost up-close" data-up-close="upActionModal" aria-label="关闭视频操作">×</button></div><div class="up-dialog-body"><p id="upActionTitle"></p>
    <fieldset class="up-rule-options"><legend>操作方式</legend><label><input name="upEffect" type="radio" value="retain" checked><span><strong>不再归档</strong><small>保留现有文件，停止今后的自动归档</small></span></label><label><input name="upEffect" type="radio" value="delete"><span><strong>删除归档，并不再归档</strong><small>先核对引用；其他来源使用的文件会保留</small></span></label></fieldset>
    <fieldset class="up-rule-options"><legend>影响范围</legend><label><input name="upScope" type="radio" value="source" checked><span><strong>仅当前 UP 订阅</strong><small>收藏夹及其他来源照常工作</small></span></label><label><input name="upScope" type="radio" value="global"><span><strong>所有来源</strong><small>这个 BV 在收藏夹、手动归档和其他订阅中都不再自动归档</small></span></label></fieldset>
    <div id="upActionStatus" class="up-notice" role="status" aria-live="polite"></div></div><div class="modal-actions up-dialog-footer"><span>排除规则会保存，直到你主动解除。</span><button class="up-primary" id="upActionPreviewBtn" type="button">核对并确认</button></div>
  </div></div>`;
}
