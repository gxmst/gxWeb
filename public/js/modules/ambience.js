// ================== 视觉增强：进场 / 光斑 / 磁吸 / 时段 / 雷暴 / 星空 / 数字滚动 ==================
// 暴露给其它模块的钩子：window.__setAmbiance / __animateNumber / __drawInSparkline

export function initAmbience() {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
        const icos = Array.from(dockRow.querySelectorAll('.dock-ico'));
        const MAX = 1.32, RANGE = 110; // 最大放大倍率 / 影响半径(px)
        dockRow.addEventListener('pointermove', (e) => {
            icos.forEach(ico => {
                const r = ico.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const d = Math.abs(e.clientX - cx);
                const f = Math.max(0, 1 - d / RANGE);
                const scale = 1 + (MAX - 1) * f;
                ico.style.transform = `scale(${scale.toFixed(3)})`;
            });
        });
        dockRow.addEventListener('pointerleave', () => {
            icos.forEach(ico => { ico.style.transform = ''; });
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
        const delay = 18000 + Math.random() * 30000; // 18~48s 一次
        lightningTimer = setTimeout(() => {
            if (window.__weatherAmbiance === 'rain' && !reduceMotion) {
                lightning.classList.remove('flash');
                void lightning.offsetWidth; // 重排以重启动画
                lightning.classList.add('flash');
            }
            scheduleLightning();
        }, delay);
    }
    lightning && lightning.addEventListener('animationend', () => lightning.classList.remove('flash'));

    // ---- 夜晚星空：缓慢闪烁的星点 ----
    let stars = [], starAnimId = null, starCtx = null;
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
        starAnimId = requestAnimationFrame(animateStars);
    }
    function refreshStarVisibility() {
        if (!starCanvas) return;
        const isNight = document.body.dataset.daypart === 'night';
        // 雨/雪氛围下不显示星空，避免画面杂乱
        const ambiance = window.__weatherAmbiance;
        const show = isNight && !reduceMotion && ambiance !== 'rain' && ambiance !== 'snow';
        if (show) {
            if (!stars.length) initStars();
            if (!starAnimId) animateStars();
            starCanvas.style.opacity = '0.9';
        } else {
            starCanvas.style.opacity = '0';
            if (starAnimId) { cancelAnimationFrame(starAnimId); starAnimId = null; }
        }
    }
    window.addEventListener('resize', () => {
        if (starAnimId) { initStars(); }
    });

    // ---- 暴露给天气引擎调用的氛围切换钩子 ----
    window.__setAmbiance = function (ambiance) {
        window.__weatherAmbiance = ambiance; // 'rain' | 'snow' | 'sun' | 'none'
        const sunGlow = document.getElementById('sunGlow');
        if (sunGlow) sunGlow.classList.toggle('on', ambiance === 'sun');
        if (ambiance === 'rain') { if (!lightningTimer) scheduleLightning(); }
        refreshStarVisibility();
    };

    applyTimeTint();
    setInterval(applyTimeTint, 5 * 60 * 1000); // 每 5 分钟校准一次时段

    // ---- 行情数字滚动 + sparkline 画入：作为全局工具暴露 ----
    // 数字滚动：把字符串价格里的数字部分做插值动画，保留非数字格式（货币符号/逗号）
    window.__animateNumber = function (el, toStr) {
        if (reduceMotion) { el.innerText = toStr; return; }
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
        if (reduceMotion) return;
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
