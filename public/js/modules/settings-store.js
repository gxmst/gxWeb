import { safeStorageGet, safeStorageSet } from './storage.js';

const SETTINGS_KEY = 'gxSettingsV1';

export const DEFAULT_SHORTCUTS = [
    { id: 'bilibili', name: 'Bilibili', url: 'https://bilibili.com' },
    { id: 'twitter', name: 'Twitter', url: 'https://x.com' },
    { id: 'github', name: 'GitHub', url: 'https://github.com' },
    { id: 'douyin', name: '抖音', url: 'https://douyin.com' },
    { id: 'discord', name: 'Discord', url: 'https://discord.com' },
];

export const DEFAULT_SETTINGS = {
    version: 1,
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
        fontSize: 'sm',
        importantOnly: false,
        autoRefresh: true,
    },
    ticker: {
        showAll: true,
        favorites: [],
        order: [],
    },
    appearance: {
        weatherEffects: true,
        tilt: true,
        ripple: false,
        powerSaving: false,
    },
    layout: {
        newsPanelWidth: null,
    },
    shortcuts: DEFAULT_SHORTCUTS,
};

function clone(value) {
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
    const ticker = source.ticker && typeof source.ticker === 'object' ? source.ticker : {};
    const appearance = source.appearance && typeof source.appearance === 'object' ? source.appearance : {};
    const layout = source.layout && typeof source.layout === 'object' ? source.layout : {};
    const search = source.search && typeof source.search === 'object' ? source.search : {};
    const panelWidth = Number.parseInt(layout.newsPanelWidth, 10);

    return {
        version: 1,
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
            category: ['all', 'news', 'foreign', 'tech'].includes(news.category) ? news.category : 'all',
            source: String(news.source || 'all').slice(0, 80),
            fontSize: ['sm', 'base', 'lg'].includes(news.fontSize) ? news.fontSize : 'sm',
            importantOnly: Boolean(news.importantOnly),
            autoRefresh: news.autoRefresh !== false,
        },
        ticker: {
            showAll: ticker.showAll !== false,
            favorites: stringList(ticker.favorites),
            order: stringList(ticker.order),
        },
        appearance: {
            weatherEffects: appearance.weatherEffects !== false,
            tilt: appearance.tilt !== false,
            ripple: Boolean(appearance.ripple),
            powerSaving: Boolean(appearance.powerSaving),
        },
        layout: {
            newsPanelWidth: Number.isFinite(panelWidth) && panelWidth >= 350 ? panelWidth : null,
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
