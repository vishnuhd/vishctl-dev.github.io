---
title: "Prompt Layout for Cache Hits: Put the Stable Part First"
date: 2026-10-13T02:45:00+08:00
draft: true
author: "Vishnu"
description: "A simple, diagram-first guide to writing prompts that a prefix cache can reuse: why one early timestamp throws away the whole cache, the right order for prompt parts, how to keep chat history append-only, and a script that measures the difference."
series: ["AI Infra"]
tags: ["prompt-caching", "kv-cache", "inference", "vllm", "rag", "ai-infra"]
cover:
  image: "/images/posts/prompt-layout-cache/00-pixel-art-cover.png"
  alt: "Pixel art of two prompt strips beside documents and a locked cache drawer, contrasting an early change with a reusable stable prefix"
  relative: false
ShowToc: true
TocOpen: false
---

Two teams send the same model the same 3,000-token prompt: same instructions, same tools, same documents. One team's requests start answering in 150 ms. The other's take over a second.

The only difference is where they put the timestamp.

```text
Prefix cache    = reuses work only for the part that is identical from the very first token
One early change = everything after it is computed again
```

{{< mermaid caption="Top: a timestamp at the start changes token one, so nothing can be reused. Bottom: the same content with the timestamp at the end reuses almost everything." >}}
flowchart TD
    subgraph BAD["Timestamp first"]
        direction LR
        A1["Time<br/>changes"] a1@--> A2["System<br/>prompt"]
        A2 a2@--> A3["Tools and<br/>documents"]
        A3 a3@--> A4["Question"]
        A4 a4@--> A5["0% reused"]
    end

    subgraph GOOD["Stable part first"]
        direction LR
        B1["System<br/>prompt"] b1@--> B2["Tools and<br/>documents"]
        B2 b2@--> B3["Time<br/>changes"]
        B3 b3@--> B4["Question"]
        B4 b4@--> B5["99% reused"]
    end

    BAD ~~~ GOOD
    a1@{ animate: true }
    a2@{ animate: true }
    a3@{ animate: true }
    a4@{ animate: true }
    b1@{ animate: true }
    b2@{ animate: true }
    b3@{ animate: true }
    b4@{ animate: true }

    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    class A1,B3,A5 warn;
    class A2,A3,A4 idle;
    class B1,B2,B5 gpu;
    class B4 input;
{{< /mermaid >}}

Most posts about prompt caching are written for platform teams. This one is for whoever builds the prompt.

The cache is already there in vLLM, SGLang, and most hosted APIs. Whether you benefit is decided by the order of your prompt.

## Why only the prefix counts

