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

export function depositSnow(pack,x,radius) {
    const spread=12+radius*3;
    for(let i=0;i<pack.depth.length;i++) {
        const local=i/(pack.depth.length-1)*pack.width;
        const distance=Math.abs(local-x);
        if(distance>spread) continue;
        const edge=Math.min(1,local/12,(pack.width-local)/12);
        const amount=(0.9+radius*0.22)*Math.exp(-3*(distance/spread)**2)*Math.max(0,edge);
        pack.depth[i]=Math.min(18,pack.depth[i]+amount);
    }
}

export function splashDroplets(x,y,random=Math.random) {
    return Array.from({length:5},(_,index)=>({x,y,vx:(index-2)*22+(random()-0.5)*18,vy:-45-random()*70,life:0,maxLife:0.35+random()*0.2,radius:0.7+random()*0.65}));
}
