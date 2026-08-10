// ============ 壁纸轮换 + 收藏夹 + 取色驱动主题 ============
// 轮换池 = 服务器列表（public/wallpapers.json：收藏目录 + 今日必应 5 张）+ 本地收藏夹。
// 本地收藏夹存在 IndexedDB 里（见 wallpaper-store.js），存的是图片字节而不是路径——
// 因为 bg_0..bg_4.jpg 是滚动窗口，5 天后同名文件已是别的图，存路径等于收藏了一个格子。
import { safeStorageGet, safeStorageSet } from './storage.js';
import { moveTabIndicator, getCurrentFilter } from './news.js?v=polish-20260811a';
import { getSettings } from './settings-store.js';
import { showControlToast } from './toast.js';
import {
    FAVORITE_LIMIT,
    deleteFavorite,
    favoritesAvailable,
    getFavoriteBlob,
    initFavorites,
    listFavorites,
    putFavorite,
} from './wallpaper-store.js';

// 轮换条目统一形态：{ key, kind: 'remote' | 'local', src?, id? }
let remoteEntries = [];
let localEntries = [];
let favoriteMeta = new Map();      // id -> meta（缩略图等，供设置页渲染）
const localUrls = new Map();       // id -> blob: URL，切换/删除时回收
let pendingRevoke = null;          // 当前正在显示的图不能立刻 revoke，推迟到下次切换

let currentEntry = null;
let currentFingerprint = '';
let activeBgLayer = 1;
let isSwitchingBg = false;
const vSuffix = new Date().toISOString().slice(0, 10);
const THEME_KEY = 'gxWallTheme';
const LAST_KEY = 'lastWallpaperKey';

function remoteKey(path) { return `remote:${path}`; }
function localKey(id) { return `local:${id}`; }

function rotationPool() {
    const rotation = getSettings().wallpaper.rotation;
    if (rotation === 'favorites' && localEntries.length) return localEntries.slice();
    return localEntries.concat(remoteEntries);
}

function pickNextEntry(excludeKey = '') {
    const pool = rotationPool();
    if (!pool.length) return null;
    if (pool.length === 1) return pool[0];
    const candidates = pool.filter(entry => entry.key !== excludeKey);
    const list = candidates.length ? candidates : pool;
    return list[Math.floor(Math.random() * list.length)];
}

// ---- OKLCH 色彩管线 ----
// 取色后的亮度/饱和度调整改在 OKLCH 空间做：它的 L 是「感知亮度」，
// 不像 HSL 的 L 对黄绿色系会过曝（同样 L 值黄色看着比蓝色亮得多）。
// 这样无论壁纸是什么色相，提亮后的强调色明度感知一致、更耐看。
// 矩阵来自 Björn Ottosson 的 OKLab 定义。输出仍是 [r,g,b] 0-255 三元组，
// 写进 --wall-r/g/b，下游所有 rgba(var(--wall-rgb), …) 不需要任何改动。

