import { createShell } from './shared/shell.js';
import { createProtectedTransport, showSessionExpired } from './shared/session.js';
import { createPresentation } from './shared/presentation.js';
import { createTaskCenter } from './features/task-center/controller.js';
import { requireElement } from './shared/dom.js';
import { archiveDeletionProgressText } from './shared/archive-deletion.js';
import { createVideoDetail } from './features/archive/video-detail.js';
import { createVideoCards } from './features/archive/video-card.js';
import { createUnavailable } from './features/archive/unavailable.js';
import { createOnlineContent } from "./features/online-content/controller.js";
import { createSettings } from "./features/settings/controller.js";
import { createAccountActions } from "./features/accounts/actions.js";
import { createConfirmation } from "./shared/confirmation.js";
import { createFavorites } from "./features/accounts/favorites.js";
import { createAccountList } from "./features/accounts/list.js";
import { createApplicationLifecycle } from "./shared/lifecycle.js";
import { createAccountRemoval } from "./features/accounts/removal.js";
import { createAccountLogin } from "./features/accounts/login.js";
import { createNotifications } from "./shared/notifications.js";
import { createModalManager } from "./shared/modals.js";
import { createPathMigrationController } from "./features/path-migration/controller.js";
import { createApiClient } from "./shared/api.js";
import { createUpdatesController } from './features/updates/controller.js';
import { createPlayback } from './features/playback/controller.js';
import { createArchiveLibrary } from './features/archive/library.js';
export function createApplication() {
    const { setHidden, setStatus, renderRequestStatus, copyTextToClipboard, formatDateTime, formatBytes, escapeHtml } = createPresentation(document, navigator);
    const archiveLibraryLayoutMedia = window.matchMedia('(max-width:720px), (max-height:480px) and (pointer:coarse)');
    const modals = createModalManager(document, (modal, options) => {
        if (modal.id === 'updatesModal') {
            updatesFeature.deactivate();
        }
        if (modal.id === 'confirmActionModal' && confirmation.pending && !options.skipConfirm) {
            finishConfirmAction(false);
            return false;
        }
        if (modal.id === 'encodingRetryModal')
            taskCenter.deactivateMedia();
        if (modal.id === 'recoveryChoiceModal')
            taskCenter.deactivateChoice();
        if (modal.id === 'loginModal') {
            accountLogin.deactivate();
        }
        if (modal.id === 'favoritesModal') {
            favorites.deactivate();
        }
        if (modal.id === 'videoDetailModal')
            videoDetail.deactivate();
        if (modal.id === 'playbackModal')
            playback.deactivate();
        if (modal.id === 'archiveLibraryModal') {
            archiveLibrary.deactivate();
        }
        if (modal.id === 'migrationModal')
            settings.deactivateMigration();
        if (modal.id === 'cleanupDataModal')
            settings.deactivateCleanup();
        if (modal.id === 'onlineContentModal') {
            onlineContent.deactivate();
        }
        if (modal.id === 'manualArchiveOptionsModal') {
            onlineContent.deactivateManual();
        }
        if (modal.id === 'recoveryIssuesModal')
            taskCenter.deactivateIssues();
        if (modal.id === 'unavailableModal')
            unavailable.deactivate();
        if (modal.id === 'pathMigrationModal')
            stopPathMigrationPolling();
        if (modal.id === 'renamePreviewModal')
            settings.deactivateRename();
        if (modal.id === 'qualityUpgradeModal')
            settings.deactivateQuality();
        if (modal.id === 'accountRemovalModal') {
            accountRemoval.deactivate();
        }
        return true;
    });
    const openModal = modals.open;
    const closeModal = modals.close;
    const activeModal = modals.active;
    const confirmation = createConfirmation(document, modals);
    const confirmAction = confirmation.ask;
    const finishConfirmAction = confirmation.finish;
    const notifications = createNotifications(document, activeModal);
    const showToast = notifications.show;
    const transport = createProtectedTransport({ fetch: window.fetch.bind(window), expired: () => {
        try { applicationLifecycle.unmount(); }
        catch (error) { console.error('Session shutdown failed', error); }
        finally { showSessionExpired(document); }
    } });
    const api = createApiClient({ fetch: transport.request, notifyError: (message) => showToast(message, "error") });
    const pathMigrationFeature = createPathMigrationController({
        root: document, api, openModal, closeModal, confirmAction, setStatus, setHidden, escapeHtml, formatBytes,
    });
    const openPathMigration = pathMigrationFeature.open;
    const stopPathMigrationPolling = pathMigrationFeature.deactivate;
    // ---- Event Bindings ----
    const updatesFeature = createUpdatesController({ root: document, request: transport.request, openModal, closeModal });
    // Rename and quality upgrade buttons
    const accountList = createAccountList({ root: document, api, formatDateTime,
        status: (message, type, retry) => renderRequestStatus('userListStatus', message, type, retry),
    });
    const loadUsers = accountList.load;
    const favorites = createFavorites({ root: document, api, openModal, closeModal, loadUsers,
        detail: (userId, mediaId, title) => videoDetail.open(userId, mediaId, title), status: (message, type) => setStatus('favoritesStatus', message, type),
    });
    const accountRemoval = createAccountRemoval({
        root: document, api, openModal, closeModal, loadUsers, showToast, formatBytes,
        archiveDeletionProgressText, confirmAction,
    });
    const accountLogin = createAccountLogin({
        root: document, api,
        open: trigger => openModal('loginModal', trigger),
        close: () => closeModal('loginModal'),
        isActive: () => activeModal()?.id === 'loginModal',
        authenticated: () => { void loadUsers(); },
    });
    const accountActions = createAccountActions({ root: requireElement(document, '#userList', HTMLElement), api, confirm: confirmAction,
        favorites: favorites.open, detail: (userId, mediaId, title) => videoDetail.open(userId, mediaId, title), unavailable: userId => unavailable.open(userId), remove: accountRemoval.open,
        reload: loadUsers, copy: copyTextToClipboard, notify: showToast,
    });
    const settings = createSettings({ root: document, api, close: closeModal, formatBytes, formatDateTime, fetch: transport.request, confirm: confirmAction, restored: async () => { await Promise.all([settings.load(), loadUsers()]); }, open: (modal, trigger) => openModal(modal.id, trigger),
        status: (message, kind, retry) => renderRequestStatus('configStatus', message, kind, retry),
        storageStatus: setStatus, notify: (message, kind = 'error') => showToast(message, kind),
        playback: value => playback.configure(value),
        migrationRequired: async (destination, signal) => {
            await openPathMigration();
            if (signal.aborted)
                return;
            requireElement(document, '#pathMigrationDestination', HTMLInputElement).value = destination;
            setStatus('pathMigrationStatus', '已有归档数据，请先完成新路径迁移。', 'muted');
        },
    });
    const loadConfig = settings.load;
    const onlineContent = createOnlineContent({ root: document, api, layout: archiveLibraryLayoutMedia, formatBytes, open: (modal, trigger) => openModal(modal.id, trigger), close: closeModal, openArchive: () => archiveLibrary.open(null), openExternal: url => window.open(url, '_blank', 'noopener,noreferrer'), notify: message => showToast(message, 'error'), status: (text, type, retry) => renderRequestStatus('onlineContentFooter', text, type, retry) });
    const playback = createPlayback({ root: document, api, openModal, closeModal, showToast, favoriteContext: () => videoDetail.context() });
    const archiveLibrary = createArchiveLibrary({ root: document, api, confirmAction, layout: archiveLibraryLayoutMedia, formatBytes, formatDateTime, openModal, closeModal, showToast, play: (bvid, trigger, context) => playback.openLibrary(bvid, trigger, context) });
    const videoCards = createVideoCards({ root: document, api, formatDateTime, notify: (message, kind = 'error') => showToast(message, kind) });
    const videoDetail = createVideoDetail({ root: document, api, cards: videoCards, formatDateTime, open: modal => openModal(modal.id), close: closeModal, play: (bvid, trigger) => playback.open(bvid, trigger), notify: message => showToast(message, 'error') });
    const unavailable = createUnavailable({ root: document, api, renderItem: item => videoCards.render(item, requireElement(document, '#unavailableGrid', HTMLElement)), releaseItems: videoCards.release, open: modal => openModal(modal.id), close: closeModal, notify: message => showToast(message, 'error') });
    const taskCenter = createTaskCenter({ root: document, api, confirmAction, openModal, closeModal, formatDateTime, formatBytes, copyTextToClipboard, showToast });
    const shellEvents = createShell({
        root: document, api, closeHelp: closeModal, loggedOut: () => { window.location.href = '/login'; },
        escape: () => {
            const modal = activeModal();
            if (!modal)
                return false;
            if (modal.id === 'playbackModal' && playback.drawerOpen)
                playback.closeDrawer();
            else if (modal.id === 'archiveLibraryModal' && archiveLibrary.detailOpen)
                archiveLibrary.closeDetail();
            else if (modal.id === 'recoveryIssuesModal' && taskCenter.escapeDetail())
                return true;
            else
                closeModal(modal);
            return true;
        },
    });
    const applicationLifecycle = createApplicationLifecycle(window, [
        shellEvents, taskCenter, playback, archiveLibrary, settings, modals, confirmation, notifications, updatesFeature, pathMigrationFeature, accountList, favorites, accountRemoval, accountLogin, accountActions, onlineContent, videoCards, videoDetail, unavailable,
        {
            init() {
                void Promise.allSettled([loadConfig(), loadUsers()]);
                void settings.loadQualityState();
            },
            destroy() {
                finishConfirmAction(false);
                let modal = activeModal();
                while (modal) {
                    if (!closeModal(modal, { restoreFocus: false }))
                        break;
                    modal = activeModal();
                }
            },
        },
    ]);
    return applicationLifecycle;
}
