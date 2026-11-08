import { getSettings, updateSettings, isWidgetVisible } from './settings-store.js';

export function panelBounds(viewport) {
    const maximum = Math.max(280, viewport - 48);
    return { compact: Math.min(450, viewport * 0.42), minimum: Math.min(320, viewport * 0.42), maximum };
}

export function panelWidth(layout, viewport) {
    if (layout.newsPanelMode === 'full') return viewport;
    const bounds = panelBounds(viewport);
    const fallback = layout.newsPanelMode === 'wide' ? viewport * 0.7 : bounds.compact;
    return Math.max(bounds.minimum, Math.min(bounds.maximum, layout.newsPanelWidth || fallback));
}

export function heroGeometry(viewport, width, active=true) {
    const available = active ? Math.max(0,viewport-width-24) : viewport;
    const base = Math.max(1,viewport-panelBounds(viewport).compact-24-64);
    return {width:available, base, scale:active ? Math.max(0,Math.min(1,(available-64)/base)) : 1};
}

export function finishPanelDrag(width, viewport) {
    const bounds = panelBounds(viewport);
    if (width >= viewport * 0.86) return { newsPanelMode: 'full', newsPanelWidth: null };
    if (width <= bounds.compact + 64) return { newsPanelMode: 'compact', newsPanelWidth: null };
    return { newsPanelMode: 'wide', newsPanelWidth: Math.round(Math.min(width, bounds.maximum)) };
}

export function stepPanelWidth(layout, viewport, delta) {
    const bounds = panelBounds(viewport);
    const width = panelWidth(layout, viewport) + delta;
    if (width >= viewport * 0.96) return { newsPanelMode: 'full', newsPanelWidth: null };
    if (width <= bounds.compact) return { newsPanelMode: 'compact', newsPanelWidth: null };
    return { newsPanelMode: 'wide', newsPanelWidth: Math.round(Math.min(width, bounds.maximum)) };
}

