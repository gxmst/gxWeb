// ================== 辅助交互与快捷键 ==================
import { getSettings, getEffectiveAppearance, isWidgetVisible } from './settings-store.js';
import { initNewsPanel } from './news-panel.js';

// 左上角控制按钮的点击反馈：加一次性 .tapped，动画结束自己摘掉。
// 用 pointerdown 而不是 click——手指/鼠标一按下就有反应，比等 click 更"跟手"；
// 同一次交互里重复触发时先强制重排，否则同名动画不会重新播放。
function bindControlTapFeedback() {
    document.querySelectorAll('.control-btn').forEach(button => {
        button.addEventListener('pointerdown', () => {
            if (button.disabled) return;
            button.classList.remove('tapped');
            void button.offsetWidth;
            button.classList.add('tapped');
        });
        button.addEventListener('animationend', event => {
            if (event.target === button) button.classList.remove('tapped');
        });
    });

    // 收藏成功那一下额外来个心跳；由 wallpaper.js 切换 is-favorite 后广播
    const favoriteButton = document.getElementById('favoriteBtn');
    window.addEventListener('gx:wallpaper-favorites', event => {
        if (!favoriteButton) return;
        const nowFavorite = favoriteButton.classList.contains('is-favorite');
        if (!nowFavorite || !event.detail?.justAdded) return;
        favoriteButton.classList.remove('just-favorited');
        void favoriteButton.offsetWidth;
        favoriteButton.classList.add('just-favorited');
    });
    favoriteButton?.addEventListener('animationend', event => {
        if (event.target === favoriteButton.querySelector('svg')) {
            favoriteButton.classList.remove('just-favorited');
        }
    });
}

export function initInteractions() {
    bindControlTapFeedback();

    // 全局快捷键监听
    window.addEventListener('keydown', (e) => {
        const searchInput = document.getElementById('searchInput');
        // 一键聚焦搜索框 ( / 键 )
        if (e.key === '/' && isWidgetVisible('search') && document.activeElement !== searchInput && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
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
        const mobile = window.innerWidth < 768 && !document.documentElement.classList.contains('news-panel-full');
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
        if (window.innerWidth < 768 && !document.documentElement.classList.contains('news-panel-full')) window.scrollTo({ top: aside.offsetTop, behavior: 'smooth' });
        else newsListEl.scrollTo({ top: 0, behavior: 'smooth' });
    });

    initNewsPanel();

    // 玻璃折射：仅在浏览器支持 url() backdrop-filter、非省电模式、且非窄屏时启用
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const glassSupported = Boolean(window.CSS && CSS.supports &&
            (CSS.supports('backdrop-filter', 'url(#glassDisplace)') ||
             CSS.supports('-webkit-backdrop-filter', 'url(#glassDisplace)')));

    function syncGlassRefraction(settings = getSettings()) {
        const enabled = glassSupported && !motionPreference.matches &&
            window.innerWidth >= 768 && getEffectiveAppearance().glassRefraction && !getEffectiveAppearance().powerSaving;
        document.documentElement.classList.toggle('glass-refract', enabled);
    }

    syncGlassRefraction();

    // 指针视差 3D 倾斜：玻璃面板随光标做小角度立体翻转（桌面 + 非省电才启用）
    const tiltElements = Array.from(document.querySelectorAll('[data-tilt]'));
    const tiltFrames = new WeakMap();

    function canTilt() {
        const appearance = getEffectiveAppearance();
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
        syncEffects();
    });
    window.addEventListener('gx:settings-changed', event => {
        const section = event.detail?.section;
        const settings = event.detail?.settings || getSettings();
        if (section === 'appearance' || section === 'widgets' || section === 'all') syncEffects(settings);
    });
    const handleMotionPreference = () => syncEffects();
    if (typeof motionPreference.addEventListener === 'function') {
        motionPreference.addEventListener('change', handleMotionPreference);
    } else if (typeof motionPreference.addListener === 'function') {
        motionPreference.addListener(handleMotionPreference);
    }
}
