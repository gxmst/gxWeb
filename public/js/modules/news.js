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

const NEWS_POLL_INTERVAL = 30000;
const MAX_NEWS_ITEMS = 400;
const NEWS_PAGE_SIZE = 60;

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
    button.className = 'news-load-more mx-auto mt-4 min-h-10 rounded-lg border border-white/10 bg-white/5 px-4 text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white';
    button.textContent = `继续加载（剩余 ${Math.max(0, total - visibleLimit)} 条）`;
    button.addEventListener('click', () => {
        visibleLimit += NEWS_PAGE_SIZE;
        renderNewsList(new Set(), true);
    });
    return button;
}

function updateResultMeta(filteredCount, renderedCount) {
    const meta = document.getElementById('newsResultMeta');
    if (!meta || !hasLoadedNews) return;
    const paused = newsPaused ? ' · 已暂停刷新' : '';
    meta.textContent = filteredCount
        ? `显示 ${renderedCount} / ${filteredCount} 条${paused}`
        : `没有匹配结果${paused}`;
}

// 使用稳定 key 对齐、更新、重排和删除节点；服务端删掉的条目不会留在 DOM 中。
function renderNewsList(newKeys = new Set(), preserveScroll = false) {
    const listContainer = document.getElementById('newsList');
    const filtered = allNewsData.filter(applyFilter);
    const visibleNews = filtered.slice(0, visibleLimit);

    updateTabCounts();
    updateResultMeta(filtered.length, visibleNews.length);
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
        const constrained = importantOnly || currentSource !== 'all' || Boolean(searchTerm);
        fragment.appendChild(emptyMessage(constrained ? '没有匹配的快讯' : '暂无对应快讯'));
    } else {
        visibleNews.forEach(news => {
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
    if (preserveScroll && oldScroll > 10) {
        listContainer.scrollTop = Math.max(0, oldScroll + listContainer.scrollHeight - oldHeight);
    }
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

// 字体切换 (0 延时本地秒切)
export function setFontSize(size, persist = true, render = true) {
    if (!['sm', 'base', 'lg'].includes(size)) return;
    currentFontSize = size;
    if (persist && getSettings().news.fontSize !== size) updateSettings('news', { fontSize: size });
    ['sm', 'base', 'lg'].forEach(s => {
        const btn = document.getElementById('fs-' + s);
        if (s === size) { btn.classList.add('bg-white/20', 'text-white'); btn.classList.remove('text-white/50'); }
        else { btn.classList.remove('bg-white/20', 'text-white'); btn.classList.add('text-white/50'); }
        btn.setAttribute('aria-pressed', String(s === size));
    });
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
    withViewTransition(renderNewsList);
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

    item.className = `news-feed-item${importantClass} py-2.5 [&_a]:text-blue-400 [&_a]:underline [&_a]:hover:text-blue-300` + (isNew ? ' animate-slide-down' : '');
    item.dataset.newsKey = news._clientKey;
    item.dataset.newsSignature = newsRenderSignature(news);

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
            allNewsData = newsList;
            updateSourceOptions();
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

    const importantButton = document.getElementById('importantOnlyButton');
    const syncImportantButton = () => {
        importantButton?.setAttribute('aria-pressed', String(importantOnly));
        importantButton?.classList.toggle('active', importantOnly);
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
        resetNewsView();
    });

    document.getElementById('newsSearchInput')?.addEventListener('input', event => {
        window.clearTimeout(searchDebounceTimer);
        const value = event.target.value;
        searchDebounceTimer = window.setTimeout(() => {
            searchTerm = value.trim().toLocaleLowerCase('zh-CN');
            resetNewsView();
        }, 120);
    });

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
    setFontSize(currentFontSize, false);
    setFilter(currentFilter, false);
    poll();
    // 窗口尺寸变化时重新对齐指示器（tab 宽度会随之变化）
    window.addEventListener('resize', () => moveTabIndicator(currentFilter));
}
