import { safeStorageGet, safeStorageSet } from './storage.js';

// ================== WebGL 轻量涟漪壁纸 ==================
// 在壁纸图层之上叠一块 WebGL canvas（z-[3]，氛围光/遮罩之下），采样当前壁纸做
// UV 折射位移：鼠标划过注入扩散+衰减的同心波，像水面被轻轻搅动。
//
// 设计取舍：
//   - 不接管壁纸的「选择/切换/取色」——那仍由 wallpaper.js 的 bgImage1/2 负责。
//     本模块只通过 window.__fluidSetWallpaper(img) 拿到当前壁纸当纹理。
//   - 默认关闭，用户可从控制中心开启并持久化偏好。
//   - 单 pass fragment shader + 直接跟随指针的轻微折射 + 少量轨迹涟漪，
//     不跑 ping-pong heightfield 流体模拟——省 GPU、够自然、不抢眼。
//   - 优雅降级：WebGL 不可用 / prefers-reduced-motion / 窄屏 / 雨雪动画 → 不显示，
//     壁纸 img 照常露出；关闭期间只记录最新壁纸，不创建 WebGL 上下文。
//
// 切换壁纸时用双纹理 + mix 因子做交叉淡入，匹配原 img opacity 过渡观感。

const MAX_RIPPLES = 4;          // 直接跟随由独立 uniform 负责，轨迹只保留少量余波
const DPR_CAP = 1;              // 不按高 DPR 放大全屏 shader，CSS 负责拉伸显示
const MAX_RENDER_PIXELS = 1920 * 1080;
const RIPPLE_MIN_DIST = 32;     // 轨迹需要同时满足距离与时间条件，避免密集覆盖
const RIPPLE_MIN_INTERVAL = 110;
const RIPPLE_LIFETIME = 0.9;
const FLUID_MODE_KEY = 'fluidRippleMode';
const MODE_OFF = 'off';
const MODE_LIGHT = 'light';

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
uniform vec4 uPointer;        // xy=最新指针位置, z=强度, w=是否在视口内

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
        if (age < 0.0 || age > ${RIPPLE_LIFETIME.toFixed(1)}) continue;
        // 按宽高比校正，让涟漪是正圆而非椭圆。
        vec2 d = uv - rp.xy;
        d.x *= aspect;
        float dist = length(d);
        float radius = age * 0.34;               // 轻量模式缩短余波范围
        float ring = dist - radius;
        float env = exp(-age * 2.6) * exp(-dist * 3.2) * strength; // 更快衰减
        float wave = sin(ring * 34.0) * env;
        if (dist > 0.0001) {
            disp += (d / dist) * wave * 0.010;
        }
        highlight += wave * 0.08;
    }

    // 最新指针使用独立的局部折射，不受轨迹注入频率限制，视觉上始终贴着光标。
    vec2 pointerDelta = uv - uPointer.xy;
    pointerDelta.x *= aspect;
    float pointerDist = length(pointerDelta);
    float pointerRadius = 0.105;
    if (uPointer.w > 0.5 && pointerDist > 0.0001 && pointerDist < pointerRadius) {
        float lens = pow(1.0 - pointerDist / pointerRadius, 2.0) * uPointer.z;
        disp += (pointerDelta / pointerDist) * lens * 0.006;
        highlight += lens * 0.025;
    }

    vec2 c0 = coverUv(texUv + disp, uRes, uTex0Res);
    vec2 c1 = coverUv(texUv + disp, uRes, uTex1Res);
    vec4 color;
    if (uMix >= 0.999) {
        // 绝大多数帧没有切换壁纸，只采样当前纹理，省掉一半纹理带宽。
        color = texture2D(uTex1, c1);
    } else {
        vec4 col0 = texture2D(uTex0, c0);
        vec4 col1 = texture2D(uTex1, c1);
        color = mix(col0, col1, clamp(uMix, 0.0, 1.0));
    }

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
let enabled = false;               // 当前是否允许渲染；用户偏好另由 requestedMode 保存
let initialized = false;
let contextLost = false;
let requestedMode = MODE_OFF;
let unavailable = false;
let weatherMotionActive = false;
let reduceMotion = false;
let listenersAttached = false;
let lastInjectX = -1, lastInjectY = -1, lastInjectT = 0;
let lastWallpaperImg = null;       // 上下文丢失后恢复时，重新上传这张壁纸。
let uploadedWallpaperSrc = '';
let pendingPointer = null;
let lastFrameTime = 0;
let controlButton = null;
const rippleUniformData = new Float32Array(MAX_RIPPLES * 4);
const pointerState = {
    x: 0.5,
    y: 0.5,
    clientX: -1,
    clientY: -1,
    lastT: 0,
    strength: 0,
    active: 0,
};

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
        pointer: gl.getUniformLocation(program, 'uPointer'),
        // WebGL 对数组 uniform 的规范名字是 uRipples[0]；Chrome 也接受 uRipples，
        // 但旧/弱实现未必都兼容，取双保险。
        ripples: gl.getUniformLocation(program, 'uRipples[0]') || gl.getUniformLocation(program, 'uRipples'),
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
    const requestedWidth = Math.max(1, Math.round(window.innerWidth * dpr));
    const requestedHeight = Math.max(1, Math.round(window.innerHeight * dpr));
    const pixelScale = Math.min(1, Math.sqrt(MAX_RENDER_PIXELS / (requestedWidth * requestedHeight)));
    const nextWidth = Math.max(1, Math.round(requestedWidth * pixelScale));
    const nextHeight = Math.max(1, Math.round(requestedHeight * pixelScale));
    if (canvas.width === nextWidth && canvas.height === nextHeight) return;
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
    if (canRender() && texSlots[1]) kick();
}