function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c) {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function rgbToOklch(r, g, b) {
    const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
    const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
    const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
    const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
    const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
    const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
    const A = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
    const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
    const C = Math.sqrt(A * A + B * B);
    let H = Math.atan2(B, A) * 180 / Math.PI;
    if (H < 0) H += 360;
    return [L, C, H];
}

function oklchToRgb(L, C, H) {
    const h = H * Math.PI / 180;
    const a = C * Math.cos(h), b = C * Math.sin(h);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}

// 感知指纹（aHash）：把取色用的 72×72 缩略再降到 8×8 灰度，按均值二值化成 64 bit。
// 用途是「这张图是不是已经在收藏夹里」——同一张图无论出现在 bg_1 还是 bg_3、
// 或者从 blob 读回来，像素一致 → 指纹一致。顺带当收藏记录的主键，天然去重。
function fingerprintFromPixels(pixels, size) {
    const cell = Math.floor(size / 8) || 1;
    const grid = new Array(64).fill(0);
    for (let by = 0; by < 8; by++) {
        for (let bx = 0; bx < 8; bx++) {
            let sum = 0, count = 0;
            for (let y = by * cell; y < (by + 1) * cell && y < size; y++) {
                for (let x = bx * cell; x < (bx + 1) * cell && x < size; x++) {
                    const i = (y * size + x) * 4;
                    sum += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
                    count++;
                }
            }
            grid[by * 8 + bx] = count ? sum / count : 0;
        }
    }
    const mean = grid.reduce((a, b) => a + b, 0) / 64;
    let hex = '';
    for (let nibble = 0; nibble < 16; nibble++) {
        let value = 0;
        for (let bit = 0; bit < 4; bit++) {
            value = (value << 1) | (grid[nibble * 4 + bit] > mean ? 1 : 0);
        }
        hex += value.toString(16);
    }
    return hex;
}

// 一次 getImageData 同时算出主题色与指纹，避免重复解码。
function analyzeImage(img) {
    const canvas = document.createElement('canvas');
    const size = 72;
    canvas.width = size;
    canvas.height = size;
    const c = canvas.getContext('2d', { willReadFrequently: true });
    c.drawImage(img, 0, 0, size, size);
    const pixels = c.getImageData(0, 0, size, size).data;
    let rSum = 0, gSum = 0, bSum = 0, weightSum = 0;
    let brightSum = 0;
    for (let i = 0; i < pixels.length; i += 16) {
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
        if (a < 180) continue;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const sat = (max - min) / 255;
        const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        if (lum < 0.06 || lum > 0.94) continue;
        const weight = 0.35 + sat * 1.8 + (1 - Math.abs(lum - 0.55)) * 0.45;
        rSum += r * weight;
        gSum += g * weight;
        bSum += b * weight;
        brightSum += lum * weight;
        weightSum += weight;
    }
    const fingerprint = fingerprintFromPixels(pixels, size);
    if (!weightSum) return { fingerprint, theme: null };

    let r = rSum / weightSum;
    let g = gSum / weightSum;
    let b = bSum / weightSum;
    const avgLum = brightSum / weightSum;
    // OKLCH 空间调强调色：L=感知亮度，C=彩度，H=色相。
    // 提亮统一到 L≈0.72-0.82——无论黄绿还是蓝紫，提亮后看着一样亮（HSL 做不到）。
    // 暗壁纸(avgLum<0.34)多抬一点保证玻璃描边可见；C 拉一个下限避免发灰。
    let [L, C, H] = rgbToOklch(r, g, b);
    C = Math.max(0.08, Math.min(0.22, C * 1.15));
    L = Math.max(0.72, Math.min(0.82, avgLum < 0.34 ? L + 0.20 : L + 0.10));
    [r, g, b] = oklchToRgb(L, C, H);

    return {
        fingerprint,
        theme: { r: Math.round(r), g: Math.round(g), b: Math.round(b), lum: Number(avgLum.toFixed(3)) },
    };
}

function applyWallpaperThemeFromImage(img, entry) {
    try {
        const { fingerprint, theme } = analyzeImage(img);
        // 本地收藏的 id 就是当初存下的指纹，直接采信，避免不同浏览器解码差异导致心形状态错乱。
        currentFingerprint = entry?.kind === 'local' ? String(entry.id) : fingerprint;
        syncFavoriteButton();
        if (!theme) return;
        applyThemeVars(theme.r, theme.g, theme.b, theme.lum);
        // 持久化最终主题，下次首帧直接应用，避免"默认天蓝 → 取色后跳变"
        safeStorageSet(THEME_KEY, JSON.stringify(theme));
    } catch (e) {
        console.warn('壁纸取色失败:', e);
    }
}

function applyThemeVars(r, g, b, avgLum) {
    const root = document.body;
    root.style.setProperty('--wall-r', Math.round(r));
    root.style.setProperty('--wall-g', Math.round(g));
    root.style.setProperty('--wall-b', Math.round(b));
    root.style.setProperty('--glass-fill', avgLum > 0.62 ? 'rgba(8, 15, 25, 0.10)' : 'rgba(255, 255, 255, 0.040)');
    root.style.setProperty('--glass-fill-strong', avgLum > 0.62 ? 'rgba(12, 20, 32, 0.14)' : 'rgba(255, 255, 255, 0.068)');
    root.style.setProperty('--glass-border', avgLum > 0.62 ? 'rgba(255, 255, 255, 0.24)' : 'rgba(255, 255, 255, 0.18)');
    root.style.setProperty('--glass-shadow', avgLum > 0.62 ? 'rgba(0, 0, 0, 0.38)' : 'rgba(0, 0, 0, 0.30)');
    root.style.setProperty('--scene-shade', avgLum > 0.62 ? 'rgba(0, 0, 0, 0.34)' : 'rgba(0, 0, 0, 0.22)');
    root.style.setProperty('--scene-vignette', avgLum > 0.62 ? 'rgba(0, 0, 0, 0.52)' : 'rgba(0, 0, 0, 0.38)');
    if (typeof moveTabIndicator === 'function') moveTabIndicator(getCurrentFilter());
}

// 首帧应用上次会话保存的主题色，等真正取色完成后会被覆盖
function applyStoredTheme() {
    try {
        const saved = JSON.parse(safeStorageGet(THEME_KEY, '') || 'null');
        if (!saved) return;
        const { r, g, b, lum } = saved;
        if ([r, g, b, lum].every(Number.isFinite)) applyThemeVars(r, g, b, lum);
    } catch { /* 坏数据直接忽略，保持默认主题 */ }
}

async function resolveEntrySrc(entry) {
    if (!entry) return '';
    if (entry.kind === 'remote') return `${entry.src}?v=${vSuffix}`;
    const cached = localUrls.get(entry.id);
    if (cached) return cached;
    const blob = await getFavoriteBlob(entry.id);
    if (!blob) return '';
    const url = URL.createObjectURL(blob);
    localUrls.set(entry.id, url);
    return url;
}

function setWallpaperLoading(loading) {
    document.getElementById('wallpaperBtn')?.classList.toggle('is-loading', loading);
}

function flushPendingRevoke() {
    if (!pendingRevoke) return;
    URL.revokeObjectURL(pendingRevoke);
    pendingRevoke = null;
}

// 统一的换图流程：预载到隐藏层 → 取色 → 交叉淡入 → 预取下一张。
// 首屏与手动切换走同一条路径，只是 announce 与预取策略略有差别。
async function showEntry(entry, { announce = false } = {}) {
    if (!entry || isSwitchingBg) return false;
    isSwitchingBg = true;
    setWallpaperLoading(true);

    const img1 = document.getElementById('bgImage1');
    const img2 = document.getElementById('bgImage2');
    if (!img1 || !img2) { isSwitchingBg = false; setWallpaperLoading(false); return false; }

    const src = await resolveEntrySrc(entry);
    if (!src) {
        isSwitchingBg = false;
        setWallpaperLoading(false);
        if (announce) showControlToast('这张壁纸读取失败');
        return false;
    }

    const currentLayer = activeBgLayer === 1 ? img1 : img2;
    const hiddenLayer = activeBgLayer === 1 ? img2 : img1;

    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            isSwitchingBg = false;
            setWallpaperLoading(false);
            resolve(false);
        }, 8000);

        hiddenLayer.onload = () => {
            clearTimeout(timeout);
            setWallpaperLoading(false);
            currentEntry = entry;
            safeStorageSet(LAST_KEY, entry.key);
            applyWallpaperThemeFromImage(hiddenLayer, entry);
            hiddenLayer.classList.remove('opacity-0');
            hiddenLayer.style.opacity = '1';
            currentLayer.style.opacity = '0';
            activeBgLayer = activeBgLayer === 1 ? 2 : 1;
            if (window.__fluidSetWallpaper) window.__fluidSetWallpaper(hiddenLayer);
            flushPendingRevoke();

            // 预取下一张候选（本地图已在 IndexedDB，只预取远端）
            const next = pickNextEntry(entry.key);
            if (next && next.kind === 'remote') {
                const preload = new Image();
                preload.src = `${next.src}?v=${vSuffix}`;
            }

            setTimeout(() => { isSwitchingBg = false; }, 600);
            resolve(true);
        };

        hiddenLayer.onerror = () => {
            clearTimeout(timeout);
            setWallpaperLoading(false);
            isSwitchingBg = false;
            if (announce) showControlToast('这张壁纸加载失败');
            resolve(false);
        };

        hiddenLayer.src = src;
    });
}

