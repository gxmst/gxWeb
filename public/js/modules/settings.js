import {
    getSettings,
    normalizeShortcutUrl,
    resetSettings,
    updateSettings,
} from './settings-store.js';

let shortcutTemplates = new Map();
let availableTickers = [];
let availableNewsSources = [];
let lastFocusedElement = null;
let resetTimer = null;

function applyAppearanceClasses(settings = getSettings()) {
    const root = document.documentElement;
    root.classList.toggle('weather-effects-off', !settings.appearance.weatherEffects);
    root.classList.toggle('tilt-off', !settings.appearance.tilt);
    root.classList.toggle('power-saving', settings.appearance.powerSaving);
}

function captureShortcutTemplates() {
    const dock = document.getElementById('dockRow');
    if (!dock) return;
    shortcutTemplates = new Map();
    dock.querySelectorAll('[data-shortcut-id]').forEach(anchor => {
        shortcutTemplates.set(anchor.dataset.shortcutId, anchor.cloneNode(true));
    });
}

function genericShortcut(shortcut) {
    const anchor = document.createElement('a');
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.className = 'flex flex-col items-center gap-3 group transition-all hover:-translate-y-2 shrink-0 snap-start';

    const icon = document.createElement('div');
    icon.className = 'dock-ico w-12 h-12 bg-white/10 backdrop-blur-md border border-white/20 text-white rounded-2xl flex items-center justify-center group-hover:bg-white/20 group-hover:scale-110 transition-all duration-300 font-semibold shadow-lg';
    icon.textContent = Array.from(shortcut.name || '链')[0]?.toUpperCase() || '链';

    const label = document.createElement('span');
    label.className = 'text-xs text-white/90 font-medium drop-shadow-md group-hover:text-white transition-colors max-w-20 truncate';
    anchor.append(icon, label);
    return anchor;
}

function renderDock(settings = getSettings()) {
    const dock = document.getElementById('dockRow');
    if (!dock) return;
    const fragment = document.createDocumentFragment();
    settings.shortcuts.forEach(shortcut => {
        const template = shortcutTemplates.get(shortcut.id);
        const anchor = template ? template.cloneNode(true) : genericShortcut(shortcut);
        anchor.dataset.shortcutId = shortcut.id;
        anchor.href = shortcut.url;
        const label = anchor.querySelector('span:last-child');
        if (label) label.textContent = shortcut.name;
        fragment.appendChild(anchor);
    });
    dock.replaceChildren(fragment);
    window.dispatchEvent(new CustomEvent('gx:shortcuts-rendered'));
}

function iconButton(label, path, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.disabled = disabled;
    button.setAttribute('aria-label', label);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('class', 'h-4 w-4');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('d', path);
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('stroke-width', '2');
    svg.appendChild(line);
    button.appendChild(svg);
    return button;
}

function renderShortcutEditor(settings = getSettings()) {
    const list = document.getElementById('shortcutSettingsList');
    const addButton = document.getElementById('addShortcutButton');
    if (!list) return;
    if (addButton) addButton.disabled = settings.shortcuts.length >= 12;
    const fragment = document.createDocumentFragment();
    settings.shortcuts.forEach((shortcut, index) => {
        const row = document.createElement('div');
        row.className = 'shortcut-setting-row grid grid-cols-[minmax(0,1fr)_auto] gap-3';

        const fields = document.createElement('div');
        fields.className = 'min-w-0';
        const name = document.createElement('input');
        name.type = 'text';
        name.value = shortcut.name;
        name.maxLength = 24;
        name.setAttribute('aria-label', `${shortcut.name} 名称`);
        const url = document.createElement('input');
        url.type = 'text';
        url.inputMode = 'url';
        url.value = shortcut.url;
        url.setAttribute('aria-label', `${shortcut.name} 网址`);
        fields.append(name, url);

        name.addEventListener('change', () => {
            const value = name.value.trim().slice(0, 24) || '链接';
            const next = getSettings().shortcuts;
            next[index] = { ...next[index], name: value };
            updateSettings('shortcuts', next);
        });
        url.addEventListener('change', () => {
            const normalized = normalizeShortcutUrl(url.value);
            url.setAttribute('aria-invalid', String(!normalized));
            if (!normalized) return;
            const next = getSettings().shortcuts;
            next[index] = { ...next[index], url: normalized };
            updateSettings('shortcuts', next);
        });

        const actions = document.createElement('div');
        actions.className = 'settings-row-actions';
        const up = iconButton('上移', 'M12 19V5m0 0l-6 6m6-6l6 6', index === 0);
        const down = iconButton('下移', 'M12 5v14m0 0l-6-6m6 6l6-6', index === settings.shortcuts.length - 1);
        const remove = iconButton('删除', 'M4 7h16m-10 4v6m4-6v6M9 7l1-2h4l1 2m-9 0l1 13h10l1-13');
        up.addEventListener('click', () => moveShortcut(index, -1));
        down.addEventListener('click', () => moveShortcut(index, 1));
        remove.addEventListener('click', () => {
            const next = getSettings().shortcuts;
            next.splice(index, 1);
            updateSettings('shortcuts', next);
        });
        actions.append(up, down, remove);
        row.append(fields, actions);
        fragment.appendChild(row);
    });
    list.replaceChildren(fragment);
}

