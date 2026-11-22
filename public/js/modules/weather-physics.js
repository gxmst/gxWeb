// Particle budgets, snowbank depth, elastic jiggle waves, and interactive brush/shake physics.
export function particleBudget(type, width, height, heavy = false) {
    const mobile = width < 768;
    const area = width * height;
    const count = type === 'snow'
        ? Math.max(mobile ? 28 : 56, Math.min(mobile ? 72 : 185, Math.round(area / 12000)))
        : Math.max(mobile ? 10 : 20, Math.min(mobile ? 24 : 65, Math.round(area / 32000)));
    return Math.round(count * (heavy ? 1.35 : 1));
}

function smoothstep(t) {
    const clamped = Math.max(0, Math.min(1, t));
    return clamped * clamped * (3 - 2 * clamped);
}

export function createSnowpack(width, previous = null) {
    const length = Math.max(24, Math.min(360, Math.ceil(width / 4) + 1));
    const depth = new Float32Array(length);
    const offset = new Float32Array(length);
    const vel = new Float32Array(length);
    const pack = { width, depth, offset, vel };
    if (previous) {
        for (let i = 0; i < length; i++) {
            depth[i] = snowHeightAt(previous, (i / (length - 1)) * previous.width);
        }
    }
    return pack;
}

export function snowHeightAt(pack, x) {
    const position = Math.max(0, Math.min(pack.depth.length - 1, (x / Math.max(1, pack.width)) * (pack.depth.length - 1)));
    const low = Math.floor(position);
    const high = Math.min(pack.depth.length - 1, low + 1);
    return pack.depth[low] + (pack.depth[high] - pack.depth[low]) * (position - low);
}

export function depositSnow(pack, x, radius, cornerRadius = 0, scale = 1) {
    const spread = 16 + radius * 4;
    const taper = Math.max(14, cornerRadius * 1.15);
    const baseAmount = (0.46 + radius * 0.14) * Math.max(0, scale);
    for (let i = 0; i < pack.depth.length; i++) {
        const local = (i / (pack.depth.length - 1)) * pack.width;
        const distance = Math.abs(local - x);
        if (distance > spread) continue;
        const edge = smoothstep(Math.min(1, local / taper, (pack.width - local) / taper));
        if (edge <= 0) continue;
        const amount = baseAmount * Math.exp(-3 * (distance / spread) ** 2) * edge;
        pack.depth[i] = Math.min(18, pack.depth[i] + amount);
    }
}

export function relaxSnowpack(pack, dt, cornerRadius = 0, meltRate = 0.002) {
    const depth = pack?.depth;
    const length = depth?.length || 0;
    if (!length || dt <= 0) return;
    if (!pack._scratch || pack._scratch.length !== length) {
        pack._scratch = new Float32Array(length);
    }
    const next = pack._scratch;
    const blend = Math.min(0.24, dt * 2.1);
    const melt = Math.max(0, meltRate) * dt;
    const taper = Math.max(14, cornerRadius * 1.15);

    next[0] = Math.max(0, depth[0] * 0.85 - melt);
    next[length - 1] = Math.max(0, depth[length - 1] * 0.85 - melt);
    for (let i = 1; i < length - 1; i++) {
        const local = (i / (length - 1)) * pack.width;
        const edge = smoothstep(Math.min(1, local / taper, (pack.width - local) / taper));
        const dM2 = depth[Math.max(0, i - 2)];
        const dM1 = depth[i - 1];
        const d0 = depth[i];
        const dP1 = depth[i + 1];
        const dP2 = depth[Math.min(length - 1, i + 2)];
        const neighborAvg = 0.12 * dM2 + 0.22 * dM1 + 0.32 * d0 + 0.22 * dP1 + 0.12 * dP2;
        const smoothed = d0 + (neighborAvg - d0) * blend - melt;
        const maxAtX = 18 * Math.max(0.08, edge);
        next[i] = Math.max(0, Math.min(maxAtX, smoothed));
    }

    // Gentle angle-of-repose avalanche settling keeps steep drifts rounded and natural.
    const maxSlope = 1.6;
    for (let i = 1; i < length - 2; i++) {
        const diff = next[i] - next[i + 1];
        if (Math.abs(diff) > maxSlope) {
            const transfer = (Math.abs(diff) - maxSlope) * 0.18;
            if (diff > 0) {
                next[i] -= transfer;
                next[i + 1] = Math.min(18, next[i + 1] + transfer);
            } else {
                next[i + 1] -= transfer;
                next[i] = Math.min(18, next[i] + transfer);
            }
        }
    }
    depth.set(next);
}

/**
 * Step the 1D damped spring-wave displacement on a snowpack so snowbanks
 * visibly wobble, ripple, and settle back when brushed or shaken.
 */
