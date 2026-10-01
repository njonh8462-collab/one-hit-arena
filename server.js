'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

const CFG = {
  worldSize: 3800, obstacleCount: 80,
  playerSpeed: 240, swordRange: 82, swordArc: 1.05, swordCd: 0.46,
  dashSpeed: 900, dashDur: 0.15, dashCd: 2.5, arrowSpeed: 950,
  respawnTime: 2.5, respawnProt: 2.5, initialProt: 2.5,
  emergeDuration: 1.2,
  tankShieldRecharge: 8.0, playerKillXp: 8,
  minEnemies: 14, enemiesPerPlayer: 2, maxEnemies: 60,
  tickMs: 33, netHz: 10,
  aoiRadius: 6000, hashCell: 500,
  chatCooldown: 800, chatMaxLen: 140, chatHistorySize: 40,
  maxName: 14, lbSize: 10, maxPlayers: 150,
  portalCount: 16, portalCooldown: [0.9, 1.8], spawnInterval: [0.35, 0.75],
  stalePlayerMs: 30000            // ✅ افزایش از ۱۵ به ۳۰ ثانیه
};
const WSZ = CFG.worldSize;

const CHARACTERS = {
  warrior: { speed:1.00, range:1.00, cd:1.00, dash:1.00, hue:205 },
  knight:  { speed:0.88, range:1.18, cd:1.06, dash:0.85, hue:42 },
  archer:  { speed:1.05, range:2.40, cd:0.85, dash:1.10, hue:140, ranged:true },
  tank:    { speed:0.82, range:1.10, cd:1.12, dash:0.78, hue:15, shield:true }
};

const TEAMS = {
  ffa:{hue:null,name:'آزاد'}, red:{hue:0,name:'قرمز'}, orange:{hue:28,name:'نارنجی'},
  yellow:{hue:52,name:'زرد'}, green:{hue:130,name:'سبز'}, blue:{hue:210,name:'آبی'},
  indigo:{hue:250,name:'نیلی'}, violet:{hue:285,name:'بنفش'}
};

const MONSTER_TYPES = [
  { id:'slime',    speed:75,  radius:16, hue:135, wobble:1.4, xp:1, hp:1,  dmg:1, ai:'chase' },
  { id:'skeleton', speed:100, radius:16, hue:205, wobble:0,   xp:1, hp:1,  dmg:1, ai:'chase' },
  { id:'demon',    speed:110, radius:17, hue:8,   wobble:0,   xp:2, hp:1,  dmg:1, ai:'dasher' },
  { id:'ghost',    speed:85,  radius:15, hue:275, wobble:0.9, xp:1, hp:1,  dmg:1, ai:'strafe', ghost:true },
  { id:'golem',    speed:55,  radius:28, hue:28,  wobble:0.2, xp:3, hp:1,  dmg:1, ai:'tank' },
  { id:'wraith',   speed:95,  radius:16, hue:295, wobble:0.6, xp:2, hp:1,  dmg:1, ai:'teleport' }
];
const MBYID = Object.fromEntries(MONSTER_TYPES.map(m=>[m.id,m]));

const TAU = Math.PI*2;
const rand  = (a,b)=>a+Math.random()*(b-a);
const randi = (a,b)=>Math.floor(rand(a,b+1));
const clamp = (v,a,b)=>v<a?a:(v>b?b:v);
const lerp  = (a,b,t)=>a+(b-a)*t;
const angDiff=(a,b)=>{let d=a-b;while(d>Math.PI)d-=TAU;while(d<-Math.PI)d+=TAU;return d;};
const normAng=(a)=>{a%=TAU;if(a>Math.PI)a-=TAU;if(a<-Math.PI)a+=TAU;return a;};
const r1=(v)=>Math.round(v*10)/10;
const r2=(v)=>Math.round(v*100)/100;

