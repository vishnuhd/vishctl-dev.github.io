---
title: "Why LMCache Exists: Stop Making GPUs Read the Same Context Again"
date: 2026-09-18T00:00:00+08:00
draft: false
description: "An example-driven guide to LMCache: repeated prefill, KV cache reuse, CPU offloading, multi-replica serving, and where caching actually helps."
series: ["AI Infra"]
tags: ["lmcache", "vllm", "kv-cache", "inference", "ai-infra", "rag"]
cover:
  image: "/images/posts/lmcache/00-pixel-art-cover.png"
  alt: "Pixel art cache vault reusing stored memory blocks across three GPU servers"
  relative: false
---

Imagine an internal assistant that answers questions about your Kubernetes platform. Every request includes the same long operations runbook.

One engineer asks, “How do I drain a node?” Another asks, “What should I check before upgrading the cluster?” A third asks, “How do we recover a failed deployment?”

The questions differ. Most of the input is identical. Yet whenever the serving system cannot reuse its previous work, the GPU processes that runbook again before it can start answering.

**LMCache helps preserve and reuse that prompt-processing work, including beyond GPU memory and across compatible serving instances.** The payoff is less repeated computation and potentially a shorter wait for the first token. It plugs into the serving stack; the model still generates an answer to each new question. [The LMCache project](https://github.com/LMCache/LMCache) describes this as a KV cache management layer.

## First, where does the waiting happen?

For a typical decoder-only language model, serving a request has two main phases:

- **Prefill:** process the input tokens and build the attention state needed to generate an answer.
- **Decode:** generate output tokens one step at a time, using that state and extending it.

The attention state includes **keys and values**, stored as tensors across the model's layers. This is the **KV cache**. It lets later tokens attend to earlier tokens without rebuilding all their keys and values each time.

{{< mermaid caption="The first answer token comes after prompt processing. Long repeated inputs create an opportunity to reuse that work." >}}
flowchart TD
    P["Prompt<br/>Runbook + question"] --> F["PREFILL<br/>Process input tokens"]
    F --> K["KV cache<br/>Attention keys and values"]
    K --> D["DECODE<br/>Generate answer tokens"]
    D --> A["Stream answer to the user"]
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef compute fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef cache fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef output fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class P input;
    class F compute;
    class K cache;
    class D,A output;
{{< /mermaid >}}

**Time to first token (TTFT)** measures how long the caller waits before output starts. Queueing, cache lookup or loading, and prefill can all contribute. Once output starts, decode speed determines how quickly the rest arrives.

Reusing prompt KV primarily attacks the prefill part. It does not remove the need to generate the answer. vLLM's [automatic prefix caching documentation](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/) makes this distinction explicit: prefix reuse helps repeated inputs, but does not directly speed up decoding.

## Example 1: one runbook, a hundred questions

Suppose each request has a 20,000-token shared prefix followed by a 100-token question. For simplicity, assume compatible model settings and tokenization, cacheable block boundaries, and a cache that retains the whole shared prefix.

| Workload | No reusable prompt cache | Ideal warm prefix reuse |
|---|---|---|
| First question | Prefill 20,100 input tokens | Prefill 20,100 input tokens and retain KV |
| Each later question | Prefill another 20,100 tokens | Restore shared KV; prefill about 100 new tokens |
| 100 questions | 2,010,000 input tokens processed through prefill | About 30,000 input tokens processed through prefill, plus cache transfers |

This is illustrative token accounting, **not a latency benchmark**. The new question still attends to the long context, cache transfers take time, and generation still runs. A 67× reduction in the counted prefill tokens does not imply a 67× faster application.

The useful observation is simpler: the shared 20,000-token input should not require the same full computation for every question.

{{< mermaid caption="A miss builds the reusable state. A later hit restores that state and computes the new suffix before generating a fresh answer." >}}
flowchart TD
    R["Runbook + new question"] --> L{"Compatible cached<br/>prefix available?"}
    L -->|Miss| F["Prefill the full prompt"]
    F --> S["Save reusable KV<br/>through LMCache"]
    F --> D["Decode a fresh answer"]
    L -->|Hit| H["Load cached prefix KV<br/>into GPU memory"]
    H --> N["Prefill uncached suffix<br/>including the question"]
    N --> D
    S -.->|Available to later requests| L
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef cache fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef compute fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef output fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class R input;
    class L,S,H cache;
    class F,N compute;
    class D output;
{{< /mermaid >}}

The diagram shows the logical flow; storage and execution may overlap in an actual deployment.

## Doesn't vLLM already cache prefixes?

Yes. A later request can already reuse a matching prefix that vLLM retains. If all your useful prefixes fit in its GPU cache and requests keep reaching the right instance, that may be enough.

The gap appears when reusable state is evicted under memory pressure, requests move between replicas, or you want cache storage to outlive an inference process. LMCache adds offloading, storage, and sharing around the serving engine. Its supported storage options include CPU memory, local storage, and remote backends. [LMCache's feature overview](https://github.com/LMCache/LMCache) describes these capabilities.

| Component | Main responsibility |
|---|---|
| vLLM serving engine | Schedule requests and execute the model |
| Native GPU prefix cache | Reuse matching prompt state retained by the engine |
| LMCache | Manage additional KV storage and reuse through an engine integration |
| Configured storage or transport backend | Hold or move the cached tensors |

In the current recommended **multiprocess mode**, LMCache runs as a separate service. Multiple vLLM instances on a node can share that service, and cache resources can be managed independently of the engine. The [architecture documentation](https://docs.lmcache.ai/mp/index.html) explains this separation.

{{< mermaid caption="A conceptual deployment: the inference engine uses GPU KV, while LMCache manages additional storage. Backends are configured choices, not a mandatory chain." >}}
flowchart TD
    A["Application"] --> V["vLLM<br/>Scheduler + model execution"]
    V <--> G["GPU memory<br/>Active KV + retained prefixes"]
    V <-->|KV connector| L["LMCache service"]
    L <--> C["CPU memory<br/>Reusable KV"]
    L <--> S["Optional local storage"]
    L <--> R["Optional remote backend"]
    classDef engine fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef gpu fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef cache fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef store fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class A,V engine;
    class G gpu;
    class L cache;
    class C,S,R store;
{{< /mermaid >}}

CPU RAM is volatile. A separate cache process can survive an engine restart while that cache process remains alive, but surviving a machine restart requires a suitable persistent backend and recovery configuration.

## Example 2: a conversation that keeps growing

Consider an incident assistant:

```text
Turn 1: system instructions + runbook + initial incident details
Turn 2: previous conversation + "Here are the latest pod events"
Turn 3: previous conversation + "The rollout is still stuck"
```

Each turn extends earlier context. Preserved KV can let the engine process the newly appended portion instead of rebuilding the entire history. If a user pauses while other requests fill GPU memory, an external cache can make that older state available again.

This is particularly useful for agents that repeatedly send stable instructions, tool definitions, and an accumulating history. The application still needs to supply the appropriate context; KV caching is not a replacement for conversation storage.

Prompt layout matters. Put stable material before changing material when the application permits it. A changing timestamp at the beginning can break an otherwise useful exact prefix. Likewise, editing an earlier message or summarizing the history changes which tokens remain reusable.

## Example 3: the next request lands on another replica

Suppose request one runs on node A and warms its cache. The load balancer sends a related request to node B. A cache hit on A does not automatically mean B has the data.

LMCache's [P2P sharing mode](https://docs.lmcache.ai/mp/p2p.html) lets node-local cache services retrieve KV from peers. The documented design uses a coordinator for peer discovery and a transfer channel for the actual data; production performance depends on the network and configuration.

{{< mermaid caption="With P2P configured, node B can retrieve a compatible prefix cached on node A. Cross-node reuse requires an explicit sharing setup." >}}
flowchart TD
    R["Related requests"] --> LB["Load balancer"]
    LB -->|First request| A["Node A<br/>Inference engine"]
    LB -->|Later request| B["Node B<br/>Inference engine"]
    A -->|Store KV| CA["LMCache A<br/>Warm prefix"]
    CB["LMCache B"] -->|Restore KV| B
    CA -->|Peer KV transfer| CB
    C["Coordinator<br/>Peer discovery"] -.-> CA
    C -.-> CB
    classDef engine fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef cache fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef control fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class R,LB,A,B engine;
    class CA,CB cache;
    class C control;
{{< /mermaid >}}

This can reduce redundant prefill across the fleet. Cache-aware routing may still help by keeping requests near useful state and avoiding transfers.

Compatibility remains essential: cached tensors are tied to model computation. Do not assume that a cache produced with one model, adapter, or KV representation can be loaded by an arbitrary other configuration.

## What about RAG documents in a different order?

Retrieval-augmented generation introduces a harder case:

```text
Request A: system + document A + document B + question A
Request B: system + document B + document A + question B
```

The documents repeat, but the document prefix does not. Attention state depends on preceding context, so moving a document is not equivalent to reusing an unchanged prefix.

**CacheBlend** extends reuse to repeated chunks outside the prefix by selectively recomputing part of the state. It requires explicit configuration; ordinary prefix caching does not acquire this behavior automatically. Evaluate answer quality as well as latency when using it. The current [CacheBlend documentation](https://docs.lmcache.ai/kv_cache_optimizations/cacheblend.html) describes the blend engine.

It also helps to separate three different caches:

| Cache | What it reuses | Example |
|---|---|---|
| Retrieval or embedding cache | Search-related work | Reuse a query embedding or retrieved document list |
| Response cache | A completed answer | Return an answer previously generated for a matching request |
| KV cache | Intermediate model attention state | Reuse runbook processing while answering a different question |

LMCache's KV layer addresses the third row. Your vector database still retrieves context, and the model still reasons over the supplied input to produce output.

## The tradeoff: moving data versus doing math

A cache hit is useful when retrieving and restoring the KV costs less than the computation it avoids.

For an illustrative request, suppose recomputing the shared prefix takes 800 ms. If lookup and restoration cost 120 ms, that portion of the path saves roughly 680 ms. If they cost 950 ms, the cache makes that path slower. These are invented timings to explain the decision, not measured LMCache results.

KV tensors can occupy much more space than their source text. Their size depends on token count, layer count, KV heads, head dimensions, and precision. A small text file can therefore create substantial storage and network traffic.

| Workload characteristic | Expected opportunity |
|---|---|
| Long repeated prefixes that exceed GPU cache capacity | Strong candidate for offloading and reuse |
| Related requests distributed across replicas | Sharing may recover otherwise missed reuse |
| Mostly short, unique prompts | Little repeated work to avoid |
| Long answers with very short prompts | Decode may dominate total latency |
| Slow storage or congested network | Transfers may erase the gain |
| Working set already fits in native GPU prefix cache | Additional benefit may be limited |

These are workload deductions from the reuse mechanism, not universal performance guarantees.

## How I would evaluate it

Start with a representative workload and compare **vLLM with its native prefix cache** against the same setup with LMCache. Keep the model, hardware, prompt mix, concurrency, and output limits consistent.

Measure cold requests separately from warm ones. Include enough distinct documents or conversations to create realistic cache pressure; repeatedly submitting one tiny prompt mostly tests an easy case.

Track TTFT at the median and tail, total request latency, throughput, tokens reused, and cache load time. For CacheBlend, add an answer-quality evaluation. The official [benchmarking guide](https://docs.lmcache.ai/getting_started/benchmarking.html) provides a long-document Q&A workload and a baseline-versus-LMCache comparison.

For implementation, use the current [quickstart](https://docs.lmcache.ai/getting_started/quickstart.html), which recommends a standalone LMCache service connected through `LMCacheMPConnector`. Match the instructions to your installed versions: older examples use a different in-process connector.

The motivating question is practical: **how much GPU work are we repeating because useful context state was discarded or is sitting on another machine?** If the answer is “a lot,” LMCache gives that work a longer useful life.

For the serving-engine side of the story, see [why vLLM matters for AI inference](/posts/why-vllm-is-dominating-ai-inference-market/).
