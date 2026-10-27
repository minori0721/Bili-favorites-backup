import { driver, type Driver } from 'driver.js';
import { requireElement } from '../../shared/dom.js';
import type { ApiClient } from '../../shared/api.js';
import type { OnboardingAccountsState, OnboardingStorageState } from '../../shared/onboarding-state.js';
import type { WorkspaceSubscriptionState } from '../../shared/workspace-state.js';
import { parseOnboardingStatus } from '../../../../shared/api/onboarding.js';
import { guideSteps, type GuideKind } from './steps.js';

const SEEN_KEY = 'bfb:onboarding:v1';
const REOPEN_HINT_KEY = 'bfb:onboarding-reopen-hint:v1';
type Tone = 'muted' | 'warning' | 'danger' | 'success';
export function createOnboarding(dependencies: {
  root: Document; api: ApiClient; active(): HTMLElement | null;
  navigate(page: 'overview' | 'accounts' | 'subscriptions' | 'tasks' | 'library', options?: { preserveScroll?: boolean }): Promise<boolean>;
  openStorage(): Promise<void>; notify(message: string): void;
}) {
  const { root } = dependencies;
  const view = root.defaultView;
  if (!view) throw new Error('Onboarding requires a browser window');
  const host = requireElement(root, '.workspace-overview', HTMLElement);
  const entry = requireElement(root, '#onboardingHelpBtn', HTMLButtonElement);
  const welcome = root.createElement('section');
  welcome.className = 'onboarding-welcome'; welcome.setAttribute('aria-labelledby', 'onboardingWelcomeTitle');
  welcome.innerHTML = `<div class="onboarding-welcome-copy"><span class="onboarding-eyebrow">使用引导</span><h3 id="onboardingWelcomeTitle" tabindex="-1">先认识一下各个入口</h3><p>用四步看看界面，或直接开始配置备份。</p></div><div class="onboarding-welcome-actions"><button type="button" class="workspace-button workspace-primary" data-onboarding="tour">认识界面</button><button type="button" class="workspace-button" data-onboarding="setup">开始配置</button><button type="button" class="onboarding-text-button" data-onboarding="dismiss">稍后再说</button></div>`;
  const setup = root.createElement('section');
  setup.className = 'onboarding-setup card'; setup.setAttribute('aria-labelledby', 'onboardingSetupTitle');
  setup.innerHTML = `<div class="onboarding-setup-heading"><div><h3 id="onboardingSetupTitle" tabindex="-1">准备开始备份</h3><p>按需要完成下面的步骤，已有配置可以继续使用。</p></div><button type="button" class="onboarding-text-button" data-onboarding="collapse">收起</button></div><ol class="onboarding-steps"><li><span class="onboarding-step-number" aria-hidden="true">1</span><div><h4>配置远端存储</h4><p id="onboardingStorageStatus">正在读取设置</p><small>连接检查只读，不会写入远端；表单修改需要另行保存。</small></div><button type="button" class="workspace-button" data-onboarding="storage">去设置</button></li><li><span class="onboarding-step-number" aria-hidden="true">2</span><div><h4>添加 B站账号</h4><p id="onboardingAccountStatus">正在读取账号</p><small>扫码登录后，用这个账号读取收藏夹和 UP 投稿。</small></div><button type="button" class="workspace-button" data-onboarding="accounts">管理账号</button></li><li><span class="onboarding-step-number" aria-hidden="true">3</span><div><h4>选择归档来源</h4><p id="onboardingSourceStatus">正在读取来源</p><small>选择收藏夹或 UP 订阅持续归档，也可以只归档单个视频。</small></div><button type="button" class="workspace-button" data-onboarding="sources" aria-expanded="false" aria-controls="onboardingSourceChoices">选择来源</button><div id="onboardingSourceChoices" class="onboarding-source-choices" hidden><button type="button" class="workspace-button" data-onboarding="favorites">收藏夹归档</button><button type="button" class="workspace-button" data-onboarding="subscriptions">UP 订阅</button><button type="button" class="workspace-button" data-onboarding="manual">单独归档</button></div></li></ol><div class="onboarding-setup-footer"><p>下载、上传和核验进度在“任务”中查看。备份完成后，到“归档库”查看和播放。</p><button type="button" class="onboarding-text-button" data-onboarding="tasks">查看任务 ↗</button></div>`;
  const slots = new Map<HTMLElement, HTMLElement>();
  for (const section of [welcome, setup]) {
    const slot = root.createElement('div'); slot.className = 'onboarding-reveal-slot';
    const inner = root.createElement('div'); inner.className = 'onboarding-reveal-inner';
    section.hidden = true; inner.append(section); slot.append(inner); slots.set(section, slot);
  }
  host.prepend(...slots.values());
  let events: AbortController | null = null;
  let tour: Driver | null = null;
  let kind: GuideKind | null = null;
  let pendingGuide: GuideKind | null = null;
  let opening = false;
  let focusFrame: number | null = null;
  let resumeFrame: number | null = null;
  let seen = false;
  let reopenHintSeen = false;
  let autoAllowed = true;
  let firstRun: { status: 'loading' | 'error' } | { status: 'ready'; autoStart: boolean } = { status: 'loading' };
  let statusRequest: AbortController | null = null;
  let ackRequest: AbortController | null = null;
  let acknowledgementWanted = false;
  let manualSource = false;
  let accounts: OnboardingAccountsState = { status: 'loading' };
  let storage: OnboardingStorageState = 'loading';
  let subscriptions: WorkspaceSubscriptionState = { status: 'loading' };
  const reduced = () => view!.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function expand(section: HTMLElement, expanded: boolean, animate = true) {
    const slot = slots.get(section)!;
    if (expanded) {
      section.hidden = false; section.inert = false; section.removeAttribute('aria-hidden');
      if (!slot.classList.contains('is-open') && animate && !reduced()) void slot.offsetHeight;
      slot.classList.add('is-open');
    } else {
      section.inert = true; section.setAttribute('aria-hidden', 'true'); slot.classList.remove('is-open');
      if (!animate || reduced()) section.hidden = true;
    }
  }
  function position(section: HTMLElement, heading: string, alignTop = false) {
    const header = requireElement(root, '.workspace-app-header', HTMLElement).getBoundingClientRect();
    const rect = section.getBoundingClientRect();
    requireElement(section, heading, HTMLElement).focus({ preventScroll: true });
    if (alignTop || rect.top < header.bottom + 12 || rect.top > view!.innerHeight - 140)
      view!.scrollTo({ top: Math.max(0, view!.scrollY + rect.top - header.bottom - 16), behavior: reduced() ? 'instant' : 'smooth' });
  }
  function offerReopenHint() {
    if (reopenHintSeen || [...slots.values()].some(slot => slot.classList.contains('is-open'))) return;
    pendingGuide = 'reopen'; scheduleResume();
  }
  async function acknowledge() {
    if (ackRequest || !events || firstRun.status !== 'ready' || !firstRun.autoStart) return;
    const request = new AbortController(); ackRequest = request;
    try {
      await dependencies.api.silent('/api/onboarding/seen', { method: 'POST', signal: request.signal });
      if (ackRequest === request && !request.signal.aborted) { firstRun = { status: 'ready', autoStart: false }; acknowledgementWanted = false; }
    } catch (error) {
      if (!request.signal.aborted) console.warn('[Onboarding] Could not remember completion', error instanceof Error ? error.name : 'request');
    } finally { if (ackRequest === request) ackRequest = null; }
  }
  function remember() {
    seen = true; autoAllowed = false; acknowledgementWanted = true; expand(welcome, false);
    try { view!.localStorage.setItem(SEEN_KEY, 'seen'); }
    catch (error) { console.debug('[Onboarding] Reminder storage unavailable', error instanceof Error ? error.name : 'storage'); }
    void acknowledge();
  }
  function stopGuide(finished = true) {
    const instance = tour, previousKind = kind, lifetime = events;
    tour = null; kind = null; pendingGuide = null; instance?.destroy();
    if (!finished || !lifetime) return;
    if (previousKind === 'overview') { remember(); expand(setup, true); }
    focusFrame = view!.requestAnimationFrame(() => { focusFrame = null; if (events === lifetime) entry.focus({ preventScroll: true }); });
  }
  function status(selector: string, message: string, tone: Tone) {
    const node = requireElement(setup, selector, HTMLElement); node.textContent = message; node.dataset.tone = tone;
  }
  function render() {
    const storageText: Record<OnboardingStorageState, [string, Tone]> = {
      loading: ['正在读取设置', 'muted'], unavailable: ['设置尚未读取，可到设置页重试', 'danger'], missing: ['请先填写远端地址和归档目录', 'danger'], unchecked: ['尚未检查当前连接', 'warning'],
      checking: ['正在执行只读连接检查…', 'muted'], passed: ['当前表单的只读连接检查通过', 'success'], failed: ['连接检查未通过，请到设置页查看原因', 'danger'],
    };
    status('#onboardingStorageStatus', ...storageText[storage]);
    if (accounts.status === 'loading') status('#onboardingAccountStatus', '正在读取账号', 'muted');
    else if (accounts.status === 'error') status('#onboardingAccountStatus', '账号读取失败，可到账号页重试', 'danger');
    else if (!accounts.total) status('#onboardingAccountStatus', '还没有添加账号', 'danger');
    else if (!accounts.usable) status('#onboardingAccountStatus', accounts.needsLogin ? '账号需要更新授权' : '账号已暂停，请按需要启用', accounts.needsLogin ? 'danger' : 'warning');
    else status('#onboardingAccountStatus', `已添加 ${accounts.total} 个账号`, 'success');
    if (manualSource) status('#onboardingSourceStatus', '已选择单独归档，不需要设置自动来源', 'muted');
    else if (accounts.status === 'error' || subscriptions.status === 'error') status('#onboardingSourceStatus', '来源信息读取失败，请到对应页面重试', 'danger');
    else if (accounts.status !== 'ready' || subscriptions.status !== 'ready') status('#onboardingSourceStatus', '正在读取来源', 'muted');
    else if (accounts.folders || subscriptions.enabled) status('#onboardingSourceStatus', `已启用 ${accounts.folders} 个收藏夹、${subscriptions.enabled} 个 UP 订阅`, 'success');
    else status('#onboardingSourceStatus', '还没有启用收藏夹或 UP 订阅', 'danger');
  }
  async function showCards(target: 'intro' | 'setup') {
    const lifetime = events;
    if (!lifetime || opening) return;
    opening = true; autoAllowed = false; pendingGuide = null;
    try {
      if (!await dependencies.navigate('overview', { preserveScroll: true }) || events !== lifetime) return;
      if (target === 'intro') expand(welcome, true);
      expand(setup, true);
      position(target === 'intro' ? welcome : setup, target === 'intro' ? '#onboardingWelcomeTitle' : '#onboardingSetupTitle', target === 'setup');
    } finally { if (events === lifetime) opening = false; }
  }
  async function startGuide(next: GuideKind) {
    const lifetime = events;
    if (!lifetime || opening || tour) return;
    if (!['overview','storage','manual','reopen'].includes(next) && accounts.status !== 'ready') {
      if (await dependencies.navigate('accounts') && events === lifetime)
        dependencies.notify('请先等待账号读取完成；读取失败时可在这里重试。');
      return;
    }
    opening = true; pendingGuide = null;
    try {
      const hasAccounts = accounts.status === 'ready' && accounts.total > 0;
      if (next === 'storage') await dependencies.openStorage();
      else if (next !== 'reopen') {
        const page = next === 'overview' || next === 'manual' ? 'overview' : next === 'subscriptions' && hasAccounts ? 'subscriptions' : 'accounts';
        if (!await dependencies.navigate(page)) return;
      }
      if (events !== lifetime || dependencies.active() || (next === 'storage' && root.body.dataset.workspaceCurrent !== 'settings')) return;
      const instance = driver({
        steps: guideSteps(root, next, hasAccounts), popoverClass: 'bfb-onboarding-popover', showProgress: next !== 'reopen', progressText: '{{current}} / {{total}}',
        showButtons: next === 'reopen' ? ['next','close'] : undefined,
        nextBtnText: '下一步', prevBtnText: '上一步', doneBtnText: '知道了', closeBtnLabel: '退出引导', animate: !reduced(), duration: 220,
        overlayColor: '#1a2f2d', overlayOpacity: 0.45, overlayClickBehavior: 'none', stagePadding: 5, stageRadius: 12,
        disableActiveInteraction: next === 'overview', allowScroll: next !== 'overview' && next !== 'reopen',
        onPopoverRender(popover) {
          popover.wrapper.setAttribute('role', 'dialog'); popover.wrapper.setAttribute('aria-modal', 'true');
          popover.wrapper.setAttribute('aria-label', next === 'overview' ? '界面使用引导' : next === 'reopen' ? '引导入口提示' : '配置使用引导');
          popover.closeButton.title = '退出引导'; popover.closeButton.setAttribute('aria-label', '退出引导');
        },
        onDestroyStarted() { if (tour === instance && events === lifetime) stopGuide(); },
      });
      tour = instance; kind = next; instance.drive();
      if (next === 'reopen') {
        reopenHintSeen = true;
        try { view!.localStorage.setItem(REOPEN_HINT_KEY, 'seen'); }
        catch (error) { console.debug('[Onboarding] Reminder storage unavailable', error instanceof Error ? error.name : 'storage'); }
      }
    } catch (error) {
      stopGuide(false);
      if (events === lifetime) {
        console.warn('[Onboarding] Guide could not open', error instanceof Error ? error.name : 'guide');
        dependencies.notify('引导暂时无法打开，可以稍后从“使用引导”重试。');
      }
    } finally { if (events === lifetime) opening = false; }
  }
  function scheduleResume() {
    if (!events || resumeFrame !== null) return;
    const lifetime = events;
    resumeFrame = view!.requestAnimationFrame(() => {
      resumeFrame = null;
      if (events !== lifetime || tour || opening || dependencies.active() || root.querySelector('.modal.is-closing')) return;
      if (pendingGuide === 'reopen') {
        if (welcome.hidden && setup.hidden && !root.hidden && root.hasFocus() && root.body.dataset.workspaceCurrent === 'overview') void startGuide('reopen');
      } else if (pendingGuide) { if (accounts.status === 'ready') void startGuide(pendingGuide); }
      else if (autoAllowed && firstRun.status === 'ready' && firstRun.autoStart && storage !== 'loading' && storage !== 'unavailable'
        && accounts.status === 'ready' && subscriptions.status === 'ready' && !root.hidden && root.hasFocus() && root.body.dataset.workspaceCurrent === 'overview') {
        autoAllowed = false; void startGuide('overview');
      }
    });
  }
  const modalObserver = new MutationObserver(scheduleResume);
  async function loadFirstRun() {
    const request = new AbortController(); statusRequest = request;
    try {
      const result = parseOnboardingStatus(await dependencies.api.silent('/api/onboarding', { signal: request.signal }));
      if (statusRequest !== request || request.signal.aborted) return;
      firstRun = { status: 'ready', ...result }; if (acknowledgementWanted) void acknowledge(); scheduleResume();
    } catch (error) {
      if (request.signal.aborted || statusRequest !== request) return;
      firstRun = { status: 'error' };
      console.warn('[Onboarding] First-run status unavailable', error instanceof Error ? error.name : 'request');
    } finally { if (statusRequest === request) statusRequest = null; }
  }
  function clicked(event: MouseEvent) {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('[data-onboarding]');
    if (!button || !host.contains(button)) return;
    const action = button.dataset.onboarding;
    if (action === 'tour') void startGuide('overview');
    else if (action === 'setup') void showCards('setup');
    else if (action === 'dismiss') { remember(); entry.focus({ preventScroll: true }); offerReopenHint(); }
    else if (action === 'collapse') { expand(setup, false); entry.focus({ preventScroll: true }); offerReopenHint(); }
    else if (action === 'storage' || action === 'accounts') void startGuide(action);
    else if (action === 'tasks') void dependencies.navigate('tasks');
    else if (action === 'sources') {
      const choices = requireElement(setup, '#onboardingSourceChoices', HTMLElement);
      choices.hidden = !choices.hidden; button.setAttribute('aria-expanded', String(!choices.hidden));
    } else if (action === 'favorites' || action === 'subscriptions' || action === 'manual') {
      manualSource = action === 'manual'; render(); void startGuide(action);
    }
  }
  return {
    init() {
      if (events) return;
      events = new AbortController(); const { signal } = events;
      try { seen = seen || view!.localStorage.getItem(SEEN_KEY) === 'seen'; reopenHintSeen = reopenHintSeen || view!.localStorage.getItem(REOPEN_HINT_KEY) === 'seen'; }
      catch (error) { console.debug('[Onboarding] Reminder storage unavailable', error instanceof Error ? error.name : 'storage'); }
      expand(welcome, !seen, false);
      entry.addEventListener('click', () => { stopGuide(false); void showCards('intro'); }, { signal });
      host.addEventListener('click', clicked, { signal });
      for (const [section, slot] of slots) slot.addEventListener('transitionend', event => {
        if (event.target === slot && event.propertyName === 'grid-template-rows' && !slot.classList.contains('is-open')) { section.hidden = true; scheduleResume(); }
      }, { signal });
      root.addEventListener('click', event => {
        if (!(event.target instanceof Element)) return;
        if (!tour?.isActive()) { autoAllowed = false; if (pendingGuide === 'reopen' || event.target.closest('[data-workspace-page]')) pendingGuide = null; return; }
        if (event.target.closest('.bfb-onboarding-popover')) return;
        const target = tour.getActiveElement();
        if (kind !== 'overview' && target?.contains(event.target)) {
          if (event.target.closest('#addUserBtn,[data-action="favorites"],#upAddBtn,#upHelpBtn,[data-up-manage],[data-workspace-action="online"]')) {
            const continuation = kind; stopGuide(false); pendingGuide = continuation;
          }
          return;
        }
        event.preventDefault(); event.stopImmediatePropagation();
      }, { signal, capture: true });
      root.addEventListener('keydown', event => {
        if (!tour?.isActive()) autoAllowed = false;
        if (pendingGuide === 'reopen') pendingGuide = null;
        if (tour?.isActive() && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); stopGuide(); }
      }, { signal, capture: true });
      root.addEventListener('input', () => { autoAllowed = false; }, { signal });
      root.addEventListener('visibilitychange', scheduleResume, { signal });
      view!.addEventListener('focus', scheduleResume, { signal });
      view!.addEventListener('storage', event => {
        if (event.key === SEEN_KEY && event.newValue === 'seen') { seen = true; expand(welcome, false); }
        if (event.key === REOPEN_HINT_KEY && event.newValue === 'seen') { reopenHintSeen = true; if (pendingGuide === 'reopen') pendingGuide = null; }
      }, { signal });
      root.querySelectorAll('.modal').forEach(modal => modalObserver.observe(modal, { attributes: true, attributeFilter: ['class'] }));
      render(); void loadFirstRun();
    },
    destroy() {
      events?.abort(); events = null; opening = false;
      if (focusFrame !== null) view!.cancelAnimationFrame(focusFrame);
      if (resumeFrame !== null) view!.cancelAnimationFrame(resumeFrame);
      focusFrame = null; resumeFrame = null;
      modalObserver.disconnect(); statusRequest?.abort(); statusRequest = null; ackRequest?.abort(); ackRequest = null;
      stopGuide(false);
      for (const [section, slot] of slots) section.hidden = !slot.classList.contains('is-open');
    },
    receiveAccounts(state: OnboardingAccountsState) { accounts = state; render(); scheduleResume(); },
    receiveStorage(state: OnboardingStorageState) { storage = state; render(); scheduleResume(); },
    receiveSubscriptions(state: WorkspaceSubscriptionState) { subscriptions = state; render(); scheduleResume(); },
  };
}
