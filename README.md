# vishctl

Notes on infra, Kubernetes, and AI systems — hosted at [vishctl.dev](https://vishctl.dev).

## About

A personal blog built with [Hugo](https://gohugo.io/) and the [PaperMod](https://github.com/adityatelange/hugo-PaperMod) theme, deployed to GitHub Pages. The name is a play on `kubectl` — reflecting a decade of DevOps and Kubernetes work.

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

Images go in `static/images/` and are referenced with absolute paths (e.g., `/images/foo.png`) so they work in both the site and RSS feed.
