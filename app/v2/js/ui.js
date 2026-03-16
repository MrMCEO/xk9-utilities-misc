/**
 * ui.js — модальные окна, конфетти, haptic, звуки, ripple, история игр.
 */

/* ════════════════════════════════════
   WEB AUDIO — тоны без внешних файлов
════════════════════════════════════ */
let _audioCtx = null;
function getAudioCtx() {
    if (!_audioCtx) {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        window._audioCtx = _audioCtx; /* Экспортируем для resume по первому жесту */
    }
    return _audioCtx;
}
function playTone(freq, type, duration, gainVal) {
    try {
        const ctx = getAudioCtx();
        const osc = ctx.createOscillator();
        const g   = ctx.createGain();
        osc.type = type || 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        g.gain.setValueAtTime(gainVal || 0.10, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + duration);
    } catch(e) {}
}

export function sndClick() { playTone(440, 'sine', 0.08, 0.07); }
export function sndWin() {
    playTone(520, 'sine', 0.18, 0.10);
    setTimeout(() => playTone(660, 'sine', 0.22, 0.10), 120);
    setTimeout(() => playTone(880, 'sine', 0.30, 0.09), 260);
}
export function sndLose() { playTone(220, 'sawtooth', 0.35, 0.08); }

/* ════════════════════════════════════
   HAPTIC
════════════════════════════════════ */
const tg = () => window.Telegram?.WebApp || {};

export function haptic(t)  { try { tg().HapticFeedback?.impactOccurred(t || 'light'); }        catch(e){} }
export function hNotify(t) { try { tg().HapticFeedback?.notificationOccurred(t || 'success'); } catch(e){} }

/* ════════════════════════════════════
   CONFETTI
════════════════════════════════════ */
const confCv  = document.getElementById('confettiCanvas');
const confCtx = confCv.getContext('2d');
let confParts = [], confRAF = null;

const CONF_COLORS = ['#3d5afe','#00e676','#f5a623','#ff6b9d','#a78bfa','#34d399'];

function confMakeParticle(W, H) {
    const shapes = ['rect', 'circle', 'triangle'];
    return {
        x:      Math.random() * W,
        y:      -10 - Math.random() * 100,
        vx:     (Math.random() - 0.5) * 4,
        vy:     1.8 + Math.random() * 3.2,
        rot:    Math.random() * 360,
        vrot:   (Math.random() - 0.5) * 9,
        size:   5 + Math.random() * 7,
        aspect: 0.35 + Math.random() * 0.45,
        color:  CONF_COLORS[Math.floor(Math.random() * CONF_COLORS.length)],
        shape:  shapes[Math.floor(Math.random() * shapes.length)],
        swing:  Math.random() * Math.PI * 2,
        swingA: 0.5 + Math.random() * 1.2,
        swingF: 1.5 + Math.random() * 2,
        life:   1.0
    };
}

export function confStart() {
    confCv.width  = window.innerWidth;
    confCv.height = window.innerHeight;
    confParts = [];
    for (let i = 0; i < 110; i++) confParts.push(confMakeParticle(confCv.width, confCv.height));
    confCv.classList.add('active');
    if (confRAF) cancelAnimationFrame(confRAF);
    confLoop();
}

function confDrawParticle(ctx, p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot * Math.PI / 180);
    ctx.fillStyle = p.color;
    const hw = p.size / 2;
    const hh = p.size * p.aspect / 2;
    if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
        ctx.fill();
    } else if (p.shape === 'triangle') {
        ctx.beginPath();
        ctx.moveTo(0, -hw);
        ctx.lineTo(hw, hw * 0.7);
        ctx.lineTo(-hw, hw * 0.7);
        ctx.closePath();
        ctx.fill();
    } else {
        ctx.fillRect(-hw, -hh, p.size, p.size * p.aspect);
    }
    ctx.restore();
}

