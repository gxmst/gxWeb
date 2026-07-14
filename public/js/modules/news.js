// ================== 新闻流与交互渲染 ==================
let allNewsData = [];
let hasLoadedNews = false;
let currentFilter = 'all';
let lastNewsSignature = '';
let currentFontSize = 'sm';
let newsPollTimer = null;
let newsRequestInFlight = false;

const NEWS_POLL_INTERVAL = 30000;
const MAX_NEWS_ITEMS = 400;

// 供 wallpaper.js 取色后重新对齐指示器读取当前分类
export function getCurrentFilter() { return currentFilter; }

function simpleHash(str) {
    str = String(str || '');
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return h;
}

function newsIdentity(news) {
    const explicitId = news.id ?? news.news_id ?? news.feed_id;
    if (explicitId !== undefined && explicitId !== null && explicitId !== '') return `id-${explicitId}`;
    return `item-${simpleHash([
        news.category, news.source, news.raw_time, news.time, news.url, news.content
    ].join('\u241f')) >>> 0}`;
}

function assignClientKeys(newsList) {
    const occurrences = new Map();
    return newsList.slice(0, MAX_NEWS_ITEMS).map(news => {
        const base = newsIdentity(news);
        const occurrence = occurrences.get(base) || 0;
        occurrences.set(base, occurrence + 1);
        return { ...news, _clientKey: occurrence ? `${base}-${occurrence}` : base };
    });
}

function newsRenderSignature(news) {
    return String(simpleHash(JSON.stringify([
        news._clientKey, news.time, news.display_content, news.content, news.url,
        news.category, news.format, Boolean(news.is_important), currentFontSize
    ])) >>> 0);
}

function datasetSignature(newsList) {
    return String(simpleHash(JSON.stringify(newsList.map(news => [
        news._clientKey, news.time, news.display_content, news.content, news.url,
        news.category, news.format, Boolean(news.is_important)
    ]))) >>> 0);
}

function formatLastUpdated(timestamp, fallback) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return fallback || '刚刚';
    return new Date(value * 1000).toLocaleTimeString('zh-CN', {
        hour: '2-digit', minute: '2-digit', hour12: false
    });
}

function setNewsStatus(kind) {
    const status = document.getElementById('newsHeartbeatStatus');
    const text = document.getElementById('newsStatusText');
    const ping = document.getElementById('newsStatusPing');
    const dot = document.getElementById('newsStatusDot');
    if (!status || !text || !ping || !dot) return;
    const offline = kind === 'offline';
    text.textContent = offline ? '断连' : 'LIVE';
    text.className = `text-[10px] font-bold ${offline ? 'text-red-400' : 'text-green-400'}`;
    ping.className = offline
        ? 'hidden'
        : 'animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75';
    dot.className = `relative inline-flex rounded-full h-2 w-2 ${offline ? 'bg-red-500' : 'bg-green-500'}`;
    status.title = offline ? '快讯连接失败，保留上次成功数据' : '快讯连接正常';
}

function emptyMessage(text) {
    const empty = document.createElement('div');
    empty.className = 'text-center text-white/30 mt-10 text-sm';
    empty.textContent = text;
    return empty;
}

// 使用稳定 key 对齐、更新、重排和删除节点；服务端删掉的条目不会留在 DOM 中。
function renderNewsList(newKeys = new Set(), preserveScroll = false) {
    const listContainer = document.getElementById('newsList');
    const filtered = allNewsData.filter(applyFilter);

    updateTabCounts();
    listContainer.setAttribute('aria-labelledby', `tab-${currentFilter}`);
    if (!hasLoadedNews && allNewsData.length === 0) return;
    const oldScroll = listContainer.scrollTop;
    const oldHeight = listContainer.scrollHeight;
    const existing = new Map(
        Array.from(listContainer.querySelectorAll('[data-news-key]'))
            .map(element => [element.dataset.newsKey, element])
    );
    const fragment = document.createDocumentFragment();
    if (filtered.length === 0) {
        fragment.appendChild(emptyMessage('暂无对应快讯'));
    } else {
        filtered.forEach(news => {
            const signature = newsRenderSignature(news);
            let element = existing.get(news._clientKey);
            if (!element || element.dataset.newsSignature !== signature) {
                element = createNewsElement(news, newKeys.has(news._clientKey));
            }
            fragment.appendChild(element);
        });
    }
    listContainer.replaceChildren(fragment);
    if (preserveScroll && oldScroll > 10) {
        listContainer.scrollTop = Math.max(0, oldScroll + listContainer.scrollHeight - oldHeight);
    }
}

// View Transitions 包装：切 tab / 切字号时让列表交叉淡入形变，而非硬切。
// #newsList 带 view-transition-name（见 components.css），故只有列表参与动画，
// 不会把动态壁纸/WebGL 卷进整页快照。不支持的浏览器或省电模式直接同步执行。
function withViewTransition(mutate) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || typeof document.startViewTransition !== 'function') {
        mutate();
        return;
    }
    document.startViewTransition(mutate);
}

