# vishctl Blog Guidelines

## 1. Writing Style & Structure
- **No em-dashes or en-dashes:** Never use `—` or `–` in prose, lists, or tables. Use colons, parentheses, commas, or separate sentences instead. Verify with `grep -n '[—–]' content/posts/<slug>.md`.
- **Easy, example-driven explanations:** Write short paragraphs (1 to 3 sentences). Explain technical concepts in plain English using concrete, relatable examples (such as a 4-step walkthrough table) before or alongside diagrams.
- **Post anatomy:**
  - Start with a sharp 2-line `text` block contrasting the core mental model.
  - Use tables and animated Mermaid diagrams (`{{< mermaid caption="..." >}}`) throughout to make every mechanism visual.
  - Include copy-pasteable hands-on commands where applicable.
  - End with a `## Cheat sheet` fenced `text` block mapping each key term to a one-line definition, plus internal links to related posts.

### Front matter
Match the existing posts:
```yaml
---
title: "..."
date: 2026-10-12T03:00:00+08:00
draft: false
author: "Vishnu"
description: "One sentence, diagram-first summary."
series: ["AI Infra"]
tags: ["lowercase", "hyphenated"]
cover:
  image: "/images/posts/<slug>/00-pixel-art-cover.png"
  alt: "Describe the image"
  relative: false
ShowToc: true
TocOpen: false
---
```
- Link related posts with root-relative paths (`/posts/<slug>/`), not full URLs.

## 2. Mermaid Diagram Rules (Mermaid v11)

### Layout & Readability (Critical)
- **Stack subgraph comparisons vertically:** When comparing two flows with `SubA ~~~ SubB`, NEVER use `flowchart LR` as the outer direction (putting two wide subgraphs side by side shrinks the SVG text to an unreadable size). Always use **`flowchart TD` on the outer diagram** so subgraphs stack Top / Bottom, and **`direction LR` inside each subgraph** so each flow uses the full article width:
  ```mermaid
  flowchart TD
      subgraph SLOW["Token-by-token decode"]
          direction LR
          T1["open<br/>brace"] --> T2["pod"] --> T3["...and<br/>so on"]
      end
      subgraph FAST["Jump-Forward decode"]
          direction LR
          J1["Jump at once<br/>pod_name key"] b1@--> J2["GPU sample<br/>payment-worker"]
      end
      SLOW ~~~ FAST
      b1@{ animate: true }
  ```
- **Use `flowchart TD` for multi-layer architecture diagrams:** When showing 3 or more stacked system layers (e.g., `Client -> Router -> Pod -> Storage`), use `flowchart TD` rather than `flowchart LR` so boxes are not squished horizontally.
- **Keep labels compact:**
  - Keep `subgraph` titles short (`"Without overlap"`, `"With overlap"`, `"vLLM: hash table"`, `"SGLang: Radix tree"`).
  - Break node labels across 2 to 3 short lines using `<br/>` (e.g., `"CPU prep 1<br/>5 ms"`).
  - Cap horizontal `direction LR` chains at 5 to 6 nodes maximum.

### Syntax & Color Palette
- **One animated edge per line:** In Mermaid v11, never chain edge IDs on a single line (`A a1@--> B a2@--> C` is a syntax error). Write one edge ID per line:
  ```mermaid
  A["Step 1"] e1@--> B["Step 2"]
  B e2@--> C["Step 3"]
  e1@{ animate: true }
  e2@{ animate: true }
  ```
- **No special characters inside labels:** Never use escaped quotes (`\"`), curly braces (`{}`), square brackets (`[]`), or `&` inside node `["..."]` labels or `sequenceDiagram` messages.
- **Standard dark-theme `classDef` palette:**
  - Blue / input: `fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;`
  - Cyan / active / GPU / hit: `fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;`
  - Violet / router / tree / cache: `fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;`
  - Amber / compute / warn / waste: `fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;`
  - Slate / idle: `fill:#101e27,stroke:#324950,color:#8aa0a8;`
- **Mandatory render verification:** Because `layouts/_partials/extend_footer.html` runs `mermaid.run({ nodes: diagrams })` inside a single `try / catch`, one broken diagram replaces *every* diagram on the page with `Diagram preview is unavailable.` Always verify with a headless browser (or the Claude Browser pane) against the local Hugo server that every `.mermaid` container renders `data-processed="true"` and zero fallback errors appear.

## 3. Cover Images & Local Preview Workflow
- **Cover image specs:** Save pixel-art covers at `static/images/posts/<slug>/00-pixel-art-cover.png` (`1672 x 941` PNG, dark midnight-blue/cyan/violet/amber aesthetic, no text in the image).
- **Preview locally first:** Always build with `hugo`, serve locally with `hugo server`, verify all diagrams render, and open the local URL for review. Do not `git commit` or `git push` until the user explicitly approves.
