import { particleBudget, createSnowpack, depositSnow, relaxSnowpack, snowHeightAt, splashDroplets } from './weather-physics.js?v=workspace-20261114c';

export function createWeatherScene(canvas) {
    const ctx = canvas.getContext('2d');
    let width = 0, height = 0, type = null, heavy = false;
    let particles = [], splashes = [], rings = [], puffs = [], bounds = [];
    let frame = null, lastFrame = 0, elapsed = 0, fade = 0, dirty = true, lastMeasure = 0;
    let packs = new Map();
    const pointer = { x: -1000, y: -1000, time: 0 };

    function resize() {
        width=document.documentElement.clientWidth;height=window.innerHeight;
        const ratio=Math.min(1.5,window.devicePixelRatio||1);
        canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
        canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;
        ctx.setTransform(ratio,0,0,ratio,0,0);
        dirty=true;
        if(type) adjustPopulation();
    }
    function measure() {
        const next=[];
        for(const id of ['search-bar','news-panel','bottom-ticker']) {
            const el=document.getElementById(id);
            if(!el || !el.getClientRects().length) continue;
            const style=getComputedStyle(el);
            if(style.visibility==='hidden') continue;
            const r=el.getBoundingClientRect();
            if(r.width<=0 || r.height<=0 || r.top<0 || r.top>=height) continue;
            const radius=Math.min(parseFloat(style.borderTopLeftRadius)||0,r.width/2,r.height/2);
            next.push({id,left:r.left,right:r.right,top:r.top,radius,width:r.width,snowGradient:null});
        }
        next.push({id:'floor',left:0,right:width,top:height-2,radius:0,width,snowGradient:null});
        bounds=next.sort((a,b)=>a.top-b.top);
        for(const bound of bounds) {
            const old=packs.get(bound.id);
            if(!old || Math.abs(old.width-bound.width)>1) packs.set(bound.id,createSnowpack(bound.width,old));
            bound.pack=packs.get(bound.id);
        }
        dirty=false;lastMeasure=elapsed;
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
        return {
            x: Math.random() * width,
            y: seed ? Math.random() * height : -24 - Math.random() * 80,
            near,
            speed: type === 'snow' ? 16 + near * 34 : 420 + near * 290,
            len: 9 + near * 10,
            radius: type === 'snow' ? 0.75 + near * 2.55 : 0.9 + near * 2.2,
            alpha: type === 'snow' ? 0.24 + near * 0.62 : 0.17 + near * 0.19,
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
    function impact(p, bound, y) {
        if (type === 'snow') {
            depositSnow(bound.pack, p.x - bound.left, p.radius, bound.radius);
            if (p.near > 0.35 && puffs.length < 48) {
                for (let i = 0; i < 2; i++) {
                    puffs.push({
                        x: p.x + (Math.random() - 0.5) * 4,
                        y: y - 0.5,
                        vx: (Math.random() - 0.5) * 20,
                        vy: -10 - Math.random() * 16,
                        radius: 0.6 + Math.random() * 0.9,
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
            if (distance > 1 && distance < 90) {
                p.x += dx / distance * (1 - distance / 90) * (type === 'snow' ? 24 : 5) * dt;
            }
        }
        for (const bound of bounds) {
            if (p.x <= bound.left || p.x >= bound.right) continue;
            const y = surface(bound, p.x);
            if (previous < y && p.y >= y) { impact(p, bound, y); return; }
        }
        if (p.y > height + 30 || p.x < -40 || p.x > width + 40) Object.assign(p, spawn());
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
    function traceSmoothCrest(xs, topYs, count) {
        ctx.moveTo(xs[0], topYs[0]);
        for (let i = 1; i < count - 1; i++) {
            const mx = (xs[i] + xs[i + 1]) * 0.5;
            const my = (topYs[i] + topYs[i + 1]) * 0.5;
            ctx.quadraticCurveTo(xs[i], topYs[i], mx, my);
        }
        ctx.lineTo(xs[count - 1], topYs[count - 1]);
    }
    function drawSnow(dt) {
        for (const bound of bounds) {
            relaxSnowpack(bound.pack, dt, bound.radius, heavy ? 0.035 : 0.06);
            if (!bound.pack.depth.some(depth => depth > 0.15)) continue;
            const samples = bound.pack.depth.length;
            const xs = new Float32Array(samples);
            const topYs = new Float32Array(samples);
            const botYs = new Float32Array(samples);
            for (let i = 0; i < samples; i++) {
                const local = i / (samples - 1) * bound.width;
                const x = bound.left + local;
                const by = baseSurfaceY(bound, x);
                xs[i] = x;
                botYs[i] = by;
                topYs[i] = by - snowHeightAt(bound.pack, local);
            }

            ctx.beginPath();
            traceSmoothCrest(xs, topYs, samples);
            for (let i = samples - 1; i >= 0; i--) ctx.lineTo(xs[i], botYs[i]);
            ctx.closePath();

            if (!bound.snowGradient) {
                const gradient = ctx.createLinearGradient(0, bound.top - 18, 0, bound.top + 4);
                gradient.addColorStop(0, 'rgba(255,255,255,0.99)');
                gradient.addColorStop(0.55, 'rgba(232,243,253,0.90)');
                gradient.addColorStop(1, 'rgba(190,213,236,0.72)');
                bound.snowGradient = gradient;
            }
            ctx.fillStyle = bound.snowGradient;
            ctx.fill();

            ctx.beginPath();
            traceSmoothCrest(xs, topYs, samples);
            ctx.strokeStyle = 'rgba(255,255,255,0.82)';
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(xs[0], botYs[0]);
            for (let i = 1; i < samples; i++) ctx.lineTo(xs[i], botYs[i]);
            ctx.strokeStyle = 'rgba(12,32,58,0.18)';
            ctx.lineWidth = 1.4;
            ctx.stroke();

            for (let i = 2; i < samples - 2; i += 3) {
                if (bound.pack.depth[i] <= 3.5) continue;
                const shimmer = Math.sin(elapsed * 2.1 + i * 2.37 + bound.top * 0.13);
                if (shimmer > 0.94) {
                    const alpha = (shimmer - 0.94) / 0.06 * 0.75;
                    ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
                    ctx.beginPath();
                    ctx.arc(xs[i], topYs[i] + Math.min(2.2, bound.pack.depth[i] * 0.3), 1.15, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }
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
        splashes=splashes.filter(p=>p.life<p.maxLife);
        for(const p of splashes) {
            p.life+=dt;p.vy+=320*dt;p.x+=p.vx*dt;p.y+=p.vy*dt;
            ctx.fillStyle=`rgba(213,236,252,${0.65*Math.max(0,1-p.life/p.maxLife)})`;
            ctx.beginPath();ctx.arc(p.x,p.y,p.radius,0,Math.PI*2);ctx.fill();
        }
        rings=rings.filter(p=>p.life<0.4);
        for(const p of rings) {
            p.life+=dt;ctx.strokeStyle=`rgba(211,234,250,${0.28*Math.max(0,1-p.life/0.4)})`;ctx.lineWidth=0.7;
            ctx.beginPath();ctx.ellipse(p.x,p.y,1+p.life*15,0.5+p.life*3,0,0,Math.PI*2);ctx.stroke();
        }
    }
    function animate(now) {
        frame=null;
        if(!type || document.hidden)return;
        const dt=lastFrame?Math.min(0.05,(now-lastFrame)/1000):1/60;
        lastFrame=now;elapsed+=dt;fade=Math.min(1,fade+dt*1.3);
        if(dirty || elapsed-lastMeasure>1)measure();
        ctx.clearRect(0,0,width,height);ctx.globalAlpha=fade;
        const wind=windVelocity();
        for(const p of particles){updateParticle(p,dt,wind);drawParticle(p);}
        if(type==='snow')drawSnow(dt);else drawSplashes(dt);
        ctx.globalAlpha=1;
        frame=requestAnimationFrame(animate);
    }
    function pause(){if(frame!==null)cancelAnimationFrame(frame);frame=null;lastFrame=0;}
    function resume(){if(type && !document.hidden && frame===null)frame=requestAnimationFrame(animate);}
    function set(next,options={}) {
        const changed=next!==type;
        pause();type=next;heavy=Boolean(options.heavy);
        canvas.dataset.weather=type||'none';
        if(changed || !type){particles=[];splashes=[];rings=[];puffs=[];packs=new Map();fade=0;ctx.clearRect(0,0,width,height);}
        dirty=true;
        if(type){adjustPopulation();resume();}
        canvas.dataset.particles=String(particles.length);
    }
    window.addEventListener('resize',resize);
    window.addEventListener('scroll',()=>{dirty=true;},true);
    window.addEventListener('gx:panel-layout',()=>{dirty=true;});
    window.addEventListener('gx:layout-changed',()=>{dirty=true;});
    window.addEventListener('pointermove',event=>{pointer.x=event.clientX;pointer.y=event.clientY;pointer.time=elapsed;},{passive:true});
    resize();
    return {set,pause,resume};
}