function wrap(v){ v %= WSZ; if (v < 0) v += WSZ; return v; }
function wrapDelta(a, b){
  let d = (a - b) % WSZ;
  if (d >  WSZ/2) d -= WSZ;
  if (d < -WSZ/2) d += WSZ;
  return d;
}
function wrapDist(ax, ay, bx, by){ return Math.hypot(wrapDelta(ax, bx), wrapDelta(ay, by)); }
function closestPointOnSegment(px, py, ax, ay, bx, by){
  const abx = bx - ax, aby = by - ay;
  const denom = abx*abx + aby*aby;
  let t = 0;
  if (denom > 0.0001) t = clamp(((px-ax)*abx + (py-ay)*aby) / denom, 0, 1);
  const cx = ax + abx*t, cy = ay + aby*t;
  const dx = px - cx, dy = py - cy;
  return { x: cx, y: cy, d2: dx*dx + dy*dy };
}
function pointInPolygon(pts, px, py){
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++){
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

class SpatialHash {
  constructor(cell, worldSize){
    this.cell = cell; this.n = Math.ceil(worldSize / cell); this.map = new Map();
  }
  k(cx, cy){
    cx = ((cx % this.n) + this.n) % this.n;
    cy = ((cy % this.n) + this.n) % this.n;
    return cx * 1000 + cy;
  }
  clear(){ this.map.clear(); }
  insert(e){
    if(!isFinite(e.x) || !isFinite(e.y)) return;
    const k = this.k(Math.floor(e.x / this.cell), Math.floor(e.y / this.cell));
    let arr = this.map.get(k);
    if (!arr) { arr = []; this.map.set(k, arr); }
    arr.push(e);
  }
  query(x, y, r, out){
    out = out || []; out.length = 0;
    const cr = Math.ceil(r / this.cell);
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    const seen = new Set();
    for (let i = -cr; i <= cr; i++){
      for (let j = -cr; j <= cr; j++){
        const arr = this.map.get(this.k(cx + i, cy + j));
        if (arr) for (const e of arr) if (!seen.has(e)) { seen.add(e); out.push(e); }
      }
    }
    return out;
  }
}

const obstacles = [];
function genWorld(){
  let seed = 20240930;
  const r = ()=>{ seed = (seed*1664525 + 1013904223) & 0xffffffff; return ((seed>>>0)/4294967296); };
  const rr = (a,b)=>a+r()*(b-a);
  const ri = (a,b)=>Math.floor(rr(a,b+1));
  let placed = 0;
  for(let tries=0; tries<CFG.obstacleCount*30 && placed<CFG.obstacleCount; tries++){
    const x = rr(120, WSZ-120), y = rr(120, WSZ-120);
    if(Math.hypot(x-WSZ/2, y-WSZ/2) < 460) continue;
    const rad = rr(24, 62);
    let overlap = false;
    for(const o of obstacles){ if(wrapDist(x, y, o.x, o.y) < o.r + rad + 20){ overlap = true; break; } }
    if(overlap) continue;
    const n = ri(5,8), pts = [];
    let boundR = 0;
    for(let j=0; j<n; j++){
      const a = j/n*TAU, rrr = rad*rr(0.78, 1.18);
      const px = Math.cos(a)*rrr, py = Math.sin(a)*rrr;
      pts.push({ x: px, y: py });
      if (Math.hypot(px, py) > boundR) boundR = Math.hypot(px, py);
    }
    const rot = rr(0,TAU);
    obstacles.push({ x: r1(x), y: r1(y), r: r1(rad), boundR: boundR + 2,
      pts, rot: r2(rot), cosr: Math.cos(rot), sinr: Math.sin(rot) });
    placed++;
  }
  console.log(`[world] ${obstacles.length} obstacles`);
}

function collideObstacles(ent, radius){
  for(let i=0; i<obstacles.length; i++){
    const o = obstacles[i];
    const dx = wrapDelta(ent.x, o.x);
    const dy = wrapDelta(ent.y, o.y);
    const maxR = o.boundR + radius;
    if (dx*dx + dy*dy > maxR*maxR) continue;
    const cos = o.cosr, sin = o.sinr;
    const lx =  dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    let bestD2 = Infinity, bestCx = 0, bestCy = 0;
    for (let k = 0; k < o.pts.length; k++){
      const a = o.pts[k], b = o.pts[(k+1) % o.pts.length];
      const cp = closestPointOnSegment(lx, ly, a.x, a.y, b.x, b.y);
      if (cp.d2 < bestD2){ bestD2 = cp.d2; bestCx = cp.x; bestCy = cp.y; }
    }
    const inside = pointInPolygon(o.pts, lx, ly);
    if (inside){
      let nx = lx - bestCx, ny = ly - bestCy;
      const nl = Math.hypot(nx, ny); if (nl < 0.0001) continue;
      nx /= nl; ny /= nl;
      const push = radius + nl;
      const wnx = nx * cos - ny * sin, wny = nx * sin + ny * cos;
      ent.x = wrap(ent.x + wnx * push); ent.y = wrap(ent.y + wny * push);
    } else if (bestD2 < radius*radius){
      let nx = lx - bestCx, ny = ly - bestCy;
      const d = Math.sqrt(bestD2) || 0.0001;
      nx /= d; ny /= d;
      const push = radius - d;
      const wnx = nx * cos - ny * sin, wny = nx * sin + ny * cos;
      ent.x = wrap(ent.x + wnx * push); ent.y = wrap(ent.y + wny * push);
    }
  }
}

const PORTALS = [];
function genPortals(){
  PORTALS.length = 0;
  const cx = WSZ/2, cy = WSZ/2, baseR = WSZ * 0.33;
  for(let i=0; i<CFG.portalCount; i++){
    let placed = false;
    for(let tries=0; tries<60 && !placed; tries++){
      const angle = (i / CFG.portalCount) * TAU + rand(-0.2, 0.2);
      const r = baseR + rand(-260, 260);
      const x = wrap(cx + Math.cos(angle) * r);
      const y = wrap(cy + Math.sin(angle) * r);
      let ok = true;
      for(const o of obstacles){ if(wrapDist(x, y, o.x, o.y) < o.boundR + 70){ ok = false; break; } }
      if(!ok) continue;
      let tooClose = false;
      for(const p of PORTALS){ if(wrapDist(x, y, p.x, p.y) < 320){ tooClose = true; break; } }
      if(tooClose) continue;
      PORTALS.push({ id: i, x, y, hue: Math.round(rand(0, 360)), radius: 38, cooldown: rand(0, 0.6) });
      placed = true;
    }
    if(!placed){
      for(let tries=0; tries<60; tries++){
        const x = rand(200, WSZ-200), y = rand(200, WSZ-200);
        let ok = true;
        for(const o of obstacles){ if(wrapDist(x, y, o.x, o.y) < o.boundR + 60){ ok = false; break; } }
        if(ok){ PORTALS.push({ id: i, x, y, hue: Math.round(rand(0, 360)), radius: 38, cooldown: rand(0, 0.6) }); break; }
      }
    }
  }
  console.log(`[portals] ${PORTALS.length}`);
}

const players = new Map();
const enemies = [];
const arrows = [];
const events = [];
const chatHistory = [];
let nextPlayerId = 1, nextEnemyId = 1, nextArrowId = 1, tick = 0, lastLbTime = 0, leaderboard = [];
const playerHash = new SpatialHash(CFG.hashCell, WSZ);
const enemyHash  = new SpatialHash(CFG.hashCell, WSZ);

function xpForLevel(lvl){ return Math.floor(8 + lvl*5 + lvl*lvl*1.2); }
function pMaxHp(p){ return 3 + Math.floor((p.level - 1) * 0.4); }
function pDamage(p){ return 1 + Math.floor((p.level - 1) / 4); }
function pSpeed(p){ return CFG.playerSpeed * CHARACTERS[p.charId].speed * (1 + (p.level-1)*0.006); }
function pRange(p){ return CFG.swordRange * CHARACTERS[p.charId].range * (1 + (p.level-1)*0.010); }
function pCd(p){ return CFG.swordCd * CHARACTERS[p.charId].cd * Math.max(0.70, 1 - (p.level-1)*0.008); }
function pDashSpeed(p){ return CFG.dashSpeed * CHARACTERS[p.charId].dash * (1 + (p.level-1)*0.005); }
// ✅ ضریب کول‌داون جهش بر اساس شخصیت (هماهنگ با کلاینت)
function pDashCd(p){ return CFG.dashCd * (CHARACTERS[p.charId].dash || 1); }

function resolveHue(team, color, charId){
  if(color !== 'auto'){ const n = parseInt(color,10); if(!isNaN(n)) return ((n%360)+360)%360; }
  if(team !== 'ffa') return TEAMS[team].hue;
  return CHARACTERS[charId].hue;
}

// ✅ پذیرش excludeId تا بازیکن خودش را در اسپاون بررسی نکند
function findPlayerSpawn(excludeId){
  for(let i=0; i<200; i++){
    const x = rand(WSZ*0.3, WSZ*0.7), y = rand(WSZ*0.3, WSZ*0.7);
    let ok = true;
    for(const o of obstacles) if(wrapDist(x, y, o.x, o.y) < o.boundR + 52){ ok=false; break; }
    if(!ok) continue;
    let farEnough = true;
    for(const p of players.values()){
      if(p.id === excludeId) continue;
      if(!p.alive) continue;
      if(wrapDist(x, y, p.x, p.y) < 250){ farEnough=false; break; }
    }
    if(farEnough) return { x, y };
  }
  return { x: WSZ/2 + rand(-200,200), y: WSZ/2 + rand(-200,200) };
}

function makePlayer(id, name, charId, team, color, ws){
  if(!CHARACTERS[charId]) charId = 'warrior';
  if(!TEAMS[team]) team = 'ffa';
  const spot = findPlayerSpawn(id);
  return {
    id, name: String(name||'Player').slice(0, CFG.maxName), charId, team, color,
    hue: resolveHue(team, color, charId),
    x: spot.x, y: spot.y, vx:0, vy:0, angle:0,
    alive: true, kills:0, deaths:0, hp: 3,
    level:1, xp:0, xpNeed: xpForLevel(1),
    atkCd:0, swing:0, swingDir:0, dashCd:0, dashTime:0, dashDir:0,
    spawnProt: CFG.initialProt, respawn:0, walkPhase:0,
    shieldCharge: CHARACTERS[charId].shield ? 1 : 0, blockFlash:0,
    // ✅ فلگ aimSet: تشخیص «اعمال شده» از «مقدار صفر معتبر»
    inX:0, inY:0, aim:0, aimSet:false,
    wantDash:false, wantAttack:false, wantAttackHeld:false,
    lastChatAt:0, ws, lastInputAt: Date.now(), aoiBuf: []
  };
}

function spawnPlayer(p){
  const spot = findPlayerSpawn(p.id);
  // --- ریست کامل سطح و ویژگی‌ها ---
  p.level = 1;
  p.xp = 0;
  p.xpNeed = xpForLevel(1);
  p.hp = pMaxHp(p);
  // --- ریست حالت ---
  p.x = spot.x; p.y = spot.y; p.vx = 0; p.vy = 0;
  p.alive = true; p.spawnProt = CFG.respawnProt;
  p.dashTime = 0; p.dashCd = 0; p.atkCd = 0.4;
  p.shieldCharge = CHARACTERS[p.charId].shield ? 1 : 0;
  p.blockFlash = 0;
}

function spawnEnemyFromPortal(portal){
  const t = MONSTER_TYPES[randi(0, MONSTER_TYPES.length-1)];
  const a = rand(0, TAU);
  const r = (portal.radius || 38) + rand(4, 26);
  const targetX = wrap(portal.x + Math.cos(a)*r);
  const targetY = wrap(portal.y + Math.sin(a)*r);
  enemies.push({
    id: nextEnemyId++, typeId: t.id,
    x: portal.x, y: portal.y,
    px0: portal.x, py0: portal.y,
    targetX, targetY,
    emergeT: 0,
    vx: 0, vy: 0, angle: rand(0, TAU), alive: true, dead: false,   // ✅ dead flag
    spawnAnim: CFG.emergeDuration,
    portalId: portal.id,
    walkPhase: rand(0, TAU), wobblePhase: rand(0, TAU), wanderPhase: rand(0, TAU),
    dashCd: rand(1.5, 3), dashTime: 0, dashDir: 0, teleCd: rand(5, 9),
    retargetCd: 0, targetId: null,
    hue: t.hue + rand(-14, 14), hp: t.hp || 1,
    outX: Math.cos(a), outY: Math.sin(a)
  });
}

function nearestPlayer(x, y, maxD){
  let best = null, bestD = maxD || Infinity;
  const list = playerHash.query(x, y, maxD || CFG.aoiRadius, []);
  for(const p of list){
    if(!p.alive) continue;
    const d = wrapDist(p.x, p.y, x, y);
    if(d < bestD){ bestD = d; best = p; }
  }
  return best;
}

function updateEnemy(e, dt){
  if(e.dead || !e.alive) return;
  const t = MBYID[e.typeId];
  if(!t){ e.dead = true; e.alive = false; return; }
  if(!isFinite(e.x) || !isFinite(e.y) || !isFinite(e.angle)){ e.dead = true; e.alive = false; return; }

  if(e.spawnAnim > 0){
    const prev = e.spawnAnim;
    e.spawnAnim = Math.max(0, e.spawnAnim - dt);
    const progress = clamp(1 - e.spawnAnim / CFG.emergeDuration, 0, 1);
    e.emergeT = progress;
    const ease = 1 - Math.pow(1 - progress, 3);
    e.x = wrap((e.px0 ?? e.x) + wrapDelta(e.targetX ?? e.x, e.px0 ?? e.x) * ease);
    e.y = wrap((e.py0 ?? e.y) + wrapDelta(e.targetY ?? e.y, e.py0 ?? e.y) * ease);
    if(prev > 0 && e.spawnAnim === 0){
      const outAngle = Math.atan2(e.outY || 0, e.outX || 0) + rand(-0.5, 0.5);
      e.vx = Math.cos(outAngle) * t.speed * 1.8;
      e.vy = Math.sin(outAngle) * t.speed * 1.8;
    }
    return;
  }

  e.dashCd = Math.max(0, e.dashCd - dt);
  e.teleCd = Math.max(0, e.teleCd - dt);
  e.wanderPhase += dt * 2.5;
  e.retargetCd -= dt;

  let target = e.targetId != null ? players.get(e.targetId) : null;
  if(!target || !target.alive || e.retargetCd <= 0){
    target = nearestPlayer(e.x, e.y, 1600);
    e.targetId = target ? target.id : null;
    e.retargetCd = rand(2.0, 4.0);
  }

  if(!target){
    const w = t.speed * 0.75;
    const wx = Math.cos(e.wanderPhase * 1.5) * w;
    const wy = Math.sin(e.wanderPhase * 1.1) * w;
    e.vx = lerp(e.vx, wx, 0.10);
    e.vy = lerp(e.vy, wy, 0.10);
    e.x = wrap(e.x + e.vx * dt); e.y = wrap(e.y + e.vy * dt);
    if(e.typeId !== 'ghost') collideObstacles(e, t.radius * 0.9);
    e.walkPhase += dt * 8;
    return;
  }

  const dxT = wrapDelta(target.x, e.x), dyT = wrapDelta(target.y, e.y);
  const dvT = Math.hypot(dxT, dyT) || 0.001;
  const dirTX = dxT / dvT, dirTY = dyT / dvT;
  let desireX = dirTX, desireY = dirTY;

  if(t.ai === 'dasher'){
    if(e.dashTime <= 0 && e.dashCd <= 0 && dvT < 380 && dvT > 140){
      if(Math.random() < dt * 0.55){
        e.dashTime = 0.24; e.dashDir = Math.atan2(dyT, dxT); e.dashCd = rand(2.5, 4.0);
      }
    }
  } else if(t.ai === 'strafe'){
    if(dvT < 280){
      const s = Math.sin(tick * 0.08 + e.wobblePhase);
      desireX = dirTX + (-dirTY) * s * 0.75;
      desireY = dirTY + ( dirTX) * s * 0.75;
    }
  } else if(t.ai === 'teleport'){
    if(e.teleCd <= 0 && dvT > 320 && dvT < 800){
      e.teleCd = rand(5, 9);
      const side = Math.random() < 0.5 ? -1 : 1;
      const behind = Math.atan2(dyT, dxT) + side * (Math.PI / 2 + rand(-0.3, 0.3));
      const rr = rand(120, 180);
      e.x = wrap(target.x + Math.cos(behind) * rr);
      e.y = wrap(target.y + Math.sin(behind) * rr);
      e.vx = 0; e.vy = 0;
    }
  } else if(t.ai === 'tank'){
    if(dvT < 180){ desireX *= 0.75; desireY *= 0.75; }
  }

  let sepX = 0, sepY = 0;
  const near = enemyHash.query(e.x, e.y, 100, []);
  for(const other of near){
    if(other === e || !other.alive || other.dead || other.spawnAnim > 0.5) continue;
    const ot = MBYID[other.typeId]; if(!ot) continue;
    const dx = wrapDelta(e.x, other.x), dy = wrapDelta(e.y, other.y);
    const d = Math.hypot(dx, dy) || 0.001;
    const minD = t.radius + ot.radius + 20;
    if(d < minD * 1.8){
      const w = (minD * 1.8 - d) / (minD * 1.8);
      sepX += (dx / d) * w * 2.2; sepY += (dy / d) * w * 2.2;
    }
  }

  let avoidX = 0, avoidY = 0;
  const lookAhead = 55;
  const fx = e.x + desireX * lookAhead, fy = e.y + desireY * lookAhead;
  for(const o of obstacles){
    const dx = wrapDelta(o.x, fx), dy = wrapDelta(o.y, fy);
    const distSq = dx*dx + dy*dy;
    const bound = o.boundR + t.radius + 8;
    if(distSq < bound * bound){
      const odx = wrapDelta(e.x, o.x), ody = wrapDelta(e.y, o.y);
      const od = Math.hypot(odx, ody) || 1;
      let perpX = -ody / od, perpY = odx / od;
      const dot = perpX * desireX + perpY * desireY;
      if(dot < 0){ perpX = -perpX; perpY = -perpY; }
      const w = (bound - Math.sqrt(distSq)) / bound;
      avoidX += perpX * w * 2.2; avoidY += perpY * w * 2.2;
    }
  }

  let moveX = desireX + sepX + avoidX;
  let moveY = desireY + sepY + avoidY;
  const mm = Math.hypot(moveX, moveY) || 1;
  moveX /= mm; moveY /= mm;

  let speed = t.speed;
  if(e.dashTime > 0){
    e.dashTime -= dt; speed = t.speed * 3.0;
    moveX = Math.cos(e.dashDir); moveY = Math.sin(e.dashDir);
  }

  const k = 1 - Math.pow(0.000003, dt);
  e.vx = lerp(e.vx, moveX * speed, k);
  e.vy = lerp(e.vy, moveY * speed, k);
  e.x = wrap(e.x + e.vx * dt); e.y = wrap(e.y + e.vy * dt);
  const ta = Math.atan2(dyT, dxT);
  e.angle = normAng(e.angle + angDiff(ta, e.angle) * Math.min(1, dt * 10));
  if(!isFinite(e.angle)) e.angle = 0;
  if(e.typeId !== 'ghost') collideObstacles(e, t.radius * 0.9);
  e.walkPhase += dt * 8; e.wobblePhase += dt * 3;

  if(target.spawnProt <= 0 && target.alive){
    if(wrapDist(e.x, e.y, target.x, target.y) < t.radius + 15) killPlayer(target, e, 'monster');
  }
}

function hitEnemy(e, byPlayer, dmg){
  if(e.dead) return;
  e.hp = (e.hp || 1) - dmg;
  if(e.hp <= 0) killEnemy(e, byPlayer);
  else events.push({ t:'hit', x:r1(e.x), y:r1(e.y), h:Math.round(e.hue) });
}

function killEnemy(e, byPlayer){
  if(e.dead) return;
  e.dead = true; e.alive = false;
  const i = enemies.indexOf(e); if(i >= 0) enemies.splice(i, 1);
  events.push({ t:'burst', x:r1(e.x), y:r1(e.y), h:Math.round(e.hue) });
  if(byPlayer && byPlayer.id && players.has(byPlayer.id)){
    byPlayer.kills++;
    byPlayer.xp += MBYID[e.typeId].xp || 1;
    while(byPlayer.xp >= byPlayer.xpNeed){
      byPlayer.xp -= byPlayer.xpNeed; byPlayer.level++;
      byPlayer.xpNeed = xpForLevel(byPlayer.level);
      events.push({ t:'levelup', x:r1(byPlayer.x), y:r1(byPlayer.y), h:byPlayer.hue, id:byPlayer.id });
    }
  }
}

function fireArrow(p){
  arrows.push({
    id: nextArrowId++, ownerId: p.id, team: p.team,
    x: wrap(p.x + Math.cos(p.angle)*22), y: wrap(p.y + Math.sin(p.angle)*22),
    px: wrap(p.x + Math.cos(p.angle)*22), py: wrap(p.y + Math.sin(p.angle)*22),
    vx: Math.cos(p.angle)*CFG.arrowSpeed, vy: Math.sin(p.angle)*CFG.arrowSpeed,
    angle: p.angle, life: (pRange(p)*2.6)/CFG.arrowSpeed, hue: p.hue
  });
}
function canAttackTeam(a, b){ return a === 'ffa' || b === 'ffa' || a !== b; }

function updateArrows(dt){
  for(let i=arrows.length-1; i>=0; i--){
    const a = arrows[i];
    a.px = a.x; a.py = a.y;
    a.x = wrap(a.x + a.vx*dt); a.y = wrap(a.y + a.vy*dt); a.life -= dt;
    const totalD = Math.hypot(wrapDelta(a.x, a.px), wrapDelta(a.y, a.py));
    const steps = Math.max(1, Math.ceil(totalD / 12));
    let hit = false;
    for(let s = 1; s <= steps && !hit; s++){
      const t = s / steps;
      const sx = wrap(a.px + wrapDelta(a.x, a.px) * t);
      const sy = wrap(a.py + wrapDelta(a.y, a.py) * t);
      for(let j=enemies.length-1; j>=0; j--){
        const e = enemies[j], ty = MBYID[e.typeId];
        if(!ty || e.spawnAnim > 0.5 || e.dead) continue;
        if(wrapDist(e.x, e.y, sx, sy) < ty.radius + 6){
          const owner = players.get(a.ownerId);
          hitEnemy(e, owner, owner ? pDamage(owner) : 1);
          hit = true; break;
        }
      }
      if(hit) break;
      const near = playerHash.query(sx, sy, 40, []);
      for(const p of near){
        if(p.id === a.ownerId || !p.alive || p.spawnProt > 0) continue;
        if(!canAttackTeam(a.team, p.team)) continue;
        if(wrapDist(p.x, p.y, sx, sy) < 16){ killPlayer(p, players.get(a.ownerId), 'arrow'); hit = true; break; }
      }
      if(hit) break;
      for(const o of obstacles){
        const dx = wrapDelta(o.x, sx), dy = wrapDelta(o.y, sy);
        if(dx*dx + dy*dy > (o.boundR + 6)*(o.boundR + 6)) continue;
        const cos = o.cosr, sin = o.sinr;
        const lx =  dx * cos + dy * sin, ly = -dx * sin + dy * cos;
        if(pointInPolygon(o.pts, lx, ly)){ hit = true; break; }
        let d2min = Infinity;
        for(let k=0; k<o.pts.length; k++){
          const A = o.pts[k], B = o.pts[(k+1) % o.pts.length];
          const cp = closestPointOnSegment(lx, ly, A.x, A.y, B.x, B.y);
          if(cp.d2 < d2min) d2min = cp.d2;
        }
        if(d2min < 25){ hit = true; break; }
      }
    }
    if(hit || a.life <= 0) arrows.splice(i, 1);
  }
}

function doAttack(p){
  if(!p.alive || p.atkCd > 0) return;
  p.atkCd = pCd(p); p.swing = 0.16; p.swingDir = p.angle;
  if(CHARACTERS[p.charId].ranged){ fireArrow(p); return; }
  const range = pRange(p), arc = CFG.swordArc;
  for(let i=enemies.length-1; i>=0; i--){
    const e = enemies[i], t = MBYID[e.typeId];
    if(!t || e.spawnAnim > 0.5 || e.dead) continue;
    const d = wrapDist(e.x, e.y, p.x, p.y);
    if(d < range + t.radius*0.5){
      const a = Math.atan2(wrapDelta(e.y, p.y), wrapDelta(e.x, p.x));
      const angSize = t.radius / Math.max(d, 1);
      if(Math.abs(angDiff(a, p.angle)) < arc + angSize) hitEnemy(e, p, pDamage(p));
    }
  }
  const near = playerHash.query(p.x, p.y, range+40, []);
  for(const q of near){
    if(q.id === p.id || !q.alive || q.spawnProt > 0) continue;
    if(!canAttackTeam(p.team, q.team)) continue;
    const d = wrapDist(q.x, q.y, p.x, p.y);
    if(d < range + 12){
      const a = Math.atan2(wrapDelta(q.y, p.y), wrapDelta(q.x, p.x));
      if(Math.abs(angDiff(a, p.angle)) < arc + 0.2) killPlayer(q, p, 'melee');
    }
  }
}

/* ✅ بازنشانی کامل + پاداش قاتل */
function killPlayer(p, killer, cause){
  if(!p.alive || p.spawnProt > 0) return;

  // سپر تانک
  if(CHARACTERS[p.charId].shield && p.shieldCharge >= 1){
    p.shieldCharge = 0; p.spawnProt = 1.2; p.blockFlash = 1;
    events.push({ t:'block', x:r1(p.x), y:r1(p.y), h:p.hue, id:p.id });
    return;
  }

  let dmg = 1;
  if(cause === 'monster' && killer && killer.typeId) dmg = MBYID[killer.typeId].dmg || 1;
  else if(killer && killer.id) dmg = pDamage(killer);

  p.hp -= dmg;
  if(p.hp > 0){
    p.spawnProt = 0.8; p.blockFlash = 1;
    events.push({ t:'hurt', x:r1(p.x), y:r1(p.y), h:p.hue, id:p.id, hp:p.hp });
    return;
  }

  // مرگ
  p.alive = false; p.deaths++; p.respawn = CFG.respawnTime;
  p.vx = 0; p.vy = 0; p.swing = 0;

  // ✅ ریست فوری سطح و ویژگی‌ها روی سرور
  const lostLevel = p.level;
  p.level = 1;
  p.xp = 0;
  p.xpNeed = xpForLevel(1);

  events.push({ t:'burst', x:r1(p.x), y:r1(p.y), h:p.hue, big:true });
  events.push({ t:'death', x:r1(p.x), y:r1(p.y), id:p.id, by: killer ? (killer.name || 'monster') : 'nature', lostLevel });

  // ✅ پاداش قاتل بازیکن (اگر قاتل، بازیکن دیگری باشد)
  if(killer && killer.id && killer.id !== p.id && players.has(killer.id) && killer.alive){
    killer.kills++;
    killer.xp += CFG.playerKillXp;
    let leveledUp = false;
    while(killer.xp >= killer.xpNeed){
      killer.xp -= killer.xpNeed; killer.level++;
      killer.xpNeed = xpForLevel(killer.level);
      leveledUp = true;
      events.push({ t:'levelup', x:r1(killer.x), y:r1(killer.y), h:killer.hue, id:killer.id });
    }
    // ✅ رویداد kill برای اطلاع قاتل
    events.push({
      t:'kill',
      killerId: killer.id,
      killerName: killer.name,
      victimId: p.id,
      victimName: p.name,
      x: r1(p.x), y: r1(p.y),
      levelUp: leveledUp ? 1 : 0
    });
  }
}

function updatePlayer(p, dt){
  if(!p.alive){
    p.respawn -= dt;
    if(p.respawn <= 0) spawnPlayer(p);
    return;
  }
  if(!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.angle)){ spawnPlayer(p); return; }

  p.atkCd = Math.max(-1, p.atkCd - dt);
  p.swing = Math.max(-1, p.swing - dt);
  p.dashCd = Math.max(-1, p.dashCd - dt);
  p.spawnProt = Math.max(-1, p.spawnProt - dt);
  p.blockFlash = Math.max(0, p.blockFlash - dt*1.8);
  if(CHARACTERS[p.charId].shield && p.shieldCharge < 1)
    p.shieldCharge = Math.min(1, p.shieldCharge + dt / CFG.tankShieldRecharge);

  const moving = Math.hypot(p.inX, p.inY) > 0.02;
  let targetAngle = p.angle;
  // ✅ استفاده از aimSet به‌جای aim !== 0 (زاویه‌ی راست معتبر است)
  if(p.aimSet && typeof p.aim === 'number' && isFinite(p.aim)) targetAngle = p.aim;
  else if(moving) targetAngle = Math.atan2(p.inY, p.inX);
  p.angle = normAng(p.angle + angDiff(targetAngle, p.angle) * Math.min(1, dt*15));
  if(!isFinite(p.angle)) p.angle = 0;

  // ✅ اعمال کول‌داون جهش (باگ اکسپلویت رفع شد)
  if(p.wantDash){
    p.wantDash = false;
    if(p.dashTime <= 0 && p.dashCd <= 0){
      p.dashCd = pDashCd(p);     // ✅ ضریب شخصیت
      p.dashTime = CFG.dashDur;
      p.dashDir = moving ? Math.atan2(p.inY, p.inX) : p.angle;
    }
  }

  const spd = pSpeed(p);
  if(p.dashTime > 0){
    p.dashTime -= dt;
    const ds = pDashSpeed(p), moveD = ds * dt;
    const steps = Math.max(1, Math.ceil(moveD / 20));
    for(let s=0; s<steps; s++){
      p.x = wrap(p.x + Math.cos(p.dashDir)*moveD/steps);
      p.y = wrap(p.y + Math.sin(p.dashDir)*moveD/steps);
      collideObstacles(p, 16);
    }
    p.walkPhase += dt*20;
  } else {
    const k = 1 - Math.pow(0.0000018, dt);
    p.vx = lerp(p.vx, p.inX*spd, k);
    p.vy = lerp(p.vy, p.inY*spd, k);
    const vx = p.vx*dt, vy = p.vy*dt;
    const mlen = Math.hypot(vx, vy);
    const steps = Math.max(1, Math.ceil(mlen / 20));
    for(let s=0; s<steps; s++){
      p.x = wrap(p.x + vx/steps); p.y = wrap(p.y + vy/steps);
      collideObstacles(p, 16);
    }
    p.walkPhase += moving ? dt*11 : dt*2.5;
  }

  if(p.wantAttack || p.wantAttackHeld) doAttack(p);
  p.wantAttack = false;
}

