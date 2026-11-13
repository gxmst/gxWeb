// ================== 底部行情双行排版 ==================
// 数字滚动 / sparkline 画入通过 window.__animateNumber / __drawInSparkline 桥接
// （由 ambience 模块初始化时挂载，未就绪时各调用点自带降级）。
import { getSettings, isWidgetVisible, getEffectiveAppearance } from './settings-store.js?v=workspace-20261114a';

const SPARKLINE_MIN_POINTS = 3;
const TICKER_POLL_INTERVAL = 20000;
const SVG_NS = 'http://www.w3.org/2000/svg';
let tickerPollTimer = null;
let tickerRequestInFlight = false;
let serverTickerInterval = 60;

function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
        node.setAttribute(key, String(value));
    }
    return node;
}

function buildSparklineNode(history, isUp, symbol = '') {
    if (!history || history.length < 2) return null;
    const w = 44, h = 15;
    const min = Math.min(...history), max = Math.max(...history);
    const range = max - min || 1;
    const coords = history.map((v, i) => {
        const x = (i / (history.length - 1)) * w;
        const y = h - ((v - min) / range) * (h - 3) - 1.5;
        return [x, y];
    });
    const pts = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const areaPts = `0,${h} ${pts} ${w},${h}`;
    const [lastX, lastY] = coords[coords.length - 1];
    const color = isUp ? '#fb7185' : '#34d399';
    const gradId = `sg-${String(symbol).replace(/[^a-zA-Z0-9_-]/g, '') || (isUp ? 'u' : 'd')}`;

    const svg = svgEl('svg', { class: 'sparkline-svg', width: w, height: h, viewBox: `0 0 ${w} ${h}` });
    const defs = svgEl('defs', {});
    const gradient = svgEl('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
    gradient.appendChild(svgEl('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': '0.34' }));
    gradient.appendChild(svgEl('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': '0' }));
    defs.appendChild(gradient);
    svg.appendChild(defs);
    svg.appendChild(svgEl('polygon', { points: areaPts, fill: `url(#${gradId})` }));
    svg.appendChild(svgEl('polyline', { class: 'sparkline-poly', points: pts, stroke: color, opacity: '0.88' }));
    svg.appendChild(svgEl('circle', { cx: lastX.toFixed(1), cy: lastY.toFixed(1), r: '1.4', fill: color }));
    return svg;
}