When a model reads a prompt, the state it builds for each token depends on **every token before it**. That state is the [KV cache](/posts/llm-basics-visual-guide/#5-context-is-the-input-kv-cache-saves-work).

So a saved state for token 500 is only valid if tokens 1 to 499 are exactly the same as last time. Change token 3, and the saved state for tokens 4 onward is no longer correct. The server has to throw it away.

That gives one rule that explains everything else in this post:

```text
A cache hit ends at the first token that differs.
```

It does not matter that the other 2,990 tokens are identical. They come after the change.

## A four-request walkthrough

Take one prompt of about 2,900 tokens and send it four times, with a new question and a new timestamp each time.

| Request | Timestamp first: tokens reused | Stable part first: tokens reused |
|---|---|---|
| 1 | 0 (nothing cached yet) | 0 (nothing cached yet) |
| 2 | 0 | 2,896 |
| 3 | 0 | 2,896 |
| 4 | 0 | 2,896 |

With the timestamp first, request four costs exactly as much as request one. The cache is full of state that never matches.

With the stable part first, every request after the first only has to read about 26 new tokens. That is the difference in [time to first token](/posts/llm-inference-metrics-ttft-tpot-throughput-goodput/#1-ttft-time-to-first-token) from the opening example.

## The right order: slowest-changing first

Sort the parts of your prompt by how often they change. The part that changes least goes first.

{{< mermaid caption="Order prompt parts from never changing at the top to always changing at the bottom. The cache can reuse everything above the first part that changed." >}}
flowchart TD
    L1["System prompt<br/>changes on deploy"] o1@--> L2["Tool definitions<br/>changes on deploy"]
    L2 o2@--> L3["Examples<br/>changes rarely"]
    L3 o3@--> L4["Documents<br/>changes per topic"]
    L4 o4@--> L5["Chat history<br/>grows each turn"]
    L5 o5@--> L6["Question, time, IDs<br/>changes every request"]

    o1@{ animate: true }
    o2@{ animate: true }
    o3@{ animate: true }
    o4@{ animate: true }
    o5@{ animate: true }

    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class L1,L2,L3 gpu;
    class L4 tree;
    class L5 input;
    class L6 warn;
{{< /mermaid >}}

| Position | Part | Shared by |
|---|---|---|
| 1 | System prompt | Every request to this app |
| 2 | Tool definitions | Every request to this app |
| 3 | Few-shot examples | Every request to this app |
| 4 | Retrieved documents | Requests about the same topic |
| 5 | Conversation history | Later turns of the same chat |
| 6 | New question, timestamp, request ID, user name | Nobody |

The third column is the real point. Parts 1 to 3 are shared by **all users**, so they are cached once and reused by everyone. Put a user name above them, and each user gets a private copy of the whole thing.

## Six things that quietly break the cache

These are the mistakes I would check for first. None of them looks like a bug.

| Mistake | Why it breaks the prefix | Fix |
|---|---|---|
| Timestamp in the system prompt | Token one changes every second | Move it to the end, or use the date without the time |
| User name or ID near the top | Every user has a different prefix | Put per-user details after the shared parts |
| Tools listed in a different order | Same tools, different tokens | Sort tools by name before sending |
| JSON with unstable key order | `{"a":1,"b":2}` is not `{"b":2,"a":1}` | Serialize with sorted keys |
| Documents in relevance order | Same documents, new order each query | Keep a stable order, such as by document ID |
| Rewriting old chat turns | Editing turn 2 invalidates turns 3 onward | Only append; never edit earlier messages |

The JSON row catches many agent frameworks. If tool definitions are built from a dictionary and the language does not guarantee key order, two identical requests can produce two different prompts.

### A timestamp does not have to go last

Sometimes the model needs the date. You have two cache-friendly options:

- **Put it at the end**, next to the question.
- **Make it coarse.** `2026-10-13` changes once a day. `2026-10-13T02:45:17` changes every second.

A date that changes once a day costs one cache miss per day. That is fine.

## Chat history: append, never rewrite

A conversation is the best case for a prefix cache, because every turn starts with the entire previous turn.

{{< mermaid caption="Top: when history only grows, each turn reuses everything before it. Bottom: when history is rewritten into a summary, the prefix changes and the turn starts from zero." >}}
flowchart TD
    subgraph APPEND["Append only"]
        direction LR
        P1["Turn 1<br/>read 2,000"] p1@--> P2["Turn 2<br/>reuse 2,000<br/>read 300"]
        P2 p2@--> P3["Turn 3<br/>reuse 2,300<br/>read 300"]
    end

    subgraph REWRITE["Summarize every turn"]
        direction LR
        R1["Turn 1<br/>read 2,000"] r1@--> R2["Turn 2<br/>new summary<br/>read 1,500"]
        R2 r2@--> R3["Turn 3<br/>new summary<br/>read 1,600"]
    end

    APPEND ~~~ REWRITE
    p1@{ animate: true }
    p2@{ animate: true }
    r1@{ animate: true }
    r2@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class P1,R1 input;
    class P2,P3 gpu;
    class R2,R3 warn;
{{< /mermaid >}}

Summarizing history feels efficient, because the prompt gets shorter. But a shorter prompt that misses the cache can cost more than a longer one that hits it.

In the diagram, the summarized chat reads 1,500 fresh tokens on turn 2. The append-only chat reads 300.

You do have to trim eventually, when the context window fills up. Do it rarely and in big steps:

- **Summarize once every many turns**, not every turn. You pay one cache miss, then get hits again.
- **Trim from a fixed point.** Dropping the oldest messages changes the prefix, so drop a large chunk at once instead of one message per turn.
- **Keep the system prompt and tools untouched** when you trim. They stay cached for everyone.

## Retrieved documents: the hard case

RAG prompts are where the simple rule runs out. The same documents come back in a different order, ranked by relevance to each new question.

| Document order | What gets reused |
|---|---|
| Same documents, same order | Everything up to the question |
| Same documents, different order | Only the system prompt and tools |
| Different documents | Only the system prompt and tools |

If your retriever often returns the same set, sorting by a stable key (document ID, or source and page number) turns the second row into the first.

There is a real trade-off. Some models pay more attention to documents near the start or end of the context, so relevance order can help answer quality. Measure both before deciding.

For reuse that survives reordering, you need something beyond a prefix cache. That is what CacheBlend does in [LMCache](/posts/why-lmcache-is-needed/#what-about-rag-documents-in-a-different-order).

## Try it: measure the layouts

This script builds the same prompt in three layouts and counts how many tokens a prefix cache could reuse. It uses only the Python standard library.

```python
#!/usr/bin/env python3
"""prefix_share.py: how much of a prompt can a prefix cache reuse?"""

BLOCK = 16  # vLLM caches whole 16-token blocks


def part(name, size):
    """A stand-in for `size` tokens of fixed text."""
    return [f"{name}{i}" for i in range(size)]


SYSTEM, TOOLS = part("sys", 600), part("tool", 300)
DOC_A, DOC_B = part("docA", 1000), part("docB", 1000)


def reusable(previous, current):
    """Tokens at the start of `current` that match `previous`, in whole blocks."""
    same = 0
    for a, b in zip(previous, current):
        if a != b:
            break
        same += 1
    return same // BLOCK * BLOCK


def request(layout, n):
    stamp = [f"time-{n}", f"request-id-{n}"]
    question = part(f"question{n}-", 20)
    docs = DOC_A + DOC_B
    if layout == "timestamp first":
        return stamp + SYSTEM + TOOLS + docs + question
    if layout == "documents reshuffled":
        docs = DOC_A + DOC_B if n % 2 else DOC_B + DOC_A
        return SYSTEM + TOOLS + docs + stamp + question
    return SYSTEM + TOOLS + docs + stamp + question   # stable first


for layout in ("timestamp first", "documents reshuffled", "stable first"):
    prompts = [request(layout, n) for n in range(1, 5)]
    total = sum(len(p) for p in prompts[1:])
    hit = sum(reusable(a, b) for a, b in zip(prompts, prompts[1:]))
    print(f"{layout:21} {hit:5,} of {total:,} prompt tokens reused  ({100 * hit / total:4.1f}%)")
```

```bash
python3 prefix_share.py
```

The output:

```text
timestamp first           0 of 8,766 prompt tokens reused  ( 0.0%)
documents reshuffled  2,688 of 8,766 prompt tokens reused  (30.7%)
stable first          8,688 of 8,766 prompt tokens reused  (99.1%)
```

Same content in all three. The middle row is the RAG case: the system prompt and tools are reused, and the reshuffled documents are not.

The `BLOCK = 16` line reflects how vLLM matches prefixes: in whole blocks of 16 tokens, as I described in [SGLang vs. vLLM](/posts/sglang-vs-vllm/#1-kv-cache-reuse-block-hash-tables-vs-radixattention). The last partial block is always recomputed, which is why the best case is 99% and not 100%.

## Check it on a real server

A simulation shows the idea. The server shows the truth.

**Time it.** Send the same long prompt twice with the timing script from my [inference metrics guide](/posts/llm-inference-metrics-ttft-tpot-throughput-goodput/#try-it-measure-ttft-and-tpot-yourself). If the second TTFT is much lower, the prefix was reused. Then move a timestamp to the front and watch the gain disappear.

**Read the counters.** vLLM counts how many prompt tokens it looked up and how many it found:

```bash
curl -s http://localhost:8000/metrics | grep prefix_cache
```

The hit rate is hits divided by queries:

```text
sum(rate(vllm:prefix_cache_hits_total[5m])) / sum(rate(vllm:prefix_cache_queries_total[5m]))
```

That is panel 6 in my [vLLM monitoring guide](/posts/monitoring-vllm-prometheus-dashboard-alerts/#6-prefix-cache-hit-rate). If it drops right after a release, someone changed the prompt template.

Hosted APIs follow the same prefix rule. Some cache automatically once a prompt is long enough, and some ask you to mark where the reusable part ends.

Either way, their usage report shows how many input tokens were served from cache, and cached tokens are usually billed at a discount. The layout advice here applies unchanged.

## When layout is not enough

Good layout makes hits possible. Two other things decide whether they happen.

| Problem | Symptom | Fix |
|---|---|---|
| Requests spread over many replicas | Hits on one Pod, misses on the next | Cache-aware routing with [llm-d](/posts/llm-d-kubernetes-inference-routing/) |
| Cache evicted under memory pressure | Hit rate falls when traffic rises | More KV cache room, or offload with [LMCache](/posts/why-lmcache-is-needed/) |

Fix the layout first. It is free, it needs no new infrastructure, and the other two fixes work better once it is done.

## Cheat sheet

```text
Prefix cache        = reuses saved state for the part of a prompt identical from token one
First difference    = where the cache hit ends; everything after is recomputed
Stable-first layout = order parts by how rarely they change: system, tools, examples, docs, chat, question
Shared prefix       = the parts every user sends; cached once and reused by all
Timestamp rule      = put it last, or make it coarse (a date, not a time)
Deterministic JSON  = sort keys and tool lists so identical content gives identical tokens
Append-only history = add new turns at the end; never edit or summarize earlier ones each turn
Stable document order = sort retrieved documents by ID so the same set gives the same prefix
16-token blocks     = vLLM matches prefixes in whole blocks, so the last partial block is redone
Hit rate            = cached prompt tokens / all prompt tokens
Rule of thumb       = anything that changes per request goes at the end
```

For what the cache stores and why it saves time, read [Why LMCache Exists](/posts/why-lmcache-is-needed/). For how much memory all that cached state takes, read [How Much GPU Memory Does an LLM Need?](/posts/llm-gpu-memory-sizing-weights-kv-cache/).
