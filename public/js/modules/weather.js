// ================== 天气与粒子物理引擎 ==================
// 氛围切换通过 window.__setAmbiance 钩子桥接到 ambience 模块（含未就绪降级）。
import { getSettings, getEffectiveAppearance, isWidgetVisible } from './settings-store.js?v=workspace-20261122b';
import { initForecast } from './forecast.js?v=workspace-20261122b';
import { createWeatherScene } from './weather-scene.js?v=workspace-20261122b';
import { showControlToast } from './toast.js?v=workspace-20261122b';

const scene = createWeatherScene(document.getElementById('weatherCanvas'));
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
let reduceMotion = motionPreference.matches;
let weatherPollTimer = null;
let weatherRequestController = null;
const WEATHER_POLL_INTERVAL = 600000;
const stopWeatherAnimation = () => scene.pause();
const startWeatherAnimation = () => scene.resume();

const WEATHER_PROFILES = {
    rain: { overlay: 'rgba(38, 70, 110, 0.10)', particle: 'rain', ambiance: 'rain' },
    storm: { overlay: 'rgba(28, 52, 92, 0.18)', particle: 'rain', ambiance: 'storm', heavy: true },
    sun: { overlay: 'rgba(255, 218, 128, 0.035)', particle: null, ambiance: 'sunny' },
    snow: { overlay: 'rgba(104, 126, 158, 0.10)', particle: 'snow', ambiance: 'snow' },
    fog: { overlay: 'rgba(150, 158, 170, 0.07)', particle: null, ambiance: 'fog' },
    cloudy: { overlay: 'rgba(108, 122, 142, 0.06)', particle: null, ambiance: 'cloudy' },
    none: { overlay: 'rgba(0, 0, 0, 0.12)', particle: null, ambiance: 'none' }
};

// 匹配优先按爬虫真实输出的 emoji，再兜底中英文关键字。
// 顺序有讲究：雷暴(⛈️含雨意)先于雨；雾/多云放最后避免误吞。
function weatherProfileFor(weatherKeyword) {
    const text = String(weatherKeyword || '');
    if (text.includes('⛈️') || text.includes('雷')) return WEATHER_PROFILES.storm;
    if (text.includes('🌧️') || text.includes('雨')) return WEATHER_PROFILES.rain;
    if (text.includes('❄️') || text.includes('雪')) return WEATHER_PROFILES.snow;
    if (text.includes('☀️') || text.includes('晴')) return WEATHER_PROFILES.sun;
    if (text.includes('🌫️') || /雾|霾|mist|fog|haze/i.test(text)) return WEATHER_PROFILES.fog;
    if (text.includes('☁️') || /阴|云|霜|overcast|cloud/i.test(text)) return WEATHER_PROFILES.cloudy;
    return WEATHER_PROFILES.none;
}

function setWeatherOverlay(overlay, profile) {
    overlay.className = "absolute inset-0 transition-colors duration-1000 z-20";
    overlay.style.backgroundColor = profile.overlay;
}

function applyEnvironmentFilter(weatherKeyword) {
    const overlay = document.getElementById('weatherOverlay');
    const appearance = getEffectiveAppearance();
    const effectsAllowed = appearance.weatherEffects && !appearance.powerSaving;
    const profile = effectsAllowed ? weatherProfileFor(weatherKeyword) : WEATHER_PROFILES.none;
    setWeatherOverlay(overlay, profile);

    const particle = !reduceMotion ? profile.particle : null;
    scene.set(particle,{heavy:profile.heavy});
    // 全屏雨雪粒子运行时暂停 WebGL 涟漪，避免两套高频背景动画争抢 GPU。
    window.dispatchEvent(new CustomEvent('gx:weather-motion', {
        detail: { active: Boolean(particle) },
    }));
    setWeatherAmbient(profile.ambiance);
}

// 氛围桥接：天气引擎 → 视觉增强钩子。ambience 认识的类型：
// 'rain' | 'storm' | 'snow' | 'sun' | 'fog' | 'cloudy' | 'none'（sunny 归一到 sun）
function setWeatherAmbient(kind) {
    const ambiance = kind === 'sunny' ? 'sun' : (kind || 'none');
    if (typeof window.__setAmbiance === 'function') window.__setAmbiance(ambiance);
    else window.__weatherAmbiance = ambiance; // ambience 尚未就绪时暂存，初始化后会自行校准
}

let realWeather = '';
const filterModes = ['auto', '晴', '阴', '雾', '雨', '雷', '雪'];
const filterIconKinds = ['auto', 'sun', 'cloudy', 'fog', 'rain', 'storm', 'snow'];
const filterLabels = ['自动（跟随实况）', '晴', '阴', '雾', '雨', '雷暴', '雪'];
let currentFilterIndex = 0;

const WEATHER_SVGS = {
    sun: '<svg class="w-4 h-4 text-amber-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4" fill="currentColor" fill-opacity="0.25"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
    cloudy: '<svg class="w-4 h-4 text-sky-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" fill="currentColor" fill-opacity="0.18"/></svg>',
    fog: '<svg class="w-4 h-4 text-slate-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 10h16M6 14h12M4 18h10M8 6h12"/></svg>',
    rain: '<svg class="w-4 h-4 text-sky-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" fill="currentColor" fill-opacity="0.18"/><path d="M16 14v6m-4-4v6m-4-6v6"/></svg>',
    storm: '<svg class="w-4 h-4 text-amber-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path d="m13 12-3 5h4l-3 5"/></svg>',
    snow: '<svg class="w-4 h-4 text-cyan-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 15h.01M8 19h.01M12 17h.01M12 21h.01M16 15h.01M16 19h.01"/></svg>',
};