export function initNewsPanel() {
    const root = document.documentElement;
    const aside = document.getElementById('newsAside');
    const header = document.getElementById('newsPanelHeader');
    const grip = document.getElementById('newsPanelDrag');
    const edge = document.getElementById('newsPanelEdge');
    const expand = document.getElementById('newsPanelExpand');
    const restore = document.getElementById('newsPanelRestore');
    const settingsButton = document.getElementById('newsPanelSettings');
    const covered = [document.querySelector('main'), document.getElementById('controlCenter'), document.getElementById('bottom-ticker')];
    let drag = null;
    let frame = 0;
    let suppressClick = false;

    const desktop = () => window.innerWidth >= 768;
    function syncGeometry(width) {
        const geometry = heroGeometry(window.innerWidth,width,isWidgetVisible('news'));
        document.body.style.setProperty('--main-width', `${geometry.width}px`);
        document.body.style.setProperty('--hero-base-width', `${isWidgetVisible('news') ? geometry.base : Math.max(1,window.innerWidth-64)}px`);
        document.body.style.setProperty('--hero-scale', String(geometry.scale));
    }
    function sync() {
        const layout = getSettings().layout;
        const active = isWidgetVisible('news');
        const full = active && layout.newsPanelMode === 'full';
        const wide = active && desktop() && layout.newsPanelMode === 'wide';
        root.classList.toggle('news-panel-full', full);
        root.classList.toggle('news-panel-wide', wide);
        aside.style.setProperty('--news-panel-width', `${panelWidth(layout, window.innerWidth)}px`);
        syncGeometry(panelWidth(layout,window.innerWidth));
        restore.hidden = !full && !wide;
        settingsButton.hidden = !full;
        expand.setAttribute('aria-pressed', String(full));
        expand.setAttribute('aria-label', full ? '退出全屏阅读' : '全屏阅读');
        expand.title = full ? '退出全屏阅读' : '全屏阅读';
        grip.title = desktop() ? '向左拖动展开，向右拖动收起；双击还原' : '点击进入全屏阅读';
        covered.forEach(element => { if (element) element.inert = full; });
        window.dispatchEvent(new CustomEvent('gx:panel-layout'));
    }
    function reset() { updateSettings('layout', { newsPanelMode: 'compact', newsPanelWidth: null }); }
    function toggleFull() {
        const current = getSettings().layout;
        updateSettings('layout', current.newsPanelMode === 'full'
            ? { newsPanelMode: 'compact', newsPanelWidth: null }
            : { newsPanelMode: 'full', newsPanelWidth: null });
    }
    function stopDrag(cancelled = false) {
        if (!drag) return;
        const previous = drag;
        drag = null;
        cancelAnimationFrame(frame);
        root.classList.remove('panel-dragging');
        if (previous.capture.hasPointerCapture(previous.id)) previous.capture.releasePointerCapture(previous.id);
        suppressClick = previous.moved;
        if (previous.moved && !cancelled) updateSettings('layout', finishPanelDrag(previous.width, window.innerWidth));
        else sync();
        // The click belonging to this pointer release must not toggle full mode.
        window.setTimeout(() => { suppressClick = false; }, 0);
    }
    function beginDrag(event) {
        if (!desktop() || event.button !== 0 || !isWidgetVisible('news')) return;
        if (event.target.closest('button, input, select, a') && !grip.contains(event.target) && event.currentTarget !== edge) return;
        event.preventDefault();
        drag = { id: event.pointerId, x: event.clientX, initial: aside.getBoundingClientRect().width, width: aside.getBoundingClientRect().width, moved: false, capture:event.currentTarget };
        event.currentTarget.setPointerCapture(event.pointerId);
    }
    function moveDrag(event) {
        if (!drag || drag.id !== event.pointerId) return;
        const delta = drag.x - event.clientX;
        if (!drag.moved && Math.abs(delta) < 6) return;
        drag.moved = true;
        root.classList.add('panel-dragging');
        // Leave full-screen geometry while dragging back to the right.
        root.classList.remove('news-panel-full');
        root.classList.add('news-panel-wide');
        const bounds = panelBounds(window.innerWidth);
        drag.width = Math.max(bounds.minimum, Math.min(window.innerWidth, drag.initial + delta));
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            aside.style.setProperty('--news-panel-width', `${drag.width}px`);
            syncGeometry(drag.width);
            window.dispatchEvent(new CustomEvent('gx:panel-layout'));
        });
    }
    for(const target of [header,edge]) {
        target.addEventListener('pointerdown',beginDrag);
        target.addEventListener('pointermove',moveDrag);
        target.addEventListener('pointerup',()=>stopDrag());
        target.addEventListener('pointercancel',()=>stopDrag(true));
        target.addEventListener('lostpointercapture',()=>stopDrag(true));
    }
    grip.addEventListener('click', () => { if (!suppressClick && !desktop()) toggleFull(); });
    grip.addEventListener('dblclick', reset);
    edge.addEventListener('dblclick',reset);
    function keyboardResize(event) {
        if (['ArrowLeft', 'ArrowRight'].includes(event.key) && desktop()) {
            event.preventDefault();
            const step = event.shiftKey ? 100 : 40;
            updateSettings('layout', stepPanelWidth(getSettings().layout, window.innerWidth, event.key === 'ArrowLeft' ? step : -step));
        } else if (event.key === 'Home') { event.preventDefault(); reset(); }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleFull(); }
    }
    grip.addEventListener('keydown',keyboardResize);
    edge.addEventListener('keydown',keyboardResize);
    expand.addEventListener('click', toggleFull);
    restore.addEventListener('click', () => { reset(); grip.focus(); });
    settingsButton.addEventListener('click', () => window.dispatchEvent(new CustomEvent('gx:open-settings')));
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !document.getElementById('settingsOverlay').hidden) return;
        if (getSettings().layout.newsPanelMode === 'full' && isWidgetVisible('news')) {
            reset(); grip.focus();
        }
    });
    window.addEventListener('blur', () => stopDrag(true));
    window.addEventListener('gx:layout-changed', () => { stopDrag(true); sync(); });
    window.addEventListener('resize', () => { stopDrag(true); sync(); });
    window.addEventListener('gx:settings-changed', event => {
        if (['layout', 'widgets', 'all'].includes(event.detail?.section)) { stopDrag(true); sync(); }
    });
    sync();
}