function confLoop() {
    confCtx.clearRect(0, 0, confCv.width, confCv.height);
    const now = performance.now() / 1000;
    let alive = false;
    for (const p of confParts) {
        p.x   += p.vx + Math.sin(now * p.swingF + p.swing) * p.swingA;
        p.y   += p.vy;
        p.rot += p.vrot;
        p.vy  += 0.07;
        const fadeStart = confCv.height * 0.70;
        if (p.y > fadeStart) {
            p.life = Math.max(0, 1 - (p.y - fadeStart) / (confCv.height * 0.35));
        }
        if (p.y < confCv.height + 30 && p.life > 0) alive = true;
        if (p.y > confCv.height + 30 || p.life <= 0) continue;
        confCtx.globalAlpha = p.life;
        confDrawParticle(confCtx, p);
    }
    confCtx.globalAlpha = 1;
    if (alive) {
        confRAF = requestAnimationFrame(confLoop);
    } else {
        confCv.classList.remove('active');
        confCtx.clearRect(0, 0, confCv.width, confCv.height);
    }
}

export function confStop() {
    if (confRAF) { cancelAnimationFrame(confRAF); confRAF = null; }
    confCv.classList.remove('active');
    confCtx.clearRect(0, 0, confCv.width, confCv.height);
}

/* ════════════════════════════════════
   MODAL
════════════════════════════════════ */
export let autoCloseTimer = null;

export function openModal(emoji, title, sub, amount, isWin) {
    if (autoCloseTimer) { clearTimeout(autoCloseTimer); autoCloseTimer = null; }
    document.getElementById('mEmoji').textContent = emoji;
    document.getElementById('mTitle').textContent = title;
    document.getElementById('mSub').textContent   = sub;
    const a = document.getElementById('mAmt');
    a.textContent = amount;
    a.className   = 'modal-amt ' + (isWin === true ? 'win' : isWin === false ? 'lose' : '');
    const ov = document.getElementById('modal');
    ov.classList.remove('modal-win', 'modal-lose');
    if (isWin === true)  { ov.classList.add('modal-win');  confStart(); }
    if (isWin === false) { ov.classList.add('modal-lose'); confStop();  }
    ov.classList.add('open');
    if (isWin === true)  hNotify('success');
    if (isWin === false) hNotify('error');
}

export function closeModal() {
    if (autoCloseTimer) { clearTimeout(autoCloseTimer); autoCloseTimer = null; }
    document.getElementById('modal').classList.remove('open');
    confStop();
}

/* ════════════════════════════════════
   GAME HISTORY (Сапёр, Лесенка)
════════════════════════════════════ */
const HIST_MAX = 5;

/**
 * Добавить запись в полосу истории.
 * @param {Array}   arr   — массив данных истории (mHistData / lHistData)
 * @param {string}  barId — id элемента-полосы
 * @param {boolean} won   — победа или проигрыш
 * @param {string}  label — текстовая метка
 */
export function pushHistory(arr, barId, won, label) {
    arr.unshift({ won, label });
    if (arr.length > HIST_MAX) arr.pop();
    const bar = document.getElementById(barId);
    if (!bar) return;
    // Безопасное построение DOM без innerHTML — защита от XSS
    bar.textContent = '';
    arr.forEach(h => {
        const span = document.createElement('span');
        span.className = `h-chip ${h.won ? 'w' : 'l'}`;
        span.textContent = h.label;
        bar.appendChild(span);
    });
}

/* ════════════════════════════════════
   RIPPLE
════════════════════════════════════ */
export function addRipple(btn) {
    btn.style.overflow = 'hidden';
    btn.style.position = 'relative';
    btn.addEventListener('pointerdown', function(e) {
        const r    = this.getBoundingClientRect();
        const size = Math.max(r.width, r.height) * 1.4;
        const x    = e.clientX - r.left - size / 2;
        const y    = e.clientY - r.top  - size / 2;
        const ripple = document.createElement('span');
        ripple.className = 'ripple-effect';
        ripple.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px`;
        this.appendChild(ripple);
        ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    });
}

export function applyRipples() {
    document.querySelectorAll('.btn, .modal-cta, .dep-manual-btn, .deposit-btn').forEach(btn => {
        if (!btn.dataset.ripple) { addRipple(btn); btn.dataset.ripple = '1'; }
    });
}

/* ════════════════════════════════════
   MODAL CLOSE BINDINGS
════════════════════════════════════ */
export function initModalBindings() {
    document.getElementById('mCloseBtn').addEventListener('click', closeModal);
    document.getElementById('modal').addEventListener('click', e => {
        if (e.target.id === 'modal') closeModal();
    });
}
