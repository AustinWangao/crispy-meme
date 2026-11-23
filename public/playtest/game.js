const SIZE = 4;
const CELLS = SIZE * SIZE;
const LEVELS = [
  { flips: 3, seed: 20261123, cn: '初夜' },
  { flips: 5, seed: 20261124, cn: '微光' },
  { flips: 7, seed: 20261125, cn: '长夜' },
];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function toggle(grid, index) {
  const row = Math.floor(index / SIZE);
  const col = index % SIZE;
  const next = grid.slice();
  const flip = (r, c) => {
    if (r >= 0 && r < SIZE && c >= 0 && c < SIZE) next[r * SIZE + c] = !next[r * SIZE + c];
  };
  flip(row, col);
  flip(row - 1, col);
  flip(row + 1, col);
  flip(row, col - 1);
  flip(row, col + 1);
  return next;
}

export function isSolved(grid) {
  return grid.every((cell) => !cell);
}

export function createLevel(flips, seed) {
  let grid = Array(CELLS).fill(false);
  const random = mulberry32(seed);
  const used = new Set();
  const moves = [];
  let guard = 0;

  while (moves.length < flips && guard < 500) {
    guard += 1;
    const index = Math.floor(random() * CELLS);
    if (used.has(index)) continue;
    used.add(index);
    moves.push(index);
    grid = toggle(grid, index);
  }

  if (isSolved(grid)) {
    const spare = [...Array(CELLS).keys()].find((index) => !used.has(index));
    if (spare !== undefined) {
      moves.push(spare);
      grid = toggle(grid, spare);
    }
  }

  // 灯阵翻转自逆：按原顺序反着点一遍即可回到全灭。
  return { grid, solution: [...moves].reverse() };
}

