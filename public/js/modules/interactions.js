// ================== 辅助交互与快捷键 ==================
import { safeStorageGet, safeStorageSet } from './storage.js';

export function initInteractions() {
    // 全局快捷键监听
    window.addEventListener('keydown', (e) => {
        const searchInput = document.getElementById('searchInput');
        // 一键聚焦搜索框 ( / 键 )
        if (e.key === '/' && document.activeElement !== searchInput && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
            e.preventDefault();
            searchInput.focus();
        }
        // 一键清空并退出搜索 ( Esc 键 )
        if (e.key === 'Escape' && document.activeElement === searchInput) {
            searchInput.value = '';
            searchInput.blur();
        }
    });

    // 回到顶部悬浮按钮
    const newsListEl = document.getElementById('newsList');
    const bttBtn = document.getElementById('backToTop');
    newsListEl.addEventListener('scroll', () => {
        if (newsListEl.scrollTop > 300) { bttBtn.classList.remove('opacity-0', 'pointer-events-none'); bttBtn.classList.add('opacity-100'); }
        else { bttBtn.classList.add('opacity-0', 'pointer-events-none'); bttBtn.classList.remove('opacity-100'); }
    });
    // onclick="scrollToTop()" 内联引用，挂到 window
    window.scrollToTop = function scrollToTop() { newsListEl.scrollTo({ top: 0, behavior: 'smooth' }); };

    // 侧边栏拖拽拉伸
    const aside = document.querySelector('aside');
    const resizer = document.getElementById('resizer');
    let isResizing = false;

    // 初始化加载宽度
    function clampNewsPanelWidth(value) {
        const width = Number.parseInt(value, 10);
        if (!Number.isFinite(width)) return null;
        const min = 350;
        const max = Math.floor(window.innerWidth * 0.6);
        return Math.min(Math.max(width, min), max);
    }

    const savedWidth = safeStorageGet('newsPanelWidth');
    if (savedWidth && window.innerWidth >= 768) {
        const restoredWidth = clampNewsPanelWidth(savedWidth);
        if (restoredWidth) aside.style.width = `${restoredWidth}px`;
    }

    resizer.addEventListener('mousedown', () => { if (window.innerWidth < 768) return; isResizing = true; document.body.style.cursor = 'ew-resize'; aside.classList.add('select-none'); });
    resizer.addEventListener('touchstart', (e) => { if (window.innerWidth < 768) return; isResizing = true; aside.classList.add('select-none'); }, { passive: true });
    window.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const newWidth = window.innerWidth - e.clientX;
        if (newWidth >= 350 && newWidth <= window.innerWidth * 0.6) {
            aside.style.width = `${newWidth}px`;
        }
    });
    window.addEventListener('touchmove', (e) => {
        if (!isResizing) return;
        const touch = e.touches[0];
        const newWidth = window.innerWidth - touch.clientX;
        if (newWidth >= 350 && newWidth <= window.innerWidth * 0.6) {
            aside.style.width = `${newWidth}px`;
        }
    }, { passive: true });
    window.addEventListener('mouseup', () => {
        if (isResizing) {
            safeStorageSet('newsPanelWidth', aside.offsetWidth);
        }
        isResizing = false;
        document.body.style.cursor = 'default';
        aside.classList.remove('select-none');
    });
    window.addEventListener('touchend', () => {
        if (isResizing) {
            safeStorageSet('newsPanelWidth', aside.offsetWidth);
        }
        isResizing = false;
        aside.classList.remove('select-none');
    });

    // 玻璃折射：仅在浏览器支持 url() backdrop-filter、非省电模式、且非窄屏时启用
    (function enableGlassRefraction() {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const wide = window.innerWidth >= 768;
        const supported = (window.CSS && CSS.supports &&
            (CSS.supports('backdrop-filter', 'url(#glassDisplace)') ||
             CSS.supports('-webkit-backdrop-filter', 'url(#glassDisplace)')));
        if (supported && !reduce && wide) {
            document.documentElement.classList.add('glass-refract');
        }
    })();

    // 指针视差 3D 倾斜：玻璃面板随光标做小角度立体翻转（桌面 + 非省电才启用）
    (function enableTilt() {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduce || window.innerWidth < 768) return;
        const els = Array.from(document.querySelectorAll('[data-tilt]'));
        els.forEach(el => {
            const max = parseFloat(el.dataset.tilt) || 5;
            let raf = null;
            el.addEventListener('pointermove', (e) => {
                const r = el.getBoundingClientRect();
                const px = (e.clientX - r.left) / r.width - 0.5;   // -0.5 ~ 0.5
                const py = (e.clientY - r.top) / r.height - 0.5;
                if (raf) cancelAnimationFrame(raf);
                raf = requestAnimationFrame(() => {
                    el.classList.add('tilting');
                    // 光标在右→绕 Y 正转；在下→绕 X 负转，符合实体板直觉
                    el.style.transform =
                        `rotateX(${(-py * max).toFixed(2)}deg) rotateY(${(px * max).toFixed(2)}deg)`;
                });
            });
            el.addEventListener('pointerleave', () => {
                if (raf) cancelAnimationFrame(raf);
                el.classList.remove('tilting');
                el.style.transform = '';
            });
        });
    })();
}
