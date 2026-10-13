// Tok: a small pixel robot that wanders along the bottom edge of the window.
// It follows the motion switch from lab.js: with motion off (or reduced motion) it stands still.
// The styles live in css/extended/tok.css.
(() => {
    if (window.__tok || !document.body) return;
    window.__tok = true;

    const root = document.documentElement;
    const session = (key, value) => {
        try {
            if (value === undefined) return sessionStorage.getItem(key);
            sessionStorage.setItem(key, value);
        } catch (_) {
            // Tok still works without browser storage; it just forgets its spot between pages.
        }
        return null;
    };
    if (session('vishctl-tok') === 'hidden') return;

    // A 16 x 18 sprite facing right. One letter per pixel, "." is transparent.
    const PALETTE = {
        o: '#0a141b', // outline
        h: '#6fa9b7', // head highlight
        b: '#3d6c7a', // body
        s: '#071017', // screen face
        e: '#66e3b4', // eyes
        m: '#3aa784', // mouth
        a: '#fbbf24', // antenna LED
        v: '#a78bfa', // chest light
        l: '#56798a', // legs
        k: '#29495a'  // feet
    };
    const BASE = [
        '.........a......',
        '.........o......',
        '...oooooooooo...',
        '..ohhhhhhhhhho..',
        '..obssssssssbo..',
        '..obssssssssbo..',
        '..obssssssssbo..',
        '..obssssssssbo..',
        '..obsssssmmsbo..',
        '..obbbbbbbbbbo..',
        '...oooooooooo...',
        '...obbbbbbbbo...',
        '.ooobvvbbbbbooo.',
        '.obobvvbbbbbobo.',
        '.obobbbbbbbbobo.',
        '.oooooooooooooo.'
    ];
    // The eyes sit toward the front of the screen, so Tok looks where it walks.
    const EYES = {
        open: { top: 5, rows: ['.......ee.ee....', '.......ee.ee....'] },
        closed: { top: 6, rows: ['.......ee.ee....'] }
    };
    const LEGS = {
        stand: ['.....ll..ll.....', '....kkk..kkk....'],
        left: ['.....kk..ll.....', '.........kkk....'],
        right: ['.....ll..kk.....', '....kkk.........']
    };

    const paths = (rows, top = 0) => {
        const byColor = {};
        rows.forEach((row, y) => [...row].forEach((pixel, x) => {
            if (pixel === '.') return;
            (byColor[pixel] ||= []).push(`M${x} ${y + top}h1v1h-1z`);
        }));
        return Object.entries(byColor)
            .map(([pixel, d]) => `<path class="tok-${pixel}" fill="${PALETTE[pixel]}" d="${d.join('')}"/>`)
            .join('');
    };
    const sprite = `<svg viewBox="0 0 16 18" shape-rendering="crispEdges" aria-hidden="true" focusable="false">`
        + `<g>${paths(BASE)}</g>`
        + Object.entries(EYES).map(([name, { top, rows }]) => `<g class="tok-eyes" data-eyes="${name}">${paths(rows, top)}</g>`).join('')
        + Object.entries(LEGS).map(([name, rows]) => `<g class="tok-legs" data-legs="${name}">${paths(rows, 16)}</g>`).join('')
        + '</svg>';

    const tok = document.createElement('div');
    tok.className = 'tok';
    Object.assign(tok.dataset, { eyes: 'open', legs: 'stand', face: 'right', side: 'left', state: 'walk' });
    tok.innerHTML = `
        <p class="tok-bubble" aria-hidden="true" hidden></p>
        <button class="tok-bot" type="button" aria-label="Tok, the site robot. Press to say hi.">
            <span class="tok-sprite">${sprite}</span>
            <span class="tok-shadow" aria-hidden="true"></span>
        </button>
        <button class="tok-close" type="button" aria-label="Hide Tok for this visit" title="Hide Tok for this visit">&times;</button>`;
    document.body.append(tok);
    const bubble = tok.querySelector('.tok-bubble');
    const bot = tok.querySelector('.tok-bot');
    const body = tok.querySelector('.tok-sprite');

    // What Tok says depends a little on where it is.
    const page = document.querySelector('[data-404-path]') ? 'missing'
        : document.querySelector('.tty-tmux, .tty-pane') ? 'about'
        : document.querySelector('.post-single .post-content') ? 'post'
        : document.getElementById('searchInput') ? 'search'
        : document.querySelector('.home-info') ? 'home'
        : 'list';
    const QUIPS = [
        'kubectl get tokens',
        'beep boop. 42 tok/s',
        'all pods Running',
        'warming up the KV cache',
        'press / to search',
        'prefill done. decoding...',
        'no GPUs were harmed',
        'sudo make coffee',
        'my draft model guessed that',
        'scheduling myself on node-0',
        'checking for OOMKilled',
        'cache hit!'
    ];
    const PAGE_QUIPS = {
        home: ['fresh notes up there', 'pick a post, any post'],
        post: ['reading along with you', 'try the commands, they work'],
        about: ['that is my human', 'my human wrote all of this'],
        search: ['type something, I will grep it', 'search is O(fast)'],
        missing: ['404: I looked everywhere', 'this page got evicted'],
        list: ['so many notes', 'kubectl get posts']
    };
    let lastLine = '';
    const pick = () => {
        const pool = Math.random() < 0.4 ? PAGE_QUIPS[page] : QUIPS;
        let line = pool[Math.floor(Math.random() * pool.length)];
        if (line === lastLine) line = QUIPS[(QUIPS.indexOf(line) + 1) % QUIPS.length];
        lastLine = line;
        return line;
    };

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const running = () => root.dataset.motion === 'running' && !document.hidden && !reduced.matches;
    const rand = (min, max) => min + Math.random() * (max - min);
    const EDGE = 8;
    const SPEED = 32; // px per second
    const STEP_MS = 150;
    const SLEEP_MS = 45000;
    const CHATTER_MS = 30000;
    const WALK = ['left', 'stand', 'right', 'stand'];

    // Carry Tok's spot across pages in the same visit; on the first page it walks in from the left.
    const savedX = session('vishctl-tok-x');
    let x = savedX === null ? NaN : Number(savedX);
    let dir = session('vishctl-tok-dir') === '-1' ? -1 : 1;
    let entering = !Number.isFinite(x);
    if (entering) {
        x = -60;
        dir = 1;
    }

    let state = 'walk';
    let until = performance.now() + rand(3000, 7000);
    let raf = 0;
    let last = 0;
    let stepAt = 0;
    let step = 0;
    let blinkAt = 0;
    let blinkEnd = 0;
    let lastInput = performance.now();
    let lastQuip = performance.now() - CHATTER_MS + 10000; // first unprompted line after about 10 s
    let curiousAt = 0;
    let pointer = null;
    let bubbleTimer = 0;
    let uiTimer = 0;
    let pokes = [];
    let muteUntil = 0;
    let introduced = false;
    let saidEOF = false;
    let gone = false;

    const width = () => bot.offsetWidth || 48;
    const maxX = () => Math.max(EDGE, window.innerWidth - width() - EDGE);

    const render = () => {
        tok.style.transform = `translate3d(${Math.round(x)}px, 0, 0)`;
        tok.dataset.face = dir < 0 ? 'left' : 'right';
        tok.dataset.side = x + width() / 2 > window.innerWidth / 2 ? 'right' : 'left';
    };

    const hideBubble = () => {
        bubble.hidden = true;
    };
    const say = (text, ms = 3600) => {
        bubble.textContent = text;
        bubble.hidden = false;
        render();
        window.clearTimeout(bubbleTimer);
        bubbleTimer = window.setTimeout(hideBubble, ms);
    };

    const facePointer = () => {
        if (pointer) dir = pointer.x > x + width() / 2 ? 1 : -1;
    };

    const setState = (next, now) => {
        state = next;
        tok.dataset.state = next;
        if (next === 'walk') {
            until = now + rand(3000, 8000);
            if (Math.random() < 0.4) dir = -dir;
        } else if (next === 'idle') {
            until = now + rand(1800, 5000);
            tok.dataset.legs = 'stand';
            facePointer();
            if (now - lastQuip > CHATTER_MS && Math.random() < 0.35) {
                lastQuip = now;
                say(pick());
            }
        } else if (next === 'sleep') {
            tok.dataset.legs = 'stand';
            tok.dataset.eyes = 'closed';
            hideBubble();
        }
    };

    const wake = (now, quiet = false) => {
        lastInput = now;
        if (state !== 'sleep') return;
        tok.dataset.eyes = 'open';
        setState('idle', now);
        if (!quiet) say('huh? I am up', 2200);
    };

    const tick = (now) => {
        raf = 0;
        if (gone || !running()) return;
        const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
        last = now;

        if (state !== 'sleep' && now - lastInput > SLEEP_MS) setState('sleep', now);

        if (state === 'walk') {
            x += dir * SPEED * dt;
            if (entering) {
                if (x >= EDGE) entering = false;
            } else if (x <= EDGE) {
                x = EDGE;
                dir = 1;
            }
            if (x >= maxX()) {
                x = maxX();
                dir = -1;
            }
            if (now - stepAt > STEP_MS) {
                stepAt = now;
                step = (step + 1) % WALK.length;
                tok.dataset.legs = WALK[step];
            }
            // Stop and look when the cursor comes close.
            const near = pointer && now - pointer.t < 1500
                && Math.abs(pointer.x - (x + width() / 2)) < 110
                && pointer.y > window.innerHeight - 160;
            if (!entering && near && now > curiousAt) {
                curiousAt = now + 8000;
                setState('idle', now);
            } else if (!entering && now > until) {
                setState('idle', now);
            }
        } else if (state === 'idle') {
            if (pointer && now - pointer.t < 1500) facePointer();
            if (now > until) setState('walk', now);
        }

        if (state !== 'sleep') {
            if (!blinkAt) blinkAt = now + rand(2000, 5000);
            if (now >= blinkAt) {
                tok.dataset.eyes = 'closed';
                blinkEnd = now + 140;
                blinkAt = now + rand(2500, 6500);
            }
            if (blinkEnd && now >= blinkEnd) {
                tok.dataset.eyes = 'open';
                blinkEnd = 0;
            }
        }

        render();
        raf = window.requestAnimationFrame(tick);
    };

    const sync = () => {
        if (gone) return;
        if (running()) {
            if (!raf) {
                last = 0;
                raf = window.requestAnimationFrame(tick);
            }
            return;
        }
        if (raf) window.cancelAnimationFrame(raf);
        raf = 0;
        // Motion off: Tok stands still, awake, fully on screen.
        if (state === 'sleep') wake(performance.now(), true);
        state = 'idle';
        tok.dataset.state = 'idle';
        tok.dataset.legs = 'stand';
        tok.dataset.eyes = 'open';
        if (entering || x < EDGE) {
            x = EDGE;
            entering = false;
        }
        x = Math.min(x, maxX());
        render();
    };

    const hop = () => {
        body.classList.remove('is-hop');
        void body.offsetWidth;
        body.classList.add('is-hop');
    };
    body.addEventListener('animationend', (event) => {
        if (event.animationName === 'tok-hop') body.classList.remove('is-hop');
    });

    bot.addEventListener('click', () => {
        const now = performance.now();
        wake(now, true);
        tok.dataset.ui = 'on';
        window.clearTimeout(uiTimer);
        uiTimer = window.setTimeout(() => delete tok.dataset.ui, 5000);
        if (now < muteUntil) return;

        pokes = pokes.filter((time) => now - time < 4000);
        pokes.push(now);
        if (pokes.length >= 5) {
            pokes = [];
            muteUntil = now + 3000;
            say('429 Too Many Pokes. Retry-After: 3s', 3000);
            return;
        }
        hop();
        lastQuip = now;
        say(introduced ? pick() : 'hi, I am Tok! beep.');
        introduced = true;
        if (running()) setState('idle', now);
    });

    tok.querySelector('.tok-close').addEventListener('click', () => {
        gone = true;
        session('vishctl-tok', 'hidden');
        if (raf) window.cancelAnimationFrame(raf);
        window.clearTimeout(bubbleTimer);
        tok.remove();
    });

    const checkEOF = () => {
        if (saidEOF || page !== 'post' || window.scrollY < 600) return;
        if (window.scrollY + window.innerHeight < root.scrollHeight - 400) return;
        saidEOF = true;
        lastQuip = performance.now();
        say('EOF. thanks for reading!', 4200);
    };

    document.addEventListener('pointermove', (event) => {
        const now = performance.now();
        pointer = { x: event.clientX, y: event.clientY, t: now };
        wake(now);
    }, { passive: true });
    window.addEventListener('scroll', () => {
        wake(performance.now());
        checkEOF();
    }, { passive: true });
    document.addEventListener('keydown', () => wake(performance.now()));
    window.addEventListener('resize', () => {
        x = Math.min(x, maxX());
        render();
    });
    window.addEventListener('pagehide', () => {
        if (gone) return;
        session('vishctl-tok-x', String(Math.round(Math.max(EDGE, Math.min(x, maxX())))));
        session('vishctl-tok-dir', String(dir));
    });

    new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-motion', 'data-page-hidden'] });
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener?.('change', sync);

    render();
    sync();
})();
