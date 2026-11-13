// ================== 新闻流交互与实时同步 ==================
import { getSettings, updateSettings, isWidgetVisible } from './settings-store.js?v=workspace-20261114a';
import {
    BOOKMARK_LIMIT,
    countSavedMatching,
    isRead,
    isSaved,
    markAllRead,
    markRead,
    savedNews,
    toggleSaved,
} from './news-state.js?v=workspace-20261114a';
import { showControlToast } from './toast.js?v=workspace-20261114a';
import {
    NEWS_PAGE_SIZE,
    assignClientKeys,
    computeTabCounts,
    datasetSignature,
    formatLastUpdated,
    groupLabel,
    matchesNewsFilter,
    newsRenderSignature,
    sourceLabel,
} from './news-logic.js?v=workspace-20261114a';
import {
    createGroupSeparator,
    createLoadMoreButton,
    createNewsElement,
    emptyMessage,
    refreshCommunitySummaries,
} from './news-render.js?v=workspace-20261114a';

const NEWS_POLL_INTERVAL = 30000;
const AT_TOP_THRESHOLD = 24;
const TAB_ACCENTS = {
    all: '255,255,255',
    news: '96,165,250',     // 蓝
    foreign: '251,191,36',  // 琥珀
    community: '52,211,153',
    tech: '167,139,250',    // 紫
};

let allNewsData = [];
let hasLoadedNews = false;
const initialNewsSettings = getSettings().news;
const storedFilter = initialNewsSettings.category;
let currentFilter = ['all', 'news', 'foreign', 'tech', 'community'].includes(storedFilter) ? storedFilter : 'all';
let lastNewsSignature = '';
const storedFontSize = initialNewsSettings.fontSize;
let currentFontSize = ['sm', 'base', 'lg'].includes(storedFontSize) ? storedFontSize : 'sm';
let currentSource = initialNewsSettings.source || 'all';
let communitySource = initialNewsSettings.communitySource || 'all';
let searchTerm = '';
let importantOnly = Boolean(initialNewsSettings.importantOnly);
let visibleLimit = NEWS_PAGE_SIZE;
let splitLimits = { live: NEWS_PAGE_SIZE, deep: NEWS_PAGE_SIZE };
let newsPaused = !initialNewsSettings.autoRefresh;
let newsPollTimer = null;
let newsRequestInFlight = false;
let searchDebounceTimer = null;
let hiddenSources = initialNewsSettings.hiddenSources;
let groupByTime = initialNewsSettings.groupByTime !== false;
let revealObservers = new Map();
let revealObserverMode = '';
let unseenKeys = new Set();
let pendingFocusKey = '';
let readingView = initialNewsSettings.readingView;
let readingObservers = [];
const readingTimers = new Map();

export function getCurrentFilter() { return currentFilter; }

function currentFilterState() {
    return { readingView, hiddenSources, currentFilter, importantOnly, currentSource, communitySource, searchTerm };
}

function applyFilter(news, ignoreReading = false) {
    return matchesNewsFilter(news, currentFilterState(), isRead, ignoreReading);
}

function readingPool() {
    return readingView === 'saved' ? savedNews() : allNewsData;
}

function updateReadingControls() {
    let unread = 0;
    for (const news of allNewsData) {
        if (applyFilter(news, true) && !isRead(news._clientKey)) unread++;
    }
    const saved = countSavedMatching(news => applyFilter(news, true));
    document.getElementById('readingUnreadCount').textContent = String(unread);
    document.getElementById('readingSavedCount').textContent = String(saved);
    document.querySelectorAll('[data-reading-view]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.readingView === readingView));
    });
    document.querySelectorAll('[data-news-key]').forEach(item => {
        const key = item.dataset.newsKey;
        const readState = isRead(key);
        const savedState = isSaved(key);
        item.classList.toggle('is-read', readState);
        const readButton = item.querySelector('[data-mark-read]');
        if (readButton) {
            const label = readState ? '标记为未读' : '标记为已读';
            readButton.setAttribute('aria-label', label);
            readButton.title = label;
            readButton.setAttribute('aria-pressed', String(readState));
        }
        const saveButton = item.querySelector('[data-save-news]');
        if (saveButton) {
            const label = savedState ? '取消收藏这条资讯' : '收藏这条资讯';
            saveButton.setAttribute('aria-pressed', String(savedState));
            saveButton.setAttribute('aria-label', label);
            saveButton.title = label;
        }
    });
}