let spawnTimer = 0;
function buildHashes(){
  playerHash.clear();
  for(const p of players.values()) playerHash.insert(p);
  enemyHash.clear();
  for(const e of enemies) enemyHash.insert(e);
}

function trySpawnEnemies(dt){
  for(const p of PORTALS) p.cooldown = Math.max(0, p.cooldown - dt);
  spawnTimer -= dt;
  if(spawnTimer > 0) return;
  const target = Math.min(CFG.maxEnemies, CFG.minEnemies + players.size * CFG.enemiesPerPlayer);
  if(enemies.length >= target){ spawnTimer = 0.4; return; }
  const avail = PORTALS.filter(p => p.cooldown <= 0);
  if(avail.length === 0){ spawnTimer = 0.15; return; }
  let totalW = 0;
  const weights = [];
  for(const p of avail){
    const near = nearestPlayer(p.x, p.y, 1500);
    const dist = near ? wrapDist(p.x, p.y, near.x, near.y) : 2000;
    const w = dist + rand(0, 600);
    weights.push(w); totalW += w;
  }
  let r = Math.random() * totalW, pickIdx = 0;
  for(let i = 0; i < avail.length; i++){
    r -= weights[i];
    if(r <= 0){ pickIdx = i; break; }
  }
  const portal = avail[pickIdx];
  spawnEnemyFromPortal(portal);
  portal.cooldown = rand(CFG.portalCooldown[0], CFG.portalCooldown[1]);
  spawnTimer = rand(CFG.spawnInterval[0], CFG.spawnInterval[1]);
}

