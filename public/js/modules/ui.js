// ============ 基础 UI 控制：时钟 / 搜索引擎 / 行情条翻页 ============
import { getSettings, updateSettings } from './settings-store.js';

// ---- 实时时钟 ----
const clockEl = document.getElementById('clock');
const dateInfoEl = document.getElementById('dateInfo');

function updateClock() {
    const now = new Date();
    clockEl.innerText = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    // 完美处理日期和星期的空格
    dateInfoEl.innerText = dateStr.replace(/(日)\s*(星期)/, '$1 $2');
}

// ---- 搜索引擎 ----
const engines = {
    bing: { name: '必应', url: 'https://www.bing.com/search?q=', color: '#00809D' },
    baidu: { name: '百度', url: 'https://www.baidu.com/s?wd=', color: '#2932E1' },
    google: { name: '谷歌', url: 'https://www.google.com/search?q=', color: '#EA4335' },
    duck: { name: 'Duck', url: 'https://duckduckgo.com/?q=', color: '#DE5833' }
};
const storedEngine = getSettings().search.engine;
let currentEngine = engines[storedEngine] ? storedEngine : 'bing';

export function setSearchEngine(engine, persist = true) {
    if (!engines[engine]) engine = 'bing';
    currentEngine = engine;
    if (persist && getSettings().search.engine !== engine) updateSettings('search', { engine });
    document.getElementById('searchInput').placeholder = `在 ${engines[engine].name} 上搜索...`;
    Object.keys(engines).forEach(key => {
        const btn = document.getElementById('eng-' + key);
        if (!btn) return;
        btn.style.setProperty('--engine-color', engines[key].color);
        btn.classList.toggle('active', key === engine);
        btn.setAttribute('aria-pressed', String(key === engine));
    });
    const mobileSelect = document.getElementById('searchEngineSelect');
    if (mobileSelect) mobileSelect.value = engine;
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
    document.querySelectorAll('[data-engine]').forEach(button => {
        button.addEventListener('click', () => setSearchEngine(button.dataset.engine));
    });
    document.getElementById('searchEngineSelect')?.addEventListener('change', event => {
        setSearchEngine(event.target.value);
    });
    window.addEventListener('gx:settings-changed', event => {
        const engine = event.detail?.settings?.search?.engine;
        if (engine && engine !== currentEngine) setSearchEngine(engine, false);
    });
    document.querySelectorAll('[data-ticker-scroll]').forEach(button => {
        button.addEventListener('click', () => scrollTicker(Number(button.dataset.tickerScroll) || 0));
    });
}
