// ================== 新闻流与交互渲染 ==================
import { getSettings, updateSettings } from './settings-store.js';

let allNewsData = [];
let hasLoadedNews = false;
const initialNewsSettings = getSettings().news;
const storedFilter = initialNewsSettings.category;
let currentFilter = ['all', 'news', 'foreign', 'tech'].includes(storedFilter) ? storedFilter : 'all';
let lastNewsSignature = '';
const storedFontSize = initialNewsSettings.fontSize;
let currentFontSize = ['sm', 'base', 'lg'].includes(storedFontSize) ? storedFontSize : 'sm';
let currentSource = initialNewsSettings.source || 'all';
let searchTerm = '';
let importantOnly = Boolean(initialNewsSettings.importantOnly);
let visibleLimit = 60;
let newsPaused = !initialNewsSettings.autoRefresh;
let newsPollTimer = null;
let newsRequestInFlight = false;
let searchDebounceTimer = null;
let groupByTime = initialNewsSettings.groupByTime !== false;
let revealObserver = null;
let unseenKeys = new Set();
let pendingFocusKey = '';

const NEWS_POLL_INTERVAL = 30000;
const MAX_NEWS_ITEMS = 400;
const NEWS_PAGE_SIZE = 60;
// 顶部这点距离内视作"正在看最新"，新条目直接就位而不弹提示。
const AT_TOP_THRESHOLD = 24;

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
        news.category, news.source, news.format, Boolean(news.is_important),
        news.importance_score, news.importance_reason, currentFontSize
    ])) >>> 0);
}

