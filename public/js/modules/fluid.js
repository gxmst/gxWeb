// ================== WebGL 流体涟漪壁纸 ==================
// 在壁纸图层之上叠一块 WebGL canvas（z-[3]，氛围光/遮罩之下），采样当前壁纸做
// UV 折射位移：鼠标划过注入扩散+衰减的同心波，像水面被轻轻搅动。
//
// 设计取舍：
//   - 不接管壁纸的「选择/切换/取色」——那仍由 wallpaper.js 的 bgImage1/2 负责。
//     本模块只通过 window.__fluidSetWallpaper(img) 拿到当前壁纸当纹理。
//   - 单 pass fragment shader + 鼠标轨迹涟漪（最多 MAX_RIPPLES 个），
//     不跑 ping-pong heightfield 流体模拟——省 GPU、够自然、不抢眼。
//   - 优雅降级：WebGL 不可用 / prefers-reduced-motion / 窄屏 → 永不显示，
//     壁纸 img 照常露出。window.__fluidSetWallpaper 始终存在（降级时是 noop）。
//
// 切换壁纸时用双纹理 + mix 因子做交叉淡入，匹配原 img opacity 过渡观感。

const MAX_RIPPLES = 12;        // shader 同时累加的涟漪数（环形复用）
const DPR_CAP = 1.5;           // 高 DPR 屏限制采样分辨率，避免烫显卡
const RIPPLE_MIN_DIST = 28;    // 鼠标移动超过该像素距离才注入新涟漪（节流）
const RIPPLE_MIN_INTERVAL = 40; // 或时间间隔（ms）
const RIPPLE_LIFETIME = 2.2;   // 单个涟漪存活秒数（与 shader 里的 age 上限一致）

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// 片元着色器：cover 映射壁纸纹理 + 缓慢 noise 呼吸 + 鼠标涟漪位移 + 极淡高光。
const FRAG_SRC = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uTex0;      // 旧壁纸
uniform sampler2D uTex1;      // 新壁纸
uniform float uMix;           // 0→1 交叉淡入
uniform vec2 uRes;            // 画布像素尺寸
uniform vec2 uTex0Res;        // 旧壁纸原始像素尺寸
uniform vec2 uTex1Res;        // 新壁纸原始像素尺寸
uniform float uTime;          // 秒
uniform vec4 uRipples[${MAX_RIPPLES}]; // xy=归一化位置(0-1), z=起始时间, w=强度

// cover 映射：把 uv(0-1, 左下原点) 映射到按 background-size:cover 裁剪的纹理坐标。
vec2 coverUv(vec2 uv, vec2 res, vec2 texRes) {
    if (texRes.x < 1.0 || texRes.y < 1.0) return uv;
    float scale = max(res.x / texRes.x, res.y / texRes.y);
    vec2 scaled = texRes * scale;
    vec2 offset = (scaled - res) * 0.5;
    vec2 px = uv * res;
    return (px + offset) / scaled;
}

