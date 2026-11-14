import { getSettings, getEffectiveAppearance } from './settings-store.js?v=workspace-20261114c';

// ================== 视觉增强：进场 / 光斑 / 磁吸 / 时段 / 雷暴 / 星空 / 数字滚动 ==================
// 暴露给其它模块的钩子：window.__setAmbiance / __animateNumber / __drawInSparkline

export function initAmbience() {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let appearance = getEffectiveAppearance();
    let powerSaving = appearance.powerSaving;

    // ---- 进场错峰动画：逐个触发 .entered，结束后清理 data-enter 避免干扰后续交互动效 ----
    const enterEls = Array.from(document.querySelectorAll('[data-enter]'));
    if (reduceMotion) {
        enterEls.forEach(el => {
            el.style.opacity = '1';
            el.removeAttribute('data-enter');
        });
    } else {
        enterEls.forEach(el => {
            el.addEventListener('animationend', event => {
                if (event.animationName === 'fadeUp') el.removeAttribute('data-enter');
            }, { once: true });
        });
        requestAnimationFrame(() => {
            enterEls.forEach(el => el.classList.add('entered'));
        });
        window.setTimeout(() => {
            enterEls.forEach(el => el.removeAttribute('data-enter'));
        }, 1600);
    }

    // ---- 玻璃面板鼠标光斑：rAF 合并指针更新并缓存容器边界，避免高频触发重排 ----
    const spotEls = Array.from(document.querySelectorAll('.glass-spot'));
    const spotState = new WeakMap();
    const invalidateSpots = () => {
        spotEls.forEach(el => {
            const state = spotState.get(el);
            if (state) state.rect = null;
        });
    };
    spotEls.forEach(el => {
        const state = { rect: null, frame: null, x: 0, y: 0 };
        spotState.set(el, state);
        el.addEventListener('pointerenter', () => {
            state.rect = el.getBoundingClientRect();
        });
        el.addEventListener('pointermove', (e) => {
            if (powerSaving || !appearance.glassGlow) return;
            state.x = e.clientX;
            state.y = e.clientY;
            if (state.frame !== null) return;
            state.frame = requestAnimationFrame(() => {
                state.frame = null;
                const r = state.rect || (state.rect = el.getBoundingClientRect());
                if (r.width <= 0 || r.height <= 0) return;
                el.style.setProperty('--mx', ((state.x - r.left) / r.width * 100).toFixed(1) + '%');
                el.style.setProperty('--my', ((state.y - r.top) / r.height * 100).toFixed(1) + '%');
                el.style.setProperty('--spot', '1');
            });
        }, { passive: true });
        el.addEventListener('pointerleave', () => {
            if (state.frame !== null) {
                cancelAnimationFrame(state.frame);
                state.frame = null;
            }
            el.style.setProperty('--spot', '0');
        });
    });

    // ---- Dock 图标磁吸放大：rAF 合批 + 缓存图标中心点 ----
    const dockRow = document.getElementById('dockRow');
    let dockCache = null;
    const invalidateGeometry = () => {
        invalidateSpots();
        dockCache = null;
    };
    window.addEventListener('resize', invalidateGeometry);
    window.addEventListener('scroll', invalidateGeometry, { passive: true });
    window.addEventListener('gx:layout-changed', invalidateGeometry);
    window.addEventListener('gx:panel-layout', invalidateGeometry);
    window.addEventListener('gx:settings-changed', event => {
        const section = event.detail?.section;
        if (section === 'shortcuts' || section === 'widgets' || section === 'all') dockCache = null;
    });

    if (dockRow && !reduceMotion) {
        const MAX = 1.32, RANGE = 110; // 最大放大倍率 / 影响半径(px)
        let dockFrame = null;
        let pointerX = 0;
        const measureDock = () => Array.from(dockRow.querySelectorAll('.dock-ico')).map(ico => {
            const r = ico.getBoundingClientRect();
            return { ico, cx: r.left + r.width / 2 };
        });
        dockRow.addEventListener('pointerenter', () => {
            dockCache = measureDock();
        });
        dockRow.addEventListener('pointermove', (e) => {
            if (powerSaving) return;
            pointerX = e.clientX;
            if (dockFrame !== null) return;
            dockFrame = requestAnimationFrame(() => {
                dockFrame = null;
                if (!dockCache) dockCache = measureDock();
                for (const item of dockCache) {
                    const d = Math.abs(pointerX - item.cx);
                    const f = Math.max(0, 1 - d / RANGE);
                    const scale = 1 + (MAX - 1) * f;
                    item.ico.style.transform = `scale(${scale.toFixed(3)})`;
                }
            });
        }, { passive: true });
        dockRow.addEventListener('pointerleave', () => {
            if (dockFrame !== null) {
                cancelAnimationFrame(dockFrame);
                dockFrame = null;
            }
            const items = dockCache || Array.from(dockRow.querySelectorAll('.dock-ico')).map(ico => ({ ico }));
            items.forEach(item => { item.ico.style.transform = ''; });
            dockCache = null;
        });
    }

    // ---- 时段自适应色调：很淡的 soft-light 叠色，夜晚偏冷 ----
    const timeTint = document.getElementById('timeTint');
    const starCanvas = document.getElementById('starCanvas');
    function applyTimeTint() {
        if (!timeTint) return;
        const h = new Date().getHours();
        document.body.dataset.daypart = (h >= 20 || h < 5) ? 'night' : 'day';
        if (!appearance.timeTint || powerSaving) {
            timeTint.style.opacity = '0';
            refreshStarVisibility();
            return;
        }
        let bg, opacity;
        if (h >= 5 && h < 9) {
            // 清晨：极淡的暖橘
            bg = 'linear-gradient(160deg, rgba(255,222,180,0.42), rgba(255,190,155,0.18))';
            opacity = '0.24';
        } else if (h >= 9 && h < 17) {
            // 白天：几乎中性，略微提亮
            bg = 'linear-gradient(160deg, rgba(255,252,240,0.32), rgba(225,240,255,0.16))';
            opacity = '0.14';
        } else if (h >= 17 && h < 20) {
            // 傍晚：保留暖色，但不把阴天再压暗
            bg = 'linear-gradient(160deg, rgba(255,202,150,0.38), rgba(180,158,210,0.18))';
            opacity = '0.24';
        } else {
            // 夜晚：冷蓝靛，但保持壁纸和玻璃的层次
            bg = 'linear-gradient(160deg, rgba(95,125,185,0.40), rgba(46,66,112,0.26))';
            opacity = '0.34';
        }
        timeTint.style.background = bg;
        timeTint.style.opacity = opacity;
        // 夜晚开启星空（仅在非雨雪氛围下由 setAmbiance 控制可见性）
        refreshStarVisibility();
    }

    // ---- 雷暴：偶发柔和泛光，普通雨不闪屏 ----
    const lightning = document.getElementById('lightningFlash');
    let lightningTimer = null;
    function scheduleLightning() {
        if (!lightning || lightningTimer || window.__weatherAmbiance !== 'storm' || document.hidden || reduceMotion || powerSaving) return;
        lightningTimer = setTimeout(() => {
            lightningTimer = null;
            if (window.__weatherAmbiance === 'storm' && !document.hidden && !reduceMotion && !powerSaving) {
                lightning.classList.add('strong');
                lightning.classList.remove('flash');
                void lightning.offsetWidth;
                lightning.classList.add('flash');
            }
            scheduleLightning();
        }, 14000 + Math.random() * 14000);
    }
    lightning && lightning.addEventListener('animationend', () => lightning.classList.remove('flash'));

    // ---- 夜晚星空：缓慢闪烁的星点 + 偶发流星 ----
    let stars = [], starAnimId = null, starCtx = null;
    let meteors = [], nextMeteorAt = 0; // 流星：晴朗夜晚偶发划过
    function initStars() {
        if (!starCanvas) return;
        starCtx = starCanvas.getContext('2d');
        starCanvas.width = window.innerWidth;
        starCanvas.height = window.innerHeight;
        const count = Math.min(140, Math.floor(window.innerWidth * window.innerHeight / 14000));
        stars = [];
        for (let i = 0; i < count; i++) {
            stars.push({
                x: Math.random() * starCanvas.width,
                y: Math.random() * starCanvas.height * 0.75, // 多集中在上方天空
                r: Math.random() * 1.1 + 0.3,
                base: Math.random() * 0.4 + 0.25,
                amp: Math.random() * 0.4 + 0.2,
                ph: Math.random() * Math.PI * 2,
                sp: Math.random() * 0.015 + 0.005
            });
        }
    }
    function spawnMeteor() {
        // 从上方偏左随机点出发，向右下方斜划（符合常见流星观感）
        const startX = Math.random() * starCanvas.width * 0.7;
        const startY = Math.random() * starCanvas.height * 0.35;
        const ang = (Math.PI / 5) + Math.random() * (Math.PI / 10); // 36°~54° 下斜
        const speed = 9 + Math.random() * 6;
        meteors.push({
            x: startX, y: startY,
            vx: Math.cos(ang) * speed,
            vy: Math.sin(ang) * speed,
            len: 90 + Math.random() * 70,   // 拖尾长度
            life: 0,
            maxLife: 60 + Math.random() * 30 // 帧数：约 1~1.5s
        });
    }
    function animateStars() {
        if (!starCtx) return;
        starCtx.clearRect(0, 0, starCanvas.width, starCanvas.height);
        for (const s of stars) {
            s.ph += s.sp;
            const a = s.base + Math.sin(s.ph) * s.amp;
            starCtx.beginPath();
            starCtx.fillStyle = `rgba(220, 232, 255, ${Math.max(0, a).toFixed(3)})`;
            starCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            starCtx.fill();
        }

        // ---- 流星：偶发生成，斜划带渐隐拖尾 ----
        const now = performance.now();
        if (nextMeteorAt === 0) nextMeteorAt = now + 8000 + Math.random() * 12000;
        if (now >= nextMeteorAt) {
            spawnMeteor();
            nextMeteorAt = now + 8000 + Math.random() * 16000; // 8~24s 一颗
        }
        for (let i = meteors.length - 1; i >= 0; i--) {
            const m = meteors[i];
            m.x += m.vx; m.y += m.vy; m.life++;
            // 头尾淡入淡出：进场 15% / 退场 30%
            const p = m.life / m.maxLife;
            let alpha = 1;
            if (p < 0.15) alpha = p / 0.15;
            else if (p > 0.7) alpha = Math.max(0, (1 - p) / 0.3);
            const tailX = m.x - m.vx / Math.hypot(m.vx, m.vy) * m.len;
            const tailY = m.y - m.vy / Math.hypot(m.vx, m.vy) * m.len;
            const grad = starCtx.createLinearGradient(m.x, m.y, tailX, tailY);
            grad.addColorStop(0, `rgba(255, 255, 255, ${(0.9 * alpha).toFixed(3)})`);
            grad.addColorStop(0.3, `rgba(215, 232, 255, ${(0.5 * alpha).toFixed(3)})`);
            grad.addColorStop(1, 'rgba(215, 232, 255, 0)');
            starCtx.strokeStyle = grad;
            starCtx.lineWidth = 1.6;
            starCtx.lineCap = 'round';
            starCtx.beginPath();
            starCtx.moveTo(m.x, m.y);
            starCtx.lineTo(tailX, tailY);
            starCtx.stroke();
            if (m.life >= m.maxLife || m.x > starCanvas.width + m.len || m.y > starCanvas.height + m.len) {
                meteors.splice(i, 1);
            }
        }
        starAnimId = requestAnimationFrame(animateStars);
    }
    function refreshStarVisibility() {
        if (!starCanvas) return;
        const isNight = document.body.dataset.daypart === 'night';
        // 雨/雪氛围下不显示星空，避免画面杂乱
        const ambiance = window.__weatherAmbiance;
        // 雨/雷暴/雪/雾 下不显示星空，避免画面杂乱
        const hideFor = ['rain', 'storm', 'snow', 'fog', 'cloudy'];
        const show = appearance.nightSky && isNight && !document.hidden && !reduceMotion && !powerSaving && !hideFor.includes(ambiance);
        if (show) {
            if (!stars.length) initStars();
            if (!starAnimId) animateStars();
            starCanvas.style.opacity = '0.9';
        } else {
            starCanvas.style.opacity = '0';
            if (starAnimId) { cancelAnimationFrame(starAnimId); starAnimId = null; }
            // 清空在途流星并重置计时，避免再次显示时残留半途流星突然出现
            meteors = [];
            nextMeteorAt = 0;
        }
    }
    window.addEventListener('resize', () => {
        if (starAnimId) { initStars(); }
    });

    // ---- 暴露给天气引擎调用的氛围切换钩子 ----
    window.__setAmbiance = function (ambiance) {
        window.__weatherAmbiance = ambiance; // 'rain' | 'storm' | 'snow' | 'sun' | 'fog' | 'cloudy' | 'none'
        const sunGlow = document.getElementById('sunGlow');
        if (sunGlow) sunGlow.classList.toggle('on', ambiance === 'sun');
        // 雾气层：仅 fog 显示；云影层：仅 cloudy 显示
        const fogLayer = document.getElementById('fogLayer');
        if (fogLayer) fogLayer.classList.toggle('on', ambiance === 'fog');
        const cloudLayer = document.getElementById('cloudLayer');
        if (cloudLayer) cloudLayer.classList.toggle('on', ambiance === 'cloudy');
        if (ambiance !== 'storm') {
            clearTimeout(lightningTimer);lightningTimer=null;
            lightning?.classList.remove('flash');
        } else scheduleLightning();
        refreshStarVisibility();
    };

    window.addEventListener('gx:settings-changed', event => {
        if (!['appearance', 'widgets', 'all'].includes(event.detail?.section)) return;
        appearance = getEffectiveAppearance();
        powerSaving = Boolean(appearance.powerSaving);
        if (powerSaving) {
            if (lightningTimer) {
                clearTimeout(lightningTimer);
                lightningTimer = null;
            }
            document.querySelectorAll('.glass-spot').forEach(el => el.style.setProperty('--spot', '0'));
            dockRow?.querySelectorAll('.dock-ico').forEach(ico => { ico.style.transform = ''; });
        } else if (window.__weatherAmbiance === 'storm') {
            scheduleLightning();
        }
        if (!appearance.glassGlow) {
            document.querySelectorAll('.glass-spot').forEach(el => el.style.setProperty('--spot', '0'));
        }
        applyTimeTint();
        refreshStarVisibility();
    });

    applyTimeTint();
    setInterval(applyTimeTint, 5 * 60 * 1000); // 每 5 分钟校准一次时段
    document.addEventListener('visibilitychange',()=>{
        document.documentElement.classList.toggle('scene-paused',document.hidden);
        if(document.hidden){clearTimeout(lightningTimer);lightningTimer=null;}
        else scheduleLightning();
        refreshStarVisibility();
    });

    // ---- 行情数字滚动 + sparkline 画入：作为全局工具暴露 ----
    // 数字滚动：把字符串价格里的数字部分做插值动画，保留非数字格式（货币符号/逗号）
    window.__animateNumber = function (el, toStr) {
        if (reduceMotion || powerSaving || !appearance.numberMotion) { el.innerText = toStr; return; }
        const fromStr = el.dataset.rawVal || '';
        const toNum = parseFloat(String(toStr).replace(/[^0-9.\-]/g, ''));
        const fromNum = parseFloat(String(fromStr).replace(/[^0-9.\-]/g, ''));
        el.dataset.rawVal = toStr;
        if (isNaN(toNum) || isNaN(fromNum) || fromNum === toNum) { el.innerText = toStr; return; }
        // 推断小数位与千分位格式
        const decimals = (String(toStr).split('.')[1] || '').replace(/[^0-9]/g, '').length;
        const hasComma = /,/.test(String(toStr));
        const prefix = (String(toStr).match(/^[^0-9.\-]+/) || [''])[0];
        const suffix = (String(toStr).match(/[^0-9.,]+$/) || [''])[0];
        const dur = 600, t0 = performance.now();
        if (el.__numRAF) cancelAnimationFrame(el.__numRAF);
        function fmt(v) {
            let s = v.toFixed(decimals);
            if (hasComma) {
                const parts = s.split('.');
                parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
                s = parts.join('.');
            }
            return prefix + s + suffix;
        }
        function step(now) {
            const p = Math.min(1, (now - t0) / dur);
            const eased = 1 - Math.pow(1 - p, 3);
            el.innerText = fmt(fromNum + (toNum - fromNum) * eased);
            if (p < 1) el.__numRAF = requestAnimationFrame(step);
            else el.innerText = toStr;
        }
        el.__numRAF = requestAnimationFrame(step);
    };

    // sparkline 画入：为新插入的折线测量长度并触发描绘动画
    window.__drawInSparkline = function (container) {
        if (reduceMotion || powerSaving || !appearance.numberMotion) return;
        const poly = container.querySelector('.sparkline-poly');
        if (!poly || typeof poly.getTotalLength !== 'function') return;
        let len = 0;
        try { len = poly.getTotalLength(); } catch { return; }
        if (!len) return;
        poly.style.setProperty('--spark-len', Math.ceil(len));
        poly.classList.remove('draw-in');
        void poly.getBoundingClientRect();
        poly.classList.add('draw-in');
    };
}