function datasetSignature(newsList) {
    return String(simpleHash(JSON.stringify(newsList.map(news => [
        news._clientKey, news.time, news.display_content, news.content, news.url,
        news.category, news.source, news.format, Boolean(news.is_important),
        news.importance_score, news.importance_reason
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
    const states = {
        online: { label: 'LIVE', text: 'text-green-400', dot: 'bg-green-500', ping: 'bg-green-400', title: '快讯连接正常' },
        paused: { label: '暂停', text: 'text-amber-400', dot: 'bg-amber-500', ping: '', title: '快讯刷新已暂停' },
        loading: { label: '同步', text: 'text-amber-400', dot: 'bg-amber-500', ping: 'bg-amber-400', title: '正在同步快讯' },
        offline: { label: '断连', text: 'text-red-400', dot: 'bg-red-500', ping: '', title: '快讯连接失败，保留上次成功数据' },
    };
    const state = states[kind] || states.offline;
    text.textContent = state.label;
    text.className = `text-[10px] font-bold ${state.text}`;
    ping.className = state.ping
        ? `animate-ping absolute inline-flex h-full w-full rounded-full ${state.ping} opacity-75`
        : 'hidden';
    dot.className = `relative inline-flex rounded-full h-2 w-2 ${state.dot}`;
    status.title = state.title;
    window.dispatchEvent(new CustomEvent('gx:status-change', { detail: { source: 'news', kind } }));
}

function emptyMessage(text) {
    const empty = document.createElement('div');
    empty.className = 'text-center text-white/30 mt-10 text-sm';
    empty.textContent = text;
    return empty;
}

function createLoadMoreButton(total) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'news-load-more mx-auto mt-4 mb-2 min-h-10 rounded-lg border border-white/10 bg-white/5 px-4 text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white';
    button.textContent = `显示更多（剩余 ${Math.max(0, total - visibleLimit)} 条）`;
    button.addEventListener('click', () => {
        // 记下当前这批的最后一条，渲染后把焦点交给紧随其后的第一条新内容——
        // 既不丢焦点（原来焦点落回 body，浏览器随即把滚动带走），也不需要滚动。
        const rendered = allNewsData.filter(applyFilter).slice(0, visibleLimit);
        pendingFocusKey = rendered.length ? rendered[rendered.length - 1]._clientKey : '';
        visibleLimit += NEWS_PAGE_SIZE;
        renderNewsList(new Set(), 'anchor');
    });
    return button;
}

// ---- 滚动锚定 ----
// 原来的做法是 scrollTop += (新高度 - 旧高度)，它只对「在顶部插入」成立：
// 追加到底部时高度同样变大，于是把视口整块往下推，看起来就是"跳到最下面"。
// 改成锚定一个具体条目：记住当前视口里第一条可见条目和它相对容器顶的偏移，
// 渲染后把这个偏移还原。插入、追加、替换都成立。
function captureScrollAnchor(container) {
    const containerTop = container.getBoundingClientRect().top;
    const items = container.querySelectorAll('[data-news-key]');
    for (const item of items) {
        const offset = item.getBoundingClientRect().top - containerTop;
        if (offset >= -4) return { key: item.dataset.newsKey, offset };
    }
    return null;
}

function restoreScrollAnchor(container, anchor) {
    if (!anchor) return;
    const target = container.querySelector(`[data-news-key="${CSS.escape(anchor.key)}"]`);
    if (!target) return;
    // 两遍收敛：改了 scrollTop 之后 sticky 时段小标题会重新落位，
    // 轻微改变后续元素的实际位置，一遍校正会留几个像素的残差。
    for (let pass = 0; pass < 2; pass++) {
        const delta = (target.getBoundingClientRect().top - container.getBoundingClientRect().top) - anchor.offset;
        if (Math.abs(delta) <= 0.5) break;
        container.scrollTop += delta;
    }
}

// ---- 时间分组 ----
// 快讯只带 HH:MM，滚久了完全失去"我看到哪儿了"的坐标。用 raw_time 切出
// 「今天 14:00」这种小时段，作为 sticky 小标题吸在列表顶部当章节标记。
function groupLabel(news) {
    const raw = Number(news.raw_time);
    if (!Number.isFinite(raw) || raw <= 0) return { id: 'unknown', label: '较早' };
    const date = new Date(raw * 1000);
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const hour = String(date.getHours()).padStart(2, '0');
    const id = `${date.toDateString()}-${hour}`;
    if (sameDay) return { id, label: `今天 ${hour}:00` };
    const yesterday = new Date(now.getTime() - 86400000);
    const dayLabel = date.toDateString() === yesterday.toDateString()
        ? '昨天'
        : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    return { id, label: `${dayLabel} ${hour}:00` };
}

function createGroupSeparator(label, count) {
    const row = document.createElement('div');
    row.className = 'news-group-sep';
    row.dataset.groupSep = label;
    const text = document.createElement('span');
    text.textContent = label;
    row.appendChild(text);
    if (count > 0) {
        const badge = document.createElement('span');
        badge.className = 'news-group-count';
        badge.textContent = String(count);
        row.appendChild(badge);
    }
    return row;
}

// ---- 进入视口时逐条显形 ----
// 只做一次性 reveal：条目滚进视口就加 .in-view，不再移除，避免来回抖动。
function ensureRevealObserver() {
    if (revealObserver || typeof IntersectionObserver !== 'function') return revealObserver;
    const container = document.getElementById('newsList');
    if (!container) return null;
    revealObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            entry.target.classList.add('in-view');
            revealObserver.unobserve(entry.target);
        }
    }, { root: window.innerWidth < 768 ? null : container, rootMargin: '80px 0px', threshold: 0.01 });
    return revealObserver;
}

function observeReveal(element) {
    const observer = ensureRevealObserver();
    if (!observer) {
        element.classList.add('in-view');
        return;
    }
    observer.observe(element);
}

function motionAllowed() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    return !document.documentElement.classList.contains('power-saving');
}

// ---- 顶部"N 条新快讯"提示 ----
// 用户正在往下读时，静默把新条目插到顶部会让人失去参照；改为累计未读数、
// 用一个可点击的 pill 告知，点了才回到顶部。
function updateUnseenPill() {
    const pill = document.getElementById('newsUnseenPill');
    const label = document.getElementById('newsUnseenCount');
    if (!pill || !label) return;
    const count = unseenKeys.size;
    label.textContent = count > 99 ? '99+' : String(count);
    const visible = count > 0;
    pill.classList.toggle('show', visible);
    pill.disabled = !visible;
    pill.setAttribute('aria-hidden', String(!visible));
}

function clearUnseen() {
    if (!unseenKeys.size) return;
    unseenKeys = new Set();
    updateUnseenPill();
}

function newsListAtTop() {
    const container = document.getElementById('newsList');
    if (!container) return true;
    if (window.innerWidth < 768) {
        const aside = document.querySelector('aside');
        return !aside || window.scrollY - aside.offsetTop < AT_TOP_THRESHOLD;
    }
    return container.scrollTop < AT_TOP_THRESHOLD;
}

