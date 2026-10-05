(() => {
    const root = document.documentElement;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motionButtons = document.querySelectorAll('[data-motion-toggle]');
    const revealTargets = document.querySelectorAll('.home-post-entry, .about-work-card, .about-skill-grid article, .about-timeline article, .about-notes li, .post-single > .post-header, .post-single > .entry-cover, .post-content > figure');
    const revealed = new WeakSet();
    const animations = new Set();
    let preference = 'running';

    try {
        if (localStorage.getItem('vishctl-motion') === 'paused') preference = 'paused';
    } catch (_) {
        // Motion controls also work when browser storage is unavailable.
    }

    const motionRunning = () => root.dataset.motion === 'running' && !document.hidden;

    const countUp = (element) => {
        const target = Number(element.dataset.countTo);
        const suffix = element.dataset.countSuffix || '';
        const final = element.textContent;
        const started = performance.now();
        const step = (now) => {
            const progress = Math.min(1, (now - started) / 900);
            const eased = 1 - Math.pow(1 - progress, 3);
            element.textContent = progress < 1 ? `${Math.round(target * eased)}${suffix}` : final;
            if (progress < 1 && motionRunning()) window.requestAnimationFrame(step);
            else element.textContent = final;
        };
        window.requestAnimationFrame(step);
    };

    const revealObserver = 'IntersectionObserver' in window && 'animate' in Element.prototype
        ? new IntersectionObserver((entries) => {
            if (!motionRunning()) return;
            entries.forEach(({ target, isIntersecting }, index) => {
                if (!isIntersecting || revealed.has(target)) return;
                revealed.add(target);
                revealObserver.unobserve(target);
                if (target.dataset.countTo) {
                    countUp(target);
                    return;
                }
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

    const counters = document.querySelectorAll('[data-count-to]');

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
            [...revealTargets, ...counters].forEach((target) => {
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

    // Looping terminal animations only run while the terminal is on screen.
    const terminalObserver = 'IntersectionObserver' in window
        ? new IntersectionObserver((entries) => entries.forEach(({ target, isIntersecting }) => {
            target.dataset.visible = String(isIntersecting);
        }), { threshold: 0.05 })
        : null;
    document.querySelectorAll('.lab-terminal, .about-terminal').forEach((terminal) => {
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