// 轻量 value noise，给画面一层几乎察觉不到的「水面呼吸」流动。
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
    vec2 uv = vUv;
    // y 轴翻转：WebGL 纹理原点在左下，图片在左上。
    vec2 texUv = vec2(uv.x, 1.0 - uv.y);

    float aspect = uRes.x / uRes.y;
    vec2 disp = vec2(0.0);
    float highlight = 0.0;

    // ---- 鼠标涟漪：每个涟漪一圈随时间扩散、衰减的位移环 ----
    for (int i = 0; i < ${MAX_RIPPLES}; i++) {
        vec4 rp = uRipples[i];
        float strength = rp.w;
        if (strength <= 0.0) continue;
        float age = uTime - rp.z;
        if (age < 0.0 || age > 2.2) continue;
        // 按宽高比校正，让涟漪是正圆而非椭圆。
        vec2 d = uv - rp.xy;
        d.x *= aspect;
        float dist = length(d);
        float radius = age * 0.42;               // 波前扩散速度
        float ring = dist - radius;
        float env = exp(-age * 1.4) * exp(-dist * 2.6) * strength; // 时间+空间双衰减
        float wave = sin(ring * 34.0) * env;
        if (dist > 0.0001) {
            disp += (d / dist) * wave * 0.020;   // 沿径向位移（克制但可见：2%）
        }
        highlight += wave * 0.16;
    }

    vec2 c0 = coverUv(texUv + disp, uRes, uTex0Res);
    vec2 c1 = coverUv(texUv + disp, uRes, uTex1Res);
    vec4 col0 = texture2D(uTex0, c0);
    vec4 col1 = texture2D(uTex1, c1);
    vec4 color = mix(col0, col1, clamp(uMix, 0.0, 1.0));

    // 涟漪波峰处加一点点高光、波谷压暗，模拟水面起伏的反光。
    color.rgb += highlight;
    gl_FragColor = vec4(color.rgb, 1.0);
}
`;

let gl = null;
let canvas = null;
let program = null;
let uniforms = {};
let texSlots = [null, null];        // [旧, 新] WebGLTexture
let texRes = [[1, 1], [1, 1]];      // 对应原始像素尺寸
let mixFactor = 1;                  // 当前交叉淡入进度
let mixTarget = 1;
let ripples = [];                   // {x, y, t, strength}（y 已转为 0=底 1=顶）
let rippleCursor = 0;
let startTime = 0;
let rafId = null;
let running = false;               // 渲染循环是否在转——独立于 rafId，作为唯一真相来源。
                                   // 不能用 rafId 兼任：若某帧抛异常，rafId 会停在旧值上，
                                   // kick() 误判"还在转"而永不重启（旧 bug：动一下就再也不动）。
let enabled = false;
let lastInjectX = -1, lastInjectY = -1, lastInjectT = 0;
let pendingFirstTexture = true;
let lastWallpaperImg = null;       // 上下文丢失后恢复时，重新上传这张壁纸。

function compileShader(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn('[fluid] shader 编译失败:', gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
    }
    return sh;
}

function buildProgram() {
    const vs = compileShader(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return false;
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.warn('[fluid] program 链接失败:', gl.getProgramInfoLog(program));
        return false;
    }
    gl.useProgram(program);

    // 全屏三角形（两个三角形覆盖 NDC）
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1,
    ]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    uniforms = {
        tex0: gl.getUniformLocation(program, 'uTex0'),
        tex1: gl.getUniformLocation(program, 'uTex1'),
        mix: gl.getUniformLocation(program, 'uMix'),
        res: gl.getUniformLocation(program, 'uRes'),
        tex0Res: gl.getUniformLocation(program, 'uTex0Res'),
        tex1Res: gl.getUniformLocation(program, 'uTex1Res'),
        time: gl.getUniformLocation(program, 'uTime'),
        ripples: gl.getUniformLocation(program, 'uRipples'),
    };
    return true;
}

function makeTexture() {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // 1x1 占位，避免首帧采样未初始化纹理。
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
}

function resize() {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
}

// 把壁纸 img 上传为新纹理，旧的留在 slot0 做交叉淡入。
function setWallpaper(img) {
    if (!enabled || !img || !img.complete || img.naturalWidth === 0) return;
    try {
        // 旧的「新纹理」降级为「旧纹理」
        if (texSlots[1]) {
            // 删掉真正过期的 slot0，把 slot1 移到 slot0
            if (texSlots[0]) gl.deleteTexture(texSlots[0]);
            texSlots[0] = texSlots[1];
            texRes[0] = texRes[1];
        }
        const tex = makeTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        texSlots[1] = tex;
        texRes[1] = [img.naturalWidth, img.naturalHeight];
        if (!texSlots[0]) {           // 首张：两槽相同，无淡入
            texSlots[0] = makeTexture();
            gl.bindTexture(gl.TEXTURE_2D, texSlots[0]);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            texRes[0] = [img.naturalWidth, img.naturalHeight];
            mixFactor = 1; mixTarget = 1;
        } else {
            mixFactor = 0; mixTarget = 1; // 触发交叉淡入
        }
        if (pendingFirstTexture) {
            pendingFirstTexture = false;
            canvas.style.opacity = '1';   // 首张纹理就绪后淡入接管
        }
        kick(); // 首张纹理 / 切壁纸交叉淡入：重新点燃循环（mixFactor<1 时会持续到淡入结束）
    } catch (e) {
        console.warn('[fluid] 上传壁纸纹理失败:', e);
    }
}

function injectRipple(clientX, clientY, strength) {
    const now = performance.now();
    const dx = clientX - lastInjectX;
    const dy = clientY - lastInjectY;
    if (lastInjectX >= 0 &&
        dx * dx + dy * dy < RIPPLE_MIN_DIST * RIPPLE_MIN_DIST &&
        now - lastInjectT < RIPPLE_MIN_INTERVAL) return;
    lastInjectX = clientX; lastInjectY = clientY; lastInjectT = now;

    ripples[rippleCursor] = {
        x: clientX / window.innerWidth,
        y: 1 - clientY / window.innerHeight,  // 翻成 0=底 1=顶，与 vUv 一致
        t: (now - startTime) / 1000,
        strength: strength,
    };
    rippleCursor = (rippleCursor + 1) % MAX_RIPPLES;
    kick(); // 有新涟漪：确保渲染循环在转
}

// 是否还有"活的"动画：未过期的涟漪，或进行中的交叉淡入。
// 都没有时画面是完全静止的，可以停掉 RAF，让 GPU 彻底空闲、
// 也让上方玻璃的 backdrop-filter 能被浏览器缓存住（弱设备的关键）。
function hasLiveAnimation() {
    if (mixFactor < mixTarget) return true;
    const t = (performance.now() - startTime) / 1000;
    for (let i = 0; i < MAX_RIPPLES; i++) {
        const r = ripples[i];
        if (r && r.strength > 0 && t - r.t >= 0 && t - r.t <= RIPPLE_LIFETIME) return true;
    }
    return false;
}

// 重新点燃渲染循环（若已停）。injectRipple / setWallpaper / contextrestored 调用。
// 关键：用独立的 running 标志判断"循环是否在转"，不再复用 rafId——
// 旧版若某帧抛异常，rafId 会停在旧句柄上、永远非空，kick() 误以为还在转而永久卡死
//（表现就是"第一次有一点点、之后鼠标再动也没反应，必须刷新"）。
function kick() {
    if (!enabled || running) return;
    running = true;
    rafId = requestAnimationFrame(render);
}

function drawFrame() {
    const t = (performance.now() - startTime) / 1000;

    if (mixFactor < mixTarget) {
        mixFactor = Math.min(mixTarget, mixFactor + 0.02); // ~0.8s 淡入
    }

    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texSlots[0]);
    gl.uniform1i(uniforms.tex0, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texSlots[1]);
    gl.uniform1i(uniforms.tex1, 1);
    gl.uniform1f(uniforms.mix, mixFactor);
    gl.uniform2f(uniforms.res, canvas.width, canvas.height);
    gl.uniform2f(uniforms.tex0Res, texRes[0][0], texRes[0][1]);
    gl.uniform2f(uniforms.tex1Res, texRes[1][0], texRes[1][1]);
    gl.uniform1f(uniforms.time, t);

    // 打包涟漪 uniform 数组
    const arr = new Float32Array(MAX_RIPPLES * 4);
    for (let i = 0; i < MAX_RIPPLES; i++) {
        const r = ripples[i];
        if (r) {
            arr[i * 4] = r.x;
            arr[i * 4 + 1] = r.y;
            arr[i * 4 + 2] = r.t;
            arr[i * 4 + 3] = r.strength;
        }
    }
    gl.uniform4fv(uniforms.ripples, arr);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

// 自停渲染循环：每帧画完后检查是否还有活动画，没有就停（画最后一帧定格），
// 等下次 kick() 再启动。静止时 0 GPU 占用——这是弱设备能扛住 A+B 叠加的核心。
// 任何一帧抛异常都必须复位 running（否则循环死了但 kick 以为还活着→永久卡死）。
function render() {
    try {
        drawFrame();
    } catch (e) {
        console.warn('[fluid] 渲染帧异常，停止循环（下次交互会重试）:', e);
        running = false;
        rafId = null;
        return;
    }
    if (hasLiveAnimation()) {
        rafId = requestAnimationFrame(render);
    } else {
        running = false; // 定格在最后一帧，停止占用
        rafId = null;
    }
}

export function initFluid() {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // 窄屏（手机）不值得跑 WebGL，且降级到原 img 体验已足够。
    const wide = window.innerWidth >= 768;

    // 钩子始终存在：降级时是 noop，wallpaper.js 无脑调用即可。
    window.__fluidSetWallpaper = () => {};

    if (reduce || !wide) return;

    canvas = document.getElementById('fluidCanvas');
    if (!canvas) return;

    gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false })
        || canvas.getContext('experimental-webgl', { alpha: false });
    if (!gl) { console.warn('[fluid] WebGL 不可用，降级到静态壁纸'); return; }

    if (!buildProgram()) { gl = null; return; }

    texSlots[0] = null;
    texSlots[1] = null;
    resize();

    // 上下文丢失：停渲染并降级（canvas 透明，底下静态壁纸 img 露出）。
    // 必须复位 running，否则恢复后 kick() 以为循环还在转而拒绝重启。
    canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
        running = false;
        canvas.style.opacity = '0';
    });

    // 上下文恢复：重建 program / uniform，丢弃旧纹理句柄（已随上下文失效），
    // 等下一次 setWallpaper 重新上传。没有这段，弱 GPU 偶发丢上下文后 fluid 永久死亡。
    canvas.addEventListener('webglcontextrestored', () => {
        if (!buildProgram()) { gl = null; enabled = false; return; }
        texSlots[0] = null;
        texSlots[1] = null;
        texRes = [[1, 1], [1, 1]];
        pendingFirstTexture = true;
        resize();
        // 重新把当前壁纸交给 fluid：选当前可见（opacity≈1）的那张 bg 图。
        const b1 = document.getElementById('bgImage1');
        const b2 = document.getElementById('bgImage2');
        const visible = (b2 && b2.style.opacity === '1') ? b2 : b1;
        if (visible && visible.complete && visible.naturalWidth > 0) setWallpaper(visible);
    });

    enabled = true;
    startTime = performance.now();

    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') return; // 触屏不注入，避免与滚动冲突
        // 速度越快涟漪越强（但封顶），静止微动几乎无涟漪。
        const speed = Math.hypot(e.movementX || 0, e.movementY || 0);
        const strength = Math.min(1, 0.25 + speed * 0.02);
        injectRipple(e.clientX, e.clientY, strength);
    }, { passive: true });

    // 真正的桥接钩子
    window.__fluidSetWallpaper = setWallpaper;

    render();
}
