(() => {
    const root = document.documentElement;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motionButtons = document.querySelectorAll('[data-motion-toggle]');
    const revealTargets = document.querySelectorAll('.home-post-entry, .post-single > .post-header, .post-single > .entry-cover, .post-content > figure');
    const revealed = new WeakSet();
    const animations = new Set();
    let preference = 'running';

    try {
        if (localStorage.getItem('vishctl-motion') === 'paused') preference = 'paused';
    } catch (_) {
        // Motion controls also work when browser storage is unavailable.
    }

    const motionRunning = () => root.dataset.motion === 'running' && !document.hidden;

    const revealObserver = 'IntersectionObserver' in window && 'animate' in Element.prototype
        ? new IntersectionObserver((entries) => {
            if (!motionRunning()) return;
            entries.forEach(({ target, isIntersecting }, index) => {
                if (!isIntersecting || revealed.has(target)) return;
                revealed.add(target);
                revealObserver.unobserve(target);
                const isArticle = Boolean(target.closest('.post-single'));
                const animation = target.animate([
                    { opacity: isArticle ? 0.65 : 0.2, transform: isArticle ? 'translateY(6px)' : 'translateY(16px)' },
                    { opacity: 1, transform: 'translateY(0)' }
                ], {
                    duration: isArticle ? 360 : 520,
                    delay: isArticle ? 0 : Math.min(index, 4) * 60,
                    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                    fill: 'backwards'
                });
                animations.add(animation);
                animation.onfinish = animation.oncancel = () => animations.delete(animation);
            });
        }, { threshold: 0.08 })
        : null;

    const updateMotion = () => {
        const paused = reducedMotion.matches || preference === 'paused';
        root.dataset.motion = paused ? 'paused' : 'running';
        motionButtons.forEach((button) => {
            button.hidden = false;
            button.textContent = paused ? 'motion: off' : 'motion: on';
            button.setAttribute('aria-pressed', String(paused));
            button.disabled = reducedMotion.matches;
            button.title = reducedMotion.matches
                ? 'Motion is off because of your system preference'
                : 'Turn decorative motion on or off';
        });

        if (paused) {
            revealObserver?.disconnect();
            animations.forEach((animation) => animation.cancel());
            animations.clear();
        } else {
            revealTargets.forEach((target) => {
                if (!revealed.has(target)) revealObserver?.observe(target);
            });
        }
    };

    motionButtons.forEach((button) => button.addEventListener('click', () => {
        preference = root.dataset.motion === 'paused' ? 'running' : 'paused';
        try {
            localStorage.setItem('vishctl-motion', preference);
        } catch (_) {
            // Keep the current page preference even without persistent storage.
        }
        updateMotion();
    }));
    reducedMotion.addEventListener('change', updateMotion);
    updateMotion();

    const updateVisibility = () => {
        root.dataset.pageHidden = String(document.hidden);
    };
    document.addEventListener('visibilitychange', updateVisibility);
    updateVisibility();

    // Pointer glow on cards and terminals, and a grid spotlight behind the page, for mouse users with motion on.
    // The styles are under "Pointer glow" and "Background spotlight" in lab.css.
    const glowTargets = '.post-entry, .lab-terminal, .searchResults li, .paginav, .tty-pane, .tty-work';
    const gridSize = 56;
    const spotlight = document.querySelector('.post-single') ? null : document.createElement('div');
    if (spotlight) {
        spotlight.className = 'lab-spotlight';
        spotlight.setAttribute('aria-hidden', 'true');
        document.body.append(spotlight);
    }
    let pointer = null;
    let pointerQueued = false;
    const gridOffset = (edge) => `${(((-1 - edge) % gridSize) + gridSize) % gridSize}px`;
    const paintPointer = () => {
        pointerQueued = false;
        if (!pointer) return;
        const { x, y } = pointer;
        let target = pointer.target;
        pointer.target = null;
        while (target) {
            const rect = target.getBoundingClientRect();
            target.classList.add('lab-glow');
            target.style.setProperty('--mx', `${x - rect.left}px`);
            target.style.setProperty('--my', `${y - rect.top}px`);
            target = target.parentElement?.closest(glowTargets);
        }
        if (!spotlight) return;
        // The box is centred on the cursor; shift its grid so the lines stay on the page grid.
        spotlight.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        spotlight.style.setProperty('--gx', gridOffset(x - 260));
        spotlight.style.setProperty('--gy', gridOffset(y - 260 + window.scrollY));
        spotlight.classList.add('is-on');
    };
    const queuePointer = () => {
        if (pointerQueued) return;
        pointerQueued = true;
        window.requestAnimationFrame(paintPointer);
    };
    document.addEventListener('pointermove', (event) => {
        if (event.pointerType !== 'mouse' || !motionRunning()) return;
        pointer = { x: event.clientX, y: event.clientY, target: event.target.closest?.(glowTargets) };
        queuePointer();
    }, { passive: true });
    window.addEventListener('scroll', () => {
        if (pointer && spotlight) queuePointer();
    }, { passive: true });
    root.addEventListener('pointerleave', () => {
        pointer = null;
        spotlight?.classList.remove('is-on');
    });

    // Looping terminal animations only run while the terminal is on screen.
    const terminalObserver = 'IntersectionObserver' in window
        ? new IntersectionObserver((entries) => entries.forEach(({ target, isIntersecting }) => {
            target.dataset.visible = String(isIntersecting);
        }), { threshold: 0.05 })
        : null;
    document.querySelectorAll('.lab-terminal').forEach((terminal) => {
        terminal.dataset.visible = String(!terminalObserver);
        terminalObserver?.observe(terminal);
    });

    // kubectl-style AGE column, computed in the browser so a static build never goes stale.
    document.querySelectorAll('time[data-age]').forEach((element) => {
        const then = Date.parse(element.getAttribute('datetime'));
        if (Number.isNaN(then)) return;
        const minutes = Math.max(0, (Date.now() - then) / 60000);
        const days = Math.floor(minutes / 1440);
        let age = `${Math.floor(minutes)}m`;
        if (days >= 365) age = `${Math.floor(days / 365)}y`;
        else if (days >= 1) age = `${days}d`;
        else if (minutes >= 60) age = `${Math.floor(minutes / 60)}h`;
        element.textContent = age;
    });

    document.querySelectorAll('[data-404-path]').forEach((element) => {
        element.textContent = decodeURIComponent(location.pathname);
    });

    // Press "/" anywhere to search, like most developer tools.
    document.addEventListener('keydown', (event) => {
        if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
        const active = document.activeElement;
        if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
        const input = document.getElementById('searchInput');
        event.preventDefault();
        if (input) {
            input.focus();
            input.select();
            return;
        }
        const searchLink = document.querySelector('#menu a[href*="/search"]');
        window.location.href = searchLink ? searchLink.href : '/search/';
    });
})();
