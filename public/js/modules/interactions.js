// ================== 辅助交互与快捷键 ==================
import { getSettings, updateSettings } from './settings-store.js';

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
    const aside = document.querySelector('aside');
    const updateBackToTop = () => {
        const mobile = window.innerWidth < 768;
        const progress = mobile ? window.scrollY - aside.offsetTop : newsListEl.scrollTop;
        const visible = progress > 300;
        bttBtn.classList.toggle('opacity-0', !visible);
        bttBtn.classList.toggle('pointer-events-none', !visible);
        bttBtn.classList.toggle('opacity-100', visible);
        bttBtn.disabled = !visible;
        bttBtn.setAttribute('aria-hidden', String(!visible));
    };
    newsListEl.addEventListener('scroll', updateBackToTop, { passive: true });
    window.addEventListener('scroll', updateBackToTop, { passive: true });
    window.addEventListener('resize', updateBackToTop);
    bttBtn.addEventListener('click', () => {
        if (window.innerWidth < 768) window.scrollTo({ top: aside.offsetTop, behavior: 'smooth' });
        else newsListEl.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // 侧边栏拖拽拉伸
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

    function applySavedPanelWidth(settings = getSettings()) {
        if (window.innerWidth < 768) {
            aside.style.width = '';
            return;
        }
        const restoredWidth = clampNewsPanelWidth(settings.layout.newsPanelWidth);
        aside.style.width = restoredWidth ? `${restoredWidth}px` : '';
    }

    applySavedPanelWidth();

    // 双击恢复默认宽度；键盘左右箭头微调（手柄在面板左缘：左=加宽，右=收窄）
    resizer.addEventListener('dblclick', () => {
        aside.style.width = '';
        updateSettings('layout', { newsPanelWidth: null });
    });
    resizer.addEventListener('keydown', (e) => {
        if (window.innerWidth < 768 || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        e.preventDefault();
        const next = clampNewsPanelWidth(aside.offsetWidth + (e.key === 'ArrowLeft' ? 24 : -24));
        if (next) {
            aside.style.width = `${next}px`;
            updateSettings('layout', { newsPanelWidth: next });
        }
    });

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
            updateSettings('layout', { newsPanelWidth: aside.offsetWidth });
        }
        isResizing = false;
        document.body.style.cursor = 'default';
        aside.classList.remove('select-none');
    });
    window.addEventListener('touchend', () => {
        if (isResizing) {
            updateSettings('layout', { newsPanelWidth: aside.offsetWidth });
        }
        isResizing = false;
        aside.classList.remove('select-none');
    });

    // 玻璃折射：仅在浏览器支持 url() backdrop-filter、非省电模式、且非窄屏时启用
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const glassSupported = Boolean(window.CSS && CSS.supports &&
            (CSS.supports('backdrop-filter', 'url(#glassDisplace)') ||
             CSS.supports('-webkit-backdrop-filter', 'url(#glassDisplace)')));

    function syncGlassRefraction(settings = getSettings()) {
        const enabled = glassSupported && !motionPreference.matches &&
            window.innerWidth >= 768 && settings.appearance.glassRefraction && !settings.appearance.powerSaving;
        document.documentElement.classList.toggle('glass-refract', enabled);
    }

    syncGlassRefraction();

    // 指针视差 3D 倾斜：玻璃面板随光标做小角度立体翻转（桌面 + 非省电才启用）
    const tiltElements = Array.from(document.querySelectorAll('[data-tilt]'));
    const tiltFrames = new WeakMap();

    function canTilt() {
        const appearance = getSettings().appearance;
        return appearance.tilt && !appearance.powerSaving &&
            !motionPreference.matches && window.innerWidth >= 768;
    }

    function clearTilt() {
        tiltElements.forEach(el => {
            const frame = tiltFrames.get(el);
            if (frame) cancelAnimationFrame(frame);
            tiltFrames.delete(el);
            el.classList.remove('tilting');
            el.style.transform = '';
        });
    }

    tiltElements.forEach(el => {
            const max = parseFloat(el.dataset.tilt) || 5;
            el.addEventListener('pointermove', (e) => {
                if (!canTilt()) return;
                const r = el.getBoundingClientRect();
                const px = (e.clientX - r.left) / r.width - 0.5;   // -0.5 ~ 0.5
                const py = (e.clientY - r.top) / r.height - 0.5;
                const previousFrame = tiltFrames.get(el);
                if (previousFrame) cancelAnimationFrame(previousFrame);
                tiltFrames.set(el, requestAnimationFrame(() => {
                    el.classList.add('tilting');
                    // 光标在右→绕 Y 正转；在下→绕 X 负转，符合实体板直觉
                    el.style.transform =
                        `rotateX(${(-py * max).toFixed(2)}deg) rotateY(${(px * max).toFixed(2)}deg)`;
                    tiltFrames.delete(el);
                }));
            });
            el.addEventListener('pointerleave', () => {
                const frame = tiltFrames.get(el);
                if (frame) cancelAnimationFrame(frame);
                tiltFrames.delete(el);
                el.classList.remove('tilting');
                el.style.transform = '';
            });
    });

    const syncEffects = (settings = getSettings()) => {
        syncGlassRefraction(settings);
        if (!canTilt()) clearTilt();
    };
    window.addEventListener('resize', () => {
        applySavedPanelWidth();
        syncEffects();
    });
    window.addEventListener('gx:settings-changed', event => {
        const section = event.detail?.section;
        const settings = event.detail?.settings || getSettings();
        if (section === 'layout' || section === 'all') applySavedPanelWidth(settings);
        if (section === 'appearance' || section === 'all') syncEffects(settings);
    });
    const handleMotionPreference = () => syncEffects();
    if (typeof motionPreference.addEventListener === 'function') {
        motionPreference.addEventListener('change', handleMotionPreference);
    } else if (typeof motionPreference.addListener === 'function') {
        motionPreference.addListener(handleMotionPreference);
    }
}
