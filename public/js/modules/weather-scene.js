import {
    createSnowpack,
    depositSnow,
    disturbSnowpack,
    findSnowSegments,
    particleBudget,
    relaxSnowpack,
    snowHeightAt,
    splashDroplets,
    stepSnowWave,
} from './weather-physics.js?v=workspace-20261122b';

export function createWeatherScene(canvas) {
    const ctx = canvas.getContext('2d');
    let width = 0, height = 0, type = null, heavy = false;
    let particles = [], splashes = [], rings = [], puffs = [], clumps = [], bounds = [];
    let frame = null, lastFrame = 0, elapsed = 0, fade = 0, dirty = true, lastMeasure = 0;
    let packs = new Map();
    const pointer = { x: -1000, y: -1000, prevX: -1000, prevY: -1000, vx: 0, vy: 0, down: false, time: 0 };

    function resize() {
        width = document.documentElement.clientWidth;
        height = window.innerHeight;
        const ratio = Math.min(1.5, window.devicePixelRatio || 1);
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        dirty = true;
        if (type) adjustPopulation();
    }

    function measure() {
        const next = [];
        for (const id of ['search-bar', 'news-panel', 'bottom-ticker']) {
            const el = document.getElementById(id);
            if (!el || !el.getClientRects().length) continue;
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden') continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0 || r.top < 0 || r.top >= height) continue;
            const radius = Math.min(parseFloat(style.borderTopLeftRadius) || 0, r.width / 2, r.height / 2);
            next.push({
                id,
                left: r.left,
                right: r.right,
                top: r.top,
                bottom: r.bottom,
                height: r.height,
                radius,
                width: r.width,
                snowGradient: null,
            });
        }
        next.push({
            id: 'floor',
            left: 0,
            right: width,
            top: height - 2,
            bottom: height,
            height: 2,
            radius: 0,
            width,
            snowGradient: null,
        });
        bounds = next.sort((a, b) => a.top - b.top);
        for (const bound of bounds) {
            const old = packs.get(bound.id);
            if (!old || Math.abs(old.width - bound.width) > 1) packs.set(bound.id, createSnowpack(bound.width, old));
            bound.pack = packs.get(bound.id);
        }
        dirty = false;
        lastMeasure = elapsed;
    }

    function baseSurfaceY(bound, x) {
        const local = x - bound.left;
        const r = bound.radius;
        const corner = local < r ? r - local : local > bound.width - r ? local - (bound.width - r) : 0;
        return bound.top + (corner ? r - Math.sqrt(Math.max(0, r * r - corner * corner)) : 0);
    }

    function surface(bound, x) {
        const local = x - bound.left;
        return baseSurfaceY(bound, x) - (type === 'snow' ? snowHeightAt(bound.pack, local) : 0);
    }

    function spawn(seed = false) {
        const near = Math.random();
        let x = Math.random() * width;
        let y = seed ? Math.random() * height : -24 - Math.random() * 80;
        if (seed && type === 'snow' && bounds.length) {
            for (let tries = 0; tries < 4; tries++) {
                const insideObstacle = bounds.some(b =>
                    b.id !== 'floor' && x > b.left && x < b.right && y > b.top && y < b.bottom
                );
                if (!insideObstacle) break;
                x = Math.random() * width;
                y = Math.random() * height;
            }
        }
        return {
            x,
            y,
            near,
            speed: type === 'snow' ? 20 + near * 34 : 420 + near * 290,
            len: 9 + near * 10,
            radius: type === 'snow' ? 0.85 + near * 2.55 : 0.9 + near * 2.2,
            alpha: type === 'snow' ? 0.28 + near * 0.62 : 0.17 + near * 0.19,
            lineWidth: 1 + near * 0.65,
            phase: Math.random() * Math.PI * 2,
            swayFreq: 0.65 + Math.random() * 0.75,
            swayAmp: 7 + near * 9,
            glintSeed: Math.random() * 100,
        };
    }

    function adjustPopulation() {
        const count = particleBudget(type, width, height, heavy);
        while (particles.length < count) particles.push(spawn(true));
        particles.length = count;
        canvas.dataset.particles = String(count);
    }

    function pushDislodgedClumps(bound, result) {
        if (!result?.clumps?.length) return;
        for (const c of result.clumps) {
            if (clumps.length < 120) {
                const wx = bound.left + c.localX;
                const wy = baseSurfaceY(bound, wx) + c.offsetY;
                clumps.push({
                    x: wx,
                    y: wy,
                    vx: c.vx,
                    vy: c.vy,
                    radius: c.radius,
                    alpha: 0.78 + Math.random() * 0.2,
                    sourceId: bound.id,
                    life: 0,
                    maxLife: 3.2,
                });
            }
            if (puffs.length < 48 && Math.random() < 0.6) {
                const wx = bound.left + c.localX;
                puffs.push({
                    x: wx + (Math.random() - 0.5) * 6,
                    y: baseSurfaceY(bound, wx) + c.offsetY,
                    vx: c.vx * 0.35 + (Math.random() - 0.5) * 28,
                    vy: c.vy * 0.35 - 8 - Math.random() * 18,
                    radius: 0.65 + Math.random() * 0.95,
                    life: 0,
                    maxLife: 0.36 + Math.random() * 0.22,
                });
            }
        }
    }

    function impact(p, bound, y) {
        if (type === 'snow') {
            // Obstacles catch snow readily so soft snowbanks visibly grow on search bar & news panel.
            const scale = bound.id === 'floor' ? 0.55 : 0.95;
            depositSnow(bound.pack, p.x - bound.left, p.radius, bound.radius, scale);
            if (p.near > 0.42 && puffs.length < 48) {
                for (let i = 0; i < 2; i++) {
                    puffs.push({
                        x: p.x + (Math.random() - 0.5) * 4,
                        y: y - 0.5,
                        vx: (Math.random() - 0.5) * 16,
                        vy: -8 - Math.random() * 14,
                        radius: 0.55 + Math.random() * 0.8,
                        life: 0,
                        maxLife: 0.28 + Math.random() * 0.18,
                    });
                }
            }
        } else {
            if (splashes.length < 150) splashes.push(...splashDroplets(p.x, y));
            if (rings.length < 30) rings.push({ x: p.x, y, life: 0 });
        }
        Object.assign(p, spawn());
    }

    function windVelocity() {
        return type === 'snow'
            ? (Math.sin(elapsed * 0.21) + 0.5 * Math.sin(elapsed * 0.47)) * (heavy ? 18 : 11)
            : Math.sin(elapsed * 0.3) * 5;
    }

    function updateParticle(p, dt, wind) {
        const previous = p.y;
        p.y += p.speed * dt;
        if (type === 'snow') {
            p.x += (wind * (0.45 + p.near * 0.55) + Math.sin(elapsed * p.swayFreq + p.phase) * p.swayAmp) * dt;
        } else {
            p.x += wind * dt;
        }
        if (elapsed - pointer.time < 0.7) {
            const dx = p.x - pointer.x, dy = p.y - pointer.y, distance = Math.hypot(dx, dy);
            if (distance > 1 && distance < 95) {
                const swirl = (1 - distance / 95);
                p.x += (dx / distance * (type === 'snow' ? 28 : 5) + pointer.vx * (type === 'snow' ? 0.16 : 0)) * swirl * dt;
                if (type === 'snow') p.y += pointer.vy * 0.08 * swirl * dt;
            }
        }
        for (const bound of bounds) {
            if (p.x <= bound.left || p.x >= bound.right) continue;
            const y = surface(bound, p.x);
            if (previous < y && p.y >= y) { impact(p, bound, y); return; }
        }
        if (p.y > height + 30 || p.x < -40 || p.x > width + 40) Object.assign(p, spawn());
    }

    function updateClumps(dt, wind) {
        const active = [];
        for (const c of clumps) {
            c.life += dt;
            if (c.life >= c.maxLife) continue;
            const prevY = c.y;
            c.vy += 210 * dt;
            c.vx = c.vx * Math.exp(-1.9 * dt) + wind * 0.35 * dt;
            c.x += c.vx * dt;
            c.y += c.vy * dt;

            let landed = false;
            for (const bound of bounds) {
                if (bound.id === c.sourceId) continue;
                if (c.x <= bound.left || c.x >= bound.right) continue;
                const y = surface(bound, c.x);
                if (prevY <= y + 2 && c.y >= y) {
                    depositSnow(bound.pack, c.x - bound.left, c.radius * 0.9, bound.radius, bound.id === 'floor' ? 0.45 : 0.7);
                    landed = true;
                    break;
                }
            }
            if (landed || c.y > height + 20 || c.x < -30 || c.x > width + 30) continue;
            active.push(c);
        }
        clumps = active;
    }

    function drawParticle(p) {
        if (type === 'snow') {
            if (p.near > 0.72) {
                ctx.fillStyle = `rgba(225,240,255,${(p.alpha * 0.24).toFixed(3)})`;
                ctx.beginPath(); ctx.arc(p.x, p.y, p.radius * 2.05, 0, Math.PI * 2); ctx.fill();
            }
            ctx.fillStyle = `rgba(246,250,255,${p.alpha.toFixed(3)})`;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2); ctx.fill();
        } else {
            ctx.strokeStyle = `rgba(204,227,249,${(p.alpha * 0.85).toFixed(3)})`;
            ctx.lineWidth = p.lineWidth; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(p.x - 0.7, p.y - p.len); ctx.lineTo(p.x, p.y); ctx.stroke();
        }
    }

    function drawClumps() {
        for (const c of clumps) {
            const fadeOut = Math.max(0, 1 - c.life / c.maxLife);
            ctx.fillStyle = `rgba(245,250,255,${(c.alpha * fadeOut).toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function traceSmoothCrest(xs, ys, count) {
        ctx.moveTo(xs[0], ys[0]);
        for (let i = 1; i < count - 1; i++) {
            const mx = (xs[i] + xs[i + 1]) * 0.5;
            const my = (ys[i] + ys[i + 1]) * 0.5;
            ctx.quadraticCurveTo(xs[i], ys[i], mx, my);
        }
        ctx.lineTo(xs[count - 1], ys[count - 1]);
    }

    function traceSmoothBaseReverse(xs, ys, count) {
        if (count <= 2) {
            for (let i = count - 1; i >= 0; i--) ctx.lineTo(xs[i], ys[i]);
            return;
        }
        ctx.lineTo(xs[count - 1], ys[count - 1]);
        for (let i = count - 2; i >= 1; i--) {
            const mx = (xs[i] + xs[i - 1]) * 0.5;
            const my = (ys[i] + ys[i - 1]) * 0.5;
            ctx.quadraticCurveTo(xs[i], ys[i], mx, my);
        }
        ctx.lineTo(xs[0], ys[0]);
    }

    function horizontalFadeStroke(startX, endX, colorBase, peakAlpha, lineWidth) {
        const span = Math.max(1, endX - startX);
        const feather = Math.min(0.24, 14 / span);
        const grad = ctx.createLinearGradient(startX, 0, endX, 0);
        grad.addColorStop(0, `rgba(${colorBase},0)`);
        grad.addColorStop(feather, `rgba(${colorBase},${peakAlpha.toFixed(3)})`);
        grad.addColorStop(1 - feather, `rgba(${colorBase},${peakAlpha.toFixed(3)})`);
        grad.addColorStop(1, `rgba(${colorBase},0)`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
    }

    function drawSnow(dt, wind) {
        for (const bound of bounds) {
            relaxSnowpack(bound.pack, dt, bound.radius, heavy ? 0.001 : 0.0025);
            stepSnowWave(bound.pack, dt);
            const depth = bound.pack.depth;
            const offset = bound.pack.offset;
            const segments = findSnowSegments(depth, 0.08);
            if (!segments.length) continue;

            const totalSamples = depth.length;
            if (!bound.snowGradient) {
                const gradient = ctx.createLinearGradient(0, bound.top - 18, 0, bound.top + 5);
                gradient.addColorStop(0, 'rgba(255,255,255,0.98)');
                gradient.addColorStop(0.55, 'rgba(232,243,253,0.92)');
                gradient.addColorStop(1, 'rgba(186,210,235,0.78)');
                bound.snowGradient = gradient;
            }

            for (const seg of segments) {
                const count = seg.end - seg.start + 1;
                if (count < 2) continue;

                const xs = new Float32Array(count);
                const topYs = new Float32Array(count);
                const botYs = new Float32Array(count);
                for (let j = 0; j < count; j++) {
                    const idx = seg.start + j;
                    const local = (idx / (totalSamples - 1)) * bound.width;
                    const x = bound.left + local;
                    const by = baseSurfaceY(bound, x);
                    const h = depth[idx] <= 0.08 ? 0 : depth[idx];
                    const waveY = h > 0 && offset ? offset[idx] : 0;
                    // Thick drifts overhang slightly over the obstacle's top glass lip.
                    const overhang = bound.id !== 'floor' && h > 2.2 ? Math.min(2.4, (h - 2.2) * 0.22) : 0;
                    xs[j] = x;
                    botYs[j] = by + overhang;
                    topYs[j] = by - Math.max(0, h - waveY);
                }

                const patchAlpha = Math.min(1, seg.maxDepth / 1.2);
                ctx.save();
                ctx.globalAlpha = fade * patchAlpha;

                ctx.beginPath();
                traceSmoothCrest(xs, topYs, count);
                traceSmoothBaseReverse(xs, botYs, count);
                ctx.closePath();
                ctx.fillStyle = bound.snowGradient;
                ctx.fill();

                const rimAlpha = Math.min(0.8, (seg.maxDepth / 3.0) * 0.8);
                if (rimAlpha > 0.04) {
                    ctx.beginPath();
                    traceSmoothCrest(xs, topYs, count);
                    horizontalFadeStroke(xs[0], xs[count - 1], '255,255,255', rimAlpha, 1.05);
                }

                const shadowAlpha = Math.min(0.22, (seg.maxDepth / 3.6) * 0.22);
                if (shadowAlpha > 0.02) {
                    ctx.beginPath();
                    traceSmoothCrest(xs, botYs, count);
                    horizontalFadeStroke(xs[0], xs[count - 1], '12,32,58', shadowAlpha, 1.5);
                }

                for (let j = 1; j < count - 1; j += 3) {
                    const d = depth[seg.start + j];
                    if (d <= 3.0) continue;
                    const shimmer = Math.sin(elapsed * 2.1 + (seg.start + j) * 2.37 + bound.top * 0.13);
                    if (shimmer > 0.94) {
                        const alpha = ((shimmer - 0.94) / 0.06) * 0.72;
                        ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
                        ctx.beginPath();
                        ctx.arc(xs[j], topYs[j] + Math.min(2.2, d * 0.3), 1.1, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }

                ctx.restore();
            }
        }

        updateClumps(dt, wind);
        drawClumps();

        puffs = puffs.filter(p => p.life < p.maxLife);
        for (const p of puffs) {
            p.life += dt;
            p.vy += 42 * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            const alpha = 0.55 * Math.max(0, 1 - p.life / p.maxLife);
            ctx.fillStyle = `rgba(244,249,255,${alpha.toFixed(3)})`;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2); ctx.fill();
        }
    }

    function drawSplashes(dt) {
        splashes = splashes.filter(p => p.life < p.maxLife);
        for (const p of splashes) {
            p.life += dt;
            p.vy += 320 * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            ctx.fillStyle = `rgba(213,236,252,${0.65 * Math.max(0, 1 - p.life / p.maxLife)})`;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2); ctx.fill();
        }
        rings = rings.filter(p => p.life < 0.4);
        for (const p of rings) {
            p.life += dt;
            ctx.strokeStyle = `rgba(211,234,250,${0.28 * Math.max(0, 1 - p.life / 0.4)})`;
            ctx.lineWidth = 0.7;
            ctx.beginPath(); ctx.ellipse(p.x, p.y, 1 + p.life * 15, 0.5 + p.life * 3, 0, 0, Math.PI * 2); ctx.stroke();
        }
    }

    function animate(now) {
        frame = null;
        if (!type || document.hidden) return;
        const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 1 / 60;
        lastFrame = now;
        elapsed += dt;
        fade = Math.min(1, fade + dt * 1.3);
        if (dirty || elapsed - lastMeasure > 1) measure();
        ctx.clearRect(0, 0, width, height);
        ctx.globalAlpha = fade;
        const wind = windVelocity();
        for (const p of particles) { updateParticle(p, dt, wind); drawParticle(p); }
        if (type === 'snow') drawSnow(dt, wind);
        else drawSplashes(dt);
        ctx.globalAlpha = 1;
        frame = requestAnimationFrame(animate);
    }

    function pause() {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        lastFrame = 0;
    }

    function resume() {
        if (type && !document.hidden && frame === null) frame = requestAnimationFrame(animate);
    }

    function set(next, options = {}) {
        const changed = next !== type;
        pause();
        type = next;
        heavy = Boolean(options.heavy);
        canvas.dataset.weather = type || 'none';
        if (changed || !type) {
            particles = [];
            splashes = [];
            rings = [];
            puffs = [];
            clumps = [];
            packs = new Map();
            fade = 0;
            ctx.clearRect(0, 0, width, height);
        }
        dirty = true;
        if (type) { adjustPopulation(); resume(); }
        canvas.dataset.particles = String(particles.length);
    }

    function interactSnowAt(x, y, vx, vy, { down = false, shakeOnly = false } = {}) {
        if (type !== 'snow' || document.hidden) return;
        for (const bound of bounds) {
            if (bound.id === 'floor') continue;
            if (x < bound.left - 24 || x > bound.right + 24) continue;
            if (y < bound.top - 34 || y > bound.top + 26) continue;
            const result = disturbSnowpack(bound.pack, x - bound.left, vx, vy, {
                radius: down ? 44 : 32,
                strength: down ? 1.45 : 0.85,
                shakeOnly,
            });
            pushDislodgedClumps(bound, result);
        }
    }

    window.addEventListener('resize', resize);
    window.addEventListener('scroll', () => { dirty = true; }, true);
    window.addEventListener('gx:panel-layout', () => {
        dirty = true;
        if (type === 'snow' && document.documentElement.classList.contains('panel-dragging')) {
            const newsBound = bounds.find(b => b.id === 'news-panel');
            if (newsBound?.pack) {
                const res = disturbSnowpack(newsBound.pack, newsBound.width * 0.5, 0, 60, {
                    radius: newsBound.width * 0.55,
                    strength: 0.75,
                    shakeOnly: true,
                });
                pushDislodgedClumps(newsBound, res);
            }
        }
    });
    window.addEventListener('gx:layout-changed', () => { dirty = true; });

    window.addEventListener('pointerdown', event => {
        pointer.down = true;
        pointer.prevX = pointer.x = event.clientX;
        pointer.prevY = pointer.y = event.clientY;
        pointer.time = elapsed;
        interactSnowAt(event.clientX, event.clientY, 0, -140, { down: true, shakeOnly: true });
    }, { passive: true });
    window.addEventListener('pointerup', () => { pointer.down = false; }, { passive: true });
    window.addEventListener('pointercancel', () => { pointer.down = false; }, { passive: true });
    window.addEventListener('pointermove', event => {
        const dt = Math.max(0.008, elapsed - pointer.time);
        const firstMove = pointer.x < -500;
        const dx = firstMove ? 0 : event.clientX - pointer.x;
        const dy = firstMove ? 0 : event.clientY - pointer.y;
        pointer.prevX = firstMove ? event.clientX : pointer.x;
        pointer.prevY = firstMove ? event.clientY : pointer.y;
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        pointer.vx = Math.max(-1400, Math.min(1400, dx / dt));
        pointer.vy = Math.max(-1400, Math.min(1400, dy / dt));
        pointer.time = elapsed;
        if (Math.hypot(dx, dy) > 1.5) {
            interactSnowAt(event.clientX, event.clientY, pointer.vx, pointer.vy, { down: pointer.down });
        }
    }, { passive: true });

    resize();
    return { set, pause, resume };
}