function resetLoopState() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    running = false;
    lastFrameTime = 0;
}

function canRender() {
    return enabled && initialized && gl && program && !weatherMotionActive &&
        !reduceMotion && !document.hidden && window.innerWidth >= 768;
}

function currentWallpaper() {
    if (lastWallpaperImg?.complete && lastWallpaperImg.naturalWidth > 0) return lastWallpaperImg;
    const b1 = document.getElementById('bgImage1');
    const b2 = document.getElementById('bgImage2');
    return (b2 && b2.style.opacity === '1') ? b2 : b1;
}

function imageSource(img) {
    return img?.currentSrc || img?.src || '';
}

function syncCanvasVisibility() {
    if (!canvas) return;
    canvas.style.opacity = canRender() && texSlots[1] ? '1' : '0';
}

// 把壁纸 img 上传为新纹理；首张只上传一次，交叉淡入结束后释放旧纹理。
function setWallpaper(img, transition = true) {
    lastWallpaperImg = img;
    if (!enabled || !initialized || !gl || !program || !img || !img.complete || img.naturalWidth === 0) return;

    const src = imageSource(img);
    if (texSlots[1] && src && src === uploadedWallpaperSrc) {
        syncCanvasVisibility();
        kick();
        return;
    }

    try {
        if (texSlots[0] && texSlots[0] !== texSlots[1]) gl.deleteTexture(texSlots[0]);
        if (transition) {
            texSlots[0] = texSlots[1];
            texRes[0] = texRes[1];
        } else {
            if (texSlots[1]) gl.deleteTexture(texSlots[1]);
            texSlots[0] = null;
            texSlots[1] = null;
        }

        const tex = makeTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        texSlots[1] = tex;
        texRes[1] = [img.naturalWidth, img.naturalHeight];
        uploadedWallpaperSrc = src;

        if (texSlots[0]) {
            mixFactor = 0;
            mixTarget = 1;
        } else {
            texRes[0] = texRes[1];
            mixFactor = 1;
            mixTarget = 1;
        }

        syncCanvasVisibility();
        kick();
    } catch (e) {
        console.warn('[fluid] 上传壁纸纹理失败:', e);
    }
}

