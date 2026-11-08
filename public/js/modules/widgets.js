import { getSettings, isQuietScene, isScreenSaver, isWidgetVisible, setScreenSaver } from './settings-store.js';

const targets = {
    date: '#dateInfo', weather: '#weatherInfoBtn', search: '#search-bar', shortcuts: '#dockRow',
    news: '#newsAside', ticker: '#bottom-ticker', wallpaperButton: '#wallpaperBtn',
    favoriteButton: '#favoriteControl', filterButton: '#filterBtn', settingsButton: '#settingsBtn',
};

export function initWidgets() {
    const root = document.documentElement;
    const recovery = document.getElementById('layoutRecovery');
    let recoveryTimer;
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
        const controls = document.getElementById('controlCenter');
        if (controls) controls.hidden = saver || isQuietScene();
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
        if (event.key === 'Escape' && isScreenSaver()) setScreenSaver(false);
        if (!editing && event.key.toLowerCase() === 's' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            setScreenSaver(false);
            window.dispatchEvent(new CustomEvent('gx:open-settings'));
        }
    });
    window.addEventListener('gx:settings-changed', event => {
        if (['widgets', 'all'].includes(event.detail?.section)) sync();
    });
    sync();
}