function renderWeatherHero(rawText) {
    const infoEl = document.getElementById('weatherInfo');
    const iconSlot = document.getElementById('weatherIconSlot');
    if (!infoEl) return;
    const profile = weatherProfileFor(rawText);
    const kind = profile.ambiance === 'sunny' ? 'sun' : profile.ambiance;
    const svg = WEATHER_SVGS[kind] || '';
    if (iconSlot) {
        iconSlot.innerHTML = svg;
    }
    const cleaned = svg
        ? String(rawText || '').replace(/[☀️☁️🌫️🌧️⛈️❄️]\s*/g, '').trim()
        : String(rawText || '').trim();
    infoEl.innerText = cleaned || String(rawText || '');
}

function toggleWeatherFilter() {
    currentFilterIndex = (currentFilterIndex + 1) % filterModes.length;
    const mode = filterModes[currentFilterIndex];
    const btn = document.getElementById('filterBtn');
    btn.innerHTML = WEATHER_SVGS[filterIconKinds[currentFilterIndex]] || '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/></svg>';
    btn.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    const label = `环境滤镜：${filterLabels[currentFilterIndex]}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    showControlToast(label);
    if (mode === 'auto') applyEnvironmentFilter(realWeather);
    else applyEnvironmentFilter(mode);
}

async function fetchWeather(signal) {
    const settings = getSettings();
    if (settings.weather.mode === 'city') {
        try {
            const url = new URL('./api/weather/forecast', window.location.href);
            url.searchParams.set('latitude', String(settings.weather.latitude));
            url.searchParams.set('longitude', String(settings.weather.longitude));
            url.searchParams.set('current_weather', 'true');
            const response = await fetch(url, { cache: 'no-cache', signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (signal.aborted) return;
            const current = payload.current_weather || {};
            const code = Number(current.weathercode);
            const temperature = Number(current.temperature);
            if (!Number.isFinite(code) || !Number.isFinite(temperature)) throw new Error('invalid weather payload');
            const emojiMap = { 0: '☀️', 1: '☁️', 2: '☁️', 3: '☁️', 45: '🌫️', 48: '🌫️', 51: '🌧️', 53: '🌧️', 55: '🌧️', 61: '🌧️', 63: '🌧️', 65: '🌧️', 71: '❄️', 73: '❄️', 75: '❄️', 95: '⛈️' };
            const emoji = emojiMap[code] || (code >= 71 && code <= 77 ? '❄️' : code >= 51 && code <= 67 ? '🌧️' : '☁️');
            const city = String(settings.weather.city || '').split(' · ')[0] || '当前城市';
            const text = `${city} · ${emoji} ${temperature}°C`;
            realWeather = text;
            renderWeatherHero(text);
            if (filterModes[currentFilterIndex] === 'auto') applyEnvironmentFilter(realWeather);
            return;
        } catch (error) {
            if (signal.aborted) return;
            console.warn('指定城市天气获取失败，回退服务器天气:', error);
        }
    }
    try {
        const response = await fetch('./weather.txt', { cache: 'no-cache', signal });
        if (!response.ok) throw new Error();
        const text = await response.text();
        if (signal.aborted) return;
        if (!text.includes('失败')) {
            realWeather = text;
            renderWeatherHero(text);
            if (filterModes[currentFilterIndex] === 'auto') applyEnvironmentFilter(realWeather);
        }
    } catch {
        if (!signal.aborted) renderWeatherHero('暂无天气数据');
    }
}

export function initWeather() {
    initForecast();
    document.getElementById('filterBtn')?.addEventListener('click', toggleWeatherFilter);
    const currentKeyword = () => filterModes[currentFilterIndex] === 'auto'
        ? realWeather
        : filterModes[currentFilterIndex];

    const needsWeather = () => isWidgetVisible('weather') || (getEffectiveAppearance().weatherEffects && !getEffectiveAppearance().powerSaving);
    let weatherNeeded = needsWeather();
    const poll = async () => {
        if (document.hidden || !needsWeather() || weatherRequestController) return;
        const controller = new AbortController();
        weatherRequestController = controller;
        try {
            await fetchWeather(controller.signal);
        } finally {
            // An obsolete request must not reset the active request or its timer.
            if (weatherRequestController === controller) {
                weatherRequestController = null;
                if (!document.hidden && needsWeather()) weatherPollTimer = window.setTimeout(poll, WEATHER_POLL_INTERVAL);
            }
        }
    };
    document.addEventListener('visibilitychange', () => {
        window.clearTimeout(weatherPollTimer);
        weatherPollTimer = null;
        if (document.hidden) stopWeatherAnimation();
        else {
            startWeatherAnimation();
            poll();
        }
    });
    window.addEventListener('gx:settings-changed', event => {
        if (event.detail?.section === 'weather' || event.detail?.section === 'all') {
            window.clearTimeout(weatherPollTimer);
            weatherPollTimer = null;
            weatherRequestController?.abort();
            weatherRequestController = null;
            poll();
        }
        if (['appearance', 'widgets', 'all'].includes(event.detail?.section)) {
            applyEnvironmentFilter(currentKeyword());
            syncWeatherPolling();
        }
    });
    function syncWeatherPolling() {
        const next = needsWeather();
        if (next === weatherNeeded) return;
        weatherNeeded = next;
        window.clearTimeout(weatherPollTimer);
        weatherRequestController?.abort();
        weatherRequestController = null;
        if (next) poll();
    }
    window.addEventListener('gx:layout-changed', syncWeatherPolling);
    const handleMotionPreference = event => {
        reduceMotion = event.matches;
        applyEnvironmentFilter(currentKeyword());
    };
    if (typeof motionPreference.addEventListener === 'function') {
        motionPreference.addEventListener('change', handleMotionPreference);
    } else {
        motionPreference.addListener(handleMotionPreference);
    }
    poll();
}
