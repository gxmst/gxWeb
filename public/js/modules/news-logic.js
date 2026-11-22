// ================== 新闻流纯函数逻辑（可在 Node 单元测试中直接运行） ==================

export const MAX_NEWS_ITEMS = 2200;
export const MAX_ARCHIVE_ITEMS = 6000;
export const NEWS_PAGE_SIZE = 60;
export const CATEGORY_QUOTAS = [
    ['community', 1100],
    ['foreign', 550],
    ['tech', 60],
];
export const ARCHIVE_CATEGORY_QUOTAS = [
    ['community', 3000],
    ['foreign', 1200],
    ['tech', 80],
];

const SOURCE_LABELS = {
    sina: '新浪',
    github: 'GitHub',
    hn: 'Hacker News',
    v2ex: 'V2EX',
    nodeseek: 'NodeSeek',
    linuxdo: 'Linux DO',
};

export function simpleHash(str) {
    str = String(str || '');
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return h;
}

export function newsIdentity(news) {
    const explicitId = news.id ?? news.news_id ?? news.feed_id;
    if (explicitId !== undefined && explicitId !== null && explicitId !== '') return `id-${explicitId}`;
    return `item-${simpleHash([
        news.category, news.source, news.raw_time, news.time, news.url, news.content
    ].join('\u241f')) >>> 0}`;
}

export function assignClientKeys(newsList, maxItems = MAX_NEWS_ITEMS, quotas = CATEGORY_QUOTAS) {
    const occurrences = new Map();
    const scaleBase = maxItems >= MAX_ARCHIVE_ITEMS ? MAX_ARCHIVE_ITEMS : MAX_NEWS_ITEMS;
    // 为较慢的来源（社区、海外 RSS、科技热榜）各预留配额，避免大量快讯把这些分类挤空。
    const reserved = new Set();
    for (const [category, baseQuota] of quotas) {
        const quota = maxItems >= scaleBase ? baseQuota : Math.max(1, Math.floor(maxItems * baseQuota / scaleBase));
        newsList.filter(item => item.category === category).slice(0, quota).forEach(item => {
            if (reserved.size < maxItems) reserved.add(item);
        });
    }
    for (const item of newsList) {
        if (reserved.size >= maxItems) break;
        reserved.add(item);
    }
    return newsList.filter(item => reserved.has(item)).slice(0, maxItems).map(news => {
        const base = newsIdentity(news);
        const occurrence = occurrences.get(base) || 0;
        occurrences.set(base, occurrence + 1);
        return { ...news, _clientKey: occurrence ? `${base}-${occurrence}` : base };
    });
}

export function newsRenderSignature(news, fontSize = 'sm', highlightTerm = '') {
    return String(simpleHash(JSON.stringify([
        news._clientKey, news.time, news.display_content, news.content, news.url,
        news.category, news.source, news.format, news.tech_data || null, Boolean(news.is_important),
        news.importance_score, news.importance_reason, news.summary, news.forum_category, fontSize,
        highlightTerm, formatItemTime(news)
    ])) >>> 0);
}

export function datasetSignature(newsList) {
    return String(simpleHash(JSON.stringify(newsList.map(news => [
        news._clientKey, news.time, news.display_content, news.content, news.url,
        news.category, news.source, news.format, news.tech_data || null, Boolean(news.is_important),
        news.importance_score, news.importance_reason, news.summary, news.forum_category,
        news.category === 'community' ? formatCommunityTime(news) : ''
    ]))) >>> 0);
}

export function formatLastUpdated(timestamp, fallback) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return fallback || '刚刚';
    return new Date(value * 1000).toLocaleTimeString('zh-CN', {
        hour: '2-digit', minute: '2-digit', hour12: false
    });
}

function dayPeriodLabel(hour) {
    if (hour < 6) return '凌晨';
    if (hour < 12) return '上午';
    if (hour < 18) return '下午';
    return '晚间';
}

export function groupLabel(news, now = new Date()) {
    const raw = Number(news.raw_time);
    if (!Number.isFinite(raw) || raw <= 0) return { id: 'unknown', label: '较早' };
    const date = new Date(raw * 1000);
    const sameDay = date.toDateString() === now.toDateString();
    const hourNum = date.getHours();
    const hour = String(hourNum).padStart(2, '0');
    if (sameDay) return { id: `${date.toDateString()}-${hour}`, label: `今天 ${hour}:00` };
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
        return { id: `${date.toDateString()}-${hour}`, label: `昨天 ${hour}:00` };
    }
    const dayLabel = `${date.getMonth() + 1}月${date.getDate()}日`;
    const period = dayPeriodLabel(hourNum);
    return { id: `${date.toDateString()}-${period}`, label: `${dayLabel} ${period}` };
}

export function sourceLabel(source) {
    return SOURCE_LABELS[String(source || '').toLowerCase()] || String(source || '未知来源');
}

export function formatCommunityTime(news, now = new Date()) {
    const raw = Number(news.raw_time);
    if (!Number.isFinite(raw) || raw <= 0) return news.time || '时间未知';
    const date = new Date(raw * 1000);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const day = date.toDateString() === now.toDateString() ? '今天'
        : date.toDateString() === yesterday.toDateString() ? '昨天'
        : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    return `${day} ${news.time || formatLastUpdated(raw)}`;
}

