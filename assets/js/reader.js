(() => {
    const content = document.querySelector('.post-single .post-content');
    if (!content) return;

    const root = document.documentElement;
    const header = document.querySelector('.header');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const progressBars = Array.from(document.querySelectorAll('[data-toc-progress-bar]'));
    const progressLabels = document.querySelectorAll('[data-toc-progress]');
    document.querySelectorAll('.post-toc-progress, [data-toc-progress]').forEach((element) => { element.hidden = false; });
    const tocList = document.querySelector('.post-toc-list');
    const tocLinks = Array.from(document.querySelectorAll('.post-toc-list a[href^="#"], .toc-mobile a[href^="#"]'));
    const targetForHash = (hash) => {
        try {
            return hash.length > 1 ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
        } catch (_) {
            return null;
        }
    };
    const linkedHeadings = new Map();
    tocLinks.forEach((link) => {
        const heading = targetForHash(link.hash);
        if (!heading || !content.contains(heading)) return;
        if (!linkedHeadings.has(heading)) linkedHeadings.set(heading, []);
        linkedHeadings.get(heading).push(link);
    });
    const headings = Array.from(content.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'))
        .filter((heading) => linkedHeadings.has(heading));

    if (header) {
        const progress = document.createElement('div');
        progress.className = 'post-reading-progress';
        progress.setAttribute('aria-hidden', 'true');
        const bar = document.createElement('span');
        bar.dataset.readingProgressBar = '';
        progress.append(bar);
        header.append(progress);
        progressBars.push(bar);
    }

    const motionPaused = () => reducedMotion.matches || root.dataset.motion === 'paused';
    const codeLanguages = new WeakMap();

    content.querySelectorAll('a.anchor').forEach((link) => {
        const heading = link.parentElement.cloneNode(true);
        heading.querySelectorAll('.anchor').forEach((anchor) => anchor.remove());
        link.setAttribute('aria-label', `Link to ${heading.textContent.trim()}`);
    });

    content.querySelectorAll('.highlight').forEach((block) => {
        const code = block.querySelector('pre > code');
        if (!code || block.querySelector('.post-code-toolbar')) return;
        const language = code.dataset.lang || Array.from(code.classList)
            .find((name) => name.startsWith('language-'))?.slice(9) || 'text';
        codeLanguages.set(code, language);
        const toolbar = document.createElement('div');
        toolbar.className = 'post-code-toolbar';
        const label = document.createElement('span');
        label.className = 'post-code-language';
        label.textContent = language;
        toolbar.append(label);
        const copy = block.querySelector('.copy-code');
        if (copy) {
            copy.type = 'button';
            copy.setAttribute('aria-label', `Copy ${language} code`);
            copy.setAttribute('aria-live', 'polite');
            toolbar.append(copy);
        }
        block.prepend(toolbar);
    });

    const scrollableElements = Array.from(content.querySelectorAll('pre, pre > code, table:not(.highlighttable)'));
    const enhancedScrollers = new Map();
    const updateScrollableElements = () => {
        scrollableElements.forEach((element) => {
            const overflows = element.scrollWidth > element.clientWidth + 1;
            if (overflows && !enhancedScrollers.has(element)) {
                const original = new Map();
                const addAttribute = (name, value) => {
                    if (element.hasAttribute(name)) return;
                    original.set(name, null);
                    element.setAttribute(name, value);
                };
                addAttribute('tabindex', '0');
                if (element.tagName !== 'TABLE') addAttribute('role', 'region');
                if (!element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby') && !element.querySelector('caption')) {
                    const code = element.matches('code') ? element : element.querySelector('code');
                    const label = element.tagName === 'TABLE' ? 'Table' : `${codeLanguages.get(code) || 'Source'} code`;
                    addAttribute('aria-label', `${label}, horizontally scrollable`);
                }
                enhancedScrollers.set(element, original);
            } else if (!overflows && enhancedScrollers.has(element)) {
                enhancedScrollers.get(element).forEach((_, name) => element.removeAttribute(name));
                enhancedScrollers.delete(element);
            }
        });
    };

    let currentHeading = null;
    let ticking = false;
    let layoutChanged = true;
    let headerHeight = -1;

    const updateReading = () => {
        const headerBottom = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
        const nextHeaderHeight = header ? Math.ceil(header.getBoundingClientRect().height) : 0;
        if (nextHeaderHeight !== headerHeight) {
            headerHeight = nextHeaderHeight;
            root.style.setProperty('--reading-header-height', `${headerHeight}px`);
        }
        const readingLine = headerBottom + 24;
        const bounds = content.getBoundingClientRect();
        // Start at the first reading line; finish when the last body content is visible.
        const readingDistance = Math.max(1, bounds.height - Math.max(0, window.innerHeight - readingLine));
        const progress = Math.min(1, Math.max(0, (readingLine - bounds.top) / readingDistance));
        progressBars.forEach((bar) => { bar.style.transform = `scaleX(${progress})`; });
        progressLabels.forEach((label) => { label.textContent = `${Math.round(progress * 100)}%`; });

        let active = null;
        for (const heading of headings) {
            if (heading.getBoundingClientRect().top <= readingLine + 1) active = heading;
            else break;
        }
        if (active !== currentHeading || layoutChanged) {
            tocLinks.forEach((link) => {
                const selected = active !== null && linkedHeadings.get(active).includes(link);
                link.classList.toggle('is-active', selected);
                if (selected) link.setAttribute('aria-current', 'location');
                else link.removeAttribute('aria-current');
            });
            const desktopLink = active && linkedHeadings.get(active).find((link) => tocList?.contains(link));
            if (desktopLink && tocList.clientHeight > 0) {
                const listBounds = tocList.getBoundingClientRect();
                const linkBounds = desktopLink.getBoundingClientRect();
                if (linkBounds.top < listBounds.top + 6 || linkBounds.bottom > listBounds.bottom - 6) {
                    const top = tocList.scrollTop + linkBounds.top - listBounds.top - (tocList.clientHeight - linkBounds.height) / 2;
                    tocList.scrollTo({ top: Math.max(0, top), behavior: motionPaused() ? 'auto' : 'smooth' });
                }
            }
            currentHeading = active;
        }
        if (layoutChanged) updateScrollableElements();
        layoutChanged = false;
        ticking = false;
    };
    const requestUpdate = () => {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(updateReading);
    };
    const requestLayoutUpdate = () => {
        layoutChanged = true;
        requestUpdate();
    };

    // Capture article navigation before the theme's unconditional smooth-scroll handler.
    document.addEventListener('click', (event) => {
        if (event.defaultPrevented) return;
        const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
        if (!link || (!link.closest('.post-single') && link.id !== 'top-link')) return;
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute('download') || (link.target && link.target !== '_self')) {
            event.stopImmediatePropagation();
            return;
        }
        const hash = link.getAttribute('href');
        const target = targetForHash(hash);
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!target) return;
        if (hash === '#top') {
            history.replaceState(null, '', `${location.pathname}${location.search}`);
        } else if (location.hash !== hash) {
            history.pushState(null, '', hash);
        }
        if (event.detail === 0) {
            if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
            target.focus({ preventScroll: true });
        }
        target.scrollIntoView({ behavior: motionPaused() ? 'auto' : 'smooth', block: 'start' });
        requestUpdate();
    }, true);

    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestLayoutUpdate);
    window.addEventListener('hashchange', requestUpdate);
    window.addEventListener('popstate', requestUpdate);
    window.addEventListener('load', requestLayoutUpdate);
    content.addEventListener('load', requestLayoutUpdate, true);
    document.querySelector('.toc-mobile')?.addEventListener('toggle', requestLayoutUpdate);
    if ('ResizeObserver' in window) {
        const resizeObserver = new ResizeObserver(requestLayoutUpdate);
        resizeObserver.observe(content);
        resizeObserver.observe(content.closest('.post-single'));
        if (header) resizeObserver.observe(header);
        scrollableElements.forEach((element) => resizeObserver.observe(element));
    }
    document.fonts?.ready.then(requestLayoutUpdate);
    updateReading();
})();
