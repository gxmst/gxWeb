// ================== 新闻流与交互渲染 ==================
let allNewsData = [];
let hasLoadedNews = false;
let currentFilter = 'all';
let lastFirstNewsHash = '';
let currentFontSize = 'sm';

// 供 wallpaper.js 取色后重新对齐指示器读取当前分类
export function getCurrentFilter() { return currentFilter; }

function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return h;
}

// 统一渲染函数：根据当前数据和过滤条件，全量重绘列表
function renderNewsList() {
    const listContainer = document.getElementById('newsList');
    const filtered = allNewsData.filter(applyFilter);

    updateTabCounts();
    if (!hasLoadedNews && allNewsData.length === 0) return;
    listContainer.innerHTML = '';
    if (filtered.length === 0) {
        listContainer.innerHTML = '<div class="text-center text-white/30 mt-10 text-sm">暂无对应快讯</div>';
    } else {
        filtered.forEach(n => listContainer.appendChild(createNewsElement(n)));
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
    currentFontSize = size;
    ['sm', 'base', 'lg'].forEach(s => {
        const btn = document.getElementById('fs-' + s);
        if (s === size) { btn.classList.add('bg-white/20', 'text-white'); btn.classList.remove('text-white/50'); }
        else { btn.classList.remove('bg-white/20', 'text-white'); btn.classList.add('text-white/50'); }
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
    currentFilter = filter;
    ['all', 'news', 'foreign', 'tech'].forEach(t => {
        const btn = document.getElementById('tab-' + t);
        if (btn) btn.classList.toggle('active', t === filter);
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
        const response = await fetch('./finance-news.json?t=' + Date.now());
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        const newsList = (data.news_list || []).map(item => {
            const normalized = { ...item };
            if (!normalized.category) {
                if ((normalized.content || '').includes('GitHub') || (normalized.content || '').includes('HN') || (normalized.content || '').includes('V2EX')) normalized.category = 'tech';
                else if (normalized.url) normalized.category = 'foreign';
                else normalized.category = 'news';
            }
            if (!normalized.format) normalized.format = normalized.category === 'tech' && !normalized.url ? 'html' : 'text';
            return normalized;
        });
        if (!newsList || newsList.length === 0) {
            hasLoadedNews = true;
            allNewsData = [];
            lastFirstNewsHash = '';
            document.getElementById('lastUpdateTime').innerText = '暂无数据';
            const sk = document.getElementById('newsSkeleton');
            if (sk) sk.remove();
            renderNewsList();
            return;
        }

        const listContainer = document.getElementById('newsList');

        // 首次加载：初始化数据并全量渲染
        if (allNewsData.length === 0) {
            hasLoadedNews = true;
            allNewsData = newsList;
            lastFirstNewsHash = simpleHash(newsList[0].content);
            document.getElementById('lastUpdateTime').innerText = `${newsList[0].time}`;
            const sk = document.getElementById('newsSkeleton');
            if (sk) sk.remove();
            renderNewsList();
            return;
        }

        // 增量同步：发现新数据时，执行平滑插入
        const newFirstHash = simpleHash(newsList[0].content);
        if (newFirstHash !== lastFirstNewsHash) {
            const newItems = [];
            for (let n of newsList) {
                if (simpleHash(n.content) === lastFirstNewsHash) break;
                if (applyFilter(n)) newItems.push(n);
            }

            allNewsData = newsList;
            document.getElementById('lastUpdateTime').innerText = `${newsList[0].time}`;
            updateTabCounts();

            if (newItems.length > 0) {
                const currentScroll = listContainer.scrollTop;
                const oldHeight = listContainer.scrollHeight;

                newItems.reverse().forEach(n => {
                    listContainer.prepend(createNewsElement(n, true));
                });

                if (currentScroll > 10) {
                    listContainer.scrollTop = currentScroll + (listContainer.scrollHeight - oldHeight);
                }
            } else {
                renderNewsList();
            }
            lastFirstNewsHash = newFirstHash;
        }
    } catch (e) {
        console.error("快讯同步失败:", e);
        document.getElementById('statusText').innerText = '断连';
        document.getElementById('statusText').className = 'text-[10px] font-bold text-red-400';
        document.getElementById('statusPing').className = 'hidden';
        document.getElementById('statusDot').className = 'relative inline-flex rounded-full h-2 w-2 bg-red-500';
        if (!hasLoadedNews) {
            hasLoadedNews = true;
            const listContainer = document.getElementById('newsList');
            if (listContainer) {
                listContainer.innerHTML = '<div class="text-center text-white/30 mt-10 text-sm">快讯暂不可用</div>';
            }
            document.getElementById('lastUpdateTime').innerText = '连接失败';
        }
    }
}

export function initNews() {
    setFilter('all');                  // 初始化激活态 + 滑动指示器定位
    fetchRealNews();
    setInterval(fetchRealNews, 30000);
    // 窗口尺寸变化时重新对齐指示器（tab 宽度会随之变化）
    window.addEventListener('resize', () => moveTabIndicator(currentFilter));
}

// HTML 内联 onclick 引用的全局函数（setFilter('all') / setFontSize('sm')）
window.setFilter = setFilter;
window.setFontSize = setFontSize;
