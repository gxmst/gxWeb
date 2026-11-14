import assert from 'node:assert/strict';
import test from 'node:test';

const memoryStorage = new Map();
globalThis.localStorage = {
    getItem(key) {
        return memoryStorage.has(key) ? memoryStorage.get(key) : null;
    },
    setItem(key, value) {
        memoryStorage.set(key, String(value));
    },
    removeItem(key) {
        memoryStorage.delete(key);
    },
    clear() {
        memoryStorage.clear();
    },
};

const {
    MAX_NEWS_ITEMS,
    assignClientKeys,
    computeTabCounts,
    formatCommunityTime,
    groupLabel,
    matchesNewsFilter,
    matchesSplitColumnFilter,
    normalizeNewsDisplayText,
    sanitizeHttpUrl,
    supportsSplitView,
} = await import('../public/js/modules/news-logic.js');

const {
    countSavedMatching,
    sanitizeReadingState,
    toggleSaved,
} = await import('../public/js/modules/news-state.js');

test('assignClientKeys reserves capacity for community, foreign, and tech at higher feed limits', () => {
    const heavySina = Array.from({ length: 900 }, (_, index) => ({
        id: `sina-${index}`,
        category: 'news',
        source: 'sina',
        raw_time: 2000 - index,
        content: `快讯 ${index}`,
    }));
    const community = Array.from({ length: 320 }, (_, index) => ({
        id: `forum-${index}`,
        category: 'community',
        source: 'linuxdo',
        raw_time: 1800 - index,
        content: `讨论 ${index}`,
    }));
    const foreign = Array.from({ length: 280 }, (_, index) => ({
        id: `rss-${index}`,
        category: 'foreign',
        source: 'Reuters',
        raw_time: 100 - index,
        content: `World headline ${index}`,
    }));
    const combined = [...heavySina, ...community, ...foreign];

    const assigned = assignClientKeys(combined);

    assert.equal(assigned.length, MAX_NEWS_ITEMS);
    assert.equal(assigned.filter(item => item.category === 'community').length, 300);
    assert.equal(assigned.filter(item => item.category === 'foreign').length, 250);
    assert.equal(assigned[0]._clientKey, 'id-sina-0');
});

test('assignClientKeys deduplicates identical explicit ids', () => {
    const items = assignClientKeys([
        { id: 'dup-1', category: 'news', source: 'sina', content: 'A' },
        { id: 'dup-1', category: 'news', source: 'sina', content: 'B' },
    ]);

    assert.deepEqual(items.map(item => item._clientKey), ['id-dup-1', 'id-dup-1-1']);
});

test('normalizeNewsDisplayText strips source tag prefix for news and foreign', () => {
    assert.equal(
        normalizeNewsDisplayText({ category: 'news', display_content: '【财联社】央行发声' }),
        '央行发声',
    );
    assert.equal(
        normalizeNewsDisplayText({ category: 'foreign', display_content: '【BBC】Global markets rally' }),
        'Global markets rally',
    );
    assert.equal(
        normalizeNewsDisplayText({ category: 'community', display_content: '【精华】Linux DO 分享' }),
        '【精华】Linux DO 分享',
    );
});

test('computeTabCounts applies hiddenSources filter to important badge too', () => {
    const items = [
        { source: 'sina', category: 'news', is_important: true },
        { source: 'nodeseek', category: 'community', is_important: true },
        { source: 'github', category: 'tech', is_important: false },
    ];

    const counts = computeTabCounts(items, ['nodeseek']);

    assert.deepEqual(counts, {
        all: 2,
        news: 1,
        foreign: 0,
        tech: 1,
        community: 0,
        important: 1,
    });
});

test('matchesNewsFilter preserves angle brackets in plain tech text and filters unread', () => {
    const techItem = {
        _clientKey: 'id-tech-1',
        category: 'tech',
        source: 'github',
        format: 'tech',
        content: 'GitHub Trends · vercel/next.js · Fast <React> compiler',
        is_important: false,
    };

    assert.equal(
        matchesNewsFilter(techItem, { readingView: 'unread', searchTerm: '<react>' }, () => false),
        true,
    );
    assert.equal(
        matchesNewsFilter(techItem, { readingView: 'unread', searchTerm: '<react>' }, () => true),
        false,
    );
    assert.equal(
        matchesNewsFilter(techItem, { importantOnly: true }, () => false),
        false,
    );
});

test('sanitizeHttpUrl accepts http(s) and rejects unsafe schemes', () => {
    assert.equal(sanitizeHttpUrl('https://example.com/a?x=1'), 'https://example.com/a?x=1');
    assert.equal(sanitizeHttpUrl('/api/health', 'https://gx.example.com'), 'https://gx.example.com/api/health');
    assert.equal(sanitizeHttpUrl('javascript:alert(1)'), '');
    assert.equal(sanitizeHttpUrl('data:text/html,hi'), '');
});

test('community source filtering ignores general source and importance but preserves reading and hidden sources', () => {
    const post = { _clientKey: 'id-forum', source: 'linuxdo', category: 'community', summary: '备份与恢复', is_important: false };
    const filters = { currentFilter: 'community', currentSource: 'BBC', importantOnly: true };
    assert.equal(matchesNewsFilter(post, filters), true);
    assert.equal(matchesNewsFilter(post, { ...filters, communitySource: 'linuxdo', searchTerm: '恢复' }), true);
    assert.equal(matchesNewsFilter(post, { ...filters, communitySource: 'nodeseek' }), false);
    assert.equal(matchesNewsFilter(post, { ...filters, hiddenSources: ['linuxdo'] }), false);
    assert.equal(matchesNewsFilter(post, { ...filters, readingView: 'unread' }, () => true), false);
    assert.equal(matchesNewsFilter(post, { currentFilter: 'all', currentSource: 'BBC' }), false);
    assert.equal(matchesNewsFilter(post, { currentFilter: 'all', importantOnly: true }), false);
});