export function toggleWallpaper() {
    const next = pickNextEntry(currentEntry?.key || '');
    if (!next) return;
    showEntry(next, { announce: true });
}

// ---- 收藏夹 ----

function syncFavoriteButton() {
    const button = document.getElementById('favoriteBtn');
    if (!button) return;
    if (!favoritesAvailable()) {
        button.hidden = true;
        return;
    }
    button.hidden = false;
    const known = Boolean(currentFingerprint);
    const isFavorite = known && favoriteMeta.has(currentFingerprint);
    button.disabled = !known;
    button.classList.toggle('is-favorite', isFavorite);
    button.setAttribute('aria-pressed', String(isFavorite));
    const label = isFavorite ? '从我的壁纸中移除' : '收藏这张壁纸';
    button.title = label;
    button.setAttribute('aria-label', label);
    const count = document.getElementById('favoriteCount');
    if (count) count.textContent = favoriteMeta.size ? String(favoriteMeta.size) : '';
}

function rebuildLocalEntries() {
    localEntries = Array.from(favoriteMeta.keys()).map(id => ({ key: localKey(id), kind: 'local', id }));
    // 已被删除的收藏，回收其 blob URL（正在显示的那张推迟到下次切换）
    for (const [id, url] of Array.from(localUrls.entries())) {
        if (favoriteMeta.has(id)) continue;
        localUrls.delete(id);
        if (currentEntry?.kind === 'local' && currentEntry.id === id) pendingRevoke = url;
        else URL.revokeObjectURL(url);
    }
}

