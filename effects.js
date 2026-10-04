/* ============================================================
 *   effects.js — v14.3
 *   سیستم افکت: دود، برق، یخ
 *   رابط عمومی: window.FX
 *
 *   تغییرات v14.3:
 *   - استفاده از زمان تجمعی به‌جای now (رفع جهش flow هنگام بازگشت تب)
 *   - پرانتزگذاری صریح عملگر بیتی در bn/sn برای خوانایی
 *   - کامنت واضح برای پارامتر رزرو‌شده‌ی hue در addAura
 *
 *   تغییرات v14.2:
 *   - جداسازی کامل glowCache و smokeCache برای جلوگیری از تداخل کلید
 * ============================================================ */
(function(){
'use strict';

const TAU = Math.PI * 2;
const rand  = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const lerp  = (a, b, t) => a + (b - a) * t;
const easeOutQuad  = t => 1 - Math.pow(1 - t, 2);
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

function noise2(x, y) {
  return Math.sin(x * 1.7 + Math.cos(y * 2.3) * 2.0) * 0.5 +
         Math.sin(y * 1.3 + Math.cos(x * 1.9) * 1.6) * 0.5;
}
function flow(x, y, t) {
  const a = noise2(x * 0.0055 + t * 0.18, y * 0.0055 - t * 0.15) * Math.PI * 1.35;
  return { x: Math.cos(a), y: Math.sin(a) };
}

/* کش‌های مستقل: glow برای فلاش‌ها، smoke برای دود */
const glowCache  = {};
const smokeCache = {};

function makeSprite(size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  for (const s of stops) g.addColorStop(s[0], s[1]);
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  return c;
}

function glow(r, g, b) {
  const k = 'g_' + r + '_' + g + '_' + b;
  if (glowCache[k]) return glowCache[k];
  return glowCache[k] = makeSprite(160, [
    [0.00, `rgba(${r},${g},${b},1)`],
    [0.12, `rgba(${r},${g},${b},0.78)`],
    [0.30, `rgba(${r},${g},${b},0.40)`],
    [0.55, `rgba(${r},${g},${b},0.14)`],
    [1.00, `rgba(${r},${g},${b},0)`]
  ]);
}

function smokeSpriteRealistic(tint, alpha) {
  const k = 'smr_' + tint + '_' + alpha;
  if (smokeCache[k]) return smokeCache[k];
  const S = 192;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const baseR = tint === 'mist' ? 220 : (tint === 'dark' ? 30 : 190);
  const baseG = tint === 'mist' ? 235 : (tint === 'dark' ? 45 : 200);
  const baseB = tint === 'mist' ? 250 : (tint === 'dark' ? 60 : 218);
  const g = x.createRadialGradient(S/2, S/2, 0, S/2, S/2, S/2);
  g.addColorStop(0.00, `rgba(${baseR},${baseG},${baseB},${alpha})`);
  g.addColorStop(0.45, `rgba(${baseR},${baseG},${baseB},${alpha*0.55})`);
  g.addColorStop(0.78, `rgba(${baseR},${baseG},${baseB},${alpha*0.18})`);
  g.addColorStop(1.00, `rgba(${baseR},${baseG},${baseB},0)`);
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);
  x.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * TAU;
    const d = Math.random() * S * 0.32;
    const px = S/2 + Math.cos(a) * d;
    const py = S/2 + Math.sin(a) * d;
    const r = rand(S * 0.06, S * 0.18);
    const alphaInner = tint === 'dark' ? 0.12 : 0.08;
    const g2 = x.createRadialGradient(px, py, 0, px, py, r);
    g2.addColorStop(0, `rgba(${baseR},${baseG},${baseB},${alpha*alphaInner})`);
    g2.addColorStop(1, `rgba(${baseR},${baseG},${baseB},0)`);
    x.fillStyle = g2;
    x.fillRect(px - r, py - r, r * 2, r * 2);
  }
  x.globalCompositeOperation = 'source-over';
  return smokeCache[k] = c;
}

