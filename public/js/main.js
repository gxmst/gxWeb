// ================== 应用入口 ==================
// 模块加载与启动顺序在此集中控制，替代旧的单文件内联 <script>。
//
// 旧 index.html 里每段脚本是「顶层自启动」的（定义完即执行 fetch/setInterval）。
// 拆分后各模块只导出一个 initXxx()，副作用收敛进去，由本文件按正确顺序调用——
// 这样 DOM、跨模块的 window.__* 钩子的就绪时序可控，不再依赖脚本书写顺序的巧合。
//
// 关键顺序约束：
//   1. initSettings() 先应用本地偏好；initAmbience() 必须在 initWeather() 之前——它定义 window.__setAmbiance 钩子，
//      天气引擎切换氛围时会调用它（否则首帧 ambiance 落空，要等下次校准）。
//   2. 所有控件事件由各模块在 initXxx() 内绑定，不依赖内联处理器或额外全局函数。

import { initUI } from './modules/ui.js?v=polish-20260720a';
import { initAmbience } from './modules/ambience.js?v=polish-20260720a';
import { initFluid } from './modules/fluid.js?v=polish-20260720a';
import { initWallpapers } from './modules/wallpaper.js?v=polish-20260720a';
import { initWeather } from './modules/weather.js?v=polish-20260720a';
import { initTicker } from './modules/ticker.js?v=polish-20260720a';
import { initNews } from './modules/news.js?v=polish-20260720a';
import { initInteractions } from './modules/interactions.js?v=polish-20260720a';
import { initStatus } from './modules/status.js?v=polish-20260720a';
import { initSettings } from './modules/settings.js?v=polish-20260720a';

// 只有完整模块图加载成功后才隐藏待进场元素；脚本被禁用或模块加载失败时，
// 页面内容保持可见，避免核心界面永久停在 opacity: 0。
document.documentElement.classList.add('js-motion');

function reportInitFailure(name, error) {
    console.error(`[app] ${name} 初始化失败:`, error);
    if (name === 'ambience') document.documentElement.classList.remove('js-motion');
}

function runInitializer(name, initializer) {
    try {
        const result = initializer();
        if (result && typeof result.catch === 'function') {
            result.catch(error => reportInitFailure(name, error));
        }
    } catch (error) {
        reportInitFailure(name, error);
    }
}

function init() {
    // 单个模块失败不会阻断其余功能；顺序仍满足 ambience/fluid 的桥接约束。
    runInitializer('ui', initUI);
    runInitializer('settings', initSettings);
    runInitializer('ambience', initAmbience);
    runInitializer('fluid', initFluid);
    runInitializer('wallpapers', initWallpapers);
    runInitializer('weather', initWeather);
    runInitializer('status', initStatus);
    runInitializer('ticker', initTicker);
    runInitializer('news', initNews);
    runInitializer('interactions', initInteractions);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