function moveShortcut(index, direction) {
    const next = getSettings().shortcuts;
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    updateSettings('shortcuts', next);
}

function orderedTickers(settings = getSettings()) {
    const positions = new Map(settings.ticker.order.map((symbol, index) => [String(symbol), index]));
    return availableTickers.slice().sort((a, b) => {
        const aSymbol = String(a.symbol);
        const bSymbol = String(b.symbol);
        const ai = positions.has(aSymbol) ? positions.get(aSymbol) : Number.MAX_SAFE_INTEGER;
        const bi = positions.has(bSymbol) ? positions.get(bSymbol) : Number.MAX_SAFE_INTEGER;
        return ai - bi || a.name.localeCompare(b.name, 'zh-CN');
    });
}

function renderTickerEditor(settings = getSettings()) {
    const list = document.getElementById('tickerSettingsList');
    const empty = document.getElementById('tickerSettingsEmpty');
    if (!list || !empty) return;
    empty.hidden = availableTickers.length > 0;
    if (!availableTickers.length) {
        list.replaceChildren();
        return;
    }
    const tickers = orderedTickers(settings);
    const allSymbols = tickers.map(item => String(item.symbol));
    const selected = settings.ticker.showAll ? new Set(allSymbols) : new Set(settings.ticker.favorites);
    const fragment = document.createDocumentFragment();
    tickers.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'ticker-setting-row flex items-center gap-3';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        const symbol = String(item.symbol);
        checkbox.checked = selected.has(symbol);
        checkbox.className = 'h-4 w-4 shrink-0 accent-sky-400';
        checkbox.setAttribute('aria-label', `显示 ${item.name}`);
        const text = document.createElement('div');
        text.className = 'min-w-0 flex-1';
        const name = document.createElement('div');
        name.className = 'truncate text-sm text-white/80';
        name.textContent = item.name;
        const category = document.createElement('div');
        category.className = 'mt-0.5 text-[10px] text-white/35';
        category.textContent = item.category || '未分类';
        text.append(name, category);

        checkbox.addEventListener('change', () => {
            const current = getSettings();
            const nextSelected = current.ticker.showAll
                ? new Set(allSymbols)
                : new Set(current.ticker.favorites);
            if (checkbox.checked) nextSelected.add(symbol);
            else nextSelected.delete(symbol);
            const showAll = nextSelected.size === allSymbols.length;
            updateSettings('ticker', {
                showAll,
                favorites: showAll ? [] : Array.from(nextSelected),
                order: allSymbols,
            });
        });

        const actions = document.createElement('div');
        actions.className = 'settings-row-actions !grid-cols-2';
        const up = iconButton('上移', 'M12 19V5m0 0l-6 6m6-6l6 6', index === 0);
        const down = iconButton('下移', 'M12 5v14m0 0l-6-6m6 6l6-6', index === tickers.length - 1);
        up.addEventListener('click', () => moveTicker(index, -1, tickers));
        down.addEventListener('click', () => moveTicker(index, 1, tickers));
        actions.append(up, down);
        row.append(checkbox, text, actions);
        fragment.appendChild(row);
    });
    list.replaceChildren(fragment);
}

function moveTicker(index, direction, tickers) {
    const target = index + direction;
    if (target < 0 || target >= tickers.length) return;
    const order = tickers.map(item => String(item.symbol));
    [order[index], order[target]] = [order[target], order[index]];
    updateSettings('ticker', { order });
}

