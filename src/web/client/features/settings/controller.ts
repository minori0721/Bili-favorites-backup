import { createQualityUpgrade } from './quality.js';
import { createRename } from './rename.js';
import type { ApiClient } from '../../shared/api.js';
import { requireElement } from '../../shared/dom.js';
import { createSettingsLoader } from './loader.js';
import { createSettingsSaver } from './saver.js';
import { createStorageCheck } from './storage-check.js';
import { createTemplateEditor } from './template.js';
import { normalizeClientEncodingPriority, renderEncodingPriorityEditor } from './encoding.js';
import { createSettingsHelp } from './help.js';
import { createCleanup } from './cleanup.js';
import { createMigration } from './migration.js';
import type { ConfirmAction } from '../../shared/confirmation.js';
export function createSettings(dependencies: {
    fetch: typeof fetch;
    confirm: ConfirmAction;
    formatDateTime(value: string): string;
    restored(): Promise<void>;
    close(modal: HTMLElement): void;
    formatBytes(value: number): string;
    open(modal: HTMLElement, trigger: HTMLElement): void;
    root: Document;
    api: ApiClient;
    status(message: string, kind?: string, retry?: () => void): void;
    storageStatus(element: HTMLElement, message: string, kind?: string): void;
    notify(message: string, kind?: string): void;
    playback(value: {
        deliveryMode: 'auto' | 'proxy';
        alistBrowserConfigured: boolean;
    }): void;
    migrationRequired(destination: string, signal: AbortSignal): Promise<void>;
}) {
    const { root } = dependencies;
    const hiRes = requireElement(root, '#bbdownHiRes', HTMLInputElement);
    const dolby = requireElement(root, '#bbdownDolby', HTMLInputElement);
    const modeControl = requireElement(root, '#bbdownApiModeControl', HTMLElement);
    const editor = requireElement(root, '#bbdownEncodingPriorityEditor', HTMLElement);
    let priority = normalizeClientEncodingPriority(null);
    let initialized = false;
    function getMode() {
        const input = root.querySelector('input[name="bbdownApiMode"]:checked');
        return input instanceof HTMLInputElement && input.value === 'app' ? 'app' : 'web';
    }
    function setMode(mode: string) {
        requireElement(root, 'input[name="bbdownApiMode"][value="' + (mode === 'app' ? 'app' : 'web') + '"]', HTMLInputElement).checked = true;
    }
    function setPriority(value: string[]) {
        priority = normalizeClientEncodingPriority(value);
        if (initialized)
            renderEncodingPriorityEditor(editor, priority, setPriority);
    }
    function premiumChanged() {
        if (hiRes.checked || dolby.checked)
            setMode('app');
    }
    function modeChanged(event: Event) {
        if (event.target instanceof HTMLInputElement && event.target.value === 'web' && (hiRes.checked || dolby.checked)) {
            setMode('app');
            dependencies.status('Hi-Res / Dolby 需要 APP 接口。', 'error');
        }
    }
    const template = createTemplateEditor(root);
    const loader = createSettingsLoader({ ...dependencies, encoding: setPriority, apiMode: setMode, templateChanged: template.refresh });
    const saver = createSettingsSaver({ ...dependencies, priority: () => priority.slice(), apiMode: getMode });
    const storage = createStorageCheck({ ...dependencies, status: dependencies.storageStatus });
    const help = createSettingsHelp({ root, priority: () => priority.slice(), apiMode: getMode, open: dependencies.open });
    const cleanup = createCleanup(dependencies);
    const migration = createMigration(dependencies);
    const rename = createRename(dependencies);
    const quality = createQualityUpgrade(dependencies);
    return {
        load: loader.load,
        deactivateCleanup: cleanup.deactivate,
        deactivateRename: rename.deactivate,
        deactivateQuality: quality.deactivate,
        loadQualityState: quality.loadState,
        deactivateMigration: migration.deactivate,
        init() {
            if (initialized)
                return;
            initialized = true;
            template.init();
            loader.init();
            saver.init();
            storage.init();
            help.init();
            cleanup.init();
            migration.init();
            rename.init();
            quality.init();
            setPriority(priority);
            hiRes.addEventListener('change', premiumChanged);
            dolby.addEventListener('change', premiumChanged);
            modeControl.addEventListener('change', modeChanged);
        },
        destroy() {
            if (!initialized)
                return;
            initialized = false;
            modeControl.removeEventListener('change', modeChanged);
            dolby.removeEventListener('change', premiumChanged);
            hiRes.removeEventListener('change', premiumChanged);
            quality.destroy();
            rename.destroy();
            migration.destroy();
            cleanup.destroy();
            help.destroy();
            storage.destroy();
            saver.destroy();
            loader.destroy();
            template.destroy();
            editor.replaceChildren();
        },
    };
}