function tickWorld(){
  const dt = CFG.tickMs / 1000;
  tick++;
  buildHashes();
  const now = Date.now();
  for(const p of players.values()){
    if(!isFinite(p.x) || !isFinite(p.y)){ spawnPlayer(p); continue; }
    updatePlayer(p, dt);
    if(now - p.lastInputAt > CFG.stalePlayerMs && p.ws && p.ws.readyState === 1){
      try{ p.ws.close(); }catch(e){}
    }
  }
  for(let i=enemies.length-1; i>=0; i--){
    const e = enemies[i];
    if(e.dead || !e.alive){ enemies.splice(i,1); continue; }
    if(!isFinite(e.x) || !isFinite(e.y) || !isFinite(e.angle)){ enemies.splice(i,1); continue; }
    updateEnemy(e, dt);
  }
  updateArrows(dt);
  trySpawnEnemies(dt);
  if(now - lastLbTime > 1000){
    lastLbTime = now;
    const list = [...players.values()];
    list.sort((a,b)=> (b.kills - a.kills) || (a.deaths - b.deaths) || (b.level - a.level));
    leaderboard = list.slice(0, CFG.lbSize).map(p=>({
      id: p.id, name: p.name, kills: p.kills, deaths: p.deaths,
      level: p.level, team: p.team, hue: p.hue
    }));
  }
}

