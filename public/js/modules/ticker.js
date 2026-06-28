// ================== 底部行情双行排版 ==================
// 数字滚动 / sparkline 画入通过 window.__animateNumber / __drawInSparkline 桥接
// （由 ambience 模块初始化时挂载，未就绪时各调用点自带降级）。

const SPARKLINE_MIN_POINTS = 3;

function buildSparklineSVG(history, isUp) {
    if (!history || history.length < 2) return '';
    const w = 36, h = 14;
    const min = Math.min(...history), max = Math.max(...history);
    const range = max - min || 1;
    const pts = history.map((v, i) => {
        const x = (i / (history.length - 1)) * w;
        const y = h - ((v - min) / range) * (h - 2) - 1;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const color = isUp ? '#f87171' : '#34d399';
    return `<svg class="sparkline-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline class="sparkline-poly" points="${pts}" stroke="${color}" opacity="0.6"/></svg>`;
}

async function fetchTickerData() {
    try {
        const response = await fetch('./ticker.json?t=' + Date.now());
        const items = await response.json();
        const container = document.getElementById('tickerContent');
        if (!items || items.length === 0) return;

        // 优化：如果后端增删了行情条目（数量不一致），则清空重绘，确保列表同步
        if (container.children.length !== items.length) container.innerHTML = '';

        if (container.children.length === 0) {
            items.forEach(item => {
                const showSparkline = item.price_history && item.price_history.length >= SPARKLINE_MIN_POINTS;
                const wrapper = document.createElement('div');
                wrapper.className = 'flex flex-col justify-center min-w-max px-1.5 gap-0';
                wrapper.dataset.symbol = item.symbol;

                const topRow = document.createElement('div');
                topRow.className = 'flex items-center gap-1';
                const nameSpan = document.createElement('span');
                nameSpan.className = 'text-[9px] text-white/50 tracking-wide drop-shadow-md name-val whitespace-nowrap';
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
                botRow.className = 'flex items-baseline gap-1';
                const priceSpan = document.createElement('span');
                priceSpan.className = 'text-[10px] font-bold text-white drop-shadow-md numeric price-val whitespace-nowrap';
                priceSpan.textContent = '--';
                const changeSpan = document.createElement('span');
                changeSpan.className = 'text-[9px] font-semibold drop-shadow-md numeric change-val whitespace-nowrap';
                changeSpan.textContent = '--';
                botRow.appendChild(priceSpan);
                botRow.appendChild(changeSpan);
                wrapper.appendChild(botRow);

                container.appendChild(wrapper);
            });
        }

        items.forEach(item => {
            const el = container.querySelector(`[data-symbol="${item.symbol}"]`);
            if (el) {
                const nameEl = el.querySelector('.name-val');
                if (nameEl) nameEl.innerText = item.name;
                const priceEl = el.querySelector('.price-val');
                // 价格变化时做数字滚动插值（保留货币符号/千分位格式）
                if (window.__animateNumber) window.__animateNumber(priceEl, item.price);
                else priceEl.innerText = item.price;
                const cEl = el.querySelector('.change-val');
                const isUp = !item.change.startsWith('-');
                cEl.innerText = (isUp ? '▲' : '▼') + ' ' + item.change;
                cEl.className = `text-[9px] font-semibold drop-shadow-md numeric change-val whitespace-nowrap ${isUp ? 'text-rose-400' : 'text-emerald-400'}`;
                const sparkContainer = el.querySelector('.sparkline-container');
                if (sparkContainer && item.price_history && item.price_history.length >= SPARKLINE_MIN_POINTS) {
                    // 仅在折线数据实际变化时重绘并触发画入动画
                    const sig = item.price_history.join(',');
                    if (sparkContainer.dataset.sig !== sig) {
                        sparkContainer.dataset.sig = sig;
                        sparkContainer.innerHTML = DOMPurify.sanitize(buildSparklineSVG(item.price_history, isUp));
                        if (window.__drawInSparkline) window.__drawInSparkline(sparkContainer);
                    }
                }
            }
        });
    } catch { console.error("行情同步异常"); }
}

async function fetchTickerStatus() {
    try {
        const resp = await fetch('./ticker-status.json?t=' + Date.now());
        const ts = await resp.json();
        if (!ts || !ts.status) return;
        const statusText = document.getElementById('statusText');
        const statusPing = document.getElementById('statusPing');
        const statusDot = document.getElementById('statusDot');

        const ageMinutes = ts.updated_at ? (Date.now() / 1000 - ts.updated_at) / 60 : 0;
        if (ageMinutes > 5) {
            statusText.innerText = '离线';
            statusText.className = 'text-[10px] font-bold text-red-400';
            statusPing.className = 'hidden';
            statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-red-500';
            statusDot.parentElement.parentElement.title = '行情数据超过5分钟未更新';
            return;
        }

        if (ts.status === 'failed') {
            statusText.innerText = '行情失败';
            statusText.className = 'text-[10px] font-bold text-red-400';
            statusPing.className = 'hidden';
            statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-red-500';
            statusDot.parentElement.parentElement.title = '行情源失败，当前显示上次成功数据';
        } else if (ts.status === 'degraded') {
            statusText.innerText = '降级';
            statusText.className = 'text-[10px] font-bold text-amber-400';
            statusPing.className = 'animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75';
            statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-amber-500';
            statusDot.parentElement.parentElement.title = '行情源降级，部分使用备用源';
        } else {
            statusText.innerText = 'LIVE';
            statusText.className = 'text-[10px] font-bold text-green-400';
            statusPing.className = 'animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75';
            statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-green-500';
            statusDot.parentElement.parentElement.title = '行情源正常';
        }
    } catch { /* ticker-status 不可用时保持原状 */ }
}

export function initTicker() {
    fetchTickerData();
    setInterval(fetchTickerData, 20000);
    fetchTickerStatus();
    setInterval(fetchTickerStatus, 20000);
}