const smokeP    = [];
const sparks    = [];
const crystals  = [];
const strikes   = [];
const shocks    = [];
const flashes   = [];
const debris    = [];

const MAX_SMOKE    = 450;
const MAX_SPARKS   = 380;
const MAX_CRYSTALS = 220;
const MAX_STRIKES  = 10;
const MAX_DEBRIS   = 80;

/* ✅ زمان تجمعی به‌جای now برای جلوگیری از جهش flow */
let fxTime = 0;

function emitSmokeParticle(e, kind) {
  if (smokeP.length >= MAX_SMOKE) return;
  const p = e.power || 1;
  const a = Math.random() * TAU;
  const d = Math.random() * 20 * p;
  const sp = rand(5, 28) * p;
  const isMist = kind === 'mist';
  const sizeBase = isMist ? rand(12, 26) : rand(22, 52) * p;
  smokeP.push({
    x: e.x + Math.cos(a) * d,
    y: e.y + Math.sin(a) * d,
    vx: Math.cos(a) * sp,
    vy: Math.sin(a) * sp,
    life: 0,
    max: isMist ? rand(1.5, 2.8) : rand(2.6, 5.2),
    size: sizeBase,
    grow: isMist ? rand(20, 48) : rand(36, 82),
    rot: Math.random() * TAU,
    vrot: rand(-0.5, 0.5),
    seed: Math.random() * 1000,
    alpha: isMist ? rand(0.06, 0.14) : rand(0.09, 0.22),
    sy: rand(0.82, 1.0),
    col: isMist ? 'mist' : (Math.random() < 0.45 ? 'dark' : 'light')
  });
}

function addSmoke(x, y, power) {
  power = power || 1;
  const n = Math.floor(20 * power);
  for (let i = 0; i < n; i++) emitSmokeParticle({ x, y, power }, 'normal');
  shocks.push({ x, y, r0: 10, r1: 100*power, life: 0, max: 0.7,
    color: '180,200,220', w: 1.8, a: 0.35 });
}

function buildBolt(x, y, power, depthMax, branchLen) {
  const segs = [];
  depthMax = depthMax || 3;
  branchLen = branchLen || 1.0;
  function branch(px, py, angle, len, depth, width) {
    const pts = [{ x: px, y: py }];
    const steps = Math.max(4, Math.floor(len / 9));
    let a = angle, cx = px, cy = py;
    const seg = len / steps;
    for (let i = 0; i < steps; i++) {
      a += rand(-0.38, 0.38);
      if (depth === depthMax) a += Math.sin(i * 0.3) * 0.04;
      cx += Math.cos(a) * seg;
      cy += Math.sin(a) * seg;
      pts.push({ x: cx, y: cy });
      if (depth > 0 && Math.random() < 0.17) {
        branch(cx, cy, a + rand(-1.35, 1.35), len * rand(0.26, 0.58), depth - 1, width * 0.58);
      }
      if (depth >= 2 && Math.random() < 0.06 && sparks.length < MAX_SPARKS) {
        sparks.push({
          x: cx, y: cy, px: cx, py: cy,
          vx: rand(-60, 60), vy: rand(-60, 60),
          life: 0, max: rand(0.2, 0.55),
          color: Math.random() < 0.5 ? '180,220,255' : '230,245,255',
          w: 1.2
        });
      }
    }
    segs.push({ pts, width });
  }
  branch(x, y, Math.random() * TAU, rand(190, 360) * power * branchLen, depthMax, 1);
  return segs;
}