// 字体切换 (0 延时本地秒切)
export function setFontSize(size) {
    if (!['sm', 'base', 'lg'].includes(size)) return;
    currentFontSize = size;
    ['sm', 'base', 'lg'].forEach(s => {
        const btn = document.getElementById('fs-' + s);
        if (s === size) { btn.classList.add('bg-white/20', 'text-white'); btn.classList.remove('text-white/50'); }
        else { btn.classList.remove('bg-white/20', 'text-white'); btn.classList.add('text-white/50'); }
        btn.setAttribute('aria-pressed', String(s === size));
    });
    withViewTransition(renderNewsList);
}

// 分类强调色（rgb 三元组，驱动指示器背景/描边/辉光）
const TAB_ACCENTS = {
    all: '255,255,255',
    news: '96,165,250',     // 蓝
    foreign: '251,191,36',  // 琥珀
    tech: '167,139,250',    // 紫
};

// 移动滑动高亮指示器到当前激活 tab
export function moveTabIndicator(filter) {
    const bar = document.getElementById('tabBar');
    const btn = document.getElementById('tab-' + filter);
    const ind = document.getElementById('tabIndicator');
    if (!bar || !btn || !ind) return;
    const styles = getComputedStyle(document.body);
    const dynamicAccent = `${styles.getPropertyValue('--wall-r').trim() || 255},${styles.getPropertyValue('--wall-g').trim() || 255},${styles.getPropertyValue('--wall-b').trim() || 255}`;
    const accent = filter === 'all' ? dynamicAccent : (TAB_ACCENTS[filter] || dynamicAccent);
    ind.style.left = btn.offsetLeft + 'px';
    ind.style.width = btn.offsetWidth + 'px';
    ind.style.background = `rgba(${accent},0.18)`;
    ind.style.border = `1px solid rgba(${accent},0.45)`;
    ind.style.boxShadow = `0 0 14px rgba(${accent},0.35), inset 0 1px 0 rgba(255,255,255,0.15)`;
}

// 更新各分类实时数量角标
function updateTabCounts() {
    const counts = { all: allNewsData.length, news: 0, foreign: 0, tech: 0 };
    for (const n of allNewsData) {
        const c = n.category;
        if (c === 'news' || c === 'foreign' || c === 'tech') counts[c]++;
    }
    for (const k of ['all', 'news', 'foreign', 'tech']) {
        const el = document.getElementById('count-' + k);
        if (el) el.textContent = counts[k] ? String(counts[k]) : '';
    }
}

// 切换分类 Tab
export function setFilter(filter) {
    if (!['all', 'news', 'foreign', 'tech'].includes(filter)) return;
    currentFilter = filter;
    ['all', 'news', 'foreign', 'tech'].forEach(t => {
        const btn = document.getElementById('tab-' + t);
        if (btn) {
            const active = t === filter;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', String(active));
            btn.tabIndex = active ? 0 : -1;
        }
    });
    moveTabIndicator(filter);
    withViewTransition(renderNewsList);
}

function sanitizeHttpUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url, window.location.origin);
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
    } catch {
        return '';
    }
}

function normalizeNewsDisplayText(news) {
    const rawText = news.display_content || news.content || '';
    if ((news.category || '') === 'news') {
        return rawText.replace(/^【[^】]+】\s*/, '');
    }
    return rawText;
}

function createNewsElement(news, isNew = false) {
    const fs = currentFontSize === 'sm' ? 'text-sm' : (currentFontSize === 'base' ? 'text-base' : 'text-lg');
    const item = document.createElement('div');
    const header = document.createElement('div');
    const body = document.createElement('div');
    const displayText = normalizeNewsDisplayText(news);
    const safeUrl = sanitizeHttpUrl(news.url);
    const isHtmlBlock = news.format === 'html';
    // 时间轴信息流：去掉表格式分隔线，靠竖线+节点圆点串联；重要项染红节点与底色
    const importantClass = news.is_important ? ' is-important' : '';

    item.className = `news-feed-item${importantClass} py-2.5 [&_a]:text-blue-400 [&_a]:underline [&_a]:hover:text-blue-300` + (isNew ? ' animate-slide-down' : '');
    item.dataset.newsKey = news._clientKey;
    item.dataset.newsSignature = newsRenderSignature(news);

    header.className = 'text-[11px] text-white/40 font-mono mb-0.5 flex items-center';
    header.append(document.createTextNode(news.time || ''));
    if (news.is_important) {
        const badge = document.createElement('span');
        badge.className = 'ml-2 px-1.5 py-0.5 bg-red-500/20 text-red-400 text-[9px] font-bold rounded border border-red-500/30 animate-pulse';
        badge.textContent = 'IMPORTANT';
        header.appendChild(badge);
    }

    body.className = `${fs} leading-loose text-white/90 drop-shadow-sm tech-content`;
    if (isHtmlBlock) {
        body.innerHTML = DOMPurify.sanitize(news.content || '', { ADD_ATTR: ['target', 'rel'] });
        body.querySelectorAll('a').forEach(a => {
            const href = sanitizeHttpUrl(a.getAttribute('href'));
            if (!href) {
                a.removeAttribute('href');
                a.removeAttribute('target');
                a.removeAttribute('rel');
                return;
            }
            a.href = href;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
        });
    } else if (safeUrl) {
        const link = document.createElement('a');
        link.href = safeUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'news-link visited:text-sky-200';
        link.textContent = displayText;
        body.appendChild(link);
    } else {
        body.textContent = displayText;
    }

    item.appendChild(header);
    item.appendChild(body);
    return item;
}