function rememberWallpaper(img) {
    lastWallpaperImg = img;
    if (enabled) setWallpaper(img, canRender());
}

function clearInteractionState() {
    ripples = [];
    rippleCursor = 0;
    lastInjectX = -1;
    lastInjectY = -1;
    lastInjectT = 0;
    pendingPointer = null;
    pointerState.clientX = -1;
    pointerState.clientY = -1;
    pointerState.lastT = 0;
    pointerState.strength = 0;
    pointerState.active = 0;
    rippleUniformData.fill(0);
}

function injectRipple(clientX, clientY, strength, now) {
    const dx = clientX - lastInjectX;
    const dy = clientY - lastInjectY;
    if (lastInjectX >= 0 &&
        (dx * dx + dy * dy < RIPPLE_MIN_DIST * RIPPLE_MIN_DIST ||
         now - lastInjectT < RIPPLE_MIN_INTERVAL)) return;

    lastInjectX = clientX;
    lastInjectY = clientY;
    lastInjectT = now;
    ripples[rippleCursor] = {
        x: clientX / window.innerWidth,
        y: 1 - clientY / window.innerHeight,
        t: (now - startTime) / 1000,
        strength,
    };
    rippleCursor = (rippleCursor + 1) % MAX_RIPPLES;
}

function consumePendingPointer() {
    if (!pendingPointer) return;
    const sample = pendingPointer;
    pendingPointer = null;

    const hasPrevious = pointerState.clientX >= 0;
    const dx = hasPrevious ? sample.clientX - pointerState.clientX : 0;
    const dy = hasPrevious ? sample.clientY - pointerState.clientY : 0;
    const dt = hasPrevious ? Math.max(1, sample.time - pointerState.lastT) : 16;
    const speed = Math.hypot(dx, dy) / dt;

    pointerState.x = sample.clientX / window.innerWidth;
    pointerState.y = 1 - sample.clientY / window.innerHeight;
    pointerState.clientX = sample.clientX;
    pointerState.clientY = sample.clientY;
    pointerState.lastT = sample.time;
    pointerState.strength = Math.min(0.8, 0.22 + speed * 0.14);
    pointerState.active = 1;

    injectRipple(sample.clientX, sample.clientY, pointerState.strength * 0.72, sample.time);
}

function hasLiveAnimation(t) {
    if (mixFactor < mixTarget) return true;
    for (let i = 0; i < MAX_RIPPLES; i++) {
        const r = ripples[i];
        if (r && r.strength > 0 && t - r.t >= 0 && t - r.t <= RIPPLE_LIFETIME) return true;
    }
    return false;
}

// 指针事件只记录最新采样；真正的状态更新与绘制最多每显示帧执行一次。
function handlePointerMove(event) {
    if (!canRender() || event.pointerType === 'touch') return;
    const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : null;
    const sample = coalesced?.length ? coalesced[coalesced.length - 1] : event;
    pendingPointer = {
        clientX: sample.clientX,
        clientY: sample.clientY,
        time: performance.now(),
    };
    kick();
}

function handleMouseMove(event) {
    if (!window.PointerEvent) handlePointerMove(event);
}

function handlePointerLeave() {
    pendingPointer = null;
    pointerState.active = 0;
    pointerState.strength = 0;
    pointerState.clientX = -1;
    pointerState.clientY = -1;
    kick();
}

function attachPointerListeners() {
    if (listenersAttached) return;
    listenersAttached = true;
    window.addEventListener('pointermove', handlePointerMove, { passive: true, capture: true });
    window.addEventListener('mousemove', handleMouseMove, { passive: true, capture: true });
    window.addEventListener('pointerleave', handlePointerLeave, { passive: true });
}

function detachPointerListeners() {
    if (!listenersAttached) return;
    listenersAttached = false;
    window.removeEventListener('pointermove', handlePointerMove, true);
    window.removeEventListener('mousemove', handleMouseMove, true);
    window.removeEventListener('pointerleave', handlePointerLeave);
}

