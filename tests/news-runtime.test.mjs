import assert from 'node:assert/strict';
import test from 'node:test';

test('news initialization reaches the first feed request before any data has loaded', async () => {
    const classes = new Set();
    const element = {
        classList: {
            contains: name => classes.has(name),
            toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
        },
        style: {}, offsetLeft: 0, offsetWidth: 80,
        setAttribute() {}, removeAttribute() {}, addEventListener() {},
        querySelector() { return null; },
    };
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    globalThis.document = {
        documentElement: element, body: element, hidden: false,
        getElementById: () => element, querySelectorAll: () => [], addEventListener() {},
    };
    globalThis.window = {
        innerWidth: 1440, matchMedia: () => ({ matches: true }),
        addEventListener() {}, dispatchEvent() {}, clearTimeout() {},
    };
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
    const requests = [];
    globalThis.fetch = url => {
        requests.push(url);
        // Keep the response pending to test the initial loading path without a browser DOM.
        return new Promise(() => {});
    };

    const { initNews } = await import('../public/js/modules/news.js');
    assert.doesNotThrow(() => initNews());
    assert.deepEqual(requests, ['./finance-news.json']);
});