function addLightning(x, y, power) {
  power = power || 1;
  if (strikes.length >= MAX_STRIKES) strikes.shift();
  strikes.push({
    x, y, power,
    life: 0, max: 1.05,
    bolts: buildBolt(x, y, power),
    regen: 0,
    decalDone: true
  });
  flashes.push({ x, y, r: 220*power, life: 0, max: 0.6, cr: 165, cg: 205, cb: 255, a: 1.0 });
  flashes.push({ x, y, r: 80*power, life: 0, max: 0.35, cr: 245, cg: 250, cb: 255, a: 0.95 });
  shocks.push({ x, y, r0: 12, r1: 240*power, life: 0, max: 0.7,
    color: '150,200,255', w: 3.2, a: 0.65 });
  shocks.push({ x, y, r0: 5, r1: 120*power, life: 0, max: 0.4,
    color: '230,245,255', w: 1.8, a: 0.85 });
  const nSparks = Math.min(46, MAX_SPARKS - sparks.length);
  for (let i = 0; i < nSparks; i++) {
    const a = Math.random() * TAU;
    const sp = rand(140, 420) * power;
    sparks.push({
      x, y, px: x, py: y,
      vx: Math.cos(a)*sp, vy: Math.sin(a)*sp,
      life: 0, max: rand(0.35, 0.95),
      color: Math.random() < 0.5 ? '180,220,255' : '220,240,255',
      w: rand(1.2, 2.6)
    });
  }
}

function addIce(x, y, power) {
  power = power || 1;
  const N = 12;
  for (let i = 0; i < N; i++) {
    if (crystals.length >= MAX_CRYSTALS) break;
    const ang = (i / N) * TAU + rand(-0.20, 0.20);
    const len = rand(55, 175) * power;
    const branches = [];
    const bn = 2 + ((Math.random() * 3) | 0);
    for (let j = 0; j < bn; j++) {
      const at = rand(0.28, 0.82);
      const side = Math.random() < 0.5 ? -1 : 1;
      const blen = rand(0.22, 0.48);
      const bang = rand(0.55, 1.15);
      const sub = [];
      const sn = 1 + ((Math.random() * 2) | 0);
      for (let k = 0; k < sn; k++) {
        sub.push({
          at: rand(0.35, 0.85),
          side: Math.random() < 0.5 ? -1 : 1,
          len: rand(0.25, 0.5),
          ang: rand(0.5, 1.1)
        });
      }
      branches.push({ at, side, len: blen, ang: bang, sub });
    }
    crystals.push({
      x, y, angle: ang, len,
      width: rand(5.5, 14) * power,
      life: 0, max: rand(2.6, 4.2),
      delay: Math.random() * 0.22,
      grow: 0, branches
    });
  }
  const nDebris = Math.min(14, MAX_DEBRIS - debris.length);
  for (let i = 0; i < nDebris; i++) {
    const a = Math.random() * TAU;
    const sp = rand(60, 220) * power;
    debris.push({
      x, y, px: x, py: y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0, max: rand(0.6, 1.2),
      size: rand(2, 4.5),
      rot: Math.random() * TAU,
      vrot: rand(-4, 4)
    });
  }
  for (let i = 0; i < 30; i++) {
    emitSmokeParticle({ x: x + rand(-42,42), y: y + rand(-42,42), power: 0.85 }, 'mist');
  }
  const nSparks = Math.min(50, MAX_SPARKS - sparks.length);
  for (let i = 0; i < nSparks; i++) {
    const a = Math.random() * TAU;
    const sp = rand(25, 150) * power;
    sparks.push({
      x, y, px: x, py: y,
      vx: Math.cos(a)*sp, vy: Math.sin(a)*sp,
      life: 0, max: rand(0.7, 1.5),
      color: Math.random() < 0.5 ? '200,245,255' : '240,253,255',
      w: rand(0.9, 2.0)
    });
  }
  flashes.push({ x, y, r: 175*power, life: 0, max: 1.6, cr: 110, cg: 195, cb: 255, a: 0.5 });
  shocks.push({ x, y, r0: 8, r1: 165*power, life: 0, max: 0.85,
    color: '150,235,255', w: 2.4, a: 0.55 });
  shocks.push({ x, y, r0: 4, r1: 85*power, life: 0, max: 0.5,
    color: '230,252,255', w: 1.3, a: 0.75 });
}

