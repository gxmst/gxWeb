// ================== 天气与粒子物理引擎 ==================
// 氛围切换通过 window.__setAmbiance 钩子桥接到 ambience 模块（含未就绪降级）。
import { getSettings } from './settings-store.js';

const canvas = document.getElementById('weatherCanvas');
const ctx = canvas.getContext('2d');
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
let particles = [];
let animationId = null;
let uiBounds = [];
let currentWeatherType = null;   // 'rain' | 'snow' | null
let canvasFade = 0;              // 切换天气时的画布淡入 (0→1)
let reduceMotion = motionPreference.matches;
let weatherPollTimer = null;
let weatherRequestInFlight = false;
const WEATHER_POLL_INTERVAL = 600000;

// 鼠标气流场：粒子在光标附近被推开/打旋
const mouse = { x: -9999, y: -9999, vx: 0, vy: 0, active: false, lastMove: 0 };
window.addEventListener('pointermove', (e) => {
    if (reduceMotion || document.hidden) return;
    mouse.vx = e.clientX - mouse.x;
    mouse.vy = e.clientY - mouse.y;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.active = true;
    mouse.lastMove = performance.now();
}, { passive: true });
window.addEventListener('pointerleave', () => { mouse.active = false; }, { passive: true });

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    _uiBoundsDirty = true;
    updateUIBounds();
}

// 按视口面积缩放粒子数，避免大屏太稀、小屏太密
function particleCountFor(type) {
    const area = window.innerWidth * window.innerHeight;
    const compact = window.innerWidth < 768;
    if (type === 'snow') return Math.max(compact ? 55 : 120, Math.min(compact ? 150 : 380, Math.round(area / 9000)));
    return Math.max(compact ? 40 : 90, Math.min(compact ? 120 : 300, Math.round(area / 12000)));   // rain
}

let _uiBoundsDirty = true;
function updateUIBounds() {
    if (!_uiBoundsDirty) return;
    _uiBoundsDirty = false;
    const ids = ['search-bar', 'news-panel', 'bottom-ticker'];
    uiBounds = [];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        // 读取真实圆角半径，碰撞面才能贴合可见弧线（修复"打在空中"）
        let radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
        radius = Math.min(radius, r.width / 2, r.height / 2);
        uiBounds.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, radius, snow: 0 });
    }
}
function markUIBoundsDirty() { _uiBoundsDirty = true; }
window.addEventListener('resize', resizeCanvas);
window.addEventListener('scroll', markUIBoundsDirty, true);

// 给定 x，返回该 bound 顶部可见表面的 y（圆角处抬高到弧线上）。x 在 bound 之外返回 null。
function surfaceYAt(bound, x) {
    if (x < bound.left || x > bound.right) return null;
    const rad = bound.radius;
    if (rad <= 0) return bound.top;
    // 左圆角区
    if (x < bound.left + rad) {
        const dx = rad - (x - bound.left);
        return bound.top + (rad - Math.sqrt(Math.max(0, rad * rad - dx * dx)));
    }
    // 右圆角区
    if (x > bound.right - rad) {
        const dx = rad - (bound.right - x);
        return bound.top + (rad - Math.sqrt(Math.max(0, rad * rad - dx * dx)));
    }
    // 中间平直段
    return bound.top;
}

resizeCanvas();

class WeatherParticle {
    constructor(type, seed) { this.type = type; this.reset(seed); }
    // seed=true：初始播种，散布在屏幕上方较高的带里，让雪/雨"开始下"而非瞬间铺满。
    // seed=false：落地/出界回收，只补在顶沿略上方，保持下落数量恒定、密度均匀。
    reset(seed) {
        this.x = Math.random() * canvas.width;
        if (seed) {
            this.y = Math.random() * canvas.height - canvas.height; // [-H, 0)，自上而下渐入
        } else {
            this.y = -10 - Math.random() * 40;                      // 顶沿略上方补员
        }
        this.prevY = this.y;
        this.isLanded = false;
        this.landedTime = 0;
        this.isSplashing = false;
        this.splashRadius = 0;
        this.splashAlpha = 1;
        this.splashX = 0;

        if (this.type === 'rain') {
            this.speed = 14 + Math.random() * 8;
            this.len = 16 + Math.random() * 16;
            this.opacity = 0.16 + Math.random() * 0.22;
            this.lineWidth = 0.7 + Math.random() * 0.7;
        } else {
            this.speed = 0.6 + Math.random() * 1.8;
            this.radius = Math.random() * 2.6 + 1.2;
            this.opacity = 0.55 + Math.random() * 0.4;
            this.swing = Math.random() * 2;
            this.swingStep = Math.random() * 100;
            this.vx = 0; // 受鼠标气流影响的横向速度
        }
    }