function renderNewsSources(settings = getSettings()) {
    const select = document.getElementById('settingsNewsSource');
    if (!select) return;
    const fragment = document.createDocumentFragment();
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = '全部来源';
    fragment.appendChild(all);
    availableNewsSources.forEach(source => {
        const option = document.createElement('option');
        option.value = source.value;
        option.textContent = source.label;
        fragment.appendChild(option);
    });
    if (settings.news.source !== 'all' && !availableNewsSources.some(item => item.value === settings.news.source)) {
        const stored = document.createElement('option');
        stored.value = settings.news.source;
        stored.textContent = settings.news.source;
        fragment.appendChild(stored);
    }
    select.replaceChildren(fragment);
    select.value = settings.news.source;
}

function syncControls(settings = getSettings()) {
    const setValue = (id, value) => { const element = document.getElementById(id); if (element) element.value = value; };
    const setChecked = (id, value) => { const element = document.getElementById(id); if (element) element.checked = Boolean(value); };
    setValue('settingsSearchEngine', settings.search.engine);
    setValue('settingsNewsCategory', settings.news.category);
    setValue('settingsNewsFontSize', settings.news.fontSize);
    setChecked('settingsImportantOnly', settings.news.importantOnly);
    setChecked('settingsAutoRefresh', settings.news.autoRefresh);
    setChecked('settingsWeatherEffects', settings.appearance.weatherEffects);
    setChecked('settingsTilt', settings.appearance.tilt);
    setChecked('settingsRipple', settings.appearance.ripple);
    setChecked('settingsPowerSaving', settings.appearance.powerSaving);
    document.getElementById('weatherModeServer')?.setAttribute('aria-pressed', String(settings.weather.mode === 'server'));
    document.getElementById('weatherModeCity')?.setAttribute('aria-pressed', String(settings.weather.mode === 'city'));
    const cityBlock = document.getElementById('citySettingsBlock');
    if (cityBlock) cityBlock.hidden = settings.weather.mode !== 'city';
    const selectedCity = document.getElementById('selectedCityText');
    if (selectedCity) selectedCity.textContent = settings.weather.mode === 'city' ? settings.weather.city : '服务器默认';
    renderNewsSources(settings);
    renderShortcutEditor(settings);
    renderTickerEditor(settings);
}

async function searchCities() {
    const input = document.getElementById('citySearchInput');
    const status = document.getElementById('citySearchStatus');
    const results = document.getElementById('citySearchResults');
    const query = input?.value.trim() || '';
    if (!query || !status || !results) return;
    status.textContent = '搜索中';
    results.replaceChildren();
    try {
        const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
        url.searchParams.set('name', query);
        url.searchParams.set('count', '6');
        url.searchParams.set('language', 'zh');
        url.searchParams.set('format', 'json');
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const cities = Array.isArray(data.results) ? data.results : [];
        status.textContent = cities.length ? `${cities.length} 个结果` : '未找到城市';
        const fragment = document.createDocumentFragment();
        cities.forEach(city => {
            const latitude = Number(city.latitude);
            const longitude = Number(city.longitude);
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'city-result-button';
            const name = document.createElement('span');
            name.className = 'text-sm text-white/80';
            const detail = [city.name, city.admin1].filter(Boolean).join(' · ');
            name.textContent = detail;
            const country = document.createElement('small');
            country.textContent = city.country || '';
            button.append(name, country);
            button.addEventListener('click', () => {
                updateSettings('weather', {
                    mode: 'city',
                    city: detail || String(city.name || query),
                    latitude,
                    longitude,
                });
                status.textContent = '已选择';
                results.replaceChildren();
            });
            fragment.appendChild(button);
        });
        results.replaceChildren(fragment);
    } catch {
        status.textContent = '城市搜索暂不可用';
    }
}

function selectSettingsTab(name) {
    document.querySelectorAll('[data-settings-tab]').forEach(button => {
        button.setAttribute('aria-selected', String(button.dataset.settingsTab === name));
    });
    document.querySelectorAll('[data-settings-panel]').forEach(panel => {
        panel.hidden = panel.dataset.settingsPanel !== name;
    });
}

function setDrawerOpen(open) {
    const overlay = document.getElementById('settingsOverlay');
    const button = document.getElementById('settingsBtn');
    if (!overlay || !button) return;
    overlay.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    document.documentElement.classList.toggle('settings-open', open);
    if (open) {
        lastFocusedElement = document.activeElement;
        syncControls();
        document.getElementById('closeSettingsButton')?.focus();
    } else if (lastFocusedElement instanceof HTMLElement) {
        lastFocusedElement.focus();
    }
}

