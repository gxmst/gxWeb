// ============ 壁纸收藏夹引擎 + 壁纸取色驱动主题 ============
import { safeStorageGet, safeStorageSet } from './storage.js';
import { moveTabIndicator, getCurrentFilter } from './news.js';

let wallpapersArray = [];
let currentBgIndex = 0;
let activeBgLayer = 1;
let isSwitchingBg = false;
const vSuffix = new Date().toISOString().slice(0, 10);

function wallpaperSrc(index) {
    return wallpapersArray[index] + '?v=' + vSuffix;
}

function pickRandomWallpaperIndex(excludeIndex = -1) {
    if (!wallpapersArray.length) return 0;
    if (wallpapersArray.length === 1) return 0;
    let idx = Math.floor(Math.random() * wallpapersArray.length);
    let guard = 0;
    while (idx === excludeIndex && guard < 8) {
        idx = Math.floor(Math.random() * wallpapersArray.length);
        guard++;
    }
    return idx === excludeIndex ? (excludeIndex + 1) % wallpapersArray.length : idx;
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

function applyWallpaperThemeFromImage(img) {
    try {
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
        if (!weightSum) return;
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
    } catch (e) {
        console.warn('壁纸取色失败:', e);
    }
}

export function toggleWallpaper() {
    if (wallpapersArray.length === 0) return;
    if (isSwitchingBg) return;
    isSwitchingBg = true;

    const switchTimeout = setTimeout(() => { isSwitchingBg = false; }, 5000);

    currentBgIndex = pickRandomWallpaperIndex(currentBgIndex);
    safeStorageSet('lastWallpaperIndex', currentBgIndex);
    const nextSrc = wallpaperSrc(currentBgIndex);

    const img1 = document.getElementById('bgImage1');
    const img2 = document.getElementById('bgImage2');

    const currentLayer = activeBgLayer === 1 ? img1 : img2;
    const hiddenLayer = activeBgLayer === 1 ? img2 : img1;

    hiddenLayer.onload = () => {
        clearTimeout(switchTimeout);
        applyWallpaperThemeFromImage(hiddenLayer);
        hiddenLayer.style.opacity = '1';
        currentLayer.style.opacity = '0';
        activeBgLayer = activeBgLayer === 1 ? 2 : 1;
        if (window.__fluidSetWallpaper) window.__fluidSetWallpaper(hiddenLayer);

        const nextIdx = pickRandomWallpaperIndex(currentBgIndex);
        const preload = new Image();
        preload.src = wallpaperSrc(nextIdx);

        setTimeout(() => {
            isSwitchingBg = false;
        }, 1000);
    };

    hiddenLayer.onerror = () => {
        clearTimeout(switchTimeout);
        isSwitchingBg = false;
    };

    hiddenLayer.src = nextSrc;
}

export async function initWallpapers() {
    try {
        const resp = await fetch('./wallpapers.json?t=' + Date.now());
        wallpapersArray = await resp.json();
        if (wallpapersArray && wallpapersArray.length > 0) {
            const lastIndex = Number.parseInt(safeStorageGet('lastWallpaperIndex', '-1'), 10);
            currentBgIndex = pickRandomWallpaperIndex(Number.isFinite(lastIndex) ? lastIndex : -1);
            safeStorageSet('lastWallpaperIndex', currentBgIndex);
            // 初始化随机壁纸并预加载下一张候选
            const img1 = document.getElementById('bgImage1');
            const img2 = document.getElementById('bgImage2');
            const firstSrc = wallpaperSrc(currentBgIndex);
            img1.onload = () => {
                applyWallpaperThemeFromImage(img1);
                img1.classList.remove('opacity-0');
                img1.classList.add('opacity-100');
                if (window.__fluidSetWallpaper) window.__fluidSetWallpaper(img1);
            };
            img1.src = firstSrc;
            img2.src = firstSrc;
            if (wallpapersArray.length > 1) {
                const nextImg = new Image();
                nextImg.src = wallpaperSrc(pickRandomWallpaperIndex(currentBgIndex));
            }
            // 列表加载成功后激活切换按钮
            const btn = document.getElementById('wallpaperBtn');
            btn.style.opacity = '1';
            btn.style.pointerEvents = 'auto';
        }
    } catch (e) {
        console.error("加载壁纸列表失败:", e);
    }
}

// 内联 onclick 引用的全局函数
window.toggleWallpaper = toggleWallpaper;