function send(ws, obj){ if(ws && ws.readyState === 1){ try{ ws.send(JSON.stringify(obj)); }catch(e){} } }

function buildStateFor(p){
  const r = CFG.aoiRadius, r2 = r*r;
  const nearP = playerHash.query(p.x, p.y, r, p.aoiBuf);
  const pOut = [];
  for(const q of nearP){
    // ✅ حذف خود بازیکن از pOut
    if(q.id === p.id) continue;
    if(!q.alive) continue;
    const dx = wrapDelta(q.x, p.x), dy = wrapDelta(q.y, p.y);
    if(dx*dx + dy*dy > r2) continue;
    pOut.push({
      id:q.id, n:q.name, c:q.charId, tm:q.team, h:q.hue,
      x:r1(q.x), y:r1(q.y), a:r2(q.angle), al:q.alive ? 1 : 0,
      hp:q.hp, mhp:pMaxHp(q), k:q.kills, d:q.deaths, lv:q.level,
      sw:q.swing>0?1:0, sd:r2(q.swingDir), dt:q.dashTime>0?1:0,
      sp:q.spawnProt>0?1:0, sc:r2(q.shieldCharge), bf:r2(q.blockFlash),
      wp:r1(q.walkPhase), ac:r2(q.atkCd)
    });
  }
  const nearE = enemyHash.query(p.x, p.y, r, []);
  const eOut = [];
  for(const e of nearE){
    if(e.dead) continue;
    const dx = wrapDelta(e.x, p.x), dy = wrapDelta(e.y, p.y);
    if(dx*dx + dy*dy > r2) continue;
    const t = MBYID[e.typeId]; if(!t) continue;
    eOut.push({ id:e.id, ty:e.typeId, x:r1(e.x), y:r1(e.y), a:r2(e.angle),
      h:Math.round(e.hue), sa:r2(e.spawnAnim), wp:r1(e.walkPhase), wb:r1(e.wobblePhase),
      hp:e.hp, mhp:t.hp });
  }
  const aOut = [];
  for(const a of arrows){
    const dx = wrapDelta(a.x, p.x), dy = wrapDelta(a.y, p.y);
    if(dx*dx + dy*dy > r2) continue;
    aOut.push({ id:a.id, ownerId:a.ownerId, x:r1(a.x), y:r1(a.y), a:r2(a.angle), h:Math.round(a.hue) });
  }
  return {
    t:'state', tick,
    me:{ x:r1(p.x), y:r1(p.y), a:r2(p.angle), al:p.alive?1:0,
      hp:p.hp, mhp:pMaxHp(p), dmg:pDamage(p),
      k:p.kills, d:p.deaths, lv:p.level, xp:p.xp, xn:p.xpNeed,
      sp:r2(p.spawnProt), sc:r2(p.shieldCharge), bf:r2(p.blockFlash),
      rs:r2(p.respawn), dc:r2(p.dashCd), ac:r2(p.atkCd), swd:p.swing>0?1:0 },  // ✅ ac
    p:pOut, e:eOut, ar:aOut, lb:leaderboard
  };
}

