# vishctl

Notes on infra, Kubernetes, and AI systems, hosted at [vishctl.dev](https://vishctl.dev).

## About

A personal blog built with [Hugo](https://gohugo.io/) and the [PaperMod](https://github.com/adityatelange/hugo-PaperMod) theme, deployed to GitHub Pages. The name is a play on `kubectl`, reflecting a decade of DevOps and Kubernetes work.

## Tech stack

- Hugo (extended) static site generator
- PaperMod theme (git submodule)
- GitHub Pages + GitHub Actions CI/CD
- Giscus comments (GitHub Discussions)
- Chroma syntax highlighting

## Local development

```bash
hugo server
```

Site available at `http://localhost:1313`.

## Adding a post

```bash
hugo new posts/my-new-post.md
```

This uses `archetypes/posts.md`, which pre-fills the standard front matter and the post skeleton (opening `text` block, a Mermaid diagram, a cheat sheet). Writing and diagram conventions live in [AGENTS.md](AGENTS.md).

## Checking a post before publishing

```bash
python3 scripts/lint-posts.py
```

The linter needs only `python3`. It fails on em-dashes and en-dashes, Mermaid v11 pitfalls (chained edge IDs, special characters in labels, wide side-by-side subgraphs), missing front matter, missing images, and internal links that point to a post that does not exist. Missing cheat sheets and off-size covers are reported as warnings. Pass a slug to check one post, or `--strict` to fail on warnings too.

It does not replace the render check: one broken Mermaid diagram blanks every diagram on the page, so still open the post on `hugo server` before pushing.

Images go in `static/images/` and are referenced with absolute paths (e.g., `/images/foo.png`) so they work in both the site and RSS feed.