function kick() {
    if (!canRender() || !texSlots[1] || running) return;
    running = true;
    rafId = requestAnimationFrame(render);
}

function drawFrame(frameTime) {
    if (!canRender() || !texSlots[1]) return false;
    consumePendingPointer();

    const t = (frameTime - startTime) / 1000;
    const dt = lastFrameTime ? Math.min(0.05, (frameTime - lastFrameTime) / 1000) : 0;
    lastFrameTime = frameTime;
    if (mixFactor < mixTarget) mixFactor = Math.min(mixTarget, mixFactor + dt / 0.65);

    const oldTexture = texSlots[0] || texSlots[1];
    const oldResolution = texSlots[0] ? texRes[0] : texRes[1];
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, oldTexture);
    gl.uniform1i(uniforms.tex0, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texSlots[1]);
    gl.uniform1i(uniforms.tex1, 1);
    gl.uniform1f(uniforms.mix, mixFactor);
    gl.uniform2f(uniforms.res, canvas.width, canvas.height);
    gl.uniform2f(uniforms.tex0Res, oldResolution[0], oldResolution[1]);
    gl.uniform2f(uniforms.tex1Res, texRes[1][0], texRes[1][1]);
    gl.uniform1f(uniforms.time, t);
    gl.uniform4f(uniforms.pointer, pointerState.x, pointerState.y, pointerState.strength, pointerState.active);

    rippleUniformData.fill(0);
    for (let i = 0; i < MAX_RIPPLES; i++) {
        const r = ripples[i];
        if (!r) continue;
        rippleUniformData[i * 4] = r.x;
        rippleUniformData[i * 4 + 1] = r.y;
        rippleUniformData[i * 4 + 2] = r.t;
        rippleUniformData[i * 4 + 3] = r.strength;
    }
    gl.uniform4fv(uniforms.ripples, rippleUniformData);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    if (mixFactor >= mixTarget && texSlots[0] && texSlots[0] !== texSlots[1]) {
        gl.deleteTexture(texSlots[0]);
        texSlots[0] = null;
    }
    return true;
}

function render(frameTime) {
    try {
        if (!drawFrame(frameTime)) {
            resetLoopState();
            return;
        }
    } catch (e) {
        console.warn('[fluid] 渲染帧异常，停止循环（下次交互会重试）:', e);
        resetLoopState();
        return;
    }

    const t = (frameTime - startTime) / 1000;
    if (hasLiveAnimation(t)) {
        rafId = requestAnimationFrame(render);
    } else {
        running = false;
        rafId = null;
        lastFrameTime = 0;
    }
}

function updateControl() {
    if (!controlButton) return;
    const preferred = requestedMode === MODE_LIGHT;
    const actuallyAvailable = preferred && !reduceMotion && !unavailable && !contextLost && window.innerWidth >= 768;
    controlButton.setAttribute('aria-pressed', String(actuallyAvailable));
    controlButton.setAttribute('aria-label', '背景涟漪');
    controlButton.disabled = reduceMotion || unavailable;
    controlButton.classList.toggle('bg-white/20', actuallyAvailable);
    controlButton.classList.toggle('ring-2', actuallyAvailable);
    controlButton.classList.toggle('ring-white/40', actuallyAvailable);

    if (unavailable) controlButton.title = '当前浏览器不支持背景涟漪';
    else if (reduceMotion) controlButton.title = '系统已启用减少动态效果';
    else if (contextLost && preferred) controlButton.title = '背景涟漪正在恢复（点击关闭）';
    else if (preferred) controlButton.title = weatherMotionActive ? '关闭背景涟漪（天气动画期间已暂停）' : '关闭背景涟漪';
    else controlButton.title = '开启轻量背景涟漪';
}

function ensureInitialized() {
    // context lost 是可恢复的瞬时状态，不能当作“不支持”并清掉用户偏好。
    if (initialized) return contextLost || Boolean(gl && program);
    canvas = document.getElementById('fluidCanvas');
    if (!canvas) return false;

    gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false })
        || canvas.getContext('experimental-webgl', { alpha: false });
    if (!gl || !buildProgram()) {
        console.warn('[fluid] WebGL 不可用，降级到静态壁纸');
        gl = null;
        unavailable = true;
        return false;
    }

    initialized = true;
    startTime = performance.now();
    texSlots = [null, null];
    texRes = [[1, 1], [1, 1]];
    resize();

    canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        contextLost = true;
        program = null;
        resetLoopState();
        clearInteractionState();
        syncCanvasVisibility();
        updateControl();
    });

    canvas.addEventListener('webglcontextrestored', () => {
        if (!buildProgram()) {
            contextLost = false;
            unavailable = true;
            stopFluidRuntime();
            updateControl();
            return;
        }
        contextLost = false;
        texSlots = [null, null];
        texRes = [[1, 1], [1, 1]];
        uploadedWallpaperSrc = '';
        startTime = performance.now();
        resize();
        if (enabled) setWallpaper(currentWallpaper(), false);
        syncCanvasVisibility();
        kick();
    });
    return true;
}

function stopFluidRuntime() {
    enabled = false;
    detachPointerListeners();
    resetLoopState();
    clearInteractionState();
    syncCanvasVisibility();
}

function reconcileFluidState() {
    const shouldEnable = requestedMode === MODE_LIGHT && !reduceMotion && !unavailable && window.innerWidth >= 768;
    if (!shouldEnable) {
        stopFluidRuntime();
        updateControl();
        return;
    }

    if (!ensureInitialized()) {
        requestedMode = MODE_OFF;
        safeStorageSet(FLUID_MODE_KEY, MODE_OFF);
        stopFluidRuntime();
        updateControl();
        return;
    }

    const wasEnabled = enabled;
    enabled = true;
    attachPointerListeners();
    resize();
    const img = currentWallpaper();
    if (img?.complete && img.naturalWidth > 0) setWallpaper(img, wasEnabled && canRender());
    syncCanvasVisibility();
    kick();
    updateControl();
}

function setRequestedMode(mode) {
    requestedMode = mode === MODE_LIGHT ? MODE_LIGHT : MODE_OFF;
    safeStorageSet(FLUID_MODE_KEY, requestedMode);
    reconcileFluidState();
}

export function initFluid() {
    controlButton = document.getElementById('rippleBtn');
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduceMotion = motionPreference.matches;
    requestedMode = safeStorageGet(FLUID_MODE_KEY, MODE_OFF) === MODE_LIGHT ? MODE_LIGHT : MODE_OFF;

    // 即使默认关闭，也要记录 wallpaper 模块后续送来的当前图片，首次开启才能立即接管。
    window.__fluidSetWallpaper = rememberWallpaper;
    controlButton?.addEventListener('click', () => {
        setRequestedMode(requestedMode === MODE_LIGHT ? MODE_OFF : MODE_LIGHT);
    });

    const handleMotionPreference = (event) => {
        reduceMotion = event.matches;
        reconcileFluidState();
    };
    if (typeof motionPreference.addEventListener === 'function') {
        motionPreference.addEventListener('change', handleMotionPreference);
    } else if (typeof motionPreference.addListener === 'function') {
        motionPreference.addListener(handleMotionPreference);
    }

    window.addEventListener('resize', () => {
        resize();
        reconcileFluidState();
    });
    window.addEventListener('gx:weather-motion', (event) => {
        weatherMotionActive = Boolean(event.detail?.active);
        resetLoopState();
        clearInteractionState();
        syncCanvasVisibility();
        if (!weatherMotionActive) kick();
        updateControl();
    });
    document.addEventListener('visibilitychange', () => {
        resetLoopState();
        clearInteractionState();
        syncCanvasVisibility();
        if (!document.hidden) kick();
    });

    reconcileFluidState();
}