function broadcastStates(){ for(const p of players.values()) send(p.ws, buildStateFor(p)); }
function broadcast(obj, exceptId){
  for(const p of players.values()){
    if(exceptId && p.id === exceptId) continue;
    send(p.ws, obj);
  }
}
function flushEvents(){
  if(!events.length) return;
  broadcast({ t:'ev', ev: events.slice() });
  events.length = 0;
}

const server = http.createServer((req, res) => {
  if(req.url === '/' || req.url === '/index.html'){
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if(err){ res.writeHead(500); res.end('index.html missing'); return; }
      res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  if(req.url === '/stats'){
    res.writeHead(200, { 'Content-Type':'application/json', 'Cache-Control':'no-store' });
    res.end(JSON.stringify({
      players: players.size, enemies: enemies.length, arrows: arrows.length,
      portals: PORTALS.length, tick, uptime: Math.floor(process.uptime())
    }));
    return;
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({
  server, perMessageDeflate: false, clientTracking: true, maxPayload: 1024 * 64
});

wss.on('connection', (ws) => {
  let player = null;
  ws.isAlive = true;
  ws.on('pong', ()=>{ ws.isAlive = true; });

  ws.on('message', raw => {
    let msg; try{ msg = JSON.parse(raw); }catch(e){ return; }

    // ✅ آپدیت lastInputAt روی هر پیام (نه فقط in)
    if(player) player.lastInputAt = Date.now();

    if(msg.t === 'ping'){ return; }

    if(msg.t === 'join'){
      if(player) return;
      if(players.size >= CFG.maxPlayers){ send(ws, { t:'error', msg:'Server full' }); try{ ws.close(); }catch(e){} return; }
      const id = nextPlayerId++;
      player = makePlayer(id, msg.name, msg.charId, msg.team, msg.color, ws);
      players.set(id, player);
      send(ws, {
        t:'welcome', id, worldSize: WSZ,
        obstacles: obstacles.map(o => ({ x:o.x, y:o.y, r:o.r, pts:o.pts, rot:o.rot })),
        portals: PORTALS.map(p => ({ id:p.id, x:p.x, y:p.y, hue:p.hue, radius:p.radius })),
        x:r1(player.x), y:r1(player.y), team:player.team, hue:player.hue,
        chatHistory: chatHistory.slice(-20)
      });
      // ✅ broadcast join به همه به‌جز خود بازیکن جدید
      broadcast({
        t:'ev',
        ev:[{ t:'join', name:player.name, x:r1(player.x), y:r1(player.y), h:player.hue, team:player.team }]
      }, player.id);
      console.log(`[join] #${id} ${player.name} — online ${players.size}`);
      return;
    }

    if(!player) return;

    if(msg.t === 'in'){
      player.inX = clamp(+msg.mx || 0, -1, 1);
      player.inY = clamp(+msg.my || 0, -1, 1);
      // ✅ استفاده از aimSet
      if(typeof msg.aim === 'number' && isFinite(msg.aim)){
        player.aim = msg.aim;
        player.aimSet = true;
      }
      if(msg.dash) player.wantDash = true;
      if(msg.atk) player.wantAttack = true;
      player.wantAttackHeld = !!msg.atkHeld;
      return;
    }

    if(msg.t === 'chat'){
      const now = Date.now();
      if(now - player.lastChatAt < CFG.chatCooldown) return;
      player.lastChatAt = now;
      const text = String(msg.text || '').slice(0, CFG.chatMaxLen).trim();
      if(!text) return;
      const payload = { t:'chat', from:player.name, fromId:player.id, team:player.team, hue:player.hue, text, ts:now };
      chatHistory.push(payload);
      if(chatHistory.length > CFG.chatHistorySize) chatHistory.shift();
      broadcast(payload);
      return;
    }

    if(msg.t === 'team'){
      const tm = TEAMS[msg.team] ? msg.team : 'ffa';
      player.team = tm;
      if(player.color === 'auto') player.hue = resolveHue(tm, 'auto', player.charId);
      return;
    }

    if(msg.t === 'color'){
      player.color = String(msg.color || 'auto');
      player.hue = resolveHue(player.team, player.color, player.charId);
      return;
    }
  });

  ws.on('close', () => {
    if(player){
      players.delete(player.id);
      broadcast({ t:'ev', ev:[{ t:'leave', name:player.name, x:r1(player.x), y:r1(player.y), h:player.hue }] });
      console.log(`[leave] #${player.id} — online ${players.size}`);
      player = null;
    }
  });
  ws.on('error', ()=>{});
});

const wsPingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if(ws.isAlive === false){ try{ ws.terminate(); }catch(e){} return; }
    ws.isAlive = false;
    try{ ws.ping(); }catch(e){}
  });
}, 25000);
wss.on('close', ()=> clearInterval(wsPingInterval));

genWorld();
genPortals();
for(let i=0; i<10; i++){
  const p = PORTALS[i % PORTALS.length];
  if(p) spawnEnemyFromPortal(p);
}
setInterval(tickWorld, CFG.tickMs);
setInterval(broadcastStates, Math.floor(1000 / CFG.netHz));
setInterval(flushEvents, 50);

process.on('uncaughtException', (err)=>{ console.error('[uncaught]', err.message); });
process.on('unhandledRejection', (err)=>{ console.error('[unhandled]', err); });

server.listen(PORT, () => {
  console.log(`One Hit Arena on port ${PORT}`);
});