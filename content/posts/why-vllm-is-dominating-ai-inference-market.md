---
title: "Why vLLM Is Dominating the AI Inference Market"
date: 2026-09-15T00:00:00+08:00
draft: false
description: "How PagedAttention, continuous batching, hardware portability, and an open ecosystem made vLLM the default engine for high-throughput LLM serving."
series: ["AI Infra"]
tags: ["vllm", "inference", "ai-infra", "kubernetes"]
cover:
  image: "/images/posts/vllm-inference-market/00-pixel-art-cover.png"
  alt: "Pixel art GPU server packing memory pages and serving many parallel token streams"
  relative: false
---

In January 2026, the maintainers of vLLM launched a company called Inferact and raised a [$150 million seed round at an $800 million valuation](https://techcrunch.com/2026/01/22/inference-startup-inferact-lands-150m-to-commercialize-vllm/), co-led by Andreessen Horowitz and Lightspeed.

That is a remarkable outcome for a project that began with a memory-management idea in a UC Berkeley research paper. It also says something about where the industry believes the next bottleneck sits. Training gets the headlines. Inference gets the bills.

vLLM is not the fastest engine in every benchmark, on every model, on every chip. Its dominance is broader than that: it has become the open serving layer that model builders, cloud platforms, accelerator vendors, and Kubernetes stacks increasingly meet in the middle.

The reasons start deep inside the KV cache.

## The problem: wasted GPU memory

During generation, a transformer stores the attention keys and values for every token it has already processed. That **KV cache** prevents the model from recomputing the entire sequence for every new token, but it grows with the request.

Traditional serving systems handled that growth by reserving one contiguous region for the request's maximum possible sequence length. A chat that uses 200 tokens could therefore hold a slot sized for 4,096. With many requests in flight, most of the most expensive memory in the system could be reserved but empty.

{{< mermaid caption="Contiguous allocation reserves for the worst case, so short requests strand most of their KV-cache slots." >}}
flowchart LR
    R1["Request A<br/>200 tokens"] --> A1["used"] --> A2["reserved"] --> A3["reserved"] --> A4["reserved"]
    R2["Request B<br/>900 tokens"] --> B1["used"] --> B2["used"] --> B3["reserved"] --> B4["reserved"]
    R3["Request C<br/>2,700 tokens"] --> C1["used"] --> C2["used"] --> C3["used"] --> C4["reserved"]

    classDef request fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef used fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef waste fill:#281d48,stroke:#7c6aa8,color:#b9add8,stroke-dasharray:5 4;
    class R1,R2,R3 request;
    class A1,B1,B2,C1,C2,C3 used;
    class A2,A3,A4,B3,B4,C4 waste;
{{< /mermaid >}}

The problem is not only the empty space at the end. Contiguous regions also fragment as requests of different lengths start and finish. Enough memory may be free in total while no single region is large enough for the next request.

That caps concurrency. Fewer requests per GPU means more GPUs for the same traffic, which pushes up cost per token.

## PagedAttention: virtual memory for the KV cache

vLLM borrowed the answer from operating systems. Instead of storing each request in one contiguous allocation, **PagedAttention** divides the KV cache into fixed-size blocks. A logical sequence can point to physical blocks anywhere in GPU memory, and the engine allocates another block only when the sequence needs it.

{{< mermaid caption="PagedAttention maps each logical sequence to small physical KV-cache blocks, allocating capacity as tokens arrive." >}}
flowchart LR
    subgraph Logical["Logical token sequences"]
        A["Request A<br/>pages 1, 2"]
        B["Request B<br/>pages 3, 4, 5"]
        C["Request C<br/>pages 6, 7"]
    end

    T["Block table"]

    subgraph Physical["Shared physical KV-cache pool"]
        P4["B · 4"]
        P1["A · 1"]
        P6["C · 6"]
        P3["B · 3"]
        P2["A · 2"]
        P7["C · 7"]
        P5["B · 5"]
        F["free"]
    end

    A --> T
    B --> T
    C --> T
    T --> P1
    T --> P3
    T --> P6

    classDef request fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef table fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef page fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef free fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-dasharray:5 4;
    class A,B,C request;
    class T table;
    class P1,P2,P3,P4,P5,P6,P7 page;
    class F free;
{{< /mermaid >}}

A short request consumes only the blocks its actual tokens require. When it finishes, those blocks return to the common pool and can immediately serve another sequence. The last block can still contain a little unused space, but external fragmentation disappears and over-reservation drops sharply.

This was not a small tuning trick. The original [PagedAttention paper](https://arxiv.org/abs/2309.06180) reported near-zero KV-cache waste and **2–4× higher throughput at comparable latency** than the serving systems it evaluated, including FasterTransformer and Orca.

PagedAttention also makes block sharing practical. Parallel samples and shared prompt prefixes can point at the same physical blocks instead of duplicating them. That matters for chat histories, agent prompts, and any workload where many requests begin with the same long context.

## Continuous batching: no empty seats

Efficient memory creates room for more requests. Continuous batching keeps that room busy.

Static batching waits for a group of requests, runs them together, and often holds the group until its slowest sequence finishes. A request generating 20 tokens can occupy a batch slot while another request in that batch runs for 500.

Continuous batching schedules at the level of a generation step. When one sequence finishes, the scheduler removes it and admits a waiting request for the next step. The batch changes shape while the model is running.

{{< mermaid caption="Continuous batching refills a GPU slot as soon as a request completes instead of waiting for the longest sequence." >}}
flowchart LR
    subgraph S1["Step 1"]
        A1["A"]
        B1["B"]
        C1["C"]
    end
    subgraph S2["Step 2"]
        A2["A"]
        B2["B"]
        C2["C · done"]
    end
    subgraph S3["Step 3"]
        A3["A"]
        B3["B"]
        D3["D · admitted"]
    end
    subgraph S4["Step 4"]
        A4["A · done"]
        B4["B"]
        D4["D"]
    end

    A1 --> A2 --> A3 --> A4
    B1 --> B2 --> B3 --> B4
    C1 --> C2 --> D3 --> D4

    classDef active fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef done fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef incoming fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    class A1,A2,A3,B1,B2,B3,B4,C1,D4 active;
    class C2,A4 done;
    class D3 incoming;
{{< /mermaid >}}

The restaurant analogy is useful: seat a new table when one leaves instead of waiting for the whole dining room to empty. Paired with PagedAttention, it lets vLLM absorb the uneven prompt lengths, output lengths, and arrival times typical of real API traffic.

## A different lane from llama.cpp and Ollama

[llama.cpp](https://github.com/ggml-org/llama.cpp) and [Ollama](https://ollama.com/) optimize for a different center of gravity: local execution, straightforward model packaging, quantized models, and a good single-user developer experience. They are excellent fits for a laptop, workstation, homelab, or local application.

vLLM is designed around shared serving: many callers, many in-flight sequences, and GPUs that need to stay saturated behind an API. Its scheduling and memory-management advantages become more valuable as concurrency rises.

So the meaningful question is not “which tool wins?” It is “what workload am I serving?” For local model use, the operational simplicity of Ollama or llama.cpp often matters more. For a high-concurrency endpoint, vLLM's architecture starts paying rent.

## Open, portable, and easy to adopt

The other half of vLLM's lead is strategic. It offers an [OpenAI-compatible server](https://docs.vllm.ai/en/stable/serving/openai_compatible_server/), which lets many applications switch their backend without rewriting the client integration. It supports hundreds of model architectures and a broad set of hardware backends.

The current [vLLM installation documentation](https://docs.vllm.ai/en/stable/getting_started/installation/) covers NVIDIA CUDA, AMD ROCm, Intel XPU, Apple Silicon, x86 and Arm CPUs, with plugins extending the project to Google TPUs, Intel Gaudi, Huawei Ascend, and other accelerators.

That portability matters. TensorRT-LLM can be an excellent choice when the target is a tightly optimized NVIDIA deployment. vLLM offers a different bargain: a common serving interface and scheduler across a heterogeneous fleet, without making the application layer care which accelerator sits underneath.

Hardware vendors have a reason to meet vLLM where its users already are. The [2026 vLLM Conference program](https://vllm.ai/events/vllm-conference/2026) includes sessions from Google on TPU acceleration and AMD on upstream ROCm collaboration. That is the ecosystem loop in action: users attract hardware support, hardware support attracts more users.

## The enterprise math

Inference optimization has direct unit economics. If an engine safely serves more concurrent tokens from the same accelerator, the saving repeats for every request, every hour, across the lifetime of the deployment.

One market estimate puts model-inference optimization tools at [$4.2 billion in 2025 and projects $48.82 billion by 2035](https://www.precedenceresearch.com/press-release/model-inference-optimization-tools-market). The exact forecast matters less than the direction: inference is becoming its own infrastructure market rather than an implementation detail after training.

Enterprises also rarely live in one environment forever. Teams mix managed APIs with self-hosted models, use different clouds by region, and change accelerators when capacity or pricing changes. A common open serving layer makes that hybrid strategy less painful. A proprietary endpoint cannot follow a workload outside its vendor's walls; vLLM can.

## Real competition is a good sign

vLLM is not unopposed. SGLang has its own strong scheduler and RadixAttention prefix-cache design. TensorRT-LLM remains formidable on NVIDIA hardware. New engines keep attacking specific layers of the serving stack, from kernels and speculative decoding to KV-cache transport.

That competition validates the size of the problem. It also clarifies vLLM's moat: not one permanent benchmark win, but a compounding ecosystem. More contributors bring earlier model support, more production experience improves the scheduler, and more surrounding infrastructure, including routers, Kubernetes operators, autoscalers, and observability, assumes vLLM as a default target. The official project now describes a community of [more than 2,000 contributors](https://docs.vllm.ai/en/stable/).

A competitor can beat a feature. Beating an integration surface that the rest of the market already builds around is harder.

## Where it is headed

The next architectural shift is **disaggregated serving**: moving prompt processing, or prefill, onto a different hardware pool from token generation, or decode.

The two phases stress hardware differently. Prefill processes many prompt tokens in parallel and is generally compute-bound. Decode produces tokens one step at a time and is usually constrained by memory bandwidth. Running both on the same GPU fleet forces one resource profile to compromise for the other.

vLLM's [disaggregated-prefill stack](https://docs.vllm.ai/projects/production-stack/en/latest/use_cases/disaggregated-prefill.html) lets operators scale and tune those pools independently, then transfer the KV cache from prefill workers to decode workers. The immediate goal is better control over time to first token and inter-token latency, not a magical throughput boost in every configuration.

That nuance is the larger story of vLLM. It did not win attention with a flashy model launch. It solved a boring, expensive systems problem: wasted GPU memory. Then it paired that solution with a scheduler, a familiar API, broad hardware support, and an open community.

The market is not standardizing on vLLM because it wins every microbenchmark. It is standardizing on vLLM because it is becoming the place where the whole inference ecosystem connects.

## Run vLLM yourself

Want to move from architecture to implementation? Read my hands-on guide to [running vLLM on Kubernetes with Minikube, WSL2, and an NVIDIA GPU](/posts/vllm-on-wsl2-minikube/).
