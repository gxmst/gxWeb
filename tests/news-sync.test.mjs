import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import * as logic from '../public/js/modules/news-logic.js';

const source = (await readFile(new URL('../public/js/modules/news.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\r?$/gm, '').replace(/\bexport /g, '');
const item = id => ({ id, source: 'sina', category: 'news', content: id, raw_time: 100 });

async function harness() {
    const window = Object.assign(new EventTarget(), {
        innerWidth: 1440, matchMedia: () => ({ matches: true }),
        clearTimeout() {}, setTimeout() { return 1; },
    });
    globalThis.window = window;
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    const reading = await import(`../public/js/modules/news-state.js?test=${Math.random()}`);
    const element = {
        classList: { toggle() {}, contains: () => false },
        style: { setProperty() {} }, offsetLeft: 0, offsetWidth: 80,
        setAttribute() {}, removeAttribute() {}, addEventListener() {},
        querySelector: () => null, querySelectorAll: () => [], remove() {},
    };
    const settings = { news: {
        category: 'all', source: 'all', communitySource: 'all', fontSize: 'sm',
        hiddenSources: [], readingView: 'all', autoRefresh: true,
    }, layout: { newsPanelMode: 'compact' } };
    const state = { hot: [item('A')], archive: [item('A')], clock: 1000, failArchive: false, requests: 0, views: [] };
    const context = vm.createContext({
        ...logic, ...reading, window, console, CustomEvent,
        getSettings: () => settings, updateSettings() {}, isWidgetVisible: () => true,
        document: {
            hidden: false, documentElement: element, body: element,
            getElementById: () => element, querySelectorAll: () => [], addEventListener() {},
        },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        Date: class extends Date { static now() { return state.clock; } },
        fetch: async url => {
            const archive = url.includes('archive');
            if (archive) state.requests++;
            return {
                ok: !(archive && state.failArchive), status: 503,
                json: async () => ({ news_list: archive ? state.archive : state.hot, archive_count: 3, last_updated: 100 }),
            };
        },
        showControlToast() {}, clearTimeout() {}, setTimeout() {},
    });
    context.recordRender = () => state.views.push(vm.runInContext('readingPool().filter(n => applyFilter(n)).map(n => n.id)', context));
    vm.runInContext(source, context);
    // Rendering is a DOM boundary; exercise the real polling and event handlers above it.
    vm.runInContext('renderNewsList = recordRender; updateReadingControls = () => {}; updateSourceOptions = () => {}; syncArchiveButton = () => {}; setNewsStatus = () => {}; initNews();', context);
    await new Promise(resolve => setImmediate(resolve));
    return { state, context, reading, ids: () => Array.from(vm.runInContext('allNewsData.map(n => n.id)', context)) };
}

test('an individual read change immediately removes its item from the unread view', async () => {
    const { state, context, reading } = await harness();
    vm.runInContext('readingView = "unread";', context);
    const before = state.views.length;
    reading.markRead('id-A');
    assert.equal(state.views.length, before + 1);
    assert.equal(state.views.at(-1).length, 0);
});

test('loaded archives refresh during polling and retain old data when refresh fails', async () => {
    const { state, context, ids } = await harness();
    await vm.runInContext('loadNewsArchive()', context);
    state.hot = [item('B')];
    await vm.runInContext('fetchRealNews()', context);
    assert.deepEqual(ids(), ['B', 'A']);
    assert.equal(state.requests, 1);

    state.hot = [item('C')];
    state.archive = [item('A'), item('B')];
    state.clock += 120000;
    await vm.runInContext('fetchRealNews()', context);
    assert.equal(state.requests, 2);
    assert.deepEqual(ids(), ['C', 'A', 'B']);

    state.failArchive = true;
    state.clock += 120000;
    await vm.runInContext('fetchRealNews()', context);
    assert.deepEqual(ids(), ['C', 'A', 'B']);
});

test('manual archive refresh is allowed and merges only the current hot feed', async () => {
    const { state, context, ids } = await harness();
    await vm.runInContext('loadNewsArchive()', context);
    state.hot = [item('B')];
    await vm.runInContext('fetchRealNews()', context);
    state.archive = [item('C')];
    await vm.runInContext('loadNewsArchive()', context);
    assert.equal(state.requests, 2);
    assert.deepEqual(ids(), ['B', 'C']);
});
