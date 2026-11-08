import { particleBudget,createSnowpack,depositSnow,snowHeightAt,splashDroplets } from './weather-physics.js';

export function createWeatherScene(canvas) {
    const ctx=canvas.getContext('2d');
    let width=0,height=0,type=null,heavy=false,particles=[],splashes=[],rings=[],bounds=[];
    let frame=null,lastFrame=0,elapsed=0,fade=0,dirty=true,lastMeasure=0;
    let packs=new Map();
    const pointer={x:-1000,y:-1000,time:0};

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
            if(!el || !el.getClientRects().length || getComputedStyle(el).visibility==='hidden') continue;
            const r=el.getBoundingClientRect();
            if(r.width<=0 || r.height<=0 || r.top<0 || r.top>=height) continue;
            const radius=Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius)||0,r.width/2,r.height/2);
            next.push({id,left:r.left,right:r.right,top:r.top,radius,width:r.width});
        }
        next.push({id:'floor',left:0,right:width,top:height-2,radius:0,width});
        bounds=next.sort((a,b)=>a.top-b.top);
        for(const bound of bounds) {
            const old=packs.get(bound.id);
            if(!old || Math.abs(old.width-bound.width)>1) packs.set(bound.id,createSnowpack(bound.width,old));
            bound.pack=packs.get(bound.id);
        }
        dirty=false;lastMeasure=elapsed;
    }
    function surface(bound,x) {
        const local=x-bound.left,r=bound.radius;
        const corner=local<r?r-local:local>bound.width-r?local-(bound.width-r):0;
        const base=bound.top+(corner?r-Math.sqrt(Math.max(0,r*r-corner*corner)):0);
        return base-(type==='snow'?snowHeightAt(bound.pack,local):0);
    }
    function spawn(seed=false) {
        const near=Math.random();
        return {x:Math.random()*width,y:seed?Math.random()*height:-24-Math.random()*80,
            speed:type==='snow'?18+near*30:420+near*290,len:9+near*10,
            radius:0.9+near*2.2,alpha:type==='snow'?0.35+near*0.5:0.17+near*0.19,
            lineWidth:1+near*0.65,phase:Math.random()*Math.PI*2};
    }
    function adjustPopulation() {
        const count=particleBudget(type,width,height,heavy);
        while(particles.length<count) particles.push(spawn(true));
        particles.length=count;
        canvas.dataset.particles=String(count);
    }
    function impact(p,bound,y) {
        if(type==='snow') depositSnow(bound.pack,p.x-bound.left,p.radius);
        else {
            if(splashes.length<150) splashes.push(...splashDroplets(p.x,y));
            if(rings.length<30) rings.push({x:p.x,y,life:0});
        }
        Object.assign(p,spawn());
    }
    function updateParticle(p,dt) {
        const previous=p.y;
        p.y+=p.speed*dt;
        p.x+=type==='snow'?Math.sin(elapsed*0.7+p.phase)*9*dt:Math.sin(elapsed*0.3)*5*dt;
        if(elapsed-pointer.time<0.7) {
            const dx=p.x-pointer.x,dy=p.y-pointer.y,distance=Math.hypot(dx,dy);
            if(distance>1 && distance<90) p.x+=dx/distance*(1-distance/90)*(type==='snow'?20:5)*dt;
        }
        for(const bound of bounds) {
            if(p.x<=bound.left || p.x>=bound.right) continue;
            const y=surface(bound,p.x);
            if(previous<y && p.y>=y) {impact(p,bound,y);return;}
        }
        if(p.y>height+30 || p.x<-30 || p.x>width+30) Object.assign(p,spawn());
    }
    function drawParticle(p) {
        if(type==='snow') {
            ctx.fillStyle=`rgba(243,248,255,${p.alpha})`;
            ctx.beginPath();ctx.arc(p.x,p.y,p.radius,0,Math.PI*2);ctx.fill();
        } else {
            const gradient=ctx.createLinearGradient(p.x,p.y-p.len,p.x,p.y);
            gradient.addColorStop(0,'rgba(204,227,249,0)');gradient.addColorStop(1,`rgba(204,227,249,${p.alpha})`);
            ctx.strokeStyle=gradient;ctx.lineWidth=p.lineWidth;ctx.lineCap='round';
            ctx.beginPath();ctx.moveTo(p.x-0.7,p.y-p.len);ctx.lineTo(p.x,p.y);ctx.stroke();
        }
    }
    function drawSnow() {
        for(const bound of bounds) {
            if(!bound.pack.depth.some(depth=>depth>0.15)) continue;
            ctx.beginPath();
            const samples=bound.pack.depth.length;
            for(let i=0;i<samples;i++) {
                const x=bound.left+i/(samples-1)*bound.width;
                const y=surface(bound,x);
                if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
            }
            for(let i=samples-1;i>=0;i--) {
                const x=bound.left+i/(samples-1)*bound.width;
                ctx.lineTo(x,surface(bound,x)+snowHeightAt(bound.pack,x-bound.left));
            }
            ctx.closePath();
            const gradient=ctx.createLinearGradient(0,bound.top-18,0,bound.top+4);
            gradient.addColorStop(0,'rgba(255,255,255,0.98)');gradient.addColorStop(1,'rgba(211,228,242,0.67)');
            ctx.fillStyle=gradient;ctx.fill();
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
        for(const p of particles){updateParticle(p,dt);drawParticle(p);}
        if(type==='snow')drawSnow();else drawSplashes(dt);
        ctx.globalAlpha=1;
        frame=requestAnimationFrame(animate);
    }
    function pause(){if(frame!==null)cancelAnimationFrame(frame);frame=null;lastFrame=0;}
    function resume(){if(type && !document.hidden && frame===null)frame=requestAnimationFrame(animate);}
    function set(next,options={}) {
        const changed=next!==type;
        pause();type=next;heavy=Boolean(options.heavy);
        canvas.dataset.weather=type||'none';
        if(changed || !type){particles=[];splashes=[];rings=[];packs=new Map();fade=0;ctx.clearRect(0,0,width,height);}
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
