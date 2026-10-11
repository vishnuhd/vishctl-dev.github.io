---
title: "SGLang vs. vLLM: RadixAttention, Structured Outputs, and When to Pick Which"
date: 2026-10-12T03:00:00+08:00
draft: false
author: "Vishnu"
description: "A simple, diagram-first comparison of SGLang and vLLM: how RadixAttention works, how jump-forward decoding speeds up JSON outputs, how their schedulers compare, and which engine fits your workload."
series: ["AI Infra"]
tags: ["sglang", "vllm", "inference", "kv-cache", "ai-infra", "kubernetes"]
cover:
  image: "/images/posts/sglang-vs-vllm/00-pixel-art-cover.png"
  alt: "Pixel art comparison showing a glowing branching Radix tree with structured bracket gates on the left and a GPU processor core packing memory pages into parallel token streams on the right"
  relative: false
ShowToc: true
TocOpen: false
---

If you self-host open-weight LLMs today, your choice almost always comes down to two engines: **[vLLM](https://github.com/vllm-project/vllm)** and **[SGLang](https://github.com/sgl-project/sglang)**.

Both started in the same UC Berkeley research circle. Both expose an OpenAI-compatible API. Both store the KV cache in pages, and both plug into Kubernetes routers like [llm-d](/posts/llm-d-kubernetes-inference-routing/).

Yet one engine often beats the other on a real workload. Why? Because they were built to solve two different problems first:

```text
vLLM    = built like OS virtual memory: pack many independent users onto any GPU
SGLang  = built for agent programs: reuse branching prompts and force fast JSON outputs
```

{{< mermaid caption="Left: vLLM started with many separate callers sharing one GPU. Right: SGLang started with one agent branching into sub-tasks and returning strict JSON." >}}
flowchart LR
    subgraph V["vLLM starting point: many independent chats"]
        direction TB
        U1["User 1: summarize email"] a1@--> G1["Shared GPU<br/>Paged KV pool"]
        U2["User 2: write SQL"] a2@--> G1
        U3["User 3: translate text"] a3@--> G1
    end

    subgraph S["SGLang starting point: one agent, many branches"]
        direction TB
        A0["Agent: 6k-token runbook"] b1@--> B1["Check pod logs"]
        A0 b2@--> B2["Check node events"]
        A0 b3@--> B3["Return strict JSON"]
    end

    V ~~~ S
    a1@{ animate: true }
    a2@{ animate: true }
    a3@{ animate: true }
    b1@{ animate: true }
    b2@{ animate: true }
    b3@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef agent fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    class U1,U2,U3 input;
    class G1 gpu;
    class A0 agent;
    class B1,B2,B3 gpu;
{{< /mermaid >}}

Over the past year, both engines have borrowed each other's best ideas. Still, three core pieces explain why they behave differently in practice:

1. **RadixAttention vs. block hash tables** (how they reuse the KV cache)
2. **Jump-forward decoding** (how they generate strict JSON)
3. **Overlapped CPU scheduling** (how they keep the GPU from waiting on Python)

Let's walk through each one with simple examples.

## 1. KV cache reuse: block hash tables vs. RadixAttention

First, clear up a common myth: **both vLLM and SGLang use paged GPU memory.** When a model reads a prompt, both engines store the resulting attention state ([the KV cache](/posts/llm-basics-visual-guide/#5-context-is-the-input-kv-cache-saves-work)) in small physical memory blocks on the GPU.

The difference is **how they organize and look up those blocks** when the next request arrives.

### How vLLM does it: a hash table of fixed blocks

When you turn on [Automatic Prefix Caching](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/) in vLLM, it slices your prompt into fixed-size chunks (usually 16 tokens per block).

It hashes Block 0, then hashes Block 0 + Block 1, and stores those hashes in a lookup table:

```text
Block 0 (tokens 1..16)   → hash_A → GPU page 12
Block 1 (tokens 17..32)  → hash_B → GPU page 45
Block 2 (tokens 33..48)  → hash_C → GPU page 08
```

If a new request starts with the exact same 16-token blocks, vLLM finds the hashes in its table and reuses those GPU pages.

### How SGLang does it: RadixAttention (a shared family tree)

Instead of a flat hash table, SGLang stores cached token sequences in a **radix tree** (a compressed tree where shared prefixes form a single trunk, and differences split into branches).

{{< mermaid caption="Left: vLLM matches fixed 16-token blocks in a hash table. Right: SGLang keeps prompts and answers in a branching Radix tree." >}}
flowchart LR
    subgraph VLLM["vLLM: Block Hash Table"]
        direction TB
        H1["Block 0: 16 tokens<br/>hash: 9f2a"] a1@--> H2["Block 1: 16 tokens<br/>hash: 4c1b"]
        H2 a2@--> H3["Block 2A: 16 tokens<br/>hash: 7e8d"]
        H2 a3@--> H4["Block 2B: 16 tokens<br/>hash: 1a3f"]
    end

    subgraph SGL["SGLang: RadixAttention Tree"]
        direction TB
        R0["Trunk: System prompt<br/>+ 6k-token runbook"] b1@--> B1["Branch 1: Pod OOM check<br/>+ assistant answer"]
        R0 b2@--> B2["Branch 2: Node disk check<br/>+ assistant answer"]
        B1 b3@--> L1["Leaf 1A: Suggest memory limit"]
        B1 b4@--> L2["Leaf 1B: Draft PR patch"]
    end

    VLLM ~~~ SGL
    a1@{ animate: true }
    a2@{ animate: true }
    a3@{ animate: true }
    b1@{ animate: true }
    b2@{ animate: true }
    b3@{ animate: true }
    b4@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef hit fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef leaf fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class H1,H2,H3,H4 input;
    class R0 tree;
    class B1,B2 hit;
    class L1,L2 leaf;
{{< /mermaid >}}

### Example 1: One incident agent, four steps

Imagine an on-call Kubernetes agent that starts with a **6,000-token runbook** and runs four steps. Here is how SGLang's radix tree handles it:

| Step | What the agent sends | What happens in the Radix tree | Prefill work saved |
|---|---|---|---|
| **1** | `Runbook + "Why did payment-worker crash?"` | No match yet. Creates one node holding the runbook, question, and the model's answer. | 0 tokens (cold start) |
| **2** | `Runbook + "Did the node run out of disk?"` | Splits the tree right after `Runbook`. Adds a second branch for the disk question. | **Reuses 6,000 runbook tokens** |
| **3** | `Step 1 chat history + "Raise memory limit to 2Gi"` | Matches the trunk *and* Branch 1 (including the model's Step 1 answer). Adds a leaf. | **Reuses runbook + Step 1 Q&A** |
| **4** | GPU memory gets full | Evicts the oldest unused **leaf** first (`Step 2`), keeping the shared `Runbook` trunk alive. | Trunk stays warm for future calls |

Watch how the tree splits and evicts from the leaves inward:

{{< mermaid caption="Step 1 builds a single branch. Step 2 splits the edge at the shared runbook. Step 3 extends Branch 1. When memory fills up, unused leaves get evicted before the shared trunk." >}}
flowchart TD
    T["Shared Trunk<br/>6,000-token Runbook<br/>(kept warm)"] e1@--> B1["Branch 1<br/>Q1: payment-worker crash?<br/>+ Model Answer 1"]
    T e2@--> B2["Branch 2<br/>Q2: node disk full?<br/>(evicted first when idle)"]
    B1 e3@--> L1["Leaf<br/>Q3: Raise limit to 2Gi"]

    e1@{ animate: true }
    e2@{ animate: true }
    e3@{ animate: true }

    classDef trunk fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:3px;
    classDef warm fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef evict fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-dasharray:5 4;
    class T trunk;
    class B1,L1 warm;
    class B2 evict;
{{< /mermaid >}}

And here is what happens across a multi-turn chat when both the prompt and the model's generated reply stay in the tree:

{{< mermaid caption="In SGLang, Turn 1 stores both your prompt and the model's answer in the radix tree. Turn 2 only computes the new follow-up line." >}}
sequenceDiagram
    participant A as Agent
    participant S as SGLang Radix Tree
    participant G as GPU

    A->>S: 1. Runbook + Check pod status
    S->>G: Prefill Runbook + Q1, decode Answer 1
    G-->>S: Save Runbook + Q1 + Answer 1 in tree
    S-->>A: Answer 1 (Pod was OOMKilled)

    A->>S: 2. Turn 1 history + Write YAML fix
    Note over S: Full cache hit on Runbook + Q1 + Answer 1
    S->>G: Prefill only Write YAML fix
    G-->>A: Answer 2 (YAML patch)
{{< /mermaid >}}

One bonus trick: because SGLang can see the whole tree, its scheduler **reorders waiting requests** so requests sharing the same branch run back-to-back before their cached KV pages get evicted.

## 2. Structured outputs: why JSON schemas slow models down (and how Jump-Forward fixes it)

When an [AI agent](/posts/ai-agent-basics/) calls a tool or updates a ticket, it cannot return a chatty paragraph. Your code needs strict JSON:

```json
{"pod_name": "payment-worker", "oom_killed": true, "memory_mb": 2048}
```

If you only ask for JSON in the system prompt, the model will eventually add markdown backticks or miss a quote. **Guided (or constrained) decoding** guarantees valid JSON by blocking every invalid token at each step.

### The slow way: checking one token at a time

Normally, a model generates text one token at a time. With naive guided decoding, every single step looks like this:

1. Check the JSON schema to see which tokens from the 128,000-word vocabulary are legal right now.
2. Mask out all illegal tokens.
3. Run a full GPU forward pass to pick **one** token.

### Example 2: Count the wasted GPU steps in one JSON line

Look at our JSON output again:

```text
{"pod_name": "payment-worker", "oom_killed": true, "memory_mb": 2048}
```

Once the model starts the object, does it really have a choice about typing `{"pod_name": "`?

No! The schema requires `pod_name` first. And after the model generates `payment-worker`, the very next characters **must** be `", "oom_killed": `.

In a standard token-by-token loop, the GPU still runs a separate decode forward pass for `{`, `"`, `pod`, `_name`, `":`, and `"`. You are using a massive neural network as an expensive typewriter for fixed punctuation.

### The fast way: SGLang's Jump-Forward Decoding

SGLang turns your JSON schema into a **Compressed Finite-State Machine (FSM)**. Whenever the schema leaves only one valid path, SGLang **jumps forward**: it inserts the entire fixed string (`{"pod_name": "`) at once without running step-by-step decode passes, and only asks the GPU to sample when there is a real decision to make.

{{< mermaid caption="Top: token-by-token decoding runs a GPU step for every forced key and quote. Bottom: Jump-Forward pastes the fixed schema text at once and only samples the values." >}}
flowchart LR
    subgraph SLOW["Standard Token-by-Token Decode (many GPU steps)"]
        direction LR
        T1["open brace"] --> T2["key: pod"] --> T3["key: _name"] --> T4["colon + quote"] --> T5["value: payment-worker"] --> T6["key: oom_killed"] --> T7["value: true"]
    end

    subgraph FAST["SGLang Jump-Forward Decode (only samples values)"]
        direction LR
        J1["Jump at once:<br/>pod_name key"] b1@--> J2["GPU Sample:<br/>payment-worker"]
        J2 b2@--> J3["Jump at once:<br/>oom_killed key"]
        J3 b3@--> J4["GPU Sample:<br/>true"]
    end

    SLOW ~~~ FAST
    b1@{ animate: true }
    b2@{ animate: true }
    b3@{ animate: true }

    classDef waste fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef jump fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef sample fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class T1,T2,T3,T4,T6 waste;
    class T5,T7 sample;
    class J1,J3 jump;
    class J2,J4 sample;
{{< /mermaid >}}

### What about XGrammar?

To make the vocabulary masks themselves fast, the SGLang / CMU team also built **[XGrammar](https://arxiv.org/abs/2411.15100)**, which precomputes grammar masks in CPU cache so checking valid tokens takes microseconds instead of milliseconds.

Good news if you use vLLM: **vLLM V1 now uses XGrammar too.** Today, both engines give you fast grammar masking through the standard OpenAI `response_format` field, while SGLang adds jump-forward decoding and its own Python DSL for multi-step templates.

## 3. CPU scheduling: why fast GPUs sit idle waiting on Python

You might think LLM serving is 100% GPU work. On modern hardware, it isn't.

### Example 3: The 10 ms GPU step and the 5 ms Python pause

Suppose a batch decode step on an H100 takes **10 ms** on the GPU.

Between every step, the Python process on the CPU has to:

- Check which sequences finished
- Look up prefix cache blocks or radix tree nodes
- Build page tables for the next step
- Turn token IDs back into text strings for streaming

Suppose that CPU bookkeeping takes **5 ms**. If the engine runs the CPU step and the GPU step one after the other, every 10 ms of GPU work is followed by 5 ms of silence:

```text
Sequential:  [CPU 5ms] → [GPU 10ms] → [CPU 5ms (GPU idle!)] → [GPU 10ms]
Result:      The GPU sits idle 33% of the time.
```

### The fix: Overlapped Scheduling

SGLang solved this with its **[Zero-Overhead Batch Scheduler](https://lmsys.org/blog/2024-12-04-sglang-v0-4/)**: while the GPU is busy running Step 1, the CPU is *already* preparing the metadata for Step 2 in parallel. By the time the GPU finishes Step 1, Step 2 is waiting at the door.

{{< mermaid caption="Top: without overlap, the GPU waits every time the CPU prepares the next batch. Bottom: SGLang and vLLM V1 prepare Step 2 on the CPU while Step 1 is still running on the GPU." >}}
flowchart LR
    subgraph SEQ["Without Overlap: GPU waits on CPU"]
        direction LR
        C1["CPU: Prep Step 1<br/>(5 ms)"] --> G1["GPU: Run Step 1<br/>(10 ms)"] --> C2["CPU: Prep Step 2<br/>(GPU idle 5 ms)"] --> G2["GPU: Run Step 2<br/>(10 ms)"]
    end

    subgraph OVL["With Overlap (SGLang and vLLM V1)"]
        direction LR
        OC1["CPU: Prep Step 1"] b1@--> OG1["GPU: Run Step 1 (10 ms)"]
        OG1 b2@--> OG2["GPU: Run Step 2 (10 ms)"]
        OC1 b3@--> OC2["CPU: Prep Step 2 (in parallel)"]
        OC2 b4@--> OG2
    end

    SEQ ~~~ OVL
    b1@{ animate: true }
    b2@{ animate: true }
    b3@{ animate: true }
    b4@{ animate: true }

    classDef cpu fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef stall fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class C1,OC1,OC2 cpu;
    class G1,G2,OG1,OG2 gpu;
    class C2 stall;
{{< /mermaid >}}

vLLM saw the exact same bottleneck and rewrote its core loop in **[vLLM V1](https://blog.vllm.ai/2025/01/27/v1-alpha-release.html)** to overlap CPU scheduling with GPU execution as well. That is why gap benchmarks between vLLM v0.x and SGLang narrowed significantly once vLLM V1 became the default.

## Where do they fit in a Kubernetes cluster?

If you read my earlier posts on [llm-d](/posts/llm-d-kubernetes-inference-routing/) and [LMCache](/posts/why-lmcache-is-needed/), it helps to see how all of these tools fit together. They do not replace each other; they sit at different layers:

{{< mermaid caption="llm-d routes requests to the right pod. Inside that pod, you run either vLLM or SGLang. LMCache or Mooncake can sit underneath to share KV cache across pods." >}}
flowchart LR
    C["Client / Agent<br/>OpenAI API request"] e1@--> R["llm-d Router<br/>Picks cache-warm pod"]
    R e2@--> P1["Pod A: vLLM or SGLang<br/>Local GPU KV cache"]
    R -.-> P2["Pod B: vLLM or SGLang<br/>Local GPU KV cache"]
    P1 e3@--> L["LMCache / Mooncake<br/>Shared CPU or remote KV pool"]
    P2 -.-> L

    e1@{ animate: true }
    e2@{ animate: true }
    e3@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef router fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef pod fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef store fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class C input;
    class R router;
    class P1,P2 pod;
    class L store;
{{< /mermaid >}}

- **llm-d** sits **above** the pods and routes a request to whichever pod already has the prefix warm.
- **vLLM or SGLang** runs **inside** each pod to execute the model and manage that pod's GPU KV cache.
- **LMCache or Mooncake** sits **beside/below** the pods to offload or move KV tensors between pods when one pod's GPU memory isn't enough.

## Hands-on: run the same JSON test on both servers

Because both servers speak the OpenAI API, you can swap one for the other without touching your client code.

### 1. Start vLLM

```bash
vllm serve Qwen/Qwen3-8B \
  --port 8000 \
  --enable-prefix-caching \
  --structured-outputs-config '{"backend": "xgrammar"}'
```

### 2. Start SGLang

```bash
python3 -m sglang.launch_server \
  --model-path Qwen/Qwen3-8B \
  --port 30000 \
  --grammar-backend xgrammar
```

### 3. Send the exact same structured-output request to either port

Point this `curl` command at `localhost:8000` (vLLM) or `localhost:30000` (SGLang):

```bash
curl -sS http://localhost:30000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen3-8B",
    "messages": [
      {
        "role": "system",
        "content": "You are a Kubernetes incident responder. Classify the alert into the required JSON schema."
      },
      {
        "role": "user",
        "content": "Pod payment-worker-7d9f8b-x2k9p is in CrashLoopBackOff with exit code 137 (OOMKilled)."
      }
    ],
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "incident_triage",
        "strict": true,
        "schema": {
          "type": "object",
          "properties": {
            "pod": { "type": "string" },
            "reason": { "type": "string", "enum": ["OOMKilled", "ImagePullBackOff", "CrashLoopBackOff", "NodeNotReady"] },
            "oom_killed": { "type": "boolean" },
            "recommended_action": { "type": "string" }
          },
          "required": ["pod", "reason", "oom_killed", "recommended_action"],
          "additionalProperties": false
        }
      }
    }
  }'
```

### 4. Check the cache hit metrics

Send the request a second time with a different pod name, then check `/metrics` to confirm the system prompt hit the cache:

| Engine | Metric to check | What you want to see |
|---|---|---|
| **vLLM** | `vllm:prefix_cache_hits_total` ÷ `vllm:prefix_cache_queries_total` | Hit ratio climbs on repeated system prompts |
| **SGLang** | `sglang:cache_hit_rate` and `sglang:cached_tokens_total` | Radix tree hit rate climbs and prefill time drops |

Both servers also return the cached token count directly in the API response under `usage.prompt_tokens_details.cached_tokens`.

## Side-by-side comparison

| Feature | vLLM | SGLang |
|---|---|---|
| **Main strength** | Broadest model and hardware support; default Kubernetes serving engine | Branching prefix reuse (RadixAttention), structured outputs, and frontier MoE speed |
| **KV cache lookup** | Block hash table (`--enable-prefix-caching`) | **RadixAttention** tree with edge splitting and leaf-first LRU eviction |
| **Structured JSON** | XGrammar / `llguidance` | XGrammar / `llguidance` + **Jump-Forward Decoding** |
| **CPU scheduler** | Overlapped multiprocess loop (vLLM V1) | Zero-overhead overlapped batch scheduler |
| **DeepSeek / MoE tuning** | Strong support (MLA, DeepEP, P/D disaggregation) | Often first to ship new DeepSeek-V3/R1 kernels (MLA, Two-Batch Overlap, MTP) |
| **Hardware support** | **Widest:** NVIDIA, AMD ROCm, Google TPU, Intel Gaudi/XPU, AWS Neuron, Ascend, Apple Silicon, CPU | Primarily NVIDIA and AMD ROCm, with growing Ascend/TPU/CPU support |
| **Model variety** | **200+ architectures:** LLMs, vision, audio/Whisper, embeddings, rerankers | Major production LLMs and vision-language models |

## When to pick which

Follow the arrows based on your hardware and traffic:

{{< mermaid caption="Start at the top. Hardware and model breadth point to vLLM; branching agent trees, heavy JSON schemas, and large MoE throughput point to SGLang." >}}
flowchart TD
    Q1{"Running on non-NVIDIA hardware<br/>(TPU, Gaudi, Neuron) or serving<br/>embeddings / audio / niche models?"}
    Q1 e1@-->|"Yes"| V1["Pick vLLM<br/>Widest hardware and model support"]
    Q1 e2@-->|"No (NVIDIA / AMD + standard LLM)"| Q2{"What does your workload<br/>do most?"}

    Q2 e3@-->|"Agent loops, branching prompts,<br/>multi-turn forks, strict JSON outputs"| S1["Pick SGLang<br/>RadixAttention + Jump-Forward"]
    Q2 e4@-->|"Huge MoE models<br/>(DeepSeek-V3/R1, Qwen3-MoE)"| S2["Test SGLang first<br/>then compare against vLLM V1"]
    Q2 e5@-->|"General chat API or standard<br/>Kubernetes recipes (llm-d, KServe)"| V2["Pick vLLM<br/>Default across K8s tooling"]

    e1@{ animate: true }
    e2@{ animate: true }
    e3@{ animate: true }
    e4@{ animate: true }
    e5@{ animate: true }

    classDef question fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef vllm fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:3px;
    classDef sglang fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:3px;
    class Q1,Q2 question;
    class V1,V2 vllm;
    class S1,S2 sglang;
{{< /mermaid >}}

### Pick vLLM when:

- **You run many different model types or hardware chips.** If one platform team serves chat models, embeddings, rerankers, and Whisper across mixed GPUs (or TPUs and Gaudi), vLLM handles all of them with one tool.
- **You want plug-and-play Kubernetes guides.** Projects like [llm-d](/posts/llm-d-kubernetes-inference-routing/), [LMCache](/posts/why-lmcache-is-needed/), and KServe test their default recipes on vLLM first.
- **Your traffic is mostly straightforward chat or independent prompts** where fixed-block prefix caching is plenty.

### Pick SGLang when:

- **You run multi-step agents or branching workflows.** If one request forks into sub-tasks, reuses multi-turn answers, and demands strict JSON on every call, RadixAttention and Jump-Forward decoding are built for your exact traffic.
- **You serve large MoE models like DeepSeek-V3/R1 or Qwen3-MoE on NVIDIA GPUs.** SGLang has consistently led on specialized MoE kernels, Multi-head Latent Attention (MLA), and Two-Batch Overlap.

## Cheat sheet

```text
PagedAttention        = store KV cache in small GPU memory pages (both use this)
vLLM APC              = find reusable prefixes using a hash table of 16-token blocks
RadixAttention        = SGLang's shared prefix tree; splits branches and evicts leaves first
Constrained decoding  = block invalid tokens so the model cannot break your JSON schema
Jump-Forward          = paste fixed JSON keys at once instead of decoding token by token
XGrammar              = fast grammar mask engine now shared by both SGLang and vLLM
Overlap scheduler     = prepare Step 2 on the CPU while Step 1 is running on the GPU
vLLM's sweet spot     = model variety, hardware portability, Kubernetes ecosystem defaults
SGLang's sweet spot   = branching agent prompts, heavy JSON outputs, large MoE speed
```

Because both engines expose the same `/v1/chat/completions` endpoint, switching is a container-image change, not an application rewrite. To see how a smart Kubernetes router sits in front of either engine, read my [guide to llm-d](/posts/llm-d-kubernetes-inference-routing/) or try the [laptop GPU simulation lab](/posts/simulate-gpu-vllm-llm-d-on-laptop/).
