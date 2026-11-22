import assert from 'node:assert/strict';
import test from 'node:test';
globalThis.localStorage = { getItem: () => null, setItem() {} };
const { initTicker, tickerStatusPresentation } = await import('../public/js/modules/ticker.js');

const now = 1800000000;

test('a ten-minute polling schedule stays live during its planned wait and expires if overdue', () => {
    const status = { status: 'ok', updated_at: now - 420 };
    assert.equal(tickerStatusPresentation(status, 600, now).kind, 'online');
    assert.equal(tickerStatusPresentation(status, 60, now).kind, 'offline');
    assert.equal(tickerStatusPresentation({ ...status, updated_at: now - 781 }, 600, now).kind, 'offline');
    assert.equal(tickerStatusPresentation({ ...status, updated_at: now - 3000 }, 3600, now).kind, 'online');
});

test('upstream failures and degraded results remain visible even with long polling intervals', () => {
    assert.equal(tickerStatusPresentation({ status: 'failed', updated_at: now }, 3600, now).label, '失败');
    assert.equal(tickerStatusPresentation({ status: 'degraded', updated_at: now }, 3600, now).kind, 'degraded');
});

test('missing timestamps and invalid schedules do not make stale ticker state look healthy', () => {
    assert.equal(tickerStatusPresentation({ status: 'ok' }, 600, now).kind, 'offline');
    for (const interval of [undefined, null, -1, 59, 86400, 'bad']) {
        assert.equal(tickerStatusPresentation({ status: 'ok', updated_at: now - 301 }, interval, now).kind, 'offline');
    }
});

test('ticker polling uses the live server interval and notices changes before the next crawl', async () => {
    const events = new Map();
    const nodes = new Map();
    globalThis.document = {
        hidden: false,
        getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, { replaceChildren() {} });
            return nodes.get(id);
        },
        createElement: () => ({}),
        addEventListener: (name, handler) => events.set(name, handler),
    };
    globalThis.window = { addEventListener() {}, dispatchEvent() {}, setTimeout: () => 1, clearTimeout() {} };
    globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init.detail; } };
    const requests = [];
    let fastInterval = 600;
    let configAvailable = true;
    globalThis.fetch = async url => {
        requests.push(url);
        if (url === './api/admin/status' && !configAvailable) throw new Error('temporary control outage');
        const data = url === './ticker.json' ? []
            : url === './ticker-status.json' ? { status: 'ok', updated_at: Date.now() / 1000 - 420 }
            : { settings: { intervals: { fast: fastInterval } } };
        return { ok: true, json: async () => data };
    };

    initTicker();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(requests.includes('./api/admin/status'));
    assert.equal(nodes.get('tickerStatusText').textContent, 'LIVE');

    configAvailable = false;
    events.get('visibilitychange')();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes.get('tickerStatusText').textContent, 'LIVE');

    configAvailable = true;
    fastInterval = 60;
    events.get('visibilitychange')();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes.get('tickerStatusText').textContent, '离线');
});

test('ticker status prefers inline interval and skips polling /api/admin/status', async () => {
    const nodes = new Map();
    globalThis.document = {
        hidden: false,
        getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, { replaceChildren() {} });
            return nodes.get(id);
        },
        createElement: () => ({}),
        addEventListener() {},
    };
    globalThis.window = { addEventListener() {}, dispatchEvent() {}, setTimeout: () => 1, clearTimeout() {} };
    globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init.detail; } };
    const requests = [];
    globalThis.fetch = async url => {
        requests.push(url);
        const data = url === './ticker.json' ? []
            : { status: 'ok', interval: 600, updated_at: Date.now() / 1000 - 420 };
        return { ok: true, json: async () => data };
    };

    initTicker();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.includes('./api/admin/status'), false);
    assert.equal(nodes.get('tickerStatusText').textContent, 'LIVE');
});