// 滚动进度：驱动底部渐隐遮罩的开关（滚到底时收掉，否则底部内容永远是灰的）。
function syncScrollShadow() {
    const container = document.getElementById('newsList');
    if (!container) return;
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    container.style.setProperty('--fade-bottom', remaining > 12 ? '2rem' : '0rem');
    container.style.setProperty('--fade-top', container.scrollTop > 12 ? '1.25rem' : '0rem');
}

function updateResultMeta(filteredCount, renderedCount) {
    const meta = document.getElementById('newsResultMeta');
    if (!meta || !hasLoadedNews) return;
    const paused = newsPaused ? ' · 已暂停刷新' : '';
    meta.textContent = filteredCount
        ? `显示 ${renderedCount} / ${filteredCount} 条${paused}`
        : `没有匹配结果${paused}`;
}

// 分类角标已经报了总数，标题栏这行只在真的被筛过 / 暂停时才占位置。
function shouldShowResultMeta() {
    return importantOnly || currentSource !== 'all' || Boolean(searchTerm) || newsPaused;
}

// 使用稳定 key 对齐、更新、重排和删除节点；服务端删掉的条目不会留在 DOM 中。
// mode: 'reset'  切分类/筛选 —— 回到顶部
//       'anchor' 轮询更新 / 显示更多 —— 锚定当前阅读位置
function renderNewsList(newKeys = new Set(), mode = 'reset') {
    const listContainer = document.getElementById('newsList');
    const filtered = allNewsData.filter(applyFilter);
    const visibleNews = filtered.slice(0, visibleLimit);

    updateTabCounts();
    updateResultMeta(filtered.length, visibleNews.length);
    const meta = document.getElementById('newsResultMeta');
    if (meta) meta.hidden = !shouldShowResultMeta();
    listContainer.setAttribute('aria-labelledby', `tab-${currentFilter}`);
    if (!hasLoadedNews && allNewsData.length === 0) return;

    const anchor = mode === 'anchor' ? captureScrollAnchor(listContainer) : null;
    const existing = new Map(
        Array.from(listContainer.querySelectorAll('[data-news-key]'))
            .map(element => [element.dataset.newsKey, element])
    );
    const fragment = document.createDocumentFragment();
    if (filtered.length === 0) {
        const constrained = importantOnly || currentSource !== 'all' || Boolean(searchTerm);
        fragment.appendChild(emptyMessage(constrained ? '没有匹配的快讯' : '暂无对应快讯'));
    } else {
        let lastGroupId = '';
        visibleNews.forEach((news, index) => {
            if (groupByTime) {
                const group = groupLabel(news);
                if (group.id !== lastGroupId) {
                    lastGroupId = group.id;
                    // 该时段在本次可见范围内的条数，让小标题自带信息量
                    let count = 0;
                    for (let i = index; i < visibleNews.length; i++) {
                        if (groupLabel(visibleNews[i]).id !== group.id) break;
                        count++;
                    }
                    fragment.appendChild(createGroupSeparator(group.label, count));
                }
            }
            const signature = newsRenderSignature(news);
            let element = existing.get(news._clientKey);
            if (!element || element.dataset.newsSignature !== signature) {
                element = createNewsElement(news, newKeys.has(news._clientKey));
            }
            fragment.appendChild(element);
        });
        if (visibleNews.length < filtered.length) fragment.appendChild(createLoadMoreButton(filtered.length));
    }
    listContainer.replaceChildren(fragment);

    if (mode === 'anchor') restoreScrollAnchor(listContainer, anchor);
    else listContainer.scrollTop = 0;

    // "显示更多"后把焦点交给第一条新内容：preventScroll 必须加，
    // 否则 focus() 自带的 scrollIntoView 会把刚还原好的位置again带走。
    if (pendingFocusKey) {
        const previous = listContainer.querySelector(`[data-news-key="${CSS.escape(pendingFocusKey)}"]`);
        const target = previous?.nextElementSibling?.matches?.('[data-news-key]')
            ? previous.nextElementSibling
            : previous?.nextElementSibling?.nextElementSibling;   // 跨过可能插入的时段小标题
        if (target?.matches?.('[data-news-key]')) {
            target.tabIndex = -1;
            target.focus({ preventScroll: true });
        }
        pendingFocusKey = '';
    }
    syncScrollShadow();
}