async function fetchTickerData() {
    try {
        const response = await fetch('./ticker.json', { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const rawItems = await response.json();
        const container = document.getElementById('tickerContent');
        if (!Array.isArray(rawItems)) return;
        window.dispatchEvent(new CustomEvent('gx:ticker-data', {
            detail: {
                items: rawItems.map(item => ({
                    symbol: String(item.symbol || ''),
                    name: String(item.name || item.symbol || ''),
                    category: String(item.category || ''),
                })).filter(item => item.symbol),
            },
        }));
        const tickerSettings = getSettings().ticker;
        const favorites = new Set(tickerSettings.favorites);
        const positions = new Map(tickerSettings.order.map((symbol, index) => [String(symbol), index]));
        const items = rawItems
            .filter(item => tickerSettings.showAll || favorites.has(String(item.symbol || '')))
            .sort((a, b) => {
                const aSymbol = String(a.symbol || '');
                const bSymbol = String(b.symbol || '');
                const ai = positions.has(aSymbol) ? positions.get(aSymbol) : Number.MAX_SAFE_INTEGER;
                const bi = positions.has(bSymbol) ? positions.get(bSymbol) : Number.MAX_SAFE_INTEGER;
                return ai - bi;
            });
        if (items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'px-3 text-xs text-white/40';
            empty.textContent = '未选择行情';
            container.replaceChildren(empty);
            return;
        }

        // 数量相同但 symbol 已替换时也必须重绘，避免新条目找不到旧节点。
        const currentSymbols = Array.from(container.children).map(element => element.dataset.symbol || '');
        const nextSymbols = items.map(item => String(item.symbol || ''));
        if (currentSymbols.join('\u241f') !== nextSymbols.join('\u241f')) container.replaceChildren();

        if (container.children.length === 0) {
            items.forEach(item => {
                const showSparkline = item.price_history && item.price_history.length >= SPARKLINE_MIN_POINTS;
                const wrapper = document.createElement('div');
                wrapper.className = 'ticker-item-card flex flex-col justify-center min-w-max gap-0.5';
                wrapper.dataset.symbol = item.symbol;
                wrapper.addEventListener('animationend', () => {
                    wrapper.classList.remove('ticker-flash-up', 'ticker-flash-down');
                });

                const topRow = document.createElement('div');
                topRow.className = 'flex items-center justify-between gap-2';
                const nameSpan = document.createElement('span');
                nameSpan.className = 'text-[10px] leading-tight text-white/60 font-medium tracking-wide drop-shadow-md name-val whitespace-nowrap';
                nameSpan.textContent = item.name;
                topRow.appendChild(nameSpan);
                if (showSparkline) {
                    const sparkSpan = document.createElement('span');
                    sparkSpan.className = 'sparkline-container inline-flex items-center';
                    sparkSpan.dataset.symbol = item.symbol;
                    topRow.appendChild(sparkSpan);
                }
                wrapper.appendChild(topRow);

                const botRow = document.createElement('div');
                botRow.className = 'flex items-baseline gap-1.5';
                const priceSpan = document.createElement('span');
                priceSpan.className = 'text-[11px] leading-tight font-bold text-white drop-shadow-md numeric price-val whitespace-nowrap';
                priceSpan.textContent = '--';
                const changeSpan = document.createElement('span');
                changeSpan.className = 'text-[10px] leading-tight font-semibold drop-shadow-md numeric change-val whitespace-nowrap';
                changeSpan.textContent = '--';
                botRow.appendChild(priceSpan);
                botRow.appendChild(changeSpan);
                wrapper.appendChild(botRow);

                container.appendChild(wrapper);
            });
        }

        const cardBySymbol = new Map();
        for (const child of container.children) {
            if (child.dataset?.symbol) cardBySymbol.set(child.dataset.symbol, child);
        }

        items.forEach(item => {
            const el = cardBySymbol.get(String(item.symbol));
            if (el) {
                const nameEl = el.querySelector('.name-val');
                if (nameEl) nameEl.innerText = item.name;
                const priceEl = el.querySelector('.price-val');
                const nextPriceNum = parseFloat(String(item.price).replace(/[^0-9.\-]/g, ''));
                const prevPriceNum = parseFloat(el.dataset.lastPrice || '');
                if (!getEffectiveAppearance().powerSaving && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && Number.isFinite(nextPriceNum) && Number.isFinite(prevPriceNum) && nextPriceNum !== prevPriceNum) {
                    el.classList.remove('ticker-flash-up', 'ticker-flash-down');
                    void el.offsetWidth;
                    el.classList.add(nextPriceNum > prevPriceNum ? 'ticker-flash-up' : 'ticker-flash-down');
                }
                if (Number.isFinite(nextPriceNum)) el.dataset.lastPrice = String(nextPriceNum);

                // 价格变化时做数字滚动插值（保留货币符号/千分位格式）
                if (window.__animateNumber) window.__animateNumber(priceEl, item.price);
                else priceEl.innerText = item.price;
                const cEl = el.querySelector('.change-val');
                const isUp = !item.change.startsWith('-');
                cEl.innerText = (isUp ? '▲' : '▼') + ' ' + item.change;
                cEl.className = `text-[10px] leading-tight font-semibold drop-shadow-md numeric change-val whitespace-nowrap ${isUp ? 'text-rose-400' : 'text-emerald-400'}`;
                const sparkContainer = el.querySelector('.sparkline-container');
                if (sparkContainer && item.price_history && item.price_history.length >= SPARKLINE_MIN_POINTS) {
                    // 仅在折线数据实际变化时重绘并触发画入动画
                    const sig = item.price_history.join(',');
                    if (sparkContainer.dataset.sig !== sig) {
                        sparkContainer.dataset.sig = sig;
                        const sparkNode = buildSparklineNode(item.price_history, isUp, item.symbol);
                        if (sparkNode) sparkContainer.replaceChildren(sparkNode);
                        else sparkContainer.replaceChildren();
                        if (window.__drawInSparkline) window.__drawInSparkline(sparkContainer);
                    }
                }
            }
        });
    } catch (error) { console.error("行情同步异常:", error); }
}

function setTickerStatus(kind, label, title) {
    const status = document.getElementById('tickerHeartbeatStatus');
    const statusText = document.getElementById('tickerStatusText');
    const statusPing = document.getElementById('tickerStatusPing');
    const statusDot = document.getElementById('tickerStatusDot');
    if (!status || !statusText || !statusPing || !statusDot) return;
    const colors = kind === 'online'
        ? { text: 'text-green-400', ping: 'bg-green-400', dot: 'bg-green-500' }
        : kind === 'degraded'
            ? { text: 'text-amber-400', ping: 'bg-amber-400', dot: 'bg-amber-500' }
            : { text: 'text-red-400', ping: '', dot: 'bg-red-500' };
    statusText.textContent = label;
    statusText.className = `text-[10px] font-bold ${colors.text}`;
    statusPing.className = kind === 'offline'
        ? 'hidden'
        : `animate-ping absolute inline-flex h-full w-full rounded-full ${colors.ping} opacity-75`;
    statusDot.className = `relative inline-flex rounded-full h-2 w-2 ${colors.dot}`;
    status.title = title;
    window.dispatchEvent(new CustomEvent('gx:status-change', { detail: { source: 'ticker', kind } }));
}

export function tickerStatusPresentation(status, intervalSeconds = 60, now = Date.now() / 1000) {
    const interval = Number(intervalSeconds);
    const validInterval = Number.isInteger(interval) && interval >= 60 && interval <= 3600 ? interval : 60;
    const staleAfter = Math.max(300, validInterval + 180);
    const updatedAt = Number(status?.updated_at);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0 || now - updatedAt > staleAfter) {
        return { kind: 'offline', label: '离线', title: `行情状态超过 ${staleAfter / 60} 分钟未更新` };
    }
    if (status.status === 'failed') {
        return { kind: 'offline', label: '失败', title: '行情源失败，当前显示上次成功数据' };
    }
    if (status.status === 'degraded') {
        return { kind: 'degraded', label: '降级', title: '行情源降级，部分使用备用源' };
    }
    return { kind: 'online', label: 'LIVE', title: '行情源正常' };
}

async function fetchTickerStatus() {
    try {
        // 读取实际服务端配置；等待下一轮期间修改频率也能立即影响过期判断。
        // 配置接口失败时沿用最近读到的间隔，避免临时故障让正常等待被误判为离线。
        const [resp, intervalSeconds] = await Promise.all([
            fetch('./ticker-status.json', { cache: 'no-cache' }),
            fetch('./api/admin/status', { cache: 'no-store' })
                .then(async response => {
                    if (response.ok) {
                        const interval = (await response.json()).settings?.intervals?.fast;
                        if (Number.isInteger(interval) && interval >= 60 && interval <= 3600) serverTickerInterval = interval;
                    }
                    return serverTickerInterval;
                })
                .catch(() => serverTickerInterval),
        ]);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const ts = await resp.json();
        if (!ts || !ts.status) return;

        const presentation = tickerStatusPresentation(ts, intervalSeconds);
        setTickerStatus(presentation.kind, presentation.label, presentation.title);
    } catch {
        setTickerStatus('offline', '断连', '行情状态接口不可用');
    }
}

export function initTicker() {
    const poll = async () => {
        if (document.hidden || !isWidgetVisible('ticker') || tickerRequestInFlight) return;
        tickerRequestInFlight = true;
        try {
            await Promise.allSettled([fetchTickerData(), fetchTickerStatus()]);
        } finally {
            tickerRequestInFlight = false;
            if (!document.hidden && isWidgetVisible('ticker')) tickerPollTimer = window.setTimeout(poll, TICKER_POLL_INTERVAL);
        }
    };
    document.addEventListener('visibilitychange', () => {
        window.clearTimeout(tickerPollTimer);
        tickerPollTimer = null;
        if (!document.hidden) poll();
    });
    window.addEventListener('gx:settings-changed', event => {
        if (isWidgetVisible('ticker') && ['ticker', 'all'].includes(event.detail?.section)) fetchTickerData();
    });
    let tickerVisible = isWidgetVisible('ticker');
    window.addEventListener('gx:layout-changed', () => {
        const next = isWidgetVisible('ticker');
        if (next === tickerVisible) return;
        tickerVisible = next;
        window.clearTimeout(tickerPollTimer);
        if (next) poll();
    });
    poll();
}