/* پارامتر hue به‌عنوان رزرو برای API پایدار نگه داشته شده */
function addAura(x, y, type, hue, power) {
  /* hue در حال حاضر استفاده نمی‌شود — برای تینت‌های آتی رزرو شده است */
  power = power || 1;
  if (type === 'smoke') {
    const n = Math.round(5 * power);
    for (let i = 0; i < n; i++) {
      emitSmokeParticle({
        x: x + rand(-18, 18),
        y: y + rand(-18, 18),
        power: 0.75 * power
      }, 'normal');
    }
  } else if (type === 'lightning') {
    const n = Math.round(3 * power);
    for (let i = 0; i < n; i++) {
      if (sparks.length >= MAX_SPARKS) break;
      const a = Math.random() * TAU;
      const sp = rand(30, 130) * power;
      sparks.push({
        x: x + rand(-12,12), y: y + rand(-12,12), px: x, py: y,
        vx: Math.cos(a)*sp, vy: Math.sin(a)*sp,
        life: 0, max: rand(0.3, 0.7),
        color: '190,225,255',
        w: 1.2
      });
    }
    if (Math.random() < 0.22 * power) {
      const bx = x + rand(-14, 14);
      const by = y + rand(-14, 14);
      strikes.push({
        x: bx, y: by, power: 0.4 * power,
        life: 0, max: 0.45,
        bolts: buildBolt(bx, by, 0.45 * power, 2, 0.5),
        regen: 0, decalDone: true
      });
      flashes.push({ x: bx, y: by, r: 60*power, life: 0, max: 0.28,
        cr: 180, cg: 220, cb: 255, a: 0.7 });
    }
  } else if (type === 'ice') {
    const n = Math.round(3 * power);
    for (let i = 0; i < n; i++) {
      if (sparks.length >= MAX_SPARKS) break;
      const a = Math.random() * TAU;
      const sp = rand(20, 90) * power;
      sparks.push({
        x: x + rand(-14,14), y: y + rand(-14,14), px: x, py: y,
        vx: Math.cos(a)*sp, vy: Math.sin(a)*sp,
        life: 0, max: rand(0.5, 1.1),
        color: '220,250,255',
        w: 1.0
      });
    }
    if (Math.random() < 0.10 * power) {
      const cx = x + rand(-20, 20);
      const cy = y + rand(-20, 20);
      const ang = Math.random() * TAU;
      const len = rand(18, 34);
      const branches = [{
        at: rand(0.4, 0.7), side: Math.random() < 0.5 ? -1 : 1,
        len: rand(0.25, 0.42), ang: rand(0.6, 1.0), sub: []
      }];
      if (crystals.length < MAX_CRYSTALS) {
        crystals.push({
          x: cx, y: cy, angle: ang, len,
          width: rand(2.5, 4.5),
          life: 0, max: rand(1.4, 2.2),
          delay: 0, grow: 0, branches
        });
      }
    }
  }
}