function isPanelScrollMode() {
    return window.innerWidth >= 768 || document.documentElement.classList.contains('news-panel-full');
}

function getSplitScrollContainers(container = document.getElementById('newsList')) {
    if (!container) return [];
    return Array.from(container.querySelectorAll('.news-split-scroll'));
}

function isSplitModeActive(filteredCount = -1) {
    const root = document.documentElement;
    const layout = getSettings().layout;
    return window.innerWidth >= 1024
        && root.classList.contains('news-panel-full')
        && (layout.fullScreenLayout || 'split') === 'split'
        && currentFilter === 'all'
        && currentSource === 'all'
        && filteredCount !== 0;
}

function disconnectReadingObservers() {
    readingObservers.forEach(observer => observer.disconnect());
    readingObservers = [];
    readingTimers.forEach(timer => clearTimeout(timer));
    readingTimers.clear();
}

function observeReading() {
    disconnectReadingObservers();
    if (!window.IntersectionObserver || readingView !== 'all' || document.hidden || !isWidgetVisible('news')) return;
    const container = document.getElementById('newsList');
    if (!container) return;
    const splitScrollers = getSplitScrollContainers(container);
    const scrollers = splitScrollers.length ? splitScrollers : [container];
    const panelScroll = isPanelScrollMode();
    for (const scroller of scrollers) {
        const items = scroller.querySelectorAll('[data-news-key]');
        if (!items.length) continue;
        const observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                const key = entry.target.dataset.newsKey;
                clearTimeout(readingTimers.get(key));
                readingTimers.delete(key);
                if (entry.isIntersecting && entry.intersectionRatio >= 0.6 && !isRead(key)) {
                    readingTimers.set(key, setTimeout(() => {
                        readingTimers.delete(key);
                        if (!document.hidden && document.getElementById('settingsOverlay')?.hidden && isWidgetVisible('news') && entry.target.isConnected) {
                            markRead(key);
                        }
                    }, 1800));
                }
            }
        }, { root: panelScroll ? scroller : null, threshold: [0, 0.6] });
        items.forEach(item => observer.observe(item));
        readingObservers.push(observer);
    }
}

function resetRevealObservers() {
    revealObservers.forEach(observer => observer.disconnect());
    revealObservers.clear();
}

function ensureRevealObserver(scrollRoot = null) {
    if (typeof IntersectionObserver !== 'function') return null;
    const container = document.getElementById('newsList');
    if (!container) return null;
    const panelScroll = isPanelScrollMode();
    const targetRoot = panelScroll ? (scrollRoot || container) : null;
    const modeKey = `${panelScroll ? 'panel' : 'page'}:${document.documentElement.classList.contains('news-split-active') ? 'split' : 'single'}`;
    if (revealObserverMode !== modeKey) {
        resetRevealObservers();
        revealObserverMode = modeKey;
    }
    const cacheKey = targetRoot || 'viewport';
    if (revealObservers.has(cacheKey)) return revealObservers.get(cacheKey);
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            entry.target.classList.add('in-view');
            observer.unobserve(entry.target);
        }
    }, { root: targetRoot, rootMargin: '80px 0px', threshold: 0.01 });
    revealObservers.set(cacheKey, observer);
    return observer;
}

