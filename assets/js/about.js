// About page: a terminal session that boots, types its own commands, and prints each section as it scrolls into view.
// The HTML is complete without this file. Everything here follows the site-wide motion switch that lab.js keeps on <html data-motion>.
(() => {
    const root = document.documentElement;
    const page = document.querySelector('.tty-page');
    if (!page) return;
    window.__ttyReady = true;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const running = () => root.dataset.motion === 'running' && !reducedMotion.matches;
    const live = () => running() && !document.hidden;

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    };
    const text = (node) => (node ? node.textContent.replace(/\s+/g, ' ').trim() : '');

    // Timers that finish at once when motion is switched off or the intro is skipped.
    const pending = new Set();
    const sleep = (ms) => new Promise((resolve) => {
        if (!running()) return resolve();
        const entry = { resolve };
        entry.id = window.setTimeout(() => {
            pending.delete(entry);
            resolve();
        }, ms);
        pending.add(entry);
    });
    const flush = () => {
        pending.forEach((entry) => {
            window.clearTimeout(entry.id);
            entry.resolve();
        });
        pending.clear();
    };
    const tween = (duration, draw) => {
        if (!running()) return draw(1);
        const started = performance.now();
        const step = (now) => {
            const progress = running() ? Math.min(1, (now - started) / duration) : 1;
            draw(progress);
            if (progress < 1) window.requestAnimationFrame(step);
        };
        window.requestAnimationFrame(step);
    };
    const defaults = { fast: () => !running(), wait: sleep };

    // Types an element's text in place. The untyped remainder stays in the layout (hidden), so nothing reflows.
    const type = async (target, { fast, wait }) => {
        if (fast()) return target.classList.add('is-typed');
        const original = target.innerHTML;
        const speed = Number(target.dataset.ttySpeed) || 30;
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        const parts = nodes.map((node) => {
            const shown = el('span');
            const hidden = el('span', 'tty-untyped', node.textContent);
            node.replaceWith(shown, hidden);
            return { shown, hidden };
        });
        const caret = el('span', 'tty-caret');
        caret.setAttribute('aria-hidden', 'true');
        target.setAttribute('aria-label', text(target));
        target.classList.add('is-typing');
        for (const { shown, hidden } of parts) {
            const full = hidden.textContent;
            shown.after(caret);
            for (let i = 1; i <= full.length && !fast(); i += 1) {
                shown.textContent = full.slice(0, i);
                hidden.textContent = full.slice(i);
                await wait(speed * (0.5 + Math.random()) + (full[i - 1] === ' ' ? speed * 0.7 : 0));
            }
        }
        if (!fast()) await wait(260);
        target.innerHTML = original;
        target.removeAttribute('aria-label');
        target.classList.replace('is-typing', 'is-typed');
    };

    // One-shot effects that play when their line is printed. The markup already holds the final state.
    const BRAILLE = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
    const effects = {
        count(node) {
            const target = Number(node.dataset.to);
            const suffix = node.dataset.suffix || '';
            const final = node.textContent;
            tween(1100, (progress) => {
                const eased = 1 - Math.pow(1 - progress, 3);
                node.textContent = progress < 1 ? `${Math.round(target * eased)}${suffix}` : final;
            });
        },
        bar(node) {
            const cells = node.textContent.length;
            const filled = Math.round(cells * Number(node.dataset.pct) / 100);
            tween(1100, (progress) => {
                const now = Math.round(filled * (1 - Math.pow(1 - progress, 3)));
                node.textContent = '█'.repeat(now) + '░'.repeat(cells - now);
            });
        },
        blocks(node) {
            const total = Number(node.dataset.n);
            tween(total * 90, (progress) => {
                const now = Math.round(total * progress);
                node.textContent = '■'.repeat(now) + '□'.repeat(total - now);
            });
        },
        async steps(node) {
            for (const step of node.children) {
                step.classList.add('is-on');
                await sleep(130);
            }
        },
        check(node) {
            const final = node.textContent;
            if (!running()) return;
            node.classList.add('is-pending');
            tween(450 + Math.random() * 450, (progress) => {
                if (progress < 1) {
                    node.textContent = `${BRAILLE[Math.floor(performance.now() / 80) % BRAILLE.length]} False`;
                    return;
                }
                node.textContent = final;
                node.classList.remove('is-pending');
            });
        },
        decode(node) {
            const final = node.textContent;
            const isArt = node.tagName === 'PRE';
            const pool = isArt ? '█▓▒░╗╔╝╚═║' : '!<>-_\\/[]{}=+*^?#';
            const width = Math.max(...final.split('\n').map((line) => line.length));
            tween(isArt ? 1000 : 520, (progress) => {
                if (progress >= 1) {
                    node.textContent = final;
                    return;
                }
                let column = 0;
                node.textContent = Array.from(final, (char) => {
                    if (char === '\n') {
                        column = 0;
                        return char;
                    }
                    const at = column / width;
                    column += 1;
                    if (char === ' ' || at + Math.random() * 0.3 <= progress * 1.3) return char;
                    return pool[Math.floor(Math.random() * pool.length)];
                }).join('');
            });
        }
    };

    // Runs a pane top to bottom: commands are typed, output lines are printed one after another.
    const runSteps = async (scope, context = defaults) => {
        for (const step of scope.querySelectorAll('[data-tty-type], [data-tty-line]')) {
            if (step.hasAttribute('data-tty-type')) {
                await type(step, context);
                continue;
            }
            step.classList.add('is-in');
            [step, ...step.querySelectorAll('[data-tty-fx]')].forEach((node) => effects[node.dataset.ttyFx]?.(node));
            await context.wait(Number(step.dataset.ttyDelay) || 60);
        }
    };

    // Looping readouts. Each returns a tick() and how many 100ms beats to wait between ticks.
    const SPARK = '▁▂▃▄▅▆▇█';
    const wave = (speed, floor = 0, ceiling = 1) => {
        let phase = Math.random() * 10;
        let drift = 0.5;
        return () => {
            phase += speed;
            drift = Math.min(1, Math.max(0, drift + (Math.random() - 0.5) * 0.35));
            return floor + (ceiling - floor) * (0.55 * (0.5 + 0.5 * Math.sin(phase)) + 0.45 * drift);
        };
    };
    const sparkline = (width, next) => {
        const values = Array.from({ length: width }, next);
        return () => {
            values.shift();
            values.push(next());
            return values.map((value) => SPARK[Math.min(7, Math.floor(value * 8))]).join('');
        };
    };
    const meter = (value, cells = 20) => {
        const filled = Math.round(value * cells);
        return '█'.repeat(filled) + '░'.repeat(cells - filled);
    };
    const rows = (viz, labels) => labels.map((label) => {
        const line = el('div');
        const name = el('span', null, label);
        const value = el('span');
        line.append(name, value);
        viz.append(line);
        return { name, value };
    });
    const readouts = {
        spark(viz) {
            const next = sparkline(Number(viz.dataset.width) || 22, wave(0.35, 0.15, 1));
            return { every: 4, tick: () => { viz.textContent = next(); } };
        },
        traffic(viz) {
            const [traffic, latency, nodes] = rows(viz, ['traffic', 'latency', 'nodes']);
            const load = sparkline(26, wave(0.3, 0.35, 1));
            const delay = sparkline(26, wave(0.5, 0, 0.3));
            traffic.value.className = 'is-cyan';
            latency.value.className = 'is-violet';
            nodes.value.className = 'is-mint';
            nodes.value.textContent = '■ ■ ■ ■ ■ ■ ■ ■  ready';
            return { every: 3, tick: () => { traffic.value.textContent = load(); latency.value.textContent = delay(); } };
        },
        upgrade(viz) {
            const [nodes, rolling, workload] = rows(viz, ['nodes', 'rolling', 'workload']);
            const cells = Array.from({ length: 5 }, () => {
                const cell = el('span');
                nodes.value.append(cell, ' ');
                return cell;
            });
            const first = 26;
            const last = 33;
            let minor = first;
            let index = 0;
            let hold = 0;
            workload.value.className = 'is-mint';
            workload.value.textContent = '● available';
            const paint = () => {
                const done = minor >= last;
                cells.forEach((cell, i) => {
                    cell.textContent = `1.${!done && i < index ? minor + 1 : minor}`;
                    cell.className = done ? 'is-mint' : i === index - 1 ? 'is-amber' : '';
                });
                rolling.value.className = done ? 'is-mint' : 'is-amber';
                rolling.value.textContent = done ? `v1.${last} on every node` : `v1.${minor} ▸ v1.${minor + 1}  ${meter(index / 5, 5)}`;
            };
            return {
                every: 4,
                tick() {
                    if (minor >= last) {
                        hold += 1;
                        if (hold > 9) { minor = first; index = 0; hold = 0; }
                    } else if (index >= 5) {
                        minor += 1;
                        index = 0;
                    } else {
                        index += 1;
                    }
                    paint();
                },
                rest() { minor = last; paint(); }
            };
        },
        apply(viz) {
            const lines = rows(viz, ['', '', '']);
            const resources = ['network', 'identity', 'compute', 'storage', 'dns', 'pipelines', 'monitoring'];
            let step = 0;
            let frame = 0;
            let held = 0;
            const paint = () => {
                const done = step >= resources.length;
                const entries = resources.slice(0, step + 1).map((name, i) => ({
                    name: `+ ${name}`,
                    value: i < step ? '✓ applied' : `${BRAILLE[frame % BRAILLE.length]} applying`,
                    tone: i < step ? 'is-mint' : 'is-amber'
                }));
                if (done) entries.push({ name: 'Apply complete.', value: '', tone: 'is-mint', wide: true });
                const visible = entries.slice(-3);
                lines.forEach(({ name, value }, i) => {
                    const entry = visible[i];
                    name.textContent = entry ? entry.name : '';
                    name.className = entry?.wide ? 'is-mint' : '';
                    name.style.flexBasis = entry?.wide ? 'auto' : '13ch';
                    value.textContent = entry ? entry.value : '';
                    value.className = entry ? entry.tone : '';
                });
            };
            return {
                every: 2,
                tick() {
                    const done = step >= resources.length;
                    frame += 1;
                    held += 1;
                    if (held >= (done ? 20 : 4)) {
                        held = 0;
                        step = done ? 0 : step + 1;
                    }
                    paint();
                },
                rest() { step = resources.length; paint(); }
            };
        },
        gpu(viz) {
            const [gpu0, gpu1, tokens] = rows(viz, ['gpu0', 'gpu1', 'tokens']);
            const loads = [wave(0.2, 0.45, 0.98), wave(0.14, 0.3, 0.92)];
            const stream = sparkline(20, wave(0.45, 0.3, 1));
            tokens.value.className = 'is-cyan';
            return {
                every: 3,
                tick() {
                    [gpu0, gpu1].forEach(({ value }, i) => {
                        const load = loads[i]();
                        value.textContent = meter(load);
                        value.className = load > 0.85 ? 'is-amber' : 'is-mint';
                    });
                    tokens.value.textContent = stream();
                }
            };
        }
    };
    const widgets = [];
    const widgetObserver = 'IntersectionObserver' in window
        ? new IntersectionObserver((entries) => entries.forEach(({ target, isIntersecting }) => {
            const widget = widgets.find((item) => item.viz === target);
            if (widget) widget.visible = isIntersecting;
        }))
        : null;
    page.querySelectorAll('[data-tty-viz]').forEach((viz) => {
        const widget = readouts[viz.dataset.ttyViz]?.(viz);
        if (!widget) return;
        Object.assign(widget, { viz, visible: !widgetObserver });
        if (running() || !widget.rest) widget.tick();
        else widget.rest();
        widgets.push(widget);
        widgetObserver?.observe(viz);
    });
    let beat = 0;
    window.setInterval(() => {
        if (!live()) return;
        beat += 1;
        widgets.forEach((widget) => {
            if (widget.visible && beat % widget.every === 0) widget.tick();
        });
    }, 100);

    // Character rain behind the hero. Drawn at about 14 fps, and only while the hero is on screen.
    const hero = page.querySelector('[data-tty-hero]');
    const rain = (() => {
        const canvas = page.querySelector('.tty-rain');
        const context = canvas?.getContext('2d');
        if (!context) return { enable() {}, sync() {} };
        const glyphs = '01ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ<>/$#_=+';
        const cell = 16;
        let drops = [];
        let width = 0;
        let height = 0;
        let frame = 0;
        let last = 0;
        let enabled = false;
        let visible = true;
        const resize = () => {
            const ratio = Math.min(window.devicePixelRatio || 1, 2);
            width = canvas.clientWidth;
            height = canvas.clientHeight;
            canvas.width = width * ratio;
            canvas.height = height * ratio;
            context.setTransform(ratio, 0, 0, ratio, 0, 0);
            context.font = `13px ${getComputedStyle(page).fontFamily}`;
            drops = Array.from({ length: Math.ceil(width / cell) }, () => -Math.random() * 45);
        };
        const draw = (now) => {
            frame = 0;
            if (!enabled || !visible || !live()) return;
            frame = window.requestAnimationFrame(draw);
            if (now - last < 70) return;
            last = now;
            context.fillStyle = 'rgba(13, 24, 32, 0.12)';
            context.fillRect(0, 0, width, height);
            drops.forEach((row, column) => {
                context.fillStyle = Math.random() < 0.08 ? '#d8fff0' : '#66e3b4';
                context.fillText(glyphs[Math.floor(Math.random() * glyphs.length)], column * cell, row * cell);
                drops[column] = row * cell > height && Math.random() > 0.96 ? 0 : row + 1;
            });
        };
        const sync = () => {
            if (!running()) context.clearRect(0, 0, width, height);
            if (!frame && enabled && visible && live()) frame = window.requestAnimationFrame(draw);
        };
        if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
        else resize();
        if ('IntersectionObserver' in window) {
            new IntersectionObserver(([entry]) => {
                visible = entry.isIntersecting;
                sync();
            }).observe(hero);
        }
        return { enable() { enabled = true; sync(); }, sync };
    })();

    // Singapore clock and a career uptime counter (counted from July 2017).
    const sgt = (options) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', hour12: false, ...options });
    const clockLong = sgt({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const clockShort = sgt({ hour: '2-digit', minute: '2-digit' });
    const pad = (value) => String(value).padStart(2, '0');
    const uptime = (withClock) => {
        const now = new Date();
        let years = now.getUTCFullYear() - 2017;
        let months = now.getUTCMonth() - 6;
        if (months < 0) {
            years -= 1;
            months += 12;
        }
        const span = `${years}y ${months}mo`;
        if (!withClock) return span;
        return `${span} ${now.getUTCDate() - 1}d ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
    };
    const tickClock = () => {
        if (document.hidden) return;
        const now = new Date();
        page.querySelectorAll('[data-tty-clock]').forEach((node) => { node.textContent = (running() ? clockLong : clockShort).format(now); });
        page.querySelectorAll('[data-tty-clock-short]').forEach((node) => { node.textContent = clockShort.format(now); });
        page.querySelectorAll('[data-tty-uptime]').forEach((node) => { node.textContent = uptime(running()); });
    };
    page.querySelectorAll('.tty-clock-wrap, .tty-tmux-clock').forEach((node) => { node.hidden = false; });
    tickClock();
    window.setInterval(tickClock, 1000);

    // The hero boots once per browser session, then runs like any other pane.
    const started = new WeakSet();
    const runHero = async () => {
        const boot = hero.querySelector('.tty-boot');
        const skipButton = hero.querySelector('[data-tty-skip]');
        let skipped = false;
        const context = {
            fast: () => skipped || !running(),
            wait: (ms) => (skipped ? Promise.resolve() : sleep(ms))
        };
        const skip = () => {
            skipped = true;
            flush();
        };
        const onKey = (event) => {
            if (event.key === 'Escape') skip();
        };
        started.add(hero);
        hero.classList.add('is-live');
        if (running()) {
            skipButton.hidden = false;
            skipButton.addEventListener('click', skip);
            document.addEventListener('keydown', onKey);
        }
        if (running() && root.dataset.aboutBoot === 'play') {
            for (const line of boot.children) {
                line.classList.add('is-in');
                await context.wait(55 + Math.random() * 95);
            }
            await context.wait(420);
            boot.classList.add('is-clearing');
            await context.wait(280);
            try {
                sessionStorage.setItem('vishctl-about-boot', '1');
            } catch (_) {
                // The boot log simply replays when session storage is unavailable.
            }
        }
        hero.classList.add('is-booted');
        rain.enable();
        await runSteps(hero, context);
        skipButton.hidden = true;
        document.removeEventListener('keydown', onKey);
        await sleep(900);
        hero.classList.add('is-done');
    };

    const runSection = async (section) => {
        if (started.has(section)) return;
        started.add(section);
        section.classList.add('is-live');
        await runSteps(section);
        await sleep(900);
        section.classList.add('is-done');
    };
    const sections = [...page.querySelectorAll('[data-tty-section]')];
    const sectionObserver = 'IntersectionObserver' in window
        ? new IntersectionObserver((entries) => entries.forEach(({ target, isIntersecting }) => {
            if (!isIntersecting) return;
            sectionObserver.unobserve(target);
            runSection(target);
        }), { rootMargin: '0px 0px -14% 0px' })
        : null;

    // tmux status line: the window under the middle of the viewport is the active one.
    const tmux = page.querySelector('.tty-tmux');
    const tmuxList = tmux.querySelector('ol');
    const tmuxLinks = new Map([...tmux.querySelectorAll('a')].map((link) => [link.hash.slice(1), link]));
    const progressLabel = tmux.querySelector('[data-tty-progress]');
    const activate = (id) => {
        const link = tmuxLinks.get(id);
        if (!link || link.hasAttribute('aria-current')) return;
        tmuxLinks.forEach((other) => other.removeAttribute('aria-current'));
        link.setAttribute('aria-current', 'true');
        tmuxList.scrollTo({
            left: link.offsetLeft - tmuxList.offsetLeft - (tmuxList.clientWidth - link.offsetWidth) / 2,
            behavior: running() ? 'smooth' : 'auto'
        });
    };
    if ('IntersectionObserver' in window) {
        const windowObserver = new IntersectionObserver((entries) => entries.forEach(({ target, isIntersecting }) => {
            if (isIntersecting) activate(target.id);
        }), { rootMargin: '-45% 0px -50% 0px' });
        sections.forEach((section) => windowObserver.observe(section));
    }
    let progressQueued = false;
    const updateProgress = () => {
        progressQueued = false;
        const rect = page.getBoundingClientRect();
        const distance = rect.height - window.innerHeight;
        const progress = distance > 0 ? Math.min(1, Math.max(0, -rect.top / distance)) : 1;
        tmux.style.setProperty('--tty-progress', progress.toFixed(3));
        progressLabel.textContent = `${Math.round(progress * 100)}%`;
    };
    window.addEventListener('scroll', () => {
        if (progressQueued) return;
        progressQueued = true;
        window.requestAnimationFrame(updateProgress);
    }, { passive: true });
    updateProgress();

    // Interactive shell. Answers are read from the page itself, so they never drift from the content above.
    const initShell = () => {
        const shell = page.querySelector('[data-tty-shell]');
        const frame = shell?.querySelector('.tty-shell-window');
        if (!frame) return;
        const log = frame.querySelector('[data-tty-shell-log]');
        const form = frame.querySelector('form');
        const input = form.querySelector('input');
        const history = [];
        let cursor = 0;
        let batch = 0;
        frame.hidden = false;

        const print = (content = '', className = '') => {
            const line = el('p', `is-new ${className}`.trim());
            line.style.setProperty('--i', batch);
            batch += 1;
            line.append(...[].concat(content));
            log.append(line);
            while (log.childElementCount > 160) log.firstElementChild.remove();
            return line;
        };
        const link = (label, href) => {
            const anchor = el('a', null, label);
            anchor.href = href;
            if (/^https?:/.test(href) && new URL(href).origin !== location.origin) {
                anchor.target = '_blank';
                anchor.rel = 'noopener noreferrer';
            }
            return anchor;
        };
        const pair = (key, value, width = 12) => print([el('span', 'is-key', key.padEnd(width)), value]);
        const contacts = Object.fromEntries([...page.querySelectorAll('[data-tty-contact]')].map((anchor) => [anchor.dataset.ttyContact, anchor.href]));
        const places = {
            '~': 'whoami', whoami: 'whoami', home: 'whoami', impact: 'impact', work: 'work', projects: 'work', man: 'man', about: 'man',
            log: 'log', experience: 'log', toolkit: 'toolkit', skills: 'toolkit', certs: 'certs', notes: 'notes', shell: 'shell', contact: 'shell'
        };
        const go = (name) => {
            const target = Object.hasOwn(places, name) && document.getElementById(places[name]);
            if (!target) return false;
            target.scrollIntoView({ behavior: running() ? 'smooth' : 'auto' });
            return true;
        };
        const openExternal = (name) => {
            print(['opening ', link(contacts[name], contacts[name])], 'is-dim');
            window.open(contacts[name], '_blank', 'noopener');
        };

        const commands = {
            help() {
                print('Things you can run here:', 'is-dim');
                [
                    ['about', 'who this is'],
                    ['work', 'selected projects'],
                    ['log', 'career history'],
                    ['skills', 'the toolkit, by directory'],
                    ['certs', 'certifications'],
                    ['notes', 'latest blog posts'],
                    ['contact', 'ways to reach me'],
                    ['email', 'open your mail client (also: linkedin, github)'],
                    ['cd <section>', 'jump around this page, e.g. cd work'],
                    ['motion, theme', 'toggle animations or the colour theme'],
                    ['clear', 'wipe the screen (ctrl+l)']
                ].forEach(([name, what]) => pair(name, what, 15));
                print('Also: ls, cat, date, uptime, neofetch, history. Tab completes, ↑ and ↓ recall. A few easter eggs are hiding.', 'is-dim');
            },
            about() {
                print(text(page.querySelector('.tty-lead')));
                print('more: cd man', 'is-dim');
            },
            whoami() {
                print('visitor');
                print('looking for vishnu? try: about', 'is-dim');
            },
            neofetch() {
                page.querySelectorAll('.tty-kv > div').forEach((row) => pair(text(row.querySelector('dt')), text(row.querySelector('dd')), 9));
            },
            ls() {
                print(['about.txt  contact.vcf  ', el('span', 'is-key', 'impact/  work/  log/  toolkit/  certs/  notes/')]);
            },
            cat([file]) {
                const name = (file || '').replace(/\/$/, '');
                if (!name) print('usage: cat <file>', 'is-dim');
                else if (/^(about\.txt|readme\.md)$/i.test(name)) commands.about();
                else if (name === 'contact.vcf') commands.contact();
                else if (Object.hasOwn(places, name)) print(`cat: ${name}: Is a directory (try: cd ${name})`, 'is-error');
                else print(`cat: ${name}: No such file or directory`, 'is-error');
            },
            cd([place = '~']) {
                const name = place.replace(/\/$/, '') || '~';
                if (go(name)) print(`→ #${places[name]}`, 'is-dim');
                else print(`cd: no such file or directory: ${place}`, 'is-error');
            },
            work() {
                page.querySelectorAll('.tty-work').forEach((card) => pair(text(card.querySelector('.tty-work-index')), text(card.querySelector('h3')), 17));
                print('details: cd work', 'is-dim');
            },
            log() {
                page.querySelectorAll('.tty-commit').forEach((commit) => {
                    print([el('span', 'is-warn', text(commit.querySelector('.tty-hash')).replace('commit ', '')), ` ${text(commit.querySelector('h3'))}`]);
                    print(`        ${text(commit.querySelector('.tty-commit-date')).replace(/^Date:\s*/, '')}`, 'is-dim');
                });
                print('details: cd log', 'is-dim');
            },
            skills() {
                page.querySelectorAll('.tty-tree > li').forEach((row) => {
                    pair(text(row.querySelector('h3')), [...row.querySelectorAll('.tty-chips li')].map(text).join(', '), 15);
                });
            },
            certs() {
                page.querySelectorAll('.tty-certs tbody tr').forEach((row) => {
                    print([el('span', 'is-ok', '✓ '), text(row.cells[1]), el('span', 'is-dim', `  (${text(row.cells[0])})`)]);
                });
            },
            notes() {
                page.querySelectorAll('.tty-notes a').forEach((note) => {
                    print([el('span', 'is-dim', `${text(note.querySelector('time'))}  `), link(text(note.querySelector('time + span')), note.href)]);
                });
            },
            contact() {
                pair('email', link(contacts.email.replace('mailto:', ''), contacts.email), 10);
                pair('linkedin', link(contacts.linkedin.replace(/^https:\/\/(www\.)?/, ''), contacts.linkedin), 10);
                pair('github', link(contacts.github.replace(/^https:\/\//, ''), contacts.github), 10);
                print('or just run: email', 'is-dim');
            },
            email() {
                print('opening your mail client...', 'is-dim');
                window.location.href = contacts.email;
            },
            linkedin: () => openExternal('linkedin'),
            github: () => openExternal('github'),
            date() {
                print(new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'full', timeStyle: 'long' }).format(new Date()));
            },
            uptime() {
                print(`up ${uptime(true)}, 1 visitor, load average: mostly coffee`);
            },
            pwd: () => print('/home/visitor'),
            echo: (args) => print(args.join(' ')),
            clear: () => log.replaceChildren(),
            history() {
                history.forEach((entry, index) => print(`${String(index + 1).padStart(4)}  ${entry}`));
            },
            motion() {
                document.querySelector('[data-motion-toggle]')?.click();
                print(`motion: ${root.dataset.motion === 'running' ? 'on' : 'off'}`);
            },
            theme() {
                document.getElementById('theme-toggle')?.click();
                print(`theme: ${root.dataset.theme}`);
            },
            man([topic]) {
                if (topic && topic !== 'vishnu') print(`No manual entry for ${topic}`, 'is-error');
                else commands.cd(['man']);
            },
            git: () => commands.log(),
            tree: () => commands.skills(),
            top: () => commands.cd(['impact']),
            sudo(args) {
                if (args.join(' ') !== 'hire vishnu') {
                    print('visitor is not in the sudoers file. This incident will be reported.', 'is-error');
                    return;
                }
                print('[sudo] request approved. Start here:', 'is-ok');
                commands.contact();
            },
            kubectl(args) {
                if (args.join(' ') !== 'get pods') {
                    print('error: you only have access to: kubectl get pods', 'is-error');
                    return;
                }
                const age = uptime(false).split(' ')[0];
                print('NAME                 READY   STATUS    AGE', 'is-dim');
                print(`curiosity-7d9f8b6c5  1/1     Running   ${age}`);
                print(`coffee-5c6d7f8b9     1/1     Running   ${age}`);
                print('side-projects-0      0/1     Pending   2d');
            },
            vim: () => print('You are now in vim. Kidding, I would not do that to you.', 'is-dim'),
            rm: () => print('rm: nice try, this file system is read-only', 'is-error'),
            exit() {
                print('logout', 'is-dim');
                go('~');
            }
        };
        const aliases = {
            '?': 'help', readme: 'about', projects: 'work', experience: 'log', career: 'log', toolkit: 'skills', tools: 'skills',
            certificates: 'certs', posts: 'notes', writing: 'notes', mail: 'email', fetch: 'neofetch', vi: 'vim', nano: 'vim', emacs: 'vim', logout: 'exit'
        };
        const names = Object.keys(commands).sort();

        const run = (raw) => {
            const line = raw.trim();
            batch = 0;
            print(line, 'is-echo');
            if (line) {
                history.push(line);
                cursor = history.length;
                const [name, ...args] = line.split(/\s+/);
                const key = name.toLowerCase();
                const resolved = Object.hasOwn(aliases, key) ? aliases[key] : key;
                if (Object.hasOwn(commands, resolved)) commands[resolved](args);
                else {
                    print(`zsh: command not found: ${name}`, 'is-error');
                    print('try: help', 'is-dim');
                }
            }
            log.scrollTop = log.scrollHeight;
        };

        form.addEventListener('submit', (event) => {
            event.preventDefault();
            run(input.value);
            input.value = '';
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                if (!history.length) return;
                event.preventDefault();
                cursor = Math.min(history.length, Math.max(0, cursor + (event.key === 'ArrowUp' ? -1 : 1)));
                input.value = history[cursor] || '';
            } else if (event.key === 'Tab' && input.value.trim() && !event.shiftKey) {
                // Only complete when there is something to complete, so Tab still leaves an empty prompt.
                const prefix = input.value.trim().toLowerCase();
                const matches = names.filter((name) => name.startsWith(prefix));
                if (!matches.length || prefix.includes(' ')) return;
                event.preventDefault();
                if (matches.length === 1) input.value = `${matches[0]} `;
                else {
                    batch = 0;
                    print(matches.join('  '), 'is-dim');
                    log.scrollTop = log.scrollHeight;
                }
            } else if (event.key === 'l' && event.ctrlKey) {
                event.preventDefault();
                commands.clear();
            }
        });
        frame.addEventListener('click', (event) => {
            if (event.target.closest('a, button, input') || String(window.getSelection())) return;
            input.focus({ preventScroll: true });
        });
        frame.querySelectorAll('[data-tty-run]').forEach((button) => button.addEventListener('click', () => run(button.dataset.ttyRun)));

        print('vishctl shell. Type a command and press enter, or pick one below.', 'is-dim').classList.remove('is-new');
        print('Start with: help', 'is-dim').classList.remove('is-new');
    };
    initShell();

    // Follow the footer's motion switch: off shows everything at once, on re-arms the panes not yet seen.
    const syncMotion = () => {
        if (running()) root.dataset.about = 'armed';
        else {
            delete root.dataset.about;
            flush();
            widgets.forEach((widget) => widget.rest?.());
        }
        rain.sync();
        tickClock();
    };
    new MutationObserver(syncMotion).observe(root, { attributes: true, attributeFilter: ['data-motion'] });
    document.addEventListener('visibilitychange', () => {
        rain.sync();
        tickClock();
    });
    syncMotion();

    // A tab opened in the background waits, so the boot sequence is not spent on throttled timers.
    if (document.hidden) document.addEventListener('visibilitychange', runHero, { once: true });
    else runHero();
    sections.filter((section) => section !== hero).forEach((section) => {
        if (sectionObserver) sectionObserver.observe(section);
        else runSection(section);
    });
})();
