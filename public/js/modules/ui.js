// ============ 基础 UI 控制：时钟 / 搜索引擎 / 行情条翻页 ============
import { safeStorageGet, safeStorageSet } from './storage.js';

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
const storedEngine = safeStorageGet('preferredEngine', 'bing');
let currentEngine = engines[storedEngine] ? storedEngine : 'bing';

export function setSearchEngine(engine) {
    if (!engines[engine]) engine = 'bing';
    currentEngine = engine;
    safeStorageSet('preferredEngine', engine);
    document.getElementById('searchInput').placeholder = `在 ${engines[engine].name} 上搜索...`;
    Object.keys(engines).forEach(key => {
        const btn = document.getElementById('eng-' + key);
        if (key === engine) {
            btn.style.color = engines[key].color;
            btn.className = 'px-3 py-1 rounded-full bg-white/20 text-white font-bold shadow-lg transition-all shrink-0 scale-105 border border-white/20';
        } else {
            btn.style.color = '';
            btn.className = 'px-3 py-1 rounded-full text-white/60 hover:text-white transition-all shrink-0 hover:bg-white/10';
        }
    });
}

export function handleSearch(event) {
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
}

// 内联 onclick 引用的全局函数
window.setSearchEngine = setSearchEngine;
window.handleSearch = handleSearch;
window.scrollTicker = scrollTicker;
