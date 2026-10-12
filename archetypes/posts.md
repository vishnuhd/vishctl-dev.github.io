---
title: "{{ replace .File.ContentBaseName "-" " " | title }}"
date: {{ .Date }}
draft: true
author: "Vishnu"
description: "One sentence, diagram-first summary."
series: ["AI Infra"]
tags: ["lowercase", "hyphenated"]
cover:
  image: "/images/posts/{{ .File.ContentBaseName }}/00-pixel-art-cover.png"
  alt: "Describe the image"
  relative: false
ShowToc: true
TocOpen: false
---

One or two short sentences that set up the problem.

```text
Thing A = the old mental model, in one line
Thing B = the new mental model, in one line
```

{{ "{{<" }} mermaid caption="Top: the slow way. Bottom: the fast way." {{ ">}}" }}
flowchart TD
    subgraph SLOW["Without it"]
        direction LR
        A1["Step 1"] a1@--> A2["Step 2"]
    end
    subgraph FAST["With it"]
        direction LR
        B1["Step 1"] b1@--> B2["Step 2"]
    end
    SLOW ~~~ FAST
    a1@{ animate: true }
    b1@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class A1,B1 input;
    class A2,B2 gpu;
{{ "{{<" }} /mermaid {{ ">}}" }}

## 1. First mechanism

Short paragraphs (1 to 3 sentences). Explain with a concrete example first.

| Step | What happens | Result |
|---|---|---|
| 1 | ... | ... |

## Try it

```bash
echo "copy-pasteable commands go here"
```

## Cheat sheet

```text
Key term     = one-line definition
```

Related: [another post](/posts/hello-world/).