function refreshRevealObserver() {
    const container = document.getElementById('newsList');
    if (!container) return;
    const panelScroll = isPanelScrollMode();
    const splitMode = document.documentElement.classList.contains('news-split-active');
    const modeKey = `${panelScroll ? 'panel' : 'page'}:${splitMode ? 'split' : 'single'}`;
    // 双栏渲染会更换滚动容器，即使布局模式未变，也必须释放旧 root 并重新观察复用条目。
    resetRevealObservers();
    revealObserverMode = modeKey;
    const splitScrollers = getSplitScrollContainers(container);
    const roots = splitScrollers.length ? splitScrollers : [container];
    for (const scroller of roots) {
        const observer = ensureRevealObserver(scroller);
        scroller.querySelectorAll('.news-feed-item:not(.in-view)').forEach(element => {
            if (observer) observer.observe(element);
            else element.classList.add('in-view');
        });
    }
}

function observeReveal(element, scrollRoot = null) {
    const observer = ensureRevealObserver(scrollRoot);
    if (!observer) {
        element.classList.add('in-view');
        return;
    }
    observer.observe(element);
}

function motionAllowed() {
    if (currentFilter === 'community') return false;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    return !document.documentElement.classList.contains('power-saving');
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

function handleLoadMore(columnKey = null, rendered = null) {
    const current = rendered || readingPool().filter(news => applyFilter(news)).slice(0, visibleLimit);
    pendingFocusKey = current.length ? current[current.length - 1]._clientKey : '';
    if (columnKey && Object.hasOwn(splitLimits, columnKey)) {
        splitLimits[columnKey] += NEWS_PAGE_SIZE;
    } else {
        visibleLimit += NEWS_PAGE_SIZE;
    }
    renderNewsList(new Set(), 'anchor');
}

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
    for (let pass = 0; pass < 2; pass++) {
        const delta = (target.getBoundingClientRect().top - container.getBoundingClientRect().top) - anchor.offset;
        if (Math.abs(delta) <= 0.5) break;
        container.scrollTop += delta;
    }
}

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
    if (!isPanelScrollMode()) {
        const aside = document.querySelector('aside');
        return !aside || window.scrollY - aside.offsetTop < AT_TOP_THRESHOLD;
    }
    const splitScrollers = getSplitScrollContainers(container);
    if (splitScrollers.length) {
        return splitScrollers.every(scroller => scroller.scrollTop < AT_TOP_THRESHOLD);
    }
    return container.scrollTop < AT_TOP_THRESHOLD;
}

function syncScrollShadow() {
    const container = document.getElementById('newsList');
    if (!container) return;
    if (document.documentElement.classList.contains('news-split-active')) {
        container.style.setProperty('--fade-bottom', '0rem');
        container.style.setProperty('--fade-top', '0rem');
        return;
    }
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    container.style.setProperty('--fade-bottom', remaining > 12 ? '2rem' : '0rem');
    container.style.setProperty('--fade-top', container.scrollTop > 12 ? '1.25rem' : '0rem');
}

function hasNewsFilters() {
    return (currentFilter !== 'community' && importantOnly)
        || (currentFilter === 'community' ? communitySource !== 'all' : currentSource !== 'all') || Boolean(searchTerm);
}

function emptyFilterText() {
    const constrained = hasNewsFilters();
    if (readingView === 'saved') return '还没有收藏的资讯，点击星标即可留存';
    if (readingView === 'unread') return '当前分类已读完';
    if (currentFilter === 'community') return constrained ? '没有匹配的帖子' : '暂无论坛帖子';
    return constrained ? '没有匹配的快讯' : '暂无对应快讯';
}

