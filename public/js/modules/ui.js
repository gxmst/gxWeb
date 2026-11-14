// ============ 基础 UI 控制：时钟 / 搜索引擎 / 行情条翻页 ============
import { getSettings, updateSettings } from './settings-store.js?v=workspace-20261114b';

// ---- 实时时钟 ----
const clockEl = document.getElementById('clock');
const dateInfoEl = document.getElementById('dateInfo');
let lastTimeKey = '';

function updateClock() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const timeKey = `${hh}:${mm}`;
    if (clockEl && timeKey !== lastTimeKey) {
        lastTimeKey = timeKey;
        clockEl.replaceChildren();
        const hourSpan = document.createElement('span');
        hourSpan.className = 'font-bold';
        hourSpan.textContent = hh;
        const colonSpan = document.createElement('span');
        colonSpan.className = 'clock-colon font-light text-white/75';
        colonSpan.textContent = ':';
        const minSpan = document.createElement('span');
        minSpan.className = 'font-medium text-white/95';
        minSpan.textContent = mm;
        clockEl.append(hourSpan, colonSpan, minSpan);
    }
    const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    // 完美处理日期和星期的空格
    if (dateInfoEl) dateInfoEl.innerText = dateStr.replace(/(日)\s*(星期)/, '$1 · $2');
}

// ---- 搜索引擎 ----
const engines = {
    bing: { name: '必应', url: 'https://www.bing.com/search?q=', color: '#38bdf8', rgb: '56, 189, 248' },
    baidu: { name: '百度', url: 'https://www.baidu.com/s?wd=', color: '#60a5fa', rgb: '96, 165, 250' },
    google: { name: '谷歌', url: 'https://www.google.com/search?q=', color: '#f87171', rgb: '248, 113, 113' },
    duck: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=', color: '#fb923c', rgb: '251, 146, 60' }
};
const storedEngine = getSettings().search.engine;
let currentEngine = engines[storedEngine] ? storedEngine : 'bing';

function engineIcon(engine) {
    if (engine === 'google') return '<img src="./icons/google.svg" width="18" height="18" alt="">';
    const paths = {
        bing: 'M5.7 3v14.6l4.2 2.4 8.4-4.9v-4.2l-6.2-2.2 1.4-3.2L5.7 3zm4.2 6.8 4.7 1.7-4.7 2.7V9.8z',
        baidu: 'M8.8 9.2c1.1 0 2-1.2 2-2.6S9.9 4 8.8 4s-2 1.2-2 2.6.9 2.6 2 2.6zm6.4 0c1.1 0 2-1.2 2-2.6S16.3 4 15.2 4s-2 1.2-2 2.6.9 2.6 2 2.6zM5.2 12.6c1 0 1.8-1.1 1.8-2.4S6.2 7.8 5.2 7.8s-1.8 1.1-1.8 2.4.8 2.4 1.8 2.4zm13.6 0c1 0 1.8-1.1 1.8-2.4s-.8-2.4-1.8-2.4-1.8 1.1-1.8 2.4.8 2.4 1.8 2.4zM12 10.6c-2.6 0-4.9 1.9-5.8 4.4-.7 1.9.4 4.2 2.5 4.7 1 .2 2.1-.2 3.3-.2s2.3.4 3.3.2c2.1-.5 3.2-2.8 2.5-4.7-.9-2.5-3.2-4.4-5.8-4.4z',
        duck: 'M12 2a10 10 0 100 20 10 10 0 000-20zm.2 4.3c2.1 0 3.7 1.5 4 3.6l2.3.5c.4.1.6.5.4.8-.6 1-1.8 1.5-2.9 1.4l-.2 2.4c1.2.4 2.1 1.4 2.3 2.7H7.9c.2-1.8 1.2-3.3 2.5-4.1-.5-.9-.8-2-.8-3.1 0-2.4 1.2-4.2 2.6-4.2z',
    };
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="${paths[engine]}"/></svg>`;
}

export function setSearchEngine(engine, persist = true) {
    if (!engines[engine]) engine = 'bing';
    currentEngine = engine;
    if (persist && getSettings().search.engine !== engine) updateSettings('search', { engine });
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.placeholder = `在 ${engines[engine].name} 上搜索...`;
    Object.keys(engines).forEach(key => {
        const btn = document.getElementById('eng-' + key);
        if (!btn) return;
        btn.classList.toggle('active', key === engine);
        btn.setAttribute('aria-checked', String(key === engine));
        btn.querySelector('[data-engine-icon]').innerHTML = engineIcon(key);
    });
    document.getElementById('searchEngineIcon').innerHTML = engineIcon(engine);
    document.getElementById('searchEngineName').textContent = engines[engine].name;
    document.getElementById('searchEngineButton').setAttribute('aria-label', `当前使用${engines[engine].name}，切换搜索引擎`);
}

export function handleSearch() {
    const query = document.getElementById('searchInput').value.trim();
    const engine = engines[currentEngine] || engines.bing;
    if (query) {
        const popup = window.open(engine.url + encodeURIComponent(query), '_blank', 'noopener,noreferrer');
        if (popup) popup.opener = null;
    }
}

// ---- 行情条翻页 ----
export function scrollTicker(amount) {
    document.getElementById('tickerScroll').scrollBy({ left: amount, behavior: 'smooth' });
}

export function initUI() {
    setInterval(updateClock, 1000);
    updateClock();
    setSearchEngine(currentEngine);
    document.getElementById('searchInput').addEventListener('keydown', event => {
        if (event.key === 'Enter') handleSearch();
    });
    const engineButton = document.getElementById('searchEngineButton');
    const menu = document.getElementById('searchEngineMenu');
    const closeMenu = (focus=false) => { menu.hidden = true; engineButton.setAttribute('aria-expanded','false'); if(focus) engineButton.focus(); };
    const openMenu = () => { menu.hidden = false; engineButton.setAttribute('aria-expanded','true'); menu.querySelector(`[data-engine="${currentEngine}"]`).focus(); };
    engineButton.addEventListener('click', () => menu.hidden ? openMenu() : closeMenu());
    engineButton.addEventListener('keydown', event => { if(event.key === 'ArrowDown') {event.preventDefault();openMenu();} });
    menu.addEventListener('keydown', event => {
        const options = Array.from(menu.querySelectorAll('button'));
        const index = options.indexOf(document.activeElement);
        if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length-1 : (index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;
            options[next].focus();
        }
        if(event.key === 'Escape') {event.preventDefault();closeMenu(true);}
    });
    document.querySelectorAll('[data-engine]').forEach(button => {
        button.addEventListener('click', () => { setSearchEngine(button.dataset.engine); closeMenu(true); });
    });
    document.addEventListener('pointerdown', event => { if(!menu.hidden && !menu.contains(event.target) && !engineButton.contains(event.target)) closeMenu(); });
    document.addEventListener('focusin', event => { if(!menu.hidden && !menu.contains(event.target) && event.target !== engineButton) closeMenu(); });
    window.addEventListener('gx:layout-changed', () => closeMenu());
    window.addEventListener('gx:settings-changed', event => {
        const engine = event.detail?.settings?.search?.engine;
        if (engine && engine !== currentEngine) setSearchEngine(engine, false);
    });
    document.querySelectorAll('[data-ticker-scroll]').forEach(button => {
        button.addEventListener('click', () => scrollTicker(Number(button.dataset.tickerScroll) || 0));
    });
}