export function stepSnowWave(pack, dt) {
    const depth = pack?.depth;
    const offset = pack?.offset;
    const vel = pack?.vel;
    const length = depth?.length || 0;
    if (!length || !offset || !vel || dt <= 0) return;

    const clampedDt = Math.min(0.033, dt);
    const substeps = clampedDt > 0.018 ? 2 : 1;
    const subDt = clampedDt / substeps;
    const damp = Math.exp(-5.8 * subDt);

    for (let s = 0; s < substeps; s++) {
        for (let i = 0; i < length; i++) {
            const d = depth[i];
            if (d <= 0.1) {
                offset[i] = 0;
                vel[i] = 0;
                continue;
            }
            const left = i > 0 ? offset[i - 1] : 0;
            const right = i < length - 1 ? offset[i + 1] : 0;
            const accel = -95 * offset[i] + 160 * (left + right - 2 * offset[i]);
            vel[i] = (vel[i] + accel * subDt) * damp;
        }
        for (let i = 0; i < length; i++) {
            const d = depth[i];
            if (d <= 0.1) continue;
            const nextOffset = offset[i] + vel[i] * subDt;
            const minOff = -Math.min(5.5, d * 0.55);
            const maxOff = Math.min(3.5, d * 0.35);
            if (nextOffset < minOff) {
                offset[i] = minOff;
                if (vel[i] < 0) vel[i] *= -0.3;
            } else if (nextOffset > maxOff) {
                offset[i] = maxOff;
                if (vel[i] > 0) vel[i] *= -0.3;
            } else {
                offset[i] = nextOffset;
            }
        }
    }
}

/**
 * Apply pointer brushing or obstacle-drag shaking to a snowpack.
 * Returns { removed, clumps } so the scene can spawn tumbling snow clumps.
 */
export function disturbSnowpack(pack, x, vx = 0, vy = 0, options = {}) {
    const { radius = 34, strength = 1, shakeOnly = false, random = Math.random } = options;
    const depth = pack?.depth;
    const length = depth?.length || 0;
    if (!length || radius <= 0) return { removed: 0, clumps: [] };

    if (!pack.offset || pack.offset.length !== length) pack.offset = new Float32Array(length);
    if (!pack.vel || pack.vel.length !== length) pack.vel = new Float32Array(length);

    const speed = Math.hypot(vx, vy);
    const plowDir = vx > 20 ? 1 : vx < -20 ? -1 : 0;
    const clumps = [];
    let removed = 0;

    for (let i = 0; i < length; i++) {
        const d = depth[i];
        if (d <= 0.15) continue;
        const local = (i / (length - 1)) * pack.width;
        const dist = Math.abs(local - x);
        if (dist > radius) continue;

        const w = Math.exp(-2.4 * (dist / radius) ** 2);
        if (shakeOnly) {
            const ripple = Math.sin((local - x) * 0.28) * 0.65 + (random() - 0.5) * 0.7;
            pack.vel[i] += (-65 + ripple * 55) * strength * w;
            if (d > 1.5) {
                const shed = Math.min(d * 0.12, 0.14 * w * strength);
                depth[i] = Math.max(0, d - shed);
                removed += shed;
                if (clumps.length < 14 && random() < 0.26 * w * strength) {
                    clumps.push({
                        localX: local,
                        offsetY: -d * (0.4 + random() * 0.5),
                        vx: (random() - 0.5) * 45,
                        vy: -14 - random() * 34,
                        radius: 0.95 + random() * Math.min(1.8, d * 0.2),
                    });
                }
            }
        } else {
            const impulse = Math.max(-145, Math.min(145, (vy * 0.22 - 48 * strength) * w));
            pack.vel[i] += impulse;
            const speedFactor = Math.min(2.2, 0.35 + speed / 420);
            const take = Math.min(d * 0.62, d * 0.16 * w * strength * speedFactor);
            if (take > 0.02) {
                depth[i] = Math.max(0, d - take);
                removed += take;
                if (plowDir !== 0) {
                    const target = i + plowDir * 2;
                    if (target > 0 && target < length - 1) {
                        depth[target] = Math.min(18, depth[target] + take * 0.3);
                    }
                }
                if (take > 0.06 && clumps.length < 18 && random() < 0.45 * w * strength) {
                    clumps.push({
                        localX: local,
                        offsetY: -d * (0.45 + random() * 0.55),
                        vx: vx * 0.25 + (random() - 0.5) * 65,
                        vy: Math.min(-16, vy * 0.18 - 34 - random() * 54),
                        radius: 1.0 + random() * Math.min(2.2, d * 0.22),
                    });
                }
            }
        }
    }

    return { removed, clumps };
}

/**
 * Scan snowpack depth and return contiguous non-empty snow runs padded with
 * one zero-anchor sample on each side so every patch feathers cleanly to zero.
 */
export function findSnowSegments(depth, threshold = 0.08) {
    const length = depth?.length || 0;
    if (length < 2) return [];
    const segments = [];
    let i = 0;
    while (i < length) {
        if (depth[i] <= threshold) {
            i++;
            continue;
        }
        const runStart = i;
        let maxDepth = depth[i];
        while (i + 1 < length && depth[i + 1] > threshold) {
            i++;
            if (depth[i] > maxDepth) maxDepth = depth[i];
        }
        const runEnd = i;
        segments.push({
            start: Math.max(0, runStart - 1),
            end: Math.min(length - 1, runEnd + 1),
            maxDepth,
        });
        i = runEnd + 1;
    }
    return segments;
}

export function splashDroplets(x, y, random = Math.random) {
    return Array.from({ length: 5 }, (_, index) => ({
        x,
        y,
        vx: (index - 2) * 22 + (random() - 0.5) * 18,
        vy: -45 - random() * 70,
        life: 0,
        maxLife: 0.35 + random() * 0.2,
        radius: 0.7 + random() * 0.65,
    }));
}
