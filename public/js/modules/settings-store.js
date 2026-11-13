import { safeStorageGet, safeStorageSet } from './storage.js?v=workspace-20261114a';

const SETTINGS_KEY = 'gxSettingsV1';

export const FONT_OPTIONS = [
    { id: 'modern', label: '现代黑体', family: '"Inter", "PingFang SC", "Microsoft YaHei", sans-serif' },
    { id: 'system', label: '系统字体', family: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
    { id: 'serif', label: '书卷宋体', family: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, serif' },
    { id: 'wenkai', label: '霞鹜文楷', family: '"LXGW WenKai", KaiTi, "STKaiti", serif' },
    { id: 'mono', label: '等宽字体', family: '"JetBrains Mono", "Sarasa Mono SC", Consolas, "Microsoft YaHei", monospace' },
];

export const DEFAULT_SHORTCUTS = [
    { id: 'bilibili', name: 'Bilibili', url: 'https://bilibili.com' },
    { id: 'twitter', name: 'Twitter', url: 'https://x.com' },
    { id: 'github', name: 'GitHub', url: 'https://github.com' },
    { id: 'douyin', name: '抖音', url: 'https://douyin.com' },
    { id: 'discord', name: 'Discord', url: 'https://discord.com' },
];

export const DEFAULT_SETTINGS = {
    version: 1,
    widgets: {
        date: true, weather: true, search: true, shortcuts: true, news: true, ticker: true,
        wallpaperButton: true, favoriteButton: true, filterButton: true, settingsButton: true,
    },
    search: { engine: 'bing' },
    weather: {
        mode: 'server',
        city: '沈阳',
        latitude: 41.80,
        longitude: 123.43,
    },
    news: {
        category: 'all',
        source: 'all',
        communitySource: 'all',
        fontSize: 'sm',
        importantOnly: false,
        autoRefresh: true,
        filterBarOpen: false,
        groupByTime: true,
        hiddenSources: [],
        readingView: 'all',
        density: 'standard',
    },
    wallpaper: {
        // mix = 收藏 + 每日必应一起轮换（新图仍有机会被看到并收藏）
        // favorites = 只轮换收藏夹（收藏夹为空时自动退回 mix）
        rotation: 'mix',
    },
    ticker: {
        showAll: true,
        favorites: [],
        order: [],
    },
    appearance: {
        weatherEffects: true,
        ripple: false,
        glassGlow: true,
        glassRefraction: true,
        timeTint: true,
        nightSky: true,
        numberMotion: true,
        powerSaving: false,
        panelOpacity: 60,
    },
    typography: { interfaceFont: 'modern', newsFont: 'inherit', clockFont: 'mono' },
    layout: {
        newsPanelWidth: null,
        newsPanelMode: 'compact',
        fullScreenLayout: 'split',
    },
    shortcuts: DEFAULT_SHORTCUTS,
};

function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function stringList(value) {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.map(item => String(item || '').trim()).filter(Boolean))).slice(0, 100);
}

export function normalizeShortcutUrl(value) {
    let candidate = String(value || '').trim();
    if (!candidate) return '';
    if (!/^[a-z][a-z\d+.-]*:/i.test(candidate)) candidate = `https://${candidate}`;
    try {
        const parsed = new URL(candidate);
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
    } catch {
        return '';
    }
}

function sanitizeShortcuts(value) {
    if (!Array.isArray(value)) return clone(DEFAULT_SHORTCUTS);
    const seen = new Set();
    const sanitized = [];
    value.slice(0, 12).forEach((item, index) => {
        const url = normalizeShortcutUrl(item?.url);
        if (!url) return;
        let id = String(item?.id || `custom-${index + 1}`).replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
        if (!id || seen.has(id)) id = `custom-${Date.now()}-${index}`;
        seen.add(id);
        sanitized.push({
            id,
            name: String(item?.name || '链接').trim().slice(0, 24) || '链接',
            url,
        });
    });
    return sanitized;
}

function sanitizeSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    const weather = source.weather && typeof source.weather === 'object' ? source.weather : {};
    const latitude = Number(weather.latitude);
    const longitude = Number(weather.longitude);
    const news = source.news && typeof source.news === 'object' ? source.news : {};
    const legacyForumSource = news.communitySource === undefined && news.category === 'community'
        && ['nodeseek', 'linuxdo'].includes(news.source);
    const wallpaper = source.wallpaper && typeof source.wallpaper === 'object' ? source.wallpaper : {};
    const ticker = source.ticker && typeof source.ticker === 'object' ? source.ticker : {};
    const appearance = source.appearance && typeof source.appearance === 'object' ? source.appearance : {};
    const layout = source.layout && typeof source.layout === 'object' ? source.layout : {};
    const typography = source.typography && typeof source.typography === 'object' ? source.typography : {};
    const fontIds = FONT_OPTIONS.map(font => font.id);
    const search = source.search && typeof source.search === 'object' ? source.search : {};
    const widgets = source.widgets && typeof source.widgets === 'object' ? source.widgets : {};
    const panelWidth = Number.parseInt(layout.newsPanelWidth, 10);

    return {
        version: 1,
        widgets: Object.fromEntries(Object.keys(DEFAULT_SETTINGS.widgets).map(key => [key, widgets[key] !== false])),
        search: {
            engine: ['bing', 'baidu', 'google', 'duck'].includes(search.engine) ? search.engine : 'bing',
        },
        weather: {
            mode: weather.mode === 'city' ? 'city' : 'server',
            city: String(weather.city || '沈阳').trim().slice(0, 40) || '沈阳',
            latitude: Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 ? latitude : 41.80,
            longitude: Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 ? longitude : 123.43,
        },
        news: {
            category: ['all', 'news', 'foreign', 'tech', 'community'].includes(news.category) ? news.category : 'all',
            source: legacyForumSource ? 'all' : String(news.source || 'all').slice(0, 80),
            communitySource: ['all', 'nodeseek', 'linuxdo'].includes(news.communitySource)
                ? news.communitySource : legacyForumSource ? news.source : 'all',
            fontSize: ['sm', 'base', 'lg'].includes(news.fontSize) ? news.fontSize : 'sm',
            importantOnly: Boolean(news.importantOnly),
            autoRefresh: news.autoRefresh !== false,
            filterBarOpen: Boolean(news.filterBarOpen),
            groupByTime: news.groupByTime !== false,
            hiddenSources: stringList(news.hiddenSources).filter(source => ['nodeseek', 'linuxdo'].includes(source)),
            readingView: ['all','unread','saved'].includes(news.readingView) ? news.readingView : 'all',
            density: ['compact','standard','relaxed'].includes(news.density) ? news.density : 'standard',
        },
        wallpaper: {
            rotation: ['mix', 'favorites'].includes(wallpaper.rotation) ? wallpaper.rotation : 'mix',
        },
        ticker: {
            showAll: ticker.showAll !== false,
            favorites: stringList(ticker.favorites),
            order: stringList(ticker.order),
        },
        appearance: {
            weatherEffects: appearance.weatherEffects !== false,
            ripple: Boolean(appearance.ripple),
            glassGlow: appearance.glassGlow !== false,
            glassRefraction: appearance.glassRefraction !== false,
            timeTint: appearance.timeTint !== false,
            nightSky: appearance.nightSky !== false,
            numberMotion: appearance.numberMotion !== false,
            powerSaving: Boolean(appearance.powerSaving),
            panelOpacity: Number.isFinite(appearance.panelOpacity) ? Math.max(20,Math.min(95,appearance.panelOpacity)) : 60,
        },
        typography: {
            interfaceFont: fontIds.includes(typography.interfaceFont) ? typography.interfaceFont : 'modern',
            newsFont: ['inherit', ...fontIds].includes(typography.newsFont) ? typography.newsFont : 'inherit',
            clockFont: fontIds.includes(typography.clockFont) ? typography.clockFont : 'mono',
        },
        layout: {
            newsPanelWidth: Number.isFinite(panelWidth) && panelWidth >= 280 ? Math.min(panelWidth, 10000) : null,
            newsPanelMode: ['compact', 'wide', 'full'].includes(layout.newsPanelMode) ? layout.newsPanelMode : 'compact',
            fullScreenLayout: ['split', 'single'].includes(layout.fullScreenLayout) ? layout.fullScreenLayout : 'split',
        },
        shortcuts: sanitizeShortcuts(source.shortcuts),
    };
}

function legacySettings() {
    const settings = clone(DEFAULT_SETTINGS);
    const engine = safeStorageGet('preferredEngine', 'bing');
    const category = safeStorageGet('newsCategoryFilter', 'all');
    const fontSize = safeStorageGet('newsFontSize', 'sm');
    const source = safeStorageGet('newsSourceFilter', 'all');
    const panelWidth = Number.parseInt(safeStorageGet('newsPanelWidth', ''), 10);
    settings.search.engine = engine;
    settings.news.category = category;
    settings.news.fontSize = fontSize;
    settings.news.source = source;
    settings.news.importantOnly = safeStorageGet('newsImportantOnly', '0') === '1';
    settings.appearance.ripple = safeStorageGet('fluidRippleMode', 'off') === 'light';
    settings.layout.newsPanelWidth = Number.isFinite(panelWidth) ? panelWidth : null;
    return sanitizeSettings(settings);
}

function loadSettings() {
    const raw = safeStorageGet(SETTINGS_KEY, '');
    if (raw) {
        try {
            return sanitizeSettings(JSON.parse(raw));
        } catch {
            // Fall through to the legacy migration.
        }
    }
    const migrated = legacySettings();
    safeStorageSet(SETTINGS_KEY, JSON.stringify(migrated));
    return migrated;
}

let currentSettings = loadSettings();
let screenSaver = false;

export function isScreenSaver() { return screenSaver; }

export function isQuietScene() {
    return screenSaver || Object.values(currentSettings.widgets).every(value => !value);
}

export function isWidgetVisible(name) {
    return !screenSaver && currentSettings.widgets[name] !== false;
}

export function getEffectiveAppearance() {
    const appearance = clone(currentSettings.appearance);
    if (isQuietScene()) {
        Object.keys(appearance).forEach(key => { appearance[key] = key === 'powerSaving'; });
    }
    return appearance;
}

export function setScreenSaver(value) {
    if (screenSaver === Boolean(value)) return;
    screenSaver = Boolean(value);
    window.dispatchEvent(new CustomEvent('gx:settings-changed', {
        detail: { section: 'widgets', settings: getSettings() },
    }));
}

function publish(section) {
    safeStorageSet(SETTINGS_KEY, JSON.stringify(currentSettings));
    window.dispatchEvent(new CustomEvent('gx:settings-changed', {
        detail: { section, settings: clone(currentSettings) },
    }));
}

export function getSettings() {
    return clone(currentSettings);
}

export function updateSettings(section, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, section)) return getSettings();
    const next = clone(currentSettings);
    next[section] = Array.isArray(value)
        ? value
        : { ...(next[section] || {}), ...(value || {}) };
    currentSettings = sanitizeSettings(next);
    publish(section);
    return getSettings();
}

export function resetSettings() {
    currentSettings = sanitizeSettings(clone(DEFAULT_SETTINGS));
    publish('all');
    return getSettings();
}
