import { getSettings, isQuietScene, isScreenSaver, isWidgetVisible, setScreenSaver } from './settings-store.js?v=workspace-20261114c';

const targets = {
    date: '#dateInfo', weather: '#weatherInfoBtn', search: '#search-bar', shortcuts: '#dockRow',
    news: '#newsAside', ticker: '#bottom-ticker', wallpaperButton: '#wallpaperBtn',
    favoriteButton: '#favoriteControl', filterButton: '#filterBtn', settingsButton: '#settingsBtn',
};

export function initWidgets() {
    const root = document.documentElement;
    const recovery = document.getElementById('layoutRecovery');
    const controls = document.getElementById('controlCenter');
    const controlsToggle = document.getElementById('controlCenterToggle');
    const controlsDrawer = document.getElementById('controlCenterDrawer');
    let recoveryTimer;

    function setControlsOpen(open) {
        if (!controls || !controlsToggle || !controlsDrawer) return;
        controls.classList.toggle('is-open', open);
        controlsToggle.setAttribute('aria-expanded', String(open));
        controlsToggle.setAttribute('aria-label', open ? '收起快捷控制栏' : '展开快捷控制栏');
        controlsToggle.title = open ? '收起快捷控制栏' : '快捷控制栏';
        controlsDrawer.inert = !open;
    }

    function sync() {
        Object.entries(targets).forEach(([name, selector]) => {
            const el = document.querySelector(selector);
            if (el) el.hidden = !isWidgetVisible(name);
        });
        const visible = getSettings().widgets;
        const saver = isScreenSaver();
        root.classList.toggle('screen-saver', saver);
        root.classList.toggle('quiet-scene', isQuietScene());
        root.classList.toggle('news-hidden', !isWidgetVisible('news'));
        root.classList.toggle('ticker-hidden', !isWidgetVisible('ticker'));
        const meta = document.getElementById('heroMeta');
        if (meta) meta.hidden = !isWidgetVisible('date') && !isWidgetVisible('weather');
        const divider = document.getElementById('heroMetaDivider');
        if (divider) divider.hidden = !isWidgetVisible('date') || !isWidgetVisible('weather');
        const hideControls = saver || isQuietScene();
        if (controls) controls.hidden = hideControls;
        if (hideControls) setControlsOpen(false);
        recovery.hidden = !saver && visible.settingsButton;
        document.getElementById('leaveScreenSaver').hidden = !saver;
        document.getElementById('screenSaverBtn').setAttribute('aria-pressed', String(saver));
        window.dispatchEvent(new CustomEvent('gx:layout-changed'));
    }
    function revealRecovery() {
        if (recovery.hidden) return;
        root.classList.add('recovery-visible');
        window.clearTimeout(recoveryTimer);
        recoveryTimer = window.setTimeout(() => {
            if (!recovery.contains(document.activeElement) && !recovery.matches(':hover')) {
                root.classList.remove('recovery-visible');
            }
        }, 3000);
    }
    if (controls && controlsToggle && controlsDrawer) {
        controlsToggle.addEventListener('click', event => {
            event.stopPropagation();
            setControlsOpen(!controls.classList.contains('is-open'));
        });
        document.addEventListener('pointerdown', event => {
            if (controls.classList.contains('is-open') && !controls.contains(event.target)) {
                setControlsOpen(false);
            }
        }, { passive: true });
        for (const id of ['settingsBtn', 'screenSaverBtn']) {
            document.getElementById(id)?.addEventListener('click', () => setControlsOpen(false));
        }
    }
    document.getElementById('screenSaverBtn').addEventListener('click', () => setScreenSaver(true));
    document.getElementById('settingsScreenSaver').addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('gx:close-settings'));
        setScreenSaver(true);
    });
    document.getElementById('leaveScreenSaver').addEventListener('click', () => setScreenSaver(false));
    document.getElementById('recoverSettings').addEventListener('click', () => {
        setScreenSaver(false);
        window.dispatchEvent(new CustomEvent('gx:open-settings'));
    });
    window.addEventListener('pointermove', revealRecovery, { passive: true });
    window.addEventListener('pointerdown', revealRecovery, { passive: true });
    document.addEventListener('keydown', event => {
        revealRecovery();
        const editing = event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]');
        if (event.key === 'Escape') {
            if (isScreenSaver()) setScreenSaver(false);
            else if (controls?.classList.contains('is-open')) setControlsOpen(false);
        }
        if (!editing && event.key.toLowerCase() === 's' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            setScreenSaver(false);
            window.dispatchEvent(new CustomEvent('gx:open-settings'));
        }
    });
    window.addEventListener('gx:settings-changed', event => {
        if (['widgets', 'all'].includes(event.detail?.section)) sync();
    });
    setControlsOpen(false);
    sync();
}
