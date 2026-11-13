// Particle budgets and snow depth use CSS pixels and elapsed seconds.
export function particleBudget(type,width,height,heavy=false) {
    const mobile=width<768;
    const area=width*height;
    const count=type==='snow'
        ? Math.max(mobile?20:40,Math.min(mobile?55:150,Math.round(area/15000)))
        : Math.max(mobile?10:20,Math.min(mobile?24:65,Math.round(area/32000)));
    return Math.round(count*(heavy?1.35:1));
}

export function createSnowpack(width,previous=null) {
    const depth=new Float32Array(Math.max(16,Math.min(256,Math.ceil(width/8)+1)));
    const pack={width,depth};
    if(previous) for(let i=0;i<depth.length;i++) depth[i]=snowHeightAt(previous,i/(depth.length-1)*previous.width);
    return pack;
}

export function snowHeightAt(pack,x) {
    const position=Math.max(0,Math.min(pack.depth.length-1,x/Math.max(1,pack.width)*(pack.depth.length-1)));
    const low=Math.floor(position),high=Math.min(pack.depth.length-1,low+1);
    return pack.depth[low]+(pack.depth[high]-pack.depth[low])*(position-low);
}

export function depositSnow(pack, x, radius, cornerRadius = 0) {
    const spread = 12 + radius * 3;
    const taper = Math.max(12, cornerRadius * 0.9);
    for (let i = 0; i < pack.depth.length; i++) {
        const local = i / (pack.depth.length - 1) * pack.width;
        const distance = Math.abs(local - x);
        if (distance > spread) continue;
        const edge = Math.min(1, local / taper, (pack.width - local) / taper);
        const amount = (0.9 + radius * 0.22) * Math.exp(-3 * (distance / spread) ** 2) * Math.max(0, edge);
        pack.depth[i] = Math.min(18, pack.depth[i] + amount);
    }
}

export function relaxSnowpack(pack, dt, cornerRadius = 0, meltRate = 0.06) {
    const depth = pack?.depth;
    const length = depth?.length || 0;
    if (!length || dt <= 0) return;
    if (!pack._scratch || pack._scratch.length !== length) {
        pack._scratch = new Float32Array(length);
    }
    const next = pack._scratch;
    const blend = Math.min(0.2, dt * 1.8);
    const melt = Math.max(0, meltRate) * dt;
    const taper = Math.max(12, cornerRadius * 0.9);

    next[0] = Math.max(0, depth[0] * 0.85 - melt);
    next[length - 1] = Math.max(0, depth[length - 1] * 0.85 - melt);
    for (let i = 1; i < length - 1; i++) {
        const local = i / (length - 1) * pack.width;
        const edge = Math.max(0, Math.min(1, local / taper, (pack.width - local) / taper));
        const neighborAvg = 0.25 * depth[i - 1] + 0.5 * depth[i] + 0.25 * depth[i + 1];
        const smoothed = depth[i] + (neighborAvg - depth[i]) * blend - melt;
        const maxAtX = 18 * Math.max(0.15, edge);
        next[i] = Math.max(0, Math.min(maxAtX, smoothed));
    }
    depth.set(next);
}

export function splashDroplets(x,y,random=Math.random) {
    return Array.from({length:5},(_,index)=>({x,y,vx:(index-2)*22+(random()-0.5)*18,vy:-45-random()*70,life:0,maxLife:0.35+random()*0.2,radius:0.7+random()*0.65}));
}