// View Transitions 包装：切 tab / 切字号时让列表交叉淡入形变，而非硬切。
// #newsList 带 view-transition-name（见 components.css），故只有列表参与动画，
// 不会把动态壁纸/WebGL 卷进整页快照。不支持的浏览器或省电模式直接同步执行。
function withViewTransition(mutate) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!hasLoadedNews || reduce || typeof document.startViewTransition !== 'function') {
        mutate();
        return;
    }
    const transition = document.startViewTransition(mutate);
    transition.finished?.catch(() => {});
}

// 字体切换 (0 延时本地秒切)；入口只剩设置中心的下拉，旧的 fs- 按钮已随重构移除
export function setFontSize(size, persist = true, render = true) {
    if (!['sm', 'base', 'lg'].includes(size)) return;
    currentFontSize = size;
    if (persist && getSettings().news.fontSize !== size) updateSettings('news', { fontSize: size });
    if (render) withViewTransition(renderNewsList);
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
        if (el) el.textContent = counts[k] ? (k === 'tech' ? `${counts[k]}源` : String(counts[k])) : '';
    }
    const importantCount = allNewsData.filter(news => news.is_important).length;
    const importantEl = document.getElementById('count-important');
    if (importantEl) importantEl.textContent = importantCount ? String(importantCount) : '';
}

function sourceLabel(source) {
    const labels = { sina: '新浪', github: 'GitHub', hn: 'Hacker News', v2ex: 'V2EX' };
    return labels[String(source || '').toLowerCase()] || String(source || '未知来源');
}

function updateSourceOptions() {
    const select = document.getElementById('newsSourceFilter');
    if (!select) return;
    const sources = Array.from(new Set(allNewsData.map(news => news.source).filter(Boolean)))
        .sort((a, b) => sourceLabel(a).localeCompare(sourceLabel(b), 'zh-CN'));
    if (currentSource !== 'all' && !sources.includes(currentSource)) {
        currentSource = 'all';
        if (getSettings().news.source !== currentSource) updateSettings('news', { source: currentSource });
    }
    const fragment = document.createDocumentFragment();
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = '全部来源';
    fragment.appendChild(allOption);
    sources.forEach(source => {
        const option = document.createElement('option');
        option.value = source;
        option.textContent = sourceLabel(source);
        fragment.appendChild(option);
    });
    select.replaceChildren(fragment);
    select.value = currentSource;
    window.dispatchEvent(new CustomEvent('gx:news-sources', {
        detail: { sources: sources.map(source => ({ value: source, label: sourceLabel(source) })) },
    }));
}

function resetNewsView() {
    visibleLimit = NEWS_PAGE_SIZE;
    clearUnseen();
    withViewTransition(() => renderNewsList(new Set(), 'reset'));
}

