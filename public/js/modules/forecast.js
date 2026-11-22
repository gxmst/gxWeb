import { getSettings, isWidgetVisible } from './settings-store.js?v=workspace-20261122b';

const FORECAST_SVGS = {
    sun: '<svg class="w-4 h-4 text-amber-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4" fill="currentColor" fill-opacity="0.25"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
    cloudy: '<svg class="w-4 h-4 text-sky-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" fill="currentColor" fill-opacity="0.18"/></svg>',
    fog: '<svg class="w-4 h-4 text-slate-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 10h16M6 14h12M4 18h10M8 6h12"/></svg>',
    rain: '<svg class="w-4 h-4 text-sky-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" fill="currentColor" fill-opacity="0.18"/><path d="M16 14v6m-4-4v6m-4-6v6"/></svg>',
    storm: '<svg class="w-4 h-4 text-amber-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path d="m13 12-3 5h4l-3 5"/></svg>',
    snow: '<svg class="w-4 h-4 text-cyan-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 15h.01M8 19h.01M12 17h.01M12 21h.01M16 15h.01M16 19h.01"/></svg>',
};

export function forecastDescription(code) {
    if (code === 0) return { label: '晴', icon: '☀', kind: 'sun' };
    if (code <= 3) return { label: code === 3 ? '阴' : '多云', icon: '☁', kind: 'cloudy' };
    if (code <= 48) return { label: '雾', icon: '≋', kind: 'fog' };
    if (code >= 95) return { label: '雷雨', icon: 'ϟ', kind: 'storm' };
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: '雪', icon: '❄', kind: 'snow' };
    return { label: '雨', icon: '☂', kind: 'rain' };
}

export function normalizeForecast(payload) {
    const daily = payload?.daily;
    if (!daily || !Array.isArray(daily.time) || daily.time.length < 7) throw new Error('暂时没有完整的七天预报');
    return daily.time.slice(0, 7).map((date, index) => {
        const high = Number(daily.temperature_2m_max?.[index]);
        const low = Number(daily.temperature_2m_min?.[index]);
        const code = Number(daily.weather_code?.[index]);
        const rawRain = daily.precipitation_probability_max?.[index];
        const rain = rawRain == null ? null : Number(rawRain);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(code) || daily.weather_code?.[index] == null || daily.temperature_2m_max?.[index] == null || daily.temperature_2m_min?.[index] == null) {
            throw new Error('预报数据不完整，请稍后重试');
        }
        return {
            date,
            high: Math.round(high),
            low: Math.round(low),
            rain: Number.isFinite(rain) ? Math.max(0, Math.min(100, rain)) : null,
            ...forecastDescription(code),
        };
    });
}