    applyMouseField() {
        // 仅在鼠标近期移动过时生效，避免静止光标持续吸附
        if (!mouse.active || performance.now() - mouse.lastMove > 600) return;
        const dx = this.x - mouse.x;
        const dy = this.y - mouse.y;
        const dist2 = dx * dx + dy * dy;
        const R = 110;
        if (dist2 > R * R || dist2 < 0.01) return;
        const dist = Math.sqrt(dist2);
        const force = (1 - dist / R);
        // 斥力（推开）+ 垂直分量制造打旋观感
        const push = force * (this.type === 'snow' ? 3.2 : 5.0);
        this.x += (dx / dist) * push + (-dy / dist) * push * 0.4 * (this.type === 'snow' ? 1 : 0.3);
        if (this.type === 'snow') this.y += (dy / dist) * push * 0.5;
    }

    update() {
        if (this.isLanded) {
            this.landedTime++;
            // 落地快速淡出回收（积雪由窗台积雪层呈现，不靠滞留个体堆叠）
            if (this.landedTime > 90 + Math.random() * 90) {
                this.opacity -= 0.02;
                if (this.opacity <= 0) this.reset(false);
            }
            return;
        }

        if (this.isSplashing) {
            this.splashRadius += 1.4;
            this.splashAlpha -= 0.09;
            if (this.splashAlpha <= 0) this.reset(false);
            return;
        }

        this.applyMouseField();

        this.prevY = this.y;
        this.y += this.speed;
        if (this.type === 'snow') {
            this.x += Math.sin(this.swingStep) * this.swing + this.vx;
            this.swingStep += 0.02;
            this.vx *= 0.94; // 鼠标横推后缓慢回稳
        }

        for (const bound of uiBounds) {
            if (this.x <= bound.left || this.x >= bound.right) continue;
            const surfY = surfaceYAt(bound, this.x);
            if (surfY === null) continue;
            // 叠加已积雪厚度：落点再抬高一点，雪会"落在雪上"
            const landY = surfY - (this.type === 'snow' ? bound.snow : 0);
            if (this.prevY < landY && this.y >= landY) {
                if (this.type === 'snow') {
                    this.isLanded = true;
                    this.y = landY;
                    // 喂给窗台积雪层（缓慢变厚，封顶）
                    if (bound.snow < 14) bound.snow += 0.05;
                } else {
                    this.isSplashing = true;
                    this.splashX = this.x;
                    this.y = landY;
                    this.splashRadius = 1;
                    this.splashAlpha = 0.55;
                }
                return;
            }
        }

        if (this.y > canvas.height + 50) this.reset(false);
    }
    draw() {
        if (this.isLanded) {
            ctx.beginPath();
            ctx.fillStyle = `rgba(255, 255, 255, ${this.opacity})`;
            ctx.ellipse(this.x, this.y, this.radius * 2, this.radius * 0.6, 0, 0, Math.PI * 2);
            ctx.fill();
            return;
        }

        if (this.isSplashing) {
            const r = Math.min(this.splashRadius, 10);
            ctx.beginPath();
            ctx.strokeStyle = `rgba(220, 238, 255, ${this.splashAlpha})`;
            ctx.lineWidth = 1.4;
            ctx.ellipse(this.splashX, this.y, r, r * 0.4, 0, Math.PI, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = `rgba(220, 238, 255, ${this.splashAlpha})`;
            ctx.beginPath();
            ctx.arc(this.splashX - r, this.y - r * 0.4, 0.8, 0, Math.PI * 2);
            ctx.arc(this.splashX + r, this.y - r * 0.4, 0.8, 0, Math.PI * 2);
            ctx.fill();
            return;
        }

        if (this.type === 'rain') {
            const grad = ctx.createLinearGradient(this.x, this.y, this.x, this.y + this.len);
            grad.addColorStop(0, `rgba(200, 222, 250, 0)`);
            grad.addColorStop(0.5, `rgba(208, 230, 255, ${this.opacity})`);
            grad.addColorStop(1, `rgba(200, 222, 250, 0)`);
            ctx.strokeStyle = grad;
            ctx.lineWidth = this.lineWidth;
            ctx.lineCap = 'butt';
            ctx.beginPath();
            ctx.moveTo(this.x, this.y);
            ctx.lineTo(this.x, this.y + this.len);
            ctx.stroke();
        } else {
            ctx.beginPath();
            ctx.fillStyle = `rgba(255, 255, 255, ${this.opacity})`;
            ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

// 窗台积雪层：沿每个 UI 顶沿（含圆角弧线）描出一条随时间变厚的白边
function drawSnowLedges() {
    for (const bound of uiBounds) {
        if (bound.snow <= 0.3) continue;
        const depth = bound.snow;
        ctx.save();
        ctx.beginPath();
        const step = 4;
        ctx.moveTo(bound.left, surfaceYAt(bound, bound.left));
        for (let x = bound.left; x <= bound.right; x += step) {
            ctx.lineTo(x, surfaceYAt(bound, x) - 0);
        }
        // 回扫上沿（抬高 depth）形成厚度带
        for (let x = bound.right; x >= bound.left; x -= step) {
            ctx.lineTo(x, surfaceYAt(bound, x) - depth);
        }
        ctx.closePath();
        const g = ctx.createLinearGradient(0, bound.top - depth, 0, bound.top + 2);
        g.addColorStop(0, 'rgba(255,255,255,0.92)');
        g.addColorStop(1, 'rgba(255,255,255,0.55)');
        ctx.fillStyle = g;
        ctx.fill();
        ctx.restore();
    }
}

let _uiBoundsFrame = 0;
function shouldAnimateWeather() {
    return !reduceMotion && !document.hidden && Boolean(currentWeatherType) && particles.length > 0;
}

function stopWeatherAnimation() {
    if (animationId !== null) cancelAnimationFrame(animationId);
    animationId = null;
}

function startWeatherAnimation() {
    if (!shouldAnimateWeather() || animationId !== null) return;
    animationId = requestAnimationFrame(animateWeather);
}

function animateWeather() {
    animationId = null;
    if (!shouldAnimateWeather()) return;
    _uiBoundsFrame++;
    if (_uiBoundsFrame % 60 === 0) _uiBoundsDirty = true;
    updateUIBounds();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 切换天气时整层淡入，消除"啪"地铺满的突兀感
    if (canvasFade < 1) canvasFade = Math.min(1, canvasFade + 0.02);
    ctx.globalAlpha = canvasFade;
    if (currentWeatherType === 'snow') drawSnowLedges();
    particles.forEach(p => { p.update(); p.draw(); });
    ctx.globalAlpha = 1;
    animationId = requestAnimationFrame(animateWeather);
}

const WEATHER_PROFILES = {
    rain: { overlay: 'rgba(38, 82, 130, 0.18)', particle: 'rain', ambiance: 'rain' },
    storm: { overlay: 'rgba(28, 52, 92, 0.28)', particle: 'rain', ambiance: 'storm', heavy: true },
    sun: { overlay: 'rgba(255, 218, 128, 0.08)', particle: null, ambiance: 'sunny' },
    snow: { overlay: 'rgba(104, 126, 158, 0.18)', particle: 'snow', ambiance: 'snow' },
    fog: { overlay: 'rgba(150, 158, 170, 0.16)', particle: null, ambiance: 'fog' },
    cloudy: { overlay: 'rgba(108, 122, 142, 0.12)', particle: null, ambiance: 'cloudy' },
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
    stopWeatherAnimation();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles = [];
    canvasFade = 0;
    _uiBoundsDirty = true; updateUIBounds();
    // 重置积雪厚度，避免切走再切回时残留旧雪
    uiBounds.forEach(b => b.snow = 0);

    const appearance = getSettings().appearance;
    const effectsAllowed = appearance.weatherEffects && !appearance.powerSaving;
    const profile = effectsAllowed ? weatherProfileFor(weatherKeyword) : WEATHER_PROFILES.none;
    setWeatherOverlay(overlay, profile);

    currentWeatherType = profile.particle;
    // 全屏雨雪粒子运行时暂停 WebGL 涟漪，避免两套高频背景动画争抢 GPU。
    window.dispatchEvent(new CustomEvent('gx:weather-motion', {
        detail: { active: Boolean(currentWeatherType) },
    }));
    if (profile.particle && !reduceMotion) {
        let n = particleCountFor(profile.particle);
        if (profile.heavy) n = Math.min(420, Math.round(n * 1.6)); // 雷暴：雨量更大
        for (let i = 0; i < n; i++) particles.push(new WeatherParticle(profile.particle, true));
        startWeatherAnimation();
    }
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
const filterIcons = ['✨', '☀️', '☁️', '🌫️', '🌧️', '⛈️', '❄️'];
let currentFilterIndex = 0;

function toggleWeatherFilter() {
    currentFilterIndex = (currentFilterIndex + 1) % filterModes.length;
    const mode = filterModes[currentFilterIndex];
    document.getElementById('filterBtn').innerText = filterIcons[currentFilterIndex];
    if (mode === 'auto') applyEnvironmentFilter(realWeather);
    else applyEnvironmentFilter(mode);
}

async function fetchWeather() {
    const settings = getSettings();
    if (settings.weather.mode === 'city') {
        try {
            const url = new URL('./api/weather/forecast', window.location.href);
            url.searchParams.set('latitude', String(settings.weather.latitude));
            url.searchParams.set('longitude', String(settings.weather.longitude));
            url.searchParams.set('current_weather', 'true');
            const response = await fetch(url, { cache: 'no-cache' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            const current = payload.current_weather || {};
            const code = Number(current.weathercode);
            const temperature = Number(current.temperature);
            if (!Number.isFinite(code) || !Number.isFinite(temperature)) throw new Error('invalid weather payload');
            const emojiMap = { 0: '☀️', 1: '☁️', 2: '☁️', 3: '☁️', 45: '🌫️', 48: '🌫️', 51: '🌧️', 53: '🌧️', 55: '🌧️', 61: '🌧️', 63: '🌧️', 65: '🌧️', 71: '❄️', 73: '❄️', 75: '❄️', 95: '⛈️' };
            const emoji = emojiMap[code] || (code >= 71 && code <= 77 ? '❄️' : code >= 51 && code <= 67 ? '🌧️' : '☁️');
            const city = String(settings.weather.city || '').split(' · ')[0] || '当前城市';
            const text = `${city} · ${emoji} ${temperature}°C`;
            realWeather = text;
            document.getElementById('weatherInfo').innerText = text;
            if (filterModes[currentFilterIndex] === 'auto') applyEnvironmentFilter(realWeather);
            return;
        } catch (error) {
            console.warn('指定城市天气获取失败，回退服务器天气:', error);
        }
    }
    try {
        const response = await fetch('./weather.txt', { cache: 'no-cache' });
        if (!response.ok) throw new Error();
        const text = await response.text();
        if (!text.includes('失败')) {
            realWeather = text;
            document.getElementById('weatherInfo').innerText = text;
            if (filterModes[currentFilterIndex] === 'auto') applyEnvironmentFilter(realWeather);
        }
    } catch { document.getElementById('weatherInfo').innerText = '暂无天气数据'; }
}

export function initWeather() {
    document.getElementById('filterBtn')?.addEventListener('click', toggleWeatherFilter);
    const currentKeyword = () => filterModes[currentFilterIndex] === 'auto'
        ? realWeather
        : filterModes[currentFilterIndex];

    const poll = async () => {
        if (document.hidden || weatherRequestInFlight) return;
        weatherRequestInFlight = true;
        try {
            await fetchWeather();
        } finally {
            weatherRequestInFlight = false;
            if (!document.hidden) weatherPollTimer = window.setTimeout(poll, WEATHER_POLL_INTERVAL);
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
            poll();
        }
        if (event.detail?.section === 'appearance' || event.detail?.section === 'all') {
            applyEnvironmentFilter(currentKeyword());
        }
    });
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