function boot() {
  const boardEl = document.getElementById('board');
  const wrapEl = document.getElementById('board-wrap');
  const movesEl = document.getElementById('moves');
  const chapterEnEl = document.getElementById('chapter-en');
  const chapterCnEl = document.getElementById('chapter-cn');
  const liveEl = document.getElementById('live');
  const resetBtn = document.getElementById('reset');
  const restartBtn = document.getElementById('restart');
  const autosolveBtn = document.getElementById('autosolve');
  const veilEl = document.getElementById('veil');
  const veilStatEl = document.getElementById('veil-stat');
  const nextBtn = document.getElementById('next');
  const canvas = document.getElementById('dust');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isDev = new URLSearchParams(window.location.search).has('dev');

  let levelIndex = 0;
  let level = createLevel(LEVELS[0].flips, LEVELS[0].seed);
  let grid = level.grid.slice();
  let moves = 0;
  let locked = false;
  let switching = false;
  let switchTimer = 0;

  const tiles = [];
  for (let index = 0; index < CELLS; index += 1) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.dataset.index = String(index);
    tile.addEventListener('click', (event) => handleTile(index, event));
    boardEl.appendChild(tile);
    tiles.push(tile);
  }

  function render() {
    tiles.forEach((tile, index) => {
      const lit = grid[index];
      const row = Math.floor(index / SIZE) + 1;
      const col = (index % SIZE) + 1;
      tile.setAttribute('aria-pressed', String(lit));
      tile.setAttribute('aria-label', `第 ${row} 行第 ${col} 列，${lit ? '亮' : '灭'}`);
    });
    movesEl.textContent = String(moves);
  }

  function startLevel(index, { animate = true, announce = true } = {}) {
    window.clearTimeout(switchTimer);
    const target = (index + LEVELS.length) % LEVELS.length;

    const apply = () => {
      levelIndex = target;
      const config = LEVELS[levelIndex];
      level = createLevel(config.flips, config.seed);
      grid = level.grid.slice();
      moves = 0;
      locked = false;
      switching = false;
      boardEl.classList.remove('is-cleared');
      wrapEl.classList.remove('is-cleared');
      veilEl.hidden = true;
      const chapter = String(levelIndex + 1).padStart(2, '0');
      chapterEnEl.textContent = `CHAPTER ${chapter} / ${String(LEVELS.length).padStart(2, '0')}`;
      chapterCnEl.textContent = `第 ${levelIndex + 1} 章 · ${config.cn}`;
      render();
      if (announce) liveEl.textContent = `第 ${levelIndex + 1} 章，${config.cn}`;
    };

    if (animate && !reducedMotion.matches) {
      switching = true;
      boardEl.classList.add('is-switching');
      switchTimer = window.setTimeout(() => {
        apply();
        window.requestAnimationFrame(() => boardEl.classList.remove('is-switching'));
      }, 260);
    } else {
      apply();
      boardEl.classList.remove('is-switching');
    }
  }

  function addRipple(tile, event) {
    const rect = tile.getBoundingClientRect();
    const keyboard = !event || event.detail === 0;
    const x = keyboard ? rect.width / 2 : event.clientX - rect.left;
    const y = keyboard ? rect.height / 2 : event.clientY - rect.top;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.setProperty('--x', `${x}px`);
    ripple.style.setProperty('--y', `${y}px`);
    tile.appendChild(ripple);
    window.setTimeout(() => ripple.remove(), 700);
  }

  function handleTile(index, event) {
    if (locked || switching) return;
    addRipple(tiles[index], event);
    grid = toggle(grid, index);
    moves += 1;
    render();
    spawnBurst(tileCenter(tiles[index]), 7);
    if (isSolved(grid)) win();
  }

  function win() {
    locked = true;
    boardEl.classList.add('is-cleared');
    wrapEl.classList.add('is-cleared');
    liveEl.textContent = `第 ${levelIndex + 1} 章完成，用了 ${moves} 步`;
    veilStatEl.textContent = `第 ${levelIndex + 1} 章 · 用了 ${moves} 步`;
    nextBtn.textContent = levelIndex === LEVELS.length - 1 ? '再从第一夜开始' : '继续寻星';
    celebrate();
    window.setTimeout(
      () => {
        veilEl.hidden = false;
        nextBtn.focus();
      },
      reducedMotion.matches ? 0 : 720,
    );
  }

  resetBtn.addEventListener('click', () => startLevel(levelIndex, { animate: false }));
  restartBtn.addEventListener('click', () => startLevel(0));
  nextBtn.addEventListener('click', () => startLevel(levelIndex + 1));

  if (isDev) {
    autosolveBtn.hidden = false;
    autosolveBtn.addEventListener('click', () => {
      startLevel(levelIndex, { animate: false, announce: false });
      const solution = [...level.solution];
      let cursor = 0;
      const step = () => {
        if (cursor >= solution.length) {
          if (!locked && isSolved(grid)) win();
          return;
        }
        const index = solution[cursor];
        cursor += 1;
        addRipple(tiles[index], null);
        grid = toggle(grid, index);
        moves += 1;
        render();
        spawnBurst(tileCenter(tiles[index]), 5);
        window.setTimeout(step, reducedMotion.matches ? 0 : 130);
      };
      window.setTimeout(step, reducedMotion.matches ? 0 : 180);
    });
  }

  /* ---------- 星尘与微光 ---------- */

  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let dust = [];
  let sparks = [];
  let raf = 0;
  let lastFrame = 0;

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seedDust();
    if (reducedMotion.matches) drawStatic();
  }

  function seedDust() {
    const count = width < 520 ? 74 : 128;
    dust = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 0.5 + Math.random() * 1.6,
      vy: 0.04 + Math.random() * 0.14,
      drift: (Math.random() - 0.5) * 0.08,
      phase: Math.random() * Math.PI * 2,
      twinkle: 0.4 + Math.random() * 1.4,
      warm: Math.random() > 0.72,
    }));
  }

  function tileCenter(tile) {
    const rect = tile.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function spawnBurst(point, count) {
    if (reducedMotion.matches) return;
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.3 + Math.random() * 1.1;
      sparks.push({
        x: point.x,
        y: point.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.3,
        r: 0.8 + Math.random() * 1.4,
        life: 0,
        ttl: 700 + Math.random() * 500,
        warm: true,
      });
    }
  }

  function celebrate() {
    if (reducedMotion.matches) return;
    for (let i = 0; i < 46; i += 1) {
      sparks.push({
        x: Math.random() * width,
        y: height + Math.random() * 60,
        vx: (Math.random() - 0.5) * 0.35,
        vy: -(0.5 + Math.random() * 1.1),
        r: 0.8 + Math.random() * 1.6,
        life: 0,
        ttl: 1600 + Math.random() * 900,
        warm: true,
      });
    }
  }

  function paintDust(time, progress) {
    for (const particle of dust) {
      const alpha = 0.2 + 0.36 * (0.5 + 0.5 * Math.sin(time * 0.001 * particle.twinkle + particle.phase));
      const tint = particle.warm ? '255, 214, 160' : '214, 232, 226';
      if (particle.r > 1.7) {
        ctx.beginPath();
        ctx.fillStyle = `rgba(${tint}, ${alpha * 0.16})`;
        ctx.arc(particle.x, particle.y, particle.r * 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.fillStyle = `rgba(${tint}, ${alpha})`;
      ctx.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
      ctx.fill();
      if (progress) {
        particle.y -= particle.vy;
        particle.x += particle.drift;
        if (particle.y < -4) {
          particle.y = height + 4;
          particle.x = Math.random() * width;
        }
        if (particle.x < -4) particle.x = width + 4;
        if (particle.x > width + 4) particle.x = -4;
      }
    }

    for (let i = sparks.length - 1; i >= 0; i -= 1) {
      const spark = sparks[i];
      spark.life += progress ? 16 : spark.ttl;
      if (spark.life >= spark.ttl) {
        sparks.splice(i, 1);
        continue;
      }
      spark.x += spark.vx * (progress ? 0.9 : 0);
      spark.y += spark.vy * (progress ? 0.9 : 0);
      const fade = 1 - spark.life / spark.ttl;
      ctx.beginPath();
      ctx.fillStyle = spark.warm
        ? `rgba(255, 219, 168, ${fade * 0.9})`
        : `rgba(214, 232, 226, ${fade * 0.7})`;
      ctx.arc(spark.x, spark.y, spark.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function frame(now) {
    if (!raf) return;
    lastFrame = now;
    ctx.clearRect(0, 0, width, height);
    paintDust(now, true);
    raf = window.requestAnimationFrame(frame);
  }

  function drawStatic() {
    ctx.clearRect(0, 0, width, height);
    paintDust(performance.now(), false);
  }

  function startDust() {
    if (raf || reducedMotion.matches) return;
    lastFrame = performance.now();
    raf = window.requestAnimationFrame(frame);
  }

  function stopDust() {
    if (!raf) return;
    window.cancelAnimationFrame(raf);
    raf = 0;
  }

  window.addEventListener('resize', resizeCanvas);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopDust();
    else startDust();
  });
  reducedMotion.addEventListener('change', () => {
    stopDust();
    if (reducedMotion.matches) {
      sparks = [];
      drawStatic();
    } else {
      startDust();
    }
  });

  resizeCanvas();
  startDust();
  startLevel(0, { animate: false, announce: false });
}

if (typeof document !== 'undefined') boot();