function buildFeedFragment(items, limit, existingByKey, newKeys, scrollRoot, emptyText, onLoadMore) {
    const fragment = document.createDocumentFragment();
    if (items.length === 0) {
        fragment.appendChild(emptyMessage(emptyText));
        return fragment;
    }
    const visibleNews = items.slice(0, limit);
    const shouldReveal = motionAllowed();
    const itemHandlers = {
        fontSize: currentFontSize,
        shouldReveal,
        observeReveal: element => observeReveal(element, scrollRoot),
        onMarkRead: news => {
            clearTimeout(readingTimers.get(news._clientKey));
            readingTimers.delete(news._clientKey);
            markRead(news._clientKey, !isRead(news._clientKey));
        },
        onToggleSave: news => {
            if (!toggleSaved(news)) showControlToast(`最多收藏 ${BOOKMARK_LIMIT} 条，请先取消部分收藏`);
        },
    };
    let lastGroupId = '';
    visibleNews.forEach((news, index) => {
        if (groupByTime && currentFilter !== 'community') {
            const group = groupLabel(news);
            if (group.id !== lastGroupId) {
                lastGroupId = group.id;
                let count = 0;
                for (let i = index; i < visibleNews.length; i++) {
                    if (groupLabel(visibleNews[i]).id !== group.id) break;
                    count++;
                }
                fragment.appendChild(createGroupSeparator(group.label, count));
            }
        }
        const signature = newsRenderSignature(news, currentFontSize);
        let element = existingByKey.get(news._clientKey);
        if (!element || element.dataset.newsSignature !== signature) {
            const summaryExpanded = Boolean(element?.querySelector('.community-summary.is-expanded'));
            element = createNewsElement(news, { ...itemHandlers, isNew: newKeys.has(news._clientKey), summaryExpanded });
        }
        fragment.appendChild(element);
    });
    if (visibleNews.length < items.length) {
        fragment.appendChild(createLoadMoreButton(items.length, limit, () => onLoadMore(visibleNews)));
    }
    return fragment;
}

function createSplitColumn(key, title, totalCount) {
    const col = document.createElement('section');
    col.className = 'news-split-col';
    col.dataset.splitCol = key;
    col.setAttribute('aria-label', title);

    const header = document.createElement('div');
    header.className = 'news-split-col-header';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = title;
    const countSpan = document.createElement('span');
    countSpan.className = 'news-split-col-count';
    countSpan.textContent = `${totalCount} 条`;
    header.append(titleSpan, countSpan);

    const scrollEl = document.createElement('div');
    scrollEl.className = 'news-split-scroll';
    col.append(header, scrollEl);
    return { col, scrollEl };
}

function updateResultMeta(filteredCount, renderedCount) {
    const meta = document.getElementById('newsResultMeta');
    if (!meta || !hasLoadedNews) return;
    const paused = newsPaused ? ' · 已暂停刷新' : '';
    meta.textContent = filteredCount
        ? `显示 ${renderedCount} / ${filteredCount} 条${paused}`
        : `没有匹配结果${paused}`;
}

function shouldShowResultMeta() {
    return hasNewsFilters() || newsPaused;
}

function syncCommunityControls() {
    const active = currentFilter === 'community';
    document.documentElement.classList.toggle('community-reading', active);
    const bar = document.getElementById('communitySourceBar');
    if (bar) bar.hidden = !active;
    document.querySelectorAll('[data-community-source]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.communitySource === communitySource));
        button.disabled = hiddenSources.includes(button.dataset.communitySource);
        button.title = button.disabled ? '该来源已在设置中关闭' : '';
    });
    const title = document.getElementById('newsPanelTitleText');
    if (title) title.textContent = active ? '社区订阅' : '7×24 快讯';
    const unseenLabel = document.getElementById('newsUnseenLabel');
    if (unseenLabel) unseenLabel.textContent = active ? '条新帖子' : '条新快讯';
    const search = document.getElementById('newsSearchInput');
    if (search) {
        search.placeholder = active ? '搜索帖子标题或摘要' : '搜索快讯、来源或原因';
        search.setAttribute('aria-label', active ? '搜索论坛帖子' : '搜索快讯');
    }
}

function renderNewsList(newKeys = new Set(), mode = 'reset') {
    const listContainer = document.getElementById('newsList');
    const filtered = readingPool().filter(news => applyFilter(news));
    const splitActive = isSplitModeActive(filtered.length);
    document.documentElement.classList.toggle('news-split-active', splitActive);

    const liveItems = splitActive ? filtered.filter(news => news.category === 'news') : null;
    const deepItems = splitActive ? filtered.filter(news => news.category !== 'news') : null;
    const renderedCount = splitActive
        ? Math.min(liveItems.length, splitLimits.live) + Math.min(deepItems.length, splitLimits.deep)
        : Math.min(filtered.length, visibleLimit);

    updateTabCounts();
    updateResultMeta(filtered.length, renderedCount);
    const meta = document.getElementById('newsResultMeta');
    if (meta) meta.hidden = !shouldShowResultMeta();
    listContainer.setAttribute('aria-labelledby', `tab-${currentFilter}`);
    if (!hasLoadedNews && allNewsData.length === 0 && filtered.length === 0) return;

    const existing = new Map(
        Array.from(listContainer.querySelectorAll('[data-news-key]'))
            .map(element => [element.dataset.newsKey, element])
    );
    const emptyText = emptyFilterText();

    if (splitActive) {
        const prevLive = listContainer.querySelector('[data-split-col="live"] .news-split-scroll');
        const prevDeep = listContainer.querySelector('[data-split-col="deep"] .news-split-scroll');
        const anchors = mode === 'anchor' ? {
            live: prevLive ? captureScrollAnchor(prevLive) : null,
            deep: prevDeep ? captureScrollAnchor(prevDeep) : null,
        } : null;

        const liveCol = createSplitColumn('live', '实时快讯 · 新浪直播', liveItems.length);
        const deepCol = createSplitColumn('deep', '海外资讯 · 科技 · 论坛精华', deepItems.length);

        liveCol.scrollEl.appendChild(buildFeedFragment(
            liveItems, splitLimits.live, existing, newKeys, liveCol.scrollEl,
            '当前暂无实时快讯', rendered => handleLoadMore('live', rendered),
        ));
        deepCol.scrollEl.appendChild(buildFeedFragment(
            deepItems, splitLimits.deep, existing, newKeys, deepCol.scrollEl,
            '当前暂无海外、科技或论坛资讯', rendered => handleLoadMore('deep', rendered),
        ));

        listContainer.replaceChildren(liveCol.col, deepCol.col);
        refreshCommunitySummaries(listContainer);
        if (mode === 'anchor' && anchors) {
            restoreScrollAnchor(liveCol.scrollEl, anchors.live);
            restoreScrollAnchor(deepCol.scrollEl, anchors.deep);
        } else {
            liveCol.scrollEl.scrollTop = 0;
            deepCol.scrollEl.scrollTop = 0;
        }
    } else {
        const anchor = mode === 'anchor' ? captureScrollAnchor(listContainer) : null;
        const fragment = buildFeedFragment(
            filtered, visibleLimit, existing, newKeys, listContainer,
            emptyText, rendered => handleLoadMore(null, rendered),
        );
        listContainer.replaceChildren(fragment);
        refreshCommunitySummaries(listContainer);

        if (mode === 'anchor') restoreScrollAnchor(listContainer, anchor);
        else listContainer.scrollTop = 0;
    }

    if (pendingFocusKey) {
        const previous = listContainer.querySelector(`[data-news-key="${CSS.escape(pendingFocusKey)}"]`);
        const target = previous?.nextElementSibling?.matches?.('[data-news-key]')
            ? previous.nextElementSibling
            : previous?.nextElementSibling?.nextElementSibling;
        if (target?.matches?.('[data-news-key]')) {
            target.tabIndex = -1;
            target.focus({ preventScroll: true });
        }
        pendingFocusKey = '';
    }
    refreshRevealObserver();
    syncScrollShadow();
    updateReadingControls();
    observeReading();
}

function withViewTransition(mutate) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!hasLoadedNews || reduce || !motionAllowed() || typeof document.startViewTransition !== 'function') {
        mutate();
        return;
    }
    const transition = document.startViewTransition(mutate);
    transition.finished?.catch(() => {});
}

export function setFontSize(size, persist = true, render = true) {
    if (!['sm', 'base', 'lg'].includes(size)) return;
    currentFontSize = size;
    if (persist && getSettings().news.fontSize !== size) updateSettings('news', { fontSize: size });
    if (render) withViewTransition(renderNewsList);
}

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

function updateTabCounts() {
    const counts = computeTabCounts(allNewsData, hiddenSources);
    for (const k of ['all', 'news', 'foreign', 'tech', 'community']) {
        const el = document.getElementById('count-' + k);
        if (el) el.textContent = counts[k] ? (k === 'tech' ? `${counts[k]}源` : String(counts[k])) : '';
    }
    const importantEl = document.getElementById('count-important');
    if (importantEl) importantEl.textContent = counts.important ? String(counts.important) : '';
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
    splitLimits = { live: NEWS_PAGE_SIZE, deep: NEWS_PAGE_SIZE };
    clearUnseen();
    withViewTransition(() => renderNewsList(new Set(), 'reset'));
}

export function setFilter(filter, persist = true, render = true) {
    if (!['all', 'news', 'foreign', 'tech', 'community'].includes(filter)) return;
    currentFilter = filter;
    syncCommunityControls();
    syncFilterIndicator();
    if (persist && getSettings().news.category !== filter) updateSettings('news', { category: filter });
    ['all', 'news', 'foreign', 'tech', 'community'].forEach(t => {
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
            if (!normalized.format) {
                normalized.format = normalized.tech_data ? 'tech'
                    : (normalized.category === 'tech' && !normalized.url ? 'html' : 'text');
            }
            return normalized;
        }));
        setNewsStatus(newsPaused ? 'paused' : 'online');
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

        if (firstLoad || nextSignature !== lastNewsSignature) {
            const wasAtTop = firstLoad || newsListAtTop();
            allNewsData = newsList;
            updateSourceOptions();
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
        console.error('快讯同步失败:', e);
        setNewsStatus('offline');
        if (!hasLoadedNews) {
            hasLoadedNews = true;
            const listContainer = document.getElementById('newsList');
            if (readingView === 'saved') renderNewsList();
            else if (listContainer) {
                listContainer.replaceChildren(emptyMessage('快讯暂不可用'));
            }
            document.getElementById('lastUpdateTime').innerText = '连接失败';
        }
    }
}

function setFilterBarOpen(open, persist = true) {
    const row = document.getElementById('newsFilterRow');
    const toggle = document.getElementById('newsFilterToggle');
    if (!row || !toggle) return;
    row.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.classList.toggle('active', open);
    if (open) row.removeAttribute('inert');
    else row.setAttribute('inert', '');
    if (persist && Boolean(getSettings().news.filterBarOpen) !== open) {
        updateSettings('news', { filterBarOpen: open });
    }
}

function syncFilterIndicator() {
    const toggle = document.getElementById('newsFilterToggle');
    if (!toggle) return;
    toggle.classList.toggle('has-filter', hasNewsFilters());
}