test('community time includes a date and preserves unknown timestamps', () => {
    const now = new Date(2026, 10, 14, 10);
    const timestamp = (day, hour) => new Date(2026, 10, day, hour).getTime() / 1000;
    assert.equal(formatCommunityTime({ raw_time: timestamp(14, 9), time: '09:00' }, now), '今天 09:00');
    assert.equal(formatCommunityTime({ raw_time: timestamp(13, 8), time: '08:00' }, now), '昨天 08:00');
    assert.equal(formatCommunityTime({ raw_time: 0, time: '08:00' }, now), '08:00');
});

test('groupLabel formats undated entries as earlier instead of current hour', () => {
    const now = new Date(2026, 10, 13, 15, 30);
    assert.deepEqual(groupLabel({ raw_time: 0 }, now), { id: 'unknown', label: '较早' });
    const todayTs = Math.floor(new Date(2026, 10, 13, 9, 15).getTime() / 1000);
    assert.equal(groupLabel({ raw_time: todayTs }, now).label, '今天 09:00');
});

test('news-state preserves structured tech bookmarks and counts filtered matches', () => {
    const techEntry = {
        _clientKey: 'id-tech-gh-1',
        id: 'tech-github-1',
        content: 'GitHub Trends · owner/repo',
        source: 'github',
        category: 'tech',
        format: 'tech',
        raw_time: 1700000000,
        time: '12:00',
        url: '',
        is_important: false,
        tech_data: {
            brand: 'GitHub Trends',
            dot_color: 'bg-purple-400',
            sections: [
                {
                    label: 'Last 7 Days',
                    compact: false,
                    items: [{ rank: '01', title: 'owner/repo', url: 'https://github.com/owner/repo', stars: '1.2k', raw_stars: 1200 }],
                },
            ],
        },
    };

    const sanitized = sanitizeReadingState({
        read: { 'id-tech-gh-1': 1700000100 },
        saved: {
            'id-tech-gh-1': techEntry,
            'id-html-1': { content: '<div>old</div>', format: 'html', category: 'tech', source: 'hn' },
            'id-weird-1': { content: 'plain', format: 'unknown', category: 'news', source: 'sina' },
        },
    });

    assert.equal(sanitized.saved['id-tech-gh-1'].format, 'tech');
    assert.equal(sanitized.saved['id-tech-gh-1'].tech_data.brand, 'GitHub Trends');
    assert.equal(sanitized.saved['id-html-1'].format, 'html');
    assert.equal(sanitized.saved['id-weird-1'].format, 'text');

    assert.equal(toggleSaved(techEntry), true);
    assert.equal(countSavedMatching(item => item.source === 'github'), 1);
    assert.equal(toggleSaved(techEntry), true);
    assert.equal(countSavedMatching(item => item.source === 'github'), 0);
});

test('supportsSplitView only enables desktop fullscreen split on unfiltered all and community views', () => {
    assert.equal(supportsSplitView({ viewportWidth: 1440, newsPanelMode: 'full', category: 'all', source: 'all' }), true);
    assert.equal(supportsSplitView({ viewportWidth: 1440, newsPanelMode: 'full', category: 'community', communitySource: 'all' }), true);
    assert.equal(supportsSplitView({ viewportWidth: 1440, newsPanelMode: 'full', category: 'community', communitySource: 'linuxdo' }), false);
    assert.equal(supportsSplitView({ viewportWidth: 1440, newsPanelMode: 'full', category: 'all', source: 'sina' }), false);
    assert.equal(supportsSplitView({ viewportWidth: 1440, newsPanelMode: 'full', category: 'tech' }), false);
    assert.equal(supportsSplitView({ viewportWidth: 1440, newsPanelMode: 'wide', category: 'all' }), false);
    assert.equal(supportsSplitView({ viewportWidth: 900, newsPanelMode: 'full', category: 'community', communitySource: 'all' }), false);
});

test('matchesSplitColumnFilter separates categories, deep digest group, and forum sources', () => {
    const domestic = { category: 'news', source: 'sina' };
    const foreign = { category: 'foreign', source: 'BBC' };
    const linuxdo = { category: 'community', source: 'linuxdo' };
    const nodeseek = { category: 'community', source: 'nodeseek' };

    assert.equal(matchesSplitColumnFilter(domestic, 'cat:news'), true);
    assert.equal(matchesSplitColumnFilter(foreign, 'cat:news'), false);
    assert.equal(matchesSplitColumnFilter(domestic, 'group:deep'), false);
    assert.equal(matchesSplitColumnFilter(foreign, 'group:deep'), true);
    assert.equal(matchesSplitColumnFilter(linuxdo, 'group:deep'), true);
    assert.equal(matchesSplitColumnFilter(linuxdo, 'src:linuxdo'), true);
    assert.equal(matchesSplitColumnFilter(nodeseek, 'src:linuxdo'), false);
    assert.equal(matchesSplitColumnFilter(nodeseek, 'src:nodeseek'), true);
    assert.equal(matchesSplitColumnFilter(linuxdo, 'all'), true);
});