function update(dt, now) {
  /* زمان تجمعی از dt؛ هرگز جهش نمی‌کند */
  fxTime += dt;
  const t = fxTime;

  for (let i = smokeP.length - 1; i >= 0; i--) {
    const p = smokeP[i];
    p.life += dt;
    const lt = p.life / p.max;
    if (lt >= 1) { smokeP.splice(i, 1); continue; }
    const f = flow(p.x, p.y, t * 0.7 + p.seed * 0.001);
    const amp = p.col === 'mist' ? 14 : 26;
    p.vx += f.x * amp * dt;
    p.vy += f.y * amp * dt;
    p.vy -= 6 * dt;
    const drag = Math.exp(-1.05 * dt);
    p.vx *= drag; p.vy *= drag;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.rot += p.vrot * dt;
  }
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.life += dt;
    if (s.life >= s.max) { sparks.splice(i, 1); continue; }
    s.px = s.x; s.py = s.y;
    const drag = Math.exp(-2.8 * dt);
    s.vx *= drag; s.vy *= drag;
    s.x += s.vx * dt; s.y += s.vy * dt;
  }
  for (let i = crystals.length - 1; i >= 0; i--) {
    const c = crystals[i];
    c.life += dt;
    if (c.life >= c.max) { crystals.splice(i, 1); continue; }
    c.grow = clamp((c.life - c.delay) / 0.55, 0, 1);
    if (c.grow > 0 && c.grow < 1 && Math.random() < 0.10 && sparks.length < MAX_SPARKS) {
      const dist = c.len * c.grow * rand(0.3, 1.0);
      const px = c.x + Math.cos(c.angle) * dist;
      const py = c.y + Math.sin(c.angle) * dist;
      sparks.push({
        x: px, y: py, px, py,
        vx: Math.cos(c.angle + Math.PI/2) * rand(-25, 25),
        vy: Math.sin(c.angle + Math.PI/2) * rand(-25, 25),
        life: 0, max: rand(0.4, 0.9),
        color: '220,250,255', w: 1
      });
    }
  }
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    d.life += dt;
    if (d.life >= d.max) { debris.splice(i, 1); continue; }
    d.px = d.x; d.py = d.y;
    d.vy += 220 * dt;
    d.vx *= Math.exp(-1.6 * dt);
    d.vy *= Math.exp(-0.4 * dt);
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.rot += d.vrot * dt;
  }
  for (let i = strikes.length - 1; i >= 0; i--) {
    const s = strikes[i];
    s.life += dt;
    if (s.life >= s.max) { strikes.splice(i, 1); continue; }
    if (s.life < 0.34) {
      s.regen -= dt;
      if (s.regen <= 0) {
        s.regen = rand(0.018, 0.05);
        s.bolts = buildBolt(s.x, s.y, s.power);
      }
    }
  }
  for (let i = shocks.length - 1; i >= 0; i--) {
    const s = shocks[i];
    s.life += dt;
    if (s.life >= s.max) shocks.splice(i, 1);
  }
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i];
    f.life += dt;
    if (f.life >= f.max) flashes.splice(i, 1);
  }
}