export function initForecast() {
    const trigger = document.getElementById('weatherInfoBtn');
    const popover = document.createElement('section');
    popover.id = 'weatherForecast';
    popover.className = 'forecast-popover glass-floating-surface';
    popover.hidden = true;
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-labelledby', 'forecastTitle');
    popover.innerHTML = '<div class="forecast-heading"><div><h3 id="forecastTitle">七天天气</h3><p id="forecastCity"></p></div><button type="button" id="closeForecast" aria-label="关闭天气预报">×</button></div><div id="forecastDays"></div><div class="forecast-footer"><span id="forecastStatus" role="status">加载中…</span><button type="button" id="retryForecast">刷新</button></div>';
    document.body.appendChild(popover);
    const city = document.getElementById('forecastCity');
    const days = document.getElementById('forecastDays');
    const status = document.getElementById('forecastStatus');
    const retry = document.getElementById('retryForecast');
    let controller = null;
    let closeTimer = null;
    const cache = new Map();

    function place() {
        if (popover.hidden) return;
        const rect = trigger.getBoundingClientRect();
        const viewportWidth = document.documentElement.clientWidth;
        const width = Math.min(340, viewportWidth - 24);
        popover.style.width = `${width}px`;
        const height = popover.getBoundingClientRect().height;
        const right = rect.right + 12;
        const fitsRight = right + width <= viewportWidth - 12;
        const left = fitsRight ? right : rect.left - width - 12 >= 12 ? rect.left - width - 12 : Math.max(12, Math.min(viewportWidth - width - 12, rect.left));
        const top = fitsRight ? rect.top - 10 : rect.bottom + 12;
        popover.style.left = `${left}px`;
        popover.style.top = `${Math.max(12, Math.min(window.innerHeight - height - 12, top))}px`;
    }

    function openPopover() {
        window.clearTimeout(closeTimer);
        popover.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        days.replaceChildren();
        requestAnimationFrame(() => {
            place();
            popover.classList.add('open');
        });
        load();
    }

    function close(focus = false) {
        if (popover.hidden && !popover.classList.contains('open')) return;
        window.clearTimeout(closeTimer);
        popover.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        controller?.abort();
        controller = null;
        closeTimer = window.setTimeout(() => { popover.hidden = true; }, 200);
        if (focus && isWidgetVisible('weather')) trigger.focus({ preventScroll: true });
    }

    function render(rows) {
        days.replaceChildren();
        const weekMin = Math.min(...rows.map(r => r.low));
        const weekMax = Math.max(...rows.map(r => r.high));
        const span = Math.max(1, weekMax - weekMin);

        for (const [index, row] of rows.entries()) {
            const line = document.createElement('div');
            line.className = 'forecast-day';
            const weekday = index === 0 ? '今天' : index === 1 ? '明天' : new Date(`${row.date}T12:00:00`).toLocaleDateString('zh-CN', { weekday: 'short' });
            const date = document.createElement('span');
            date.className = 'forecast-date';
            date.textContent = weekday;
            date.title = row.date;

            const icon = document.createElement('span');
            icon.className = 'forecast-icon';
            icon.title = row.label;
            icon.setAttribute('aria-label', row.label);
            icon.innerHTML = FORECAST_SVGS[row.kind] || FORECAST_SVGS.cloudy;

            const rain = document.createElement('span');
            rain.className = 'forecast-rain';
            rain.textContent = row.rain == null || row.rain < 10 ? '—' : `${row.rain}%`;
            rain.title = '降水概率';

            const tempMin = document.createElement('span');
            tempMin.className = 'forecast-temp-min';
            tempMin.textContent = `${row.low}°`;

            const track = document.createElement('div');
            track.className = 'forecast-range-track';
            const fill = document.createElement('div');
            fill.className = 'forecast-range-fill';
            const leftPct = ((row.low - weekMin) / span) * 100;
            const widthPct = Math.max(10, ((row.high - row.low) / span) * 100);
            fill.style.left = `${leftPct.toFixed(1)}%`;
            fill.style.width = `${Math.min(100 - leftPct, widthPct).toFixed(1)}%`;
            track.appendChild(fill);

            const tempMax = document.createElement('span');
            tempMax.className = 'forecast-temp-max';
            tempMax.textContent = `${row.high}°`;

            line.append(date, icon, rain, tempMin, track, tempMax);
            days.appendChild(line);
        }
        place();
    }

    async function load(force = false) {
        controller?.abort();
        const active = new AbortController();
        controller = active;
        retry.disabled = true;
        status.textContent = '获取预报中…';
        const settings = getSettings().weather;
        try {
            let location = settings;
            if (settings.mode === 'server') {
                const response = await fetch('./api/weather/default', { signal: active.signal });
                if (!response.ok) throw new Error('暂时无法读取默认天气城市');
                location = await response.json();
            }
            if (active.signal.aborted) return;
            city.textContent = String(location.city || '当前城市');
            const latitude = Number(location.latitude), longitude = Number(location.longitude);
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('城市坐标不可用');
            const key = `${latitude}:${longitude}`;
            const cached = cache.get(key);
            if (!force && cached && Date.now() - cached.time < 300000) {
                render(cached.rows);
                status.textContent = 'Open-Meteo · 五分钟内缓存';
                return;
            }
            const url = new URL('./api/weather/forecast', window.location.href);
            for (const [name, value] of Object.entries({ latitude, longitude, daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max', forecast_days: 7, timezone: 'auto' })) {
                url.searchParams.set(name, String(value));
            }
            const response = await fetch(url, { signal: active.signal, cache: 'no-cache' });
            if (!response.ok) throw new Error('天气服务暂不可用，请稍后重试');
            const rows = normalizeForecast(await response.json());
            if (active.signal.aborted) return;
            cache.set(key, { rows, time: Date.now() });
            if (cache.size > 8) cache.delete(cache.keys().next().value);
            render(rows);
            status.textContent = 'Open-Meteo · 刚刚更新 · 降水概率';
        } catch (error) {
            if (!active.signal.aborted) {
                days.replaceChildren();
                status.textContent = error.message;
                place();
            }
        } finally {
            if (controller === active) {
                controller = null;
                retry.disabled = false;
            }
        }
    }

    trigger.addEventListener('click', () => {
        if (!popover.hidden) { close(); return; }
        openPopover();
    });
    document.getElementById('closeForecast').addEventListener('click', () => close(true));
    retry.addEventListener('click', () => load(true));
    document.addEventListener('pointerdown', event => {
        if (!popover.hidden && !popover.contains(event.target) && !trigger.contains(event.target)) close();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !popover.hidden) { event.preventDefault(); close(true); }
    });
    window.addEventListener('resize', place);
    window.addEventListener('gx:panel-layout', () => {
        if (document.documentElement.classList.contains('news-panel-full')) close();
        else place();
    });
    window.addEventListener('gx:layout-changed', () => {
        if (!isWidgetVisible('weather')) close();
        else place();
    });
    window.addEventListener('gx:settings-changed', event => {
        if (['weather', 'all'].includes(event.detail?.section)) close();
    });
}