export function initNews() {
    document.querySelectorAll('[data-community-source]').forEach(button => {
        button.addEventListener('click', () => updateSettings('news', { communitySource: button.dataset.communitySource }));
    });
    document.querySelectorAll('[data-reading-view]').forEach(button => {
        button.addEventListener('click', () => updateSettings('news', { readingView: button.dataset.readingView }));
    });
    document.getElementById('markAllNewsRead').addEventListener('click', () => {
        markAllRead(readingPool().filter(news => applyFilter(news, true)));
        if (readingView === 'unread') renderNewsList();
    });
    window.addEventListener('gx:reading-changed', event => {
        updateReadingControls();
        if (event.detail.kind === 'saved' && readingView === 'saved') renderNewsList(new Set(), 'anchor');
    });
    document.addEventListener('visibilitychange', observeReading);

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
        if (!isPanelScrollMode()) {
            const aside = document.querySelector('aside');
            window.scrollTo({ top: aside ? aside.offsetTop : 0, behavior: 'smooth' });
        } else {
            const splitScrollers = getSplitScrollContainers(listContainer);
            if (splitScrollers.length) {
                splitScrollers.forEach(scroller => scroller.scrollTo({ top: 0, behavior: 'smooth' }));
            } else {
                listContainer?.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }
    });
    const handleListScroll = () => {
        syncScrollShadow();
        if (newsListAtTop()) clearUnseen();
    };
    listContainer?.addEventListener('scroll', handleListScroll, { passive: true, capture: true });
    window.addEventListener('scroll', handleListScroll, { passive: true });
    window.addEventListener('resize', () => {
        syncScrollShadow();
        refreshRevealObserver();
    });

    const poll = async () => {
        if (document.hidden || !isWidgetVisible('news') || (newsPaused && hasLoadedNews) || newsRequestInFlight) return;
        newsRequestInFlight = true;
        try {
            await fetchRealNews();
        } finally {
            newsRequestInFlight = false;
            if (!document.hidden && isWidgetVisible('news') && !newsPaused) newsPollTimer = window.setTimeout(poll, NEWS_POLL_INTERVAL);
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
        if (next.readingView !== readingView) { readingView = next.readingView; viewChanged = true; }
        if (JSON.stringify(next.hiddenSources) !== JSON.stringify(hiddenSources)) {
            hiddenSources = next.hiddenSources;
            viewChanged = true;
        }
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
        if (next.communitySource !== communitySource) {
            communitySource = next.communitySource;
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
        syncCommunityControls();
        syncFilterIndicator();
        applyPauseState(!next.autoRefresh);
        if (viewChanged) resetNewsView();
    });

    const handleVisibility = () => {
        window.clearTimeout(newsPollTimer);
        newsPollTimer = null;
        if (!document.hidden) poll();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    let newsVisible = isWidgetVisible('news');
    window.addEventListener('gx:layout-changed', () => {
        const next = isWidgetVisible('news');
        if (next === newsVisible) return;
        newsVisible = next;
        handleVisibility();
        if (next) requestAnimationFrame(() => { moveTabIndicator(currentFilter); syncScrollShadow(); });
    });

    syncImportantButton();
    syncPauseButton();
    setFilterBarOpen(Boolean(initialNewsSettings.filterBarOpen) || currentSource !== 'all', false);
    setFontSize(currentFontSize, false);
    setFilter(currentFilter, false);
    updateUnseenPill();
    poll();
    const refreshSummaries = () => refreshCommunitySummaries(document.getElementById('newsList'));
    if (typeof ResizeObserver !== 'undefined') {
        const summaryObserver = new ResizeObserver(refreshSummaries);
        summaryObserver.observe(document.getElementById('newsList'));
    }
    document.fonts?.ready.then(refreshSummaries);
    window.addEventListener('resize', () => moveTabIndicator(currentFilter));
    window.addEventListener('gx:panel-layout', () => {
        const filteredCount = hasLoadedNews ? readingPool().filter(news => applyFilter(news)).length : 0;
        const nextSplit = isSplitModeActive(filteredCount);
        const currentSplit = document.documentElement.classList.contains('news-split-active');
        if (hasLoadedNews && nextSplit !== currentSplit) {
            renderNewsList(new Set(), 'reset');
        }
        moveTabIndicator(currentFilter);
        syncScrollShadow();
        observeReading();
        refreshRevealObserver();
    });
    const tabBar = document.getElementById('tabBar');
    if (tabBar && typeof ResizeObserver === 'function') {
        new ResizeObserver(() => moveTabIndicator(currentFilter)).observe(tabBar);
    }
    window.addEventListener('gx:settings-changed', event => {
        if (event.detail?.section === 'typography') {
            requestAnimationFrame(() => moveTabIndicator(currentFilter));
            document.fonts?.ready?.then(() => moveTabIndicator(currentFilter));
        }
    });
    document.fonts?.ready?.then(() => moveTabIndicator(currentFilter));
}
