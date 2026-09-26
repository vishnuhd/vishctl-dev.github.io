(() => {
    const root = document.documentElement;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motionButtons = document.querySelectorAll('[data-motion-toggle]');
    const revealTargets = document.querySelectorAll('.home-post-entry, .about-work-card, .about-skill-grid article');
    const revealed = new WeakSet();
    const animations = new Set();
    let preference = 'running';

    try {
        if (localStorage.getItem('vishctl-motion') === 'paused') preference = 'paused';
    } catch (_) {
        // Motion controls also work when browser storage is unavailable.
    }

    const revealObserver = 'IntersectionObserver' in window && 'animate' in Element.prototype
        ? new IntersectionObserver((entries) => {
            if (root.dataset.motion !== 'running' || document.hidden) return;
            entries.forEach(({ target, isIntersecting }, index) => {
                if (!isIntersecting || revealed.has(target)) return;
                revealed.add(target);
                revealObserver.unobserve(target);
                const animation = target.animate([
                    { opacity: 0.35, transform: 'translateY(14px)' },
                    { opacity: 1, transform: 'translateY(0)' }
                ], {
                    duration: 480,
                    delay: Math.min(index, 3) * 55,
                    easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
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
            button.textContent = paused ? 'Motion: paused' : 'Motion: on';
            button.setAttribute('aria-pressed', String(paused));
            button.disabled = reducedMotion.matches;
            button.title = reducedMotion.matches
                ? 'Motion is paused by your system preference'
                : 'Pause or resume decorative motion';
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

    const terminalObserver = 'IntersectionObserver' in window
        ? new IntersectionObserver((entries) => entries.forEach(({ target, isIntersecting }) => {
            target.dataset.visible = String(isIntersecting);
        }), { threshold: 0.05 })
        : null;

    document.querySelectorAll('.lab-terminal').forEach((terminal) => {
        terminal.dataset.visible = String(!terminalObserver);
        terminalObserver?.observe(terminal);
        const buttons = terminal.querySelectorAll('[data-lab-tab]');
        const panels = terminal.querySelectorAll('[data-lab-panel]');
        const selectPanel = (value) => {
            if (!Array.from(panels).some((panel) => panel.dataset.labPanel === value)) return;
            buttons.forEach((button) => {
                button.setAttribute('aria-pressed', String(button.dataset.labTab === value));
            });
            panels.forEach((panel) => { panel.hidden = panel.dataset.labPanel !== value; });
        };
        buttons.forEach((button) => {
            button.hidden = false;
            button.addEventListener('click', () => selectPanel(button.dataset.labTab));
        });
        if (buttons.length) {
            const selected = Array.from(buttons).find((button) => button.getAttribute('aria-pressed') === 'true');
            selectPanel((selected || buttons[0]).dataset.labTab);
        }
    });
})();