// 切换分类 Tab
export function setFilter(filter, persist = true, render = true) {
    if (!['all', 'news', 'foreign', 'tech'].includes(filter)) return;
    currentFilter = filter;
    if (persist && getSettings().news.category !== filter) updateSettings('news', { category: filter });
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
    if (render) resetNewsView();
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

    item.className = `news-feed-item${importantClass} py-2 [&_a]:text-blue-400 [&_a]:underline [&_a]:hover:text-blue-300` + (isNew ? ' animate-slide-down' : '');
    item.dataset.newsKey = news._clientKey;
    item.dataset.newsSignature = newsRenderSignature(news);
    // 滚动显形：新建节点先处于未显形态，进视口再淡入上浮。
    // 省电/减少动态偏好下直接标记为已显形，等于关掉这套动效。
    if (motionAllowed()) observeReveal(item);
    else item.classList.add('in-view');

    header.className = 'text-[11px] text-white/45 font-mono mb-0.5 flex flex-wrap items-center gap-1.5';
    const time = document.createElement('span');
    time.textContent = news.time || '';
    header.appendChild(time);
    if (news.source) {
        const source = document.createElement('span');
        source.className = 'news-source-badge';
        source.textContent = sourceLabel(news.source);
        header.appendChild(source);
    }
    if (news.is_important) {
        const badge = document.createElement('span');
        const reason = String(news.importance_reason || '').trim();
        badge.className = 'news-important-badge';
        badge.textContent = reason ? `重要 · ${reason}` : '重要';
        const score = Number(news.importance_score);
        badge.title = Number.isFinite(score) && score > 0 ? `重要性 ${score} 分` : '重要快讯';
        header.appendChild(badge);
    }

    body.className = `${fs} leading-relaxed text-white/90 drop-shadow-sm tech-content`;
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
    if (currentFilter === 'news' && category !== 'news') return false;
    if (currentFilter === 'foreign' && category !== 'foreign') return false;
    if (currentFilter === 'tech' && category !== 'tech') return false;
    if (importantOnly && !n.is_important) return false;
    if (currentSource !== 'all' && n.source !== currentSource) return false;
    if (searchTerm) {
        const searchText = [
            n.display_content, n.content, sourceLabel(n.source), n.importance_reason
        ].filter(Boolean).join(' ').replace(/<[^>]+>/g, ' ').toLocaleLowerCase('zh-CN');
        if (!searchText.includes(searchTerm)) return false;
    }
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
            updateSourceOptions();
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

        // 比较整个有界数据集，而不是只看第一条，避免漏掉同一分钟内的普通更新。
        if (firstLoad || nextSignature !== lastNewsSignature) {
            const wasAtTop = firstLoad || newsListAtTop();
            allNewsData = newsList;
            updateSourceOptions();
            // 数据始终就位（计数/筛选不能骗人），但正在往下读时不抢走视口位置，
            // 而是把新增条目记成未读、用顶部 pill 提示。
            if (!firstLoad && !wasAtTop) {
                for (const key of newKeys) unseenKeys.add(key);
            } else {
                clearUnseen();
            }
            renderNewsList(firstLoad ? new Set() : newKeys, firstLoad ? 'reset' : 'anchor');
            updateUnseenPill();
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

// 折叠筛选行：搜索 / 来源 / 只看重要平时收起，标题栏只留一个漏斗按钮。
// 收起时用 inert + hidden 双保险，键盘 Tab 不会落进看不见的控件。
function setFilterBarOpen(open, persist = true) {
    const row = document.getElementById('newsFilterRow');
    const toggle = document.getElementById('newsFilterToggle');
    if (!row || !toggle) return;
    row.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.classList.toggle('active', open);
    if (open) {
        row.removeAttribute('inert');
    } else {
        row.setAttribute('inert', '');
    }
    if (persist && Boolean(getSettings().news.filterBarOpen) !== open) {
        updateSettings('news', { filterBarOpen: open });
    }
}

// 有筛选条件生效时给漏斗按钮点一个小圆点，收起状态下也知道结果被过滤过。
function syncFilterIndicator() {
    const toggle = document.getElementById('newsFilterToggle');
    if (!toggle) return;
    const active = importantOnly || currentSource !== 'all' || Boolean(searchTerm);
    toggle.classList.toggle('has-filter', active);
}

export function initNews() {
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

    const importantButton = document.getElementById('importantOnlyButton');
    const syncImportantButton = () => {
        importantButton?.setAttribute('aria-pressed', String(importantOnly));
        importantButton?.classList.toggle('active', importantOnly);
        syncFilterIndicator();
    };
    importantButton?.addEventListener('click', () => {
        importantOnly = !importantOnly;
        updateSettings('news', { importantOnly });
        syncImportantButton();
        resetNewsView();
    });

    document.getElementById('newsSourceFilter')?.addEventListener('change', event => {
        currentSource = event.target.value || 'all';
        updateSettings('news', { source: currentSource });
        syncFilterIndicator();
        resetNewsView();
    });

    document.getElementById('newsSearchInput')?.addEventListener('input', event => {
        window.clearTimeout(searchDebounceTimer);
        const value = event.target.value;
        searchDebounceTimer = window.setTimeout(() => {
            searchTerm = value.trim().toLocaleLowerCase('zh-CN');
            syncFilterIndicator();
            resetNewsView();
        }, 120);
    });

    const filterToggle = document.getElementById('newsFilterToggle');
    filterToggle?.addEventListener('click', () => {
        const open = filterToggle.getAttribute('aria-expanded') !== 'true';
        setFilterBarOpen(open);
        if (open) document.getElementById('newsSearchInput')?.focus();
    });
    document.getElementById('newsFilterRow')?.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        setFilterBarOpen(false);
        filterToggle?.focus();
    });

    const listContainer = document.getElementById('newsList');
    document.getElementById('newsUnseenPill')?.addEventListener('click', () => {
        clearUnseen();
        if (window.innerWidth < 768) {
            const aside = document.querySelector('aside');
            window.scrollTo({ top: aside ? aside.offsetTop : 0, behavior: 'smooth' });
        } else {
            listContainer?.scrollTo({ top: 0, behavior: 'smooth' });
        }
    });
    const handleListScroll = () => {
        syncScrollShadow();
        if (newsListAtTop()) clearUnseen();
    };
    listContainer?.addEventListener('scroll', handleListScroll, { passive: true });
    window.addEventListener('scroll', handleListScroll, { passive: true });
    window.addEventListener('resize', syncScrollShadow);

    const poll = async () => {
        if (document.hidden || newsPaused || newsRequestInFlight) return;
        newsRequestInFlight = true;
        try {
            await fetchRealNews();
        } finally {
            newsRequestInFlight = false;
            if (!document.hidden && !newsPaused) newsPollTimer = window.setTimeout(poll, NEWS_POLL_INTERVAL);
        }
    };

    const pauseButton = document.getElementById('pauseNewsButton');
    const syncPauseButton = () => {
        pauseButton?.setAttribute('aria-pressed', String(newsPaused));
        pauseButton?.classList.toggle('active', newsPaused);
        pauseButton?.querySelector('[data-pause-icon]')?.classList.toggle('hidden', newsPaused);
        pauseButton?.querySelector('[data-play-icon]')?.classList.toggle('hidden', !newsPaused);
        if (pauseButton) {
            pauseButton.title = newsPaused ? '继续快讯刷新' : '暂停快讯刷新';
            pauseButton.setAttribute('aria-label', pauseButton.title);
        }
    };
    pauseButton?.addEventListener('click', () => {
        updateSettings('news', { autoRefresh: newsPaused });
    });

    const applyPauseState = paused => {
        const changed = newsPaused !== paused;
        newsPaused = paused;
        syncPauseButton();
        if (!changed) return;
        window.clearTimeout(newsPollTimer);
        newsPollTimer = null;
        setNewsStatus(newsPaused ? 'paused' : 'loading');
        renderNewsList();
        if (!newsPaused) poll();
    };

    window.addEventListener('gx:settings-changed', event => {
        if (!['news', 'all'].includes(event.detail?.section)) return;
        const next = event.detail?.settings?.news;
        if (!next) return;
        let viewChanged = false;
        if (next.fontSize !== currentFontSize) {
            setFontSize(next.fontSize, false, false);
            viewChanged = true;
        }
        if (next.category !== currentFilter) {
            setFilter(next.category, false, false);
            viewChanged = true;
        }
        if (next.source !== currentSource) {
            currentSource = next.source;
            updateSourceOptions();
            viewChanged = true;
        }
        if (Boolean(next.importantOnly) !== importantOnly) {
            importantOnly = Boolean(next.importantOnly);
            syncImportantButton();
            viewChanged = true;
        }
        if ((next.groupByTime !== false) !== groupByTime) {
            groupByTime = next.groupByTime !== false;
            viewChanged = true;
        }
        setFilterBarOpen(Boolean(next.filterBarOpen), false);
        applyPauseState(!next.autoRefresh);
        if (viewChanged) resetNewsView();
    });

    const handleVisibility = () => {
        window.clearTimeout(newsPollTimer);
        newsPollTimer = null;
        if (!document.hidden && !newsPaused) poll();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    syncImportantButton();
    syncPauseButton();
    // 上次留了搜索词或来源筛选，就把折叠行展开，否则用户看到"结果少了"却找不到开关。
    setFilterBarOpen(Boolean(initialNewsSettings.filterBarOpen) || currentSource !== 'all', false);
    setFontSize(currentFontSize, false);
    setFilter(currentFilter, false);
    updateUnseenPill();
    poll();
    // 窗口尺寸变化时重新对齐指示器（tab 宽度会随之变化）
    window.addEventListener('resize', () => moveTabIndicator(currentFilter));
    // web 字体（font-display: swap）换入后 tab 宽度会变，指示器需再对齐一次
    document.fonts?.ready?.then(() => moveTabIndicator(currentFilter));
}