function publishFavorites() {
    const items = Array.from(favoriteMeta.values()).sort((a, b) => Number(b.addedAt || 0) - Number(a.addedAt || 0));
    window.dispatchEvent(new CustomEvent('gx:wallpaper-favorites', {
        detail: {
            items,
            limit: FAVORITE_LIMIT,
            available: favoritesAvailable(),
            bytes: items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
            currentId: currentEntry?.kind === 'local' ? currentEntry.id : '',
            currentFingerprint,
        },
    }));
}

async function refreshFavorites() {
    const list = await listFavorites();
    favoriteMeta = new Map(list.map(item => [item.id, item]));
    rebuildLocalEntries();
    syncFavoriteButton();
    publishFavorites();
}

// 把当前显示的这张图整份存下来。缩略图另存一份 dataURL，设置页列表就不必解码原图。
async function captureCurrentWallpaper() {
    const layer = activeBgLayer === 1 ? document.getElementById('bgImage1') : document.getElementById('bgImage2');
    if (!layer || !layer.src) throw new Error('当前没有可收藏的壁纸');

    const response = await fetch(layer.src, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();

    const thumbWidth = 320;
    const ratio = layer.naturalHeight && layer.naturalWidth ? layer.naturalHeight / layer.naturalWidth : 0.5625;
    const canvas = document.createElement('canvas');
    canvas.width = thumbWidth;
    canvas.height = Math.max(1, Math.round(thumbWidth * ratio));
    canvas.getContext('2d').drawImage(layer, 0, 0, canvas.width, canvas.height);

    const stored = safeStorageGet(THEME_KEY, '');
    let theme = null;
    try { theme = stored ? JSON.parse(stored) : null; } catch { theme = null; }

    return {
        blob,
        meta: {
            id: currentFingerprint,
            thumbnail: canvas.toDataURL('image/jpeg', 0.72),
            width: layer.naturalWidth,
            height: layer.naturalHeight,
            theme,
            origin: currentEntry?.kind === 'remote' ? currentEntry.src : 'local',
        },
    };
}

async function toggleFavorite() {
    if (!favoritesAvailable() || !currentFingerprint) return;
    const button = document.getElementById('favoriteBtn');
    if (button) button.disabled = true;
    try {
        if (favoriteMeta.has(currentFingerprint)) {
            await deleteFavorite(currentFingerprint);
            await refreshFavorites();
            showControlToast('已从我的壁纸移除');
            return;
        }
        if (favoriteMeta.size >= FAVORITE_LIMIT) {
            showControlToast(`我的壁纸已满 ${FAVORITE_LIMIT} 张，先在设置里清理`, 2200);
            return;
        }
        const { blob, meta } = await captureCurrentWallpaper();
        await putFavorite(meta, blob);
        // 刚收藏的图从此以本地条目身份参与轮换，当前显示的条目也切成 local，
        // 这样服务器把它轮换掉之后再次抽到它仍然能显示。
        currentEntry = { key: localKey(meta.id), kind: 'local', id: meta.id };
        safeStorageSet(LAST_KEY, currentEntry.key);
        await refreshFavorites();
        showControlToast('已加入我的壁纸，之后会参与轮换');
    } catch (error) {
        console.warn('壁纸收藏失败:', error);
        showControlToast('收藏失败，可能是存储空间不足', 2200);
    } finally {
        syncFavoriteButton();
    }
}

// 设置页调用：把某张收藏设为当前壁纸 / 删除某张收藏 / 清空。
export async function applyFavorite(id) {
    if (!favoriteMeta.has(String(id))) return;
    await showEntry({ key: localKey(id), kind: 'local', id: String(id) }, { announce: true });
    publishFavorites();
}

export async function removeFavorite(id) {
    await deleteFavorite(String(id));
    await refreshFavorites();
}

export function requestFavorites() {
    publishFavorites();
}

export async function initWallpapers() {
    applyStoredTheme();
    document.getElementById('wallpaperBtn')?.addEventListener('click', toggleWallpaper);
    document.getElementById('favoriteBtn')?.addEventListener('click', toggleFavorite);

    // 两层都显式落一个内联 opacity:0，让首帧淡入也是真的 transition
    // （只靠 Tailwind 的 opacity-0 类，首次 remove 后是"换了个样式源"，浏览器可能不插值）。
    for (const id of ['bgImage1', 'bgImage2']) {
        const layer = document.getElementById(id);
        if (layer) layer.style.opacity = '0';
    }

    // 收藏夹（IndexedDB）与壁纸列表（网络）互不依赖，并行拿，别串着等。
    const remoteReady = fetch('./wallpapers.json', { cache: 'no-cache' })
        .then(resp => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return resp.json();
        })
        .then(list => {
            remoteEntries = (Array.isArray(list) ? list : [])
                .filter(path => typeof path === 'string' && path)
                .map(path => ({ key: remoteKey(path), kind: 'remote', src: path }));
        })
        .catch(e => console.error('加载壁纸列表失败:', e));

    await initFavorites();
    await Promise.all([refreshFavorites(), remoteReady]);

    const pool = rotationPool();
    if (pool.length) {
        // 首屏优先复用上次那张：命中缓存/本地库秒出，不再每次刷新都等一张新图。
        const lastKey = safeStorageGet(LAST_KEY, '');
        const restored = pool.find(entry => entry.key === lastKey);
        await showEntry(restored || pickNextEntry(), { announce: false });

        const btn = document.getElementById('wallpaperBtn');
        if (btn) {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.pointerEvents = 'auto';
        }
    }
    syncFavoriteButton();
    publishFavorites();
}
