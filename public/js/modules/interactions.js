// ================== 辅助交互与快捷键 ==================
import { getEffectiveAppearance, isWidgetVisible } from './settings-store.js?v=workspace-20261114b';
import { initNewsPanel } from './news-panel.js?v=workspace-20261114b';

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
    const getListScrollTop = () => {
        const scrollers = newsListEl.querySelectorAll('.news-split-scroll');
        if (!scrollers.length) return newsListEl.scrollTop;
        let maxTop = 0;
        scrollers.forEach(el => { if (el.scrollTop > maxTop) maxTop = el.scrollTop; });
        return maxTop;
    };
    const updateBackToTop = () => {
        const mobile = window.innerWidth < 768 && !document.documentElement.classList.contains('news-panel-full');
        const progress = mobile ? window.scrollY - aside.offsetTop : getListScrollTop();
        const visible = progress > 300;
        bttBtn.classList.toggle('opacity-0', !visible);
        bttBtn.classList.toggle('pointer-events-none', !visible);
        bttBtn.classList.toggle('opacity-100', visible);
        bttBtn.disabled = !visible;
        bttBtn.setAttribute('aria-hidden', String(!visible));
    };
    newsListEl.addEventListener('scroll', updateBackToTop, { passive: true, capture: true });
    window.addEventListener('scroll', updateBackToTop, { passive: true });
    window.addEventListener('resize', updateBackToTop);
    window.addEventListener('gx:panel-layout', updateBackToTop);
    bttBtn.addEventListener('click', () => {
        if (window.innerWidth < 768 && !document.documentElement.classList.contains('news-panel-full')) {
            window.scrollTo({ top: aside.offsetTop, behavior: 'smooth' });
        } else {
            const scrollers = newsListEl.querySelectorAll('.news-split-scroll');
            if (scrollers.length) scrollers.forEach(el => el.scrollTo({ top: 0, behavior: 'smooth' }));
            else newsListEl.scrollTo({ top: 0, behavior: 'smooth' });
        }
    });

    initNewsPanel();

    // 玻璃折射：仅在浏览器支持 url() backdrop-filter、非省电模式、且非窄屏时启用，
    // 并在关闭或页面后台时暂停 SVG SMIL <animate> 避免空耗帧率。
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const glassSupported = Boolean(window.CSS && CSS.supports &&
            (CSS.supports('backdrop-filter', 'url(#glassDisplace)') ||
             CSS.supports('-webkit-backdrop-filter', 'url(#glassDisplace)')));
    const glassDisplaceSvg = document.getElementById('glassDisplace')?.closest('svg');

    function syncGlassRefraction() {
        const appearance = getEffectiveAppearance();
        const enabled = glassSupported && !motionPreference.matches &&
            window.innerWidth >= 768 && appearance.glassRefraction && !appearance.powerSaving;
        document.documentElement.classList.toggle('glass-refract', enabled);
        if (glassDisplaceSvg) {
            if (enabled && !document.hidden) {
                if (typeof glassDisplaceSvg.unpauseAnimations === 'function') glassDisplaceSvg.unpauseAnimations();
            } else if (typeof glassDisplaceSvg.pauseAnimations === 'function') {
                glassDisplaceSvg.pauseAnimations();
            }
        }
    }

    const syncEffects = () => syncGlassRefraction();
    syncEffects();
    window.addEventListener('resize', syncEffects);
    document.addEventListener('visibilitychange', syncEffects);
    window.addEventListener('gx:settings-changed', event => {
        const section = event.detail?.section;
        if (section === 'appearance' || section === 'widgets' || section === 'all') syncEffects();
    });
    const handleMotionPreference = () => syncEffects();
    if (typeof motionPreference.addEventListener === 'function') {
        motionPreference.addEventListener('change', handleMotionPreference);
    } else if (typeof motionPreference.addListener === 'function') {
        motionPreference.addListener(handleMotionPreference);
    }
}