function trapDrawerFocus(event) {
    const overlay = document.getElementById('settingsOverlay');
    const drawer = document.getElementById('settingsDrawer');
    if (event.key !== 'Tab' || !overlay || overlay.hidden || !drawer) return;
    const focusable = Array.from(drawer.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )).filter(element => !element.closest('[hidden]') && element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!drawer.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function bindControls() {
    document.getElementById('settingsBtn')?.addEventListener('click', () => setDrawerOpen(true));
    document.getElementById('closeSettingsButton')?.addEventListener('click', () => setDrawerOpen(false));
    document.getElementById('settingsOverlay')?.addEventListener('click', event => {
        if (event.target === event.currentTarget) setDrawerOpen(false);
    });
    document.addEventListener('keydown', event => {
        const overlay = document.getElementById('settingsOverlay');
        if (event.key === 'Escape' && overlay && !overlay.hidden) setDrawerOpen(false);
        trapDrawerFocus(event);
    });
    document.querySelectorAll('[data-settings-tab]').forEach(button => {
        button.addEventListener('click', () => selectSettingsTab(button.dataset.settingsTab));
    });
    document.getElementById('weatherModeServer')?.addEventListener('click', () => updateSettings('weather', { mode: 'server' }));
    document.getElementById('weatherModeCity')?.addEventListener('click', () => updateSettings('weather', { mode: 'city' }));
    document.getElementById('citySearchButton')?.addEventListener('click', searchCities);
    document.getElementById('citySearchInput')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); searchCities(); }
    });
    document.getElementById('settingsSearchEngine')?.addEventListener('change', event => updateSettings('search', { engine: event.target.value }));
    document.getElementById('settingsNewsCategory')?.addEventListener('change', event => updateSettings('news', { category: event.target.value }));
    document.getElementById('settingsNewsSource')?.addEventListener('change', event => updateSettings('news', { source: event.target.value }));
    document.getElementById('settingsNewsFontSize')?.addEventListener('change', event => updateSettings('news', { fontSize: event.target.value }));
    document.getElementById('settingsImportantOnly')?.addEventListener('change', event => updateSettings('news', { importantOnly: event.target.checked }));
    document.getElementById('settingsAutoRefresh')?.addEventListener('change', event => updateSettings('news', { autoRefresh: event.target.checked }));
    document.getElementById('settingsWeatherEffects')?.addEventListener('change', event => updateSettings('appearance', { weatherEffects: event.target.checked }));
    document.getElementById('settingsTilt')?.addEventListener('change', event => updateSettings('appearance', { tilt: event.target.checked }));
    document.getElementById('settingsRipple')?.addEventListener('change', event => updateSettings('appearance', { ripple: event.target.checked }));
    document.getElementById('settingsPowerSaving')?.addEventListener('change', event => updateSettings('appearance', { powerSaving: event.target.checked }));
    document.getElementById('addShortcutButton')?.addEventListener('click', () => {
        const next = getSettings().shortcuts;
        if (next.length >= 12) return;
        next.push({ id: `custom-${Date.now()}`, name: '新链接', url: 'https://example.com/' });
        updateSettings('shortcuts', next);
    });
    document.getElementById('resetSettingsButton')?.addEventListener('click', event => {
        const button = event.currentTarget;
        if (button.dataset.armed !== 'true') {
            button.dataset.armed = 'true';
            button.textContent = '再次点击确认';
            window.clearTimeout(resetTimer);
            resetTimer = window.setTimeout(() => {
                button.dataset.armed = 'false';
                button.textContent = '恢复默认设置';
            }, 3000);
            return;
        }
        window.clearTimeout(resetTimer);
        button.dataset.armed = 'false';
        button.textContent = '恢复默认设置';
        resetSettings();
    });
}

export function initSettings() {
    captureShortcutTemplates();
    renderDock();
    applyAppearanceClasses();
    bindControls();
    syncControls();
    window.addEventListener('gx:ticker-data', event => {
        availableTickers = Array.isArray(event.detail?.items) ? event.detail.items : [];
        renderTickerEditor();
    });
    window.addEventListener('gx:news-sources', event => {
        availableNewsSources = Array.isArray(event.detail?.sources) ? event.detail.sources : [];
        renderNewsSources();
    });
    window.addEventListener('gx:settings-changed', event => {
        const settings = event.detail?.settings || getSettings();
        applyAppearanceClasses(settings);
        syncControls(settings);
        if (event.detail?.section === 'shortcuts' || event.detail?.section === 'all') renderDock(settings);
    });
}