function applyFilter(n) {
    const category = n.category || 'all';
    if (currentFilter === 'news') return category === 'news';
    if (currentFilter === 'foreign') return category === 'foreign';
    if (currentFilter === 'tech') return category === 'tech';
    return true;
}

async function fetchRealNews() {
    try {
        const response = await fetch('./finance-news.json', { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        const newsList = assignClientKeys((data.news_list || []).map(item => {
            const normalized = { ...item };
            if (!normalized.category) {
                if ((normalized.content || '').includes('GitHub') || (normalized.content || '').includes('HN') || (normalized.content || '').includes('V2EX')) normalized.category = 'tech';
                else if (normalized.url) normalized.category = 'foreign';
                else normalized.category = 'news';
            }
            if (!normalized.format) normalized.format = normalized.category === 'tech' && !normalized.url ? 'html' : 'text';
            return normalized;
        }));
        setNewsStatus('online');
        if (!newsList || newsList.length === 0) {
            hasLoadedNews = true;
            allNewsData = [];
            lastNewsSignature = datasetSignature([]);
            document.getElementById('lastUpdateTime').innerText = '暂无数据';
            const sk = document.getElementById('newsSkeleton');
            if (sk) sk.remove();
            renderNewsList();
            return;
        }

        const nextSignature = datasetSignature(newsList);
        const previousKeys = new Set(allNewsData.map(news => news._clientKey));
        const newKeys = new Set(newsList.filter(news => !previousKeys.has(news._clientKey)).map(news => news._clientKey));
        const firstLoad = !hasLoadedNews;
        hasLoadedNews = true;
        document.getElementById('lastUpdateTime').textContent = formatLastUpdated(data.last_updated, newsList[0].time);
        const sk = document.getElementById('newsSkeleton');
        if (sk) sk.remove();

        // 比较整个有界数据集，而不是只看第一条；重要置顶不再遮蔽普通新闻更新。
        if (firstLoad || nextSignature !== lastNewsSignature) {
            allNewsData = newsList;
            renderNewsList(firstLoad ? new Set() : newKeys, !firstLoad);
            lastNewsSignature = nextSignature;
        }
    } catch (e) {
        console.error("快讯同步失败:", e);
        setNewsStatus('offline');
        if (!hasLoadedNews) {
            hasLoadedNews = true;
            const listContainer = document.getElementById('newsList');
            if (listContainer) {
                listContainer.replaceChildren(emptyMessage('快讯暂不可用'));
            }
            document.getElementById('lastUpdateTime').innerText = '连接失败';
        }
    }
}

export function initNews() {
    setFilter('all');                  // 初始化激活态 + 滑动指示器定位
    document.querySelectorAll('[data-font-size]').forEach(button => {
        button.addEventListener('click', () => setFontSize(button.dataset.fontSize));
    });
    const tabs = Array.from(document.querySelectorAll('[role="tab"][data-filter]'));
    tabs.forEach(button => button.addEventListener('click', () => setFilter(button.dataset.filter)));
    document.getElementById('tabBar')?.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const activeIndex = tabs.findIndex(button => button.dataset.filter === currentFilter);
        let nextIndex = activeIndex;
        if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = tabs.length - 1;
        else nextIndex = (activeIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        setFilter(tabs[nextIndex].dataset.filter);
        tabs[nextIndex].focus();
    });

    const poll = async () => {
        if (document.hidden || newsRequestInFlight) return;
        newsRequestInFlight = true;
        try {
            await fetchRealNews();
        } finally {
            newsRequestInFlight = false;
            if (!document.hidden) newsPollTimer = window.setTimeout(poll, NEWS_POLL_INTERVAL);
        }
    };
    const handleVisibility = () => {
        window.clearTimeout(newsPollTimer);
        newsPollTimer = null;
        if (!document.hidden) poll();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    poll();
    // 窗口尺寸变化时重新对齐指示器（tab 宽度会随之变化）
    window.addEventListener('resize', () => moveTabIndicator(currentFilter));
}
