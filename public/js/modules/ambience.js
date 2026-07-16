import { getSettings } from './settings-store.js';

// ================== 视觉增强：进场 / 光斑 / 磁吸 / 时段 / 雷暴 / 星空 / 数字滚动 ==================
// 暴露给其它模块的钩子：window.__setAmbiance / __animateNumber / __drawInSparkline

export function initAmbience() {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let powerSaving = getSettings().appearance.powerSaving;

    // ---- 进场错峰动画：逐个触发 .entered ----
    const enterEls = Array.from(document.querySelectorAll('[data-enter]'));
    if (reduceMotion) {
        enterEls.forEach(el => { el.style.opacity = '1'; });
    } else {
        requestAnimationFrame(() => {
            enterEls.forEach(el => el.classList.add('entered'));
        });
    }

    // ---- 玻璃面板鼠标光斑：跟随指针的柔光 ----
    const spotEls = Array.from(document.querySelectorAll('.glass-spot'));
    spotEls.forEach(el => {
        el.addEventListener('pointermove', (e) => {
            if (powerSaving) return;
            const r = el.getBoundingClientRect();
            el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
            el.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
            el.style.setProperty('--spot', '1');
        });
        el.addEventListener('pointerleave', () => el.style.setProperty('--spot', '0'));
    });

    // ---- Dock 图标磁吸放大：靠近指针的图标按距离放大 ----
    const dockRow = document.getElementById('dockRow');
    if (dockRow && !reduceMotion) {
        const MAX = 1.32, RANGE = 110; // 最大放大倍率 / 影响半径(px)
        dockRow.addEventListener('pointermove', (e) => {
            if (powerSaving) return;
            dockRow.querySelectorAll('.dock-ico').forEach(ico => {
                const r = ico.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const d = Math.abs(e.clientX - cx);
                const f = Math.max(0, 1 - d / RANGE);
                const scale = 1 + (MAX - 1) * f;
                ico.style.transform = `scale(${scale.toFixed(3)})`;
            });
        });
        dockRow.addEventListener('pointerleave', () => {
            dockRow.querySelectorAll('.dock-ico').forEach(ico => { ico.style.transform = ''; });
        });
    }

    // ---- 时段自适应色调：很淡的 soft-light 叠色，夜晚偏冷 ----
    const timeTint = document.getElementById('timeTint');
    const starCanvas = document.getElementById('starCanvas');
    function applyTimeTint() {
        if (!timeTint) return;
        const h = new Date().getHours();
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
        document.body.dataset.daypart = (h >= 20 || h < 5) ? 'night' : 'day';
        refreshStarVisibility();
    }

    // ---- 雷暴闪电：仅雨模式下偶发泛光 ----
    const lightning = document.getElementById('lightningFlash');
    let lightningTimer = null;
    function scheduleLightning() {
        if (!lightning) return;
        const amb = window.__weatherAmbiance;
        const isStorm = amb === 'storm';
        // 雷暴：5~12s 一次、更亮、偶发双闪；普通雨：18~48s 一次、柔和
        const delay = isStorm ? (5000 + Math.random() * 7000) : (18000 + Math.random() * 30000);
        lightningTimer = setTimeout(() => {
            const a = window.__weatherAmbiance;
            if ((a === 'rain' || a === 'storm') && !reduceMotion && !powerSaving) {
                const strong = a === 'storm';
                lightning.classList.toggle('strong', strong);
                lightning.classList.remove('flash');
                void lightning.offsetWidth; // 重排以重启动画
                lightning.classList.add('flash');
                // 雷暴偶发双闪：首闪后 120~260ms 再补一道
                if (strong && Math.random() < 0.4) {
                    setTimeout(() => {
                        if (window.__weatherAmbiance !== 'storm') return;
                        lightning.classList.remove('flash');
                        void lightning.offsetWidth;
                        lightning.classList.add('flash');
                    }, 120 + Math.random() * 140);
                }
            }
            scheduleLightning();
        }, delay);
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
        const hideFor = ['rain', 'storm', 'snow', 'fog'];
        const show = isNight && !reduceMotion && !powerSaving && !hideFor.includes(ambiance);
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
        // 雷暴与普通雨都跑闪电调度（内部按 storm/rain 区分频率与强度）
        if (ambiance === 'rain' || ambiance === 'storm') { if (!lightningTimer) scheduleLightning(); }
        refreshStarVisibility();
    };

    window.addEventListener('gx:settings-changed', event => {
        if (!['appearance', 'all'].includes(event.detail?.section)) return;
        powerSaving = Boolean((event.detail?.settings || getSettings()).appearance.powerSaving);
        if (powerSaving) {
            if (lightningTimer) {
                clearTimeout(lightningTimer);
                lightningTimer = null;
            }
            document.querySelectorAll('.glass-spot').forEach(el => el.style.setProperty('--spot', '0'));
            dockRow?.querySelectorAll('.dock-ico').forEach(ico => { ico.style.transform = ''; });
        } else if (window.__weatherAmbiance === 'rain' || window.__weatherAmbiance === 'storm') {
            scheduleLightning();
        }
        refreshStarVisibility();
    });

    applyTimeTint();
    setInterval(applyTimeTint, 5 * 60 * 1000); // 每 5 分钟校准一次时段

    // ---- 行情数字滚动 + sparkline 画入：作为全局工具暴露 ----
    // 数字滚动：把字符串价格里的数字部分做插值动画，保留非数字格式（货币符号/逗号）
    window.__animateNumber = function (el, toStr) {
        if (reduceMotion || powerSaving) { el.innerText = toStr; return; }
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
        if (reduceMotion || powerSaving) return;
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