export function formatItemTime(news, now = new Date()) {
    if (news.category === 'community') return formatCommunityTime(news, now);
    const raw = Number(news.raw_time);
    if (Number.isFinite(raw) && raw > 0) {
        const date = new Date(raw * 1000);
        if (date.toDateString() !== now.toDateString()) {
            return formatCommunityTime(news, now);
        }
    }
    return news.time || '';
}

export function sanitizeHttpUrl(url, baseOrigin = (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1')) {
    if (!url) return '';
    try {
        const parsed = new URL(url, baseOrigin);
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
    } catch {
        return '';
    }
}

export function normalizeNewsDisplayText(news) {
    const rawText = news.display_content || news.content || '';
    if (['news', 'foreign'].includes(news.category || '')) {
        return rawText.replace(/^【[^】]+】\s*/, '');
    }
    return rawText;
}

export function matchesDateFilter(news, dateFilter = 'all', now = new Date()) {
    if (!dateFilter || dateFilter === 'all') return true;
    const raw = Number(news?.raw_time);
    if (!Number.isFinite(raw) || raw <= 0) return false;
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const yesterdayStart = todayStart - 86400;
    const threeDaysStart = todayStart - 2 * 86400;
    if (dateFilter === 'today') return raw >= todayStart;
    if (dateFilter === 'yesterday') return raw >= yesterdayStart && raw < todayStart;
    if (dateFilter === '3d') return raw >= threeDaysStart;
    if (dateFilter === 'older') return raw < threeDaysStart;
    return true;
}

export function computeDateBucketCounts(items, now = new Date()) {
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const yesterdayStart = todayStart - 86400;
    const threeDaysStart = todayStart - 2 * 86400;
    const counts = { all: items.length, today: 0, yesterday: 0, '3d': 0, older: 0 };
    for (const item of items) {
        const raw = Number(item?.raw_time);
        if (!Number.isFinite(raw) || raw <= 0) continue;
        if (raw >= todayStart) counts.today++;
        else if (raw >= yesterdayStart) counts.yesterday++;
        if (raw >= threeDaysStart) counts['3d']++;
        else counts.older++;
    }
    return counts;
}

export function computeTabCounts(allNewsData, hiddenSources = []) {
    const hidden = new Set(hiddenSources);
    const enabled = allNewsData.filter(news => !hidden.has(news.source));
    const counts = { all: enabled.length, news: 0, foreign: 0, tech: 0, community: 0, important: 0 };
    for (const news of enabled) {
        const category = news.category;
        if (category && category !== 'all' && category !== 'important' && Object.hasOwn(counts, category)) {
            counts[category]++;
        }
        if (news.is_important) counts.important++;
    }
    return counts;
}

export function matchesNewsFilter(news, filterState, checkReadFn, ignoreReading = false) {
    const {
        readingView = 'all',
        hiddenSources = [],
        currentFilter = 'all',
        importantOnly = false,
        currentSource = 'all',
        communitySource = 'all',
        dateFilter = 'all',
        searchTerm = '',
    } = filterState || {};

    if (!ignoreReading && readingView === 'unread' && checkReadFn?.(news._clientKey)) return false;
    if (hiddenSources.includes(news.source)) return false;
    const category = news.category || 'all';
    if (currentFilter !== 'all' && category !== currentFilter) return false;
    if (currentFilter !== 'community' && importantOnly && !news.is_important) return false;
    const sourceFilter = currentFilter === 'community' ? communitySource : currentSource;
    if (sourceFilter !== 'all' && news.source !== sourceFilter) return false;
    if (dateFilter && dateFilter !== 'all' && !matchesDateFilter(news, dateFilter)) return false;
    if (searchTerm) {
        let searchText = [
            news.display_content,
            news.content,
            news.summary,
            news.forum_category,
            sourceLabel(news.source),
            news.importance_reason,
        ].filter(Boolean).join(' ');
        if (news.format === 'html') {
            searchText = searchText.replace(/<[^>]+>/g, ' ');
        }
        if (!searchText.toLocaleLowerCase('zh-CN').includes(searchTerm)) return false;
    }
    return true;
}

/** Determine whether dual-column fullscreen split layout applies to the active view. */
export function supportsSplitView({
    viewportWidth = 0,
    newsPanelMode = 'compact',
    category = 'all',
    source = 'all',
    communitySource = 'all',
} = {}) {
    if (viewportWidth < 1024 || newsPanelMode !== 'full') return false;
    if (category === 'all') return source === 'all';
    if (category === 'community') return communitySource === 'all';
    return false;
}

/** Match an already-filtered news item against a single split column selector spec. */
export function matchesSplitColumnFilter(news, spec = 'all') {
    if (!news) return false;
    if (!spec || spec === 'all') return true;
    if (spec === 'group:deep') return news.category !== 'news';
    if (spec.startsWith('cat:')) return news.category === spec.slice(4);
    if (spec.startsWith('src:')) return news.source === spec.slice(4);
    return true;
}
