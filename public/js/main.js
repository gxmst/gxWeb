// ================== 应用入口 ==================
// 模块加载与启动顺序在此集中控制，替代旧的单文件内联 <script>。
//
// 旧 index.html 里每段脚本是「顶层自启动」的（定义完即执行 fetch/setInterval）。
// 拆分后各模块只导出一个 initXxx()，副作用收敛进去，由本文件按正确顺序调用——
// 这样 DOM、跨模块的 window.__* 钩子的就绪时序可控，不再依赖脚本书写顺序的巧合。
//
// 关键顺序约束：
//   1. initAmbience() 必须在 initWeather() 之前——它定义 window.__setAmbiance 钩子，
//      天气引擎切换氛围时会调用它（否则首帧 ambiance 落空，要等下次校准）。
//   2. HTML 内联 onclick 所需的全局函数（toggleWallpaper / setSearchEngine /
//      handleSearch / setFontSize / setFilter / scrollToTop / scrollTicker /
//      toggleWeatherFilter）由各模块在自身文件内 `window.xxx = xxx` 暴露。

import { initUI } from './modules/ui.js';
import { initAmbience } from './modules/ambience.js';
import { initFluid } from './modules/fluid.js';
import { initWallpapers } from './modules/wallpaper.js';
import { initWeather } from './modules/weather.js';
import { initTicker } from './modules/ticker.js';
import { initNews } from './modules/news.js';
import { initInteractions } from './modules/interactions.js';

function init() {
    initUI();           // 时钟 / 搜索引擎（依赖 storage）
    initAmbience();     // 视觉增强 + 暴露 __setAmbiance/__animateNumber/__drawInSparkline，须早于 weather
    initFluid();        // WebGL 流体涟漪壁纸（暴露 __fluidSetWallpaper），须早于 wallpaper 首次取色
    initWallpapers();   // 壁纸引擎 + 取色（异步拉取壁纸列表）
    initWeather();      // 天气粒子物理引擎（首拉 weather.txt + 轮询）
    initTicker();       // 底部行情条 + 心跳状态（首拉 + 轮询）
    initNews();         // 新闻流：setFilter('all') + 首拉 + 轮询 + resize 重对齐指示器
    initInteractions(); // 快捷键、回到顶部、resizer 拖拽、玻璃折射、3D 倾斜
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