function drawShocks(ctx) {
  if (!shocks.length) return;
  ctx.globalCompositeOperation = 'lighter';
  for (const s of shocks) {
    const t = s.life / s.max;
    const r = lerp(s.r0, s.r1, easeOutQuad(t));
    const a = (1 - t) * (1 - t) * s.a;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, TAU);
    ctx.strokeStyle = `rgba(${s.color},${a})`;
    ctx.lineWidth = s.w * (1 - t) + 0.4;
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}
function drawFlashes(ctx) {
  if (!flashes.length) return;
  ctx.globalCompositeOperation = 'lighter';
  for (const f of flashes) {
    const t = f.life / f.max;
    const a = (1 - t) * (1 - t) * f.a;
    const r = f.r * (0.55 + 0.75 * t);
    ctx.globalAlpha = a;
    ctx.drawImage(glow(f.cr, f.cg, f.cb), f.x - r, f.y - r, r*2, r*2);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
function drawCrystal(ctx, c) {
  const g = c.grow;
  if (g <= 0.002) return;
  const t = c.life / c.max;
  const fadeIn  = clamp(c.life * 5, 0, 1);
  const fadeOut = t > 0.62 ? clamp(1 - (t - 0.62) / 0.38, 0, 1) : 1;
  const alpha = fadeIn * fadeOut;
  if (alpha <= 0.01) return;
  const L = c.len * easeOutCubic(g);
  const w = c.width * (1 - 0.42 * g);
  if (L < 1) return;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(c.angle);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha * 0.32;
  ctx.drawImage(glow(120, 200, 255), -L*0.15, -L*0.15, L*1.3, L*1.3);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  const grd = ctx.createLinearGradient(0, 0, L, 0);
  grd.addColorStop(0.00, `rgba(70,150,215,${0.55*alpha})`);
  grd.addColorStop(0.35, `rgba(125,200,240,${0.45*alpha})`);
  grd.addColorStop(0.72, `rgba(185,232,255,${0.55*alpha})`);
  grd.addColorStop(1.00, `rgba(240,253,255,${0.92*alpha})`);
  ctx.beginPath();
  ctx.moveTo(0, -w);
  ctx.lineTo(L*0.42, -w*0.55);
  ctx.lineTo(L*0.85, -w*0.18);
  ctx.lineTo(L, 0);
  ctx.lineTo(L*0.85, w*0.18);
  ctx.lineTo(L*0.42, w*0.55);
  ctx.lineTo(0, w);
  ctx.closePath();
  ctx.fillStyle = grd;
  ctx.fill();
  ctx.strokeStyle = `rgba(225,250,255,${0.72*alpha})`;
  ctx.lineWidth = 1.1;
  ctx.stroke();
  ctx.strokeStyle = `rgba(255,255,255,${0.42*alpha})`;
  ctx.lineWidth = 0.7;
  ctx.beginPath(); ctx.moveTo(L*0.08, 0); ctx.lineTo(L*0.94, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -w); ctx.lineTo(L*0.94, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, w); ctx.lineTo(L*0.94, 0); ctx.stroke();
  ctx.strokeStyle = `rgba(255,255,255,${0.85*alpha})`;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(0, -w*0.96);
  ctx.lineTo(L*0.85, -w*0.16);
  ctx.stroke();
  for (const b of c.branches) {
    const bl = L * b.len;
    const bw = w * 0.48;
    ctx.save();
    ctx.translate(L * b.at, 0);
    ctx.rotate(b.side * b.ang);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha * 0.26;
    ctx.drawImage(glow(140, 215, 255), -bl*0.15, -bl*0.15, bl*1.3, bl*1.3);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const bg = ctx.createLinearGradient(0, 0, bl, 0);
    bg.addColorStop(0, `rgba(120,195,235,${0.42*alpha})`);
    bg.addColorStop(1, `rgba(235,251,255,${0.82*alpha})`);
    ctx.beginPath();
    ctx.moveTo(0, -bw);
    ctx.lineTo(bl*0.55, -bw*0.4);
    ctx.lineTo(bl, 0);
    ctx.lineTo(bl*0.55, bw*0.4);
    ctx.lineTo(0, bw);
    ctx.closePath();
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = `rgba(240,253,255,${0.62*alpha})`;
    ctx.lineWidth = 0.85;
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${0.5*alpha})`;
    ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(bl*0.92, 0); ctx.stroke();
    for (const s of b.sub) {
      const sl = bl * s.len;
      const sw = bw * 0.5;
      ctx.save();
      ctx.translate(bl * s.at, 0);
      ctx.rotate(s.side * s.ang);
      ctx.beginPath();
      ctx.moveTo(0, -sw);
      ctx.lineTo(sl, 0);
      ctx.lineTo(0, sw);
      ctx.closePath();
      ctx.fillStyle = `rgba(190,238,255,${0.35*alpha})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(240,253,255,${0.5*alpha})`;
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }
  ctx.restore();
}
function drawIce(ctx) {
  if (!crystals.length && !debris.length) return;
  for (const c of crystals) drawCrystal(ctx, c);
  if (!debris.length) return;
  ctx.globalCompositeOperation = 'source-over';
  for (const d of debris) {
    const t = d.life / d.max;
    const a = (1 - t);
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(d.rot);
    ctx.fillStyle = `rgba(200,240,255,${a*0.85})`;
    ctx.beginPath();
    ctx.moveTo(-d.size, 0);
    ctx.lineTo(0, -d.size);
    ctx.lineTo(d.size, 0);
    ctx.lineTo(0, d.size);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = `rgba(255,255,255,${a*0.7})`;
    ctx.lineWidth = 0.6;
    ctx.stroke();
    ctx.restore();
  }
}
function drawSmoke(ctx) {
  if (!smokeP.length) return;
  const L = smokeSpriteRealistic('light', 0.5);
  const D = smokeSpriteRealistic('dark', 0.55);
  const M = smokeSpriteRealistic('mist', 0.42);
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < smokeP.length; i++) {
    const p = smokeP[i];
    const t = p.life / p.max;
    const fadeIn  = clamp(t * 5, 0, 1);
    const fadeOut = (1 - t) * (1 - t * 0.4);
    const a = p.alpha * fadeIn * fadeOut;
    if (a <= 0.003) continue;
    const s = p.size + p.grow * t;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    let spr;
    if (p.col === 'mist') spr = M;
    else if (p.col === 'dark') spr = D;
    else spr = L;
    ctx.globalAlpha = a;
    ctx.drawImage(spr, -s*0.5, -s*0.5*p.sy, s, s*p.sy);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
function drawLightning(ctx) {
  if (!strikes.length) return;
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strikes) {
    let a, aur;
    if (s.life < 0.34) {
      a = 0.85 + Math.random() * 0.35; aur = 1;
    } else if (s.life < 0.55) {
      a = clamp(1 - (s.life - 0.34) / 0.21, 0, 1); a *= a; aur = a;
    } else {
      a = clamp(1 - (s.life - 0.55) / 0.5, 0, 1); a *= a * 0.6; aur = a * 0.6;
    }
    if (a <= 0.008 && aur <= 0.008) continue;
    for (const seg of s.bolts) {
      ctx.beginPath();
      for (let i = 0; i < seg.pts.length; i++) {
        const p = seg.pts[i];
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      }
      const w = seg.width;
      ctx.strokeStyle = `rgba(80,120,255,${0.10 * aur})`;
      ctx.lineWidth = w * 22; ctx.stroke();
      ctx.strokeStyle = `rgba(70,140,255,${0.22 * a})`;
      ctx.lineWidth = w * 10; ctx.stroke();
      ctx.strokeStyle = `rgba(140,200,255,${0.42 * a})`;
      ctx.lineWidth = w * 4.2; ctx.stroke();
      ctx.strokeStyle = `rgba(210,235,255,${0.85 * a})`;
      ctx.lineWidth = w * 1.6; ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${0.98 * a})`;
      ctx.lineWidth = w * 0.65; ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}
function drawSparks(ctx) {
  if (!sparks.length) return;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < sparks.length; i++) {
    const s = sparks[i];
    const t = s.life / s.max;
    const a = (1 - t) * (1 - t);
    ctx.strokeStyle = `rgba(${s.color},${a * 0.95})`;
    ctx.lineWidth = s.w * (1 - t) + 0.3;
    ctx.beginPath();
    ctx.moveTo(s.px, s.py);
    ctx.lineTo(s.x, s.y);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function draw(ctx) {
  drawShocks(ctx);
  drawFlashes(ctx);
  drawIce(ctx);
  drawSmoke(ctx);
  drawLightning(ctx);
  drawSparks(ctx);
}
function clear() {
  smokeP.length = 0;
  sparks.length = 0;
  crystals.length = 0;
  strikes.length = 0;
  shocks.length = 0;
  flashes.length = 0;
  debris.length = 0;
  fxTime = 0;
}

window.FX = {
  addSmoke, addLightning, addIce, addAura,
  update, draw, clear,
  stats: () => ({
    smoke: smokeP.length,
    sparks: sparks.length,
    crystals: crystals.length,
    strikes: strikes.length,
    debris: debris.length
  })
};

})();