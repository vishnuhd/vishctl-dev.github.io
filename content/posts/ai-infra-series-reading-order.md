---
title: "The AI Infra Series: A Map and a Reading Order"
date: 2026-10-13T02:51:00+08:00
draft: true
author: "Vishnu"
description: "A one-page map of every AI infrastructure post on this blog: what each one covers in a sentence, the order to read them in, and four shortcuts depending on whether you run a laptop, a cluster, an app, or an on-call rotation."
series: ["AI Infra"]
tags: ["ai-infra", "inference", "kubernetes", "vllm", "guide"]
cover:
  image: "/images/posts/ai-infra-reading-order/00-pixel-art-cover.png"
  alt: "Pixel art of six glowing waypoints joined by a dotted path that climbs across a night sky, ending at a small amber flag"
  relative: false
ShowToc: true
TocOpen: false
---

This blog now has more than twenty posts about running language models: on a laptop, on one GPU, and on a Kubernetes cluster. They were written in the order I got curious, which is not the order that makes them easiest to learn from.

This page fixes that. It is a map, not a new topic.

```text
Read top to bottom = from "what is a token" to "how do I run this in production"
Jump by role       = four shortcuts further down, each three to five posts long
```

{{< mermaid caption="The series in six stages. Each stage assumes the one above it, but every post links back to what it needs." >}}
flowchart TD
    F["Foundations<br/>how an LLM answers"] m1@--> E["Serving engines<br/>how one GPU serves many users"]
    E m2@--> C["Caching and routing<br/>how to stop repeating work"]
    C m3@--> G["GPUs on Kubernetes<br/>how the hardware is shared"]
    G m4@--> P["Performance<br/>how to measure and size it"]
    P m5@--> O["Operations<br/>how to keep it running"]

    m1@{ animate: true }
    m2@{ animate: true }
    m3@{ animate: true }
    m4@{ animate: true }
    m5@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class F input;
    class E,C gpu;
    class G,P tree;
    class O warn;
{{< /mermaid >}}

## Four shortcuts

If you do not want the whole path, start here.

| You are | Read these, in order |
|---|---|
| Running models on your own laptop | [LLM basics](/posts/llm-basics-visual-guide/), [quantization](/posts/llm-quantization-fp16-int8-4bit-gguf/), [Ollama](/posts/running-ollama-on-32gb-macbook-air/), [llama.cpp](/posts/running-llama-cpp-on-32gb-macbook-air/) |
| A platform engineer new to GPUs | [GPU platform](/posts/kubernetes-gpu-platform-engineering/), [GPU sharing](/posts/kubernetes-gpu-sharing-time-slicing-mps-mig/), [memory sizing](/posts/llm-gpu-memory-sizing-weights-kv-cache/), [simulation lab](/posts/simulate-gpu-vllm-llm-d-on-laptop/) |
| Building an app on top of a model | [LLM basics](/posts/llm-basics-visual-guide/), [AI agents](/posts/ai-agent-basics/), [prompt layout](/posts/prompt-layout-prefix-cache-hits/), [rate limits](/posts/llm-rate-limiting-load-shedding-tokens/) |
| On call for an LLM service | [metrics](/posts/llm-inference-metrics-ttft-tpot-throughput-goodput/), [monitoring](/posts/monitoring-vllm-prometheus-dashboard-alerts/), [autoscaling](/posts/autoscaling-llm-inference-kubernetes-keda/), [cold starts](/posts/vllm-cold-start-model-cache-kubernetes/), [load shedding](/posts/llm-rate-limiting-load-shedding-tokens/) |

## 1. Foundations

Start here if words like token, context window, or KV cache are still fuzzy.

| Post | What you get from it |
|---|---|
| [What Happens When You Ask an LLM a Question](/posts/llm-basics-visual-guide/) | The whole journey of one prompt: tokens, transformers, prefill, decode, and the KV cache |
| [AI and LLM Glossary](/posts/ai-llm-glossary/) | Short definitions for every term the other posts use |
| [What the heck is an AI Agent?](/posts/ai-agent-basics/) | Why an agent is a loop around a model, and why loops cost more to serve |
| [LLM Quantization, Simply](/posts/llm-quantization-fp16-int8-4bit-gguf/) | How rounding weights shrinks a model, and how to read names like `Q4_K_M` |

## 2. Serving engines

How one GPU answers many people at the same time.

| Post | What you get from it |
|---|---|
| [Why vLLM Is Dominating the AI Inference Market](/posts/why-vllm-is-dominating-ai-inference-market/) | PagedAttention and continuous batching, the two ideas behind modern serving |
| [SGLang vs. vLLM](/posts/sglang-vs-vllm/) | How the two main engines differ on cache reuse, JSON output, and scheduling |
| [Speculative Decoding, Simply](/posts/speculative-decoding-draft-model-explained/) | How a small model drafts tokens so the big one only has to check them |

## 3. Caching and routing

The cheapest GPU work is the work you do not repeat.

| Post | What you get from it |
|---|---|
| [Why LMCache Exists](/posts/why-lmcache-is-needed/) | Why re-reading the same context is wasteful, and how to keep that work beyond GPU memory |
| [Prompt Layout for Cache Hits](/posts/prompt-layout-prefix-cache-hits/) | How to order a prompt so the cache can actually be used |
| [llm-d, Simply](/posts/llm-d-kubernetes-inference-routing/) | Routing each request to the replica that already holds its cache |

## 4. GPUs on Kubernetes

What sits underneath the model server.

| Post | What you get from it |
|---|---|
| [Kubernetes GPU Platform Engineering](/posts/kubernetes-gpu-platform-engineering/) | The full stack from `nvidia-smi` to NCCL, with a troubleshooting question per layer |
| [GPU Sharing on Kubernetes](/posts/kubernetes-gpu-sharing-time-slicing-mps-mig/) | Time-slicing, MPS, and MIG: what each one isolates and when to use it |
| [How Much GPU Memory Does an LLM Need?](/posts/llm-gpu-memory-sizing-weights-kv-cache/) | Two formulas for weights and KV cache, and how many users fit |
| [Why Is My GPU Pod Pending?](/posts/kubernetes-gpu-pod-pending-troubleshooting/) | A seven-step checklist for a GPU Pod the scheduler will not place |

## 5. Performance

How to tell whether it is fast, and fast enough.

| Post | What you get from it |
|---|---|
| [LLM Inference Metrics, Simply](/posts/llm-inference-metrics-ttft-tpot-throughput-goodput/) | TTFT, TPOT, throughput, percentiles, and goodput, with a script to measure them |
| [Monitoring vLLM in Production](/posts/monitoring-vllm-prometheus-dashboard-alerts/) | Six dashboard panels, four alerts, and a triage table |

## 6. Operations

Keeping it up when traffic changes.

| Post | What you get from it |
|---|---|
| [Autoscaling LLM Inference on Kubernetes](/posts/autoscaling-llm-inference-kubernetes-keda/) | Why CPU-based scaling fails and how to scale on queue depth |
| [Faster vLLM Cold Starts on Kubernetes](/posts/vllm-cold-start-model-cache-kubernetes/) | Getting a new replica ready in seconds by caching the image and the model |
| [Rate Limiting LLM APIs](/posts/llm-rate-limiting-load-shedding-tokens/) | Token budgets per tenant, and rejecting work you cannot finish in time |

## Hands-on labs

Posts where the main content is commands and screenshots.

| Post | What you build |
|---|---|
| [No GPU? Simulate One](/posts/simulate-gpu-vllm-llm-d-on-laptop/) | A kind cluster with 16 fake H100s, a simulated vLLM, and the llm-d router |
| [Run vLLM on Kubernetes with Minikube, WSL2 and NVIDIA GPU](/posts/vllm-on-wsl2-minikube/) | A real GPU-backed vLLM Deployment on a Windows laptop |
| [Hermes Agent + LM Studio](/posts/hermes-agent-lm-studio-gemma4/) | A local agent with tools, backed by a model on your own machine |
| [TypeSafe's Jev: Early Access](/posts/typesafe-jev-system-one-models/) | A first look at models built for fast decisions instead of chat |

## Running models locally

A smaller side series about laptops, where memory is the main constraint.

| Post | Machine | Runtime |
|---|---|---|
| [Running Ollama on a 32 GB MacBook Air](/posts/running-ollama-on-32gb-macbook-air/) | MacBook Air | Ollama |
| [Running llama.cpp on a 32 GB MacBook Air](/posts/running-llama-cpp-on-32gb-macbook-air/) | MacBook Air | llama.cpp |
| [oMLX vs Ollama vs vMLX vs MLX-LM](/posts/omlx-vs-vmlx-vs-mlx-32gb-macbook-air/) | MacBook Air | Four MLX-based options |
| [Running a 35B MoE Model on an 8 GB Laptop GPU](/posts/running-freetoken-on-8gb-laptop-gpu/) | Windows laptop, RTX 4070 | FreeToken |

## How the pieces connect

If you only remember one picture from the series, make it this one. It is the path of a single request through everything above.

{{< mermaid caption="One request, top to bottom. Each box is covered by at least one post in the series." >}}
flowchart TD
    A["App builds a prompt<br/>stable part first"] r1@--> B["Gateway<br/>token budget and shedding"]
    B r2@--> C["Router<br/>finds the warm replica"]
    C r3@--> D["Model server<br/>queue, batch, KV cache"]
    D r4@--> E["GPU<br/>whole, sliced, or shared"]
    D r5@--> F["Metrics<br/>dashboards, alerts, autoscaling"]

    r1@{ animate: true }
    r2@{ animate: true }
    r3@{ animate: true }
    r4@{ animate: true }
    r5@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class A input;
    class B,C tree;
    class D,E gpu;
    class F warn;
{{< /mermaid >}}

| Box | Post |
|---|---|
| App builds a prompt | [Prompt layout](/posts/prompt-layout-prefix-cache-hits/) |
| Gateway | [Rate limiting and load shedding](/posts/llm-rate-limiting-load-shedding-tokens/) |
| Router | [llm-d](/posts/llm-d-kubernetes-inference-routing/) |
| Model server | [vLLM](/posts/why-vllm-is-dominating-ai-inference-market/), [SGLang vs. vLLM](/posts/sglang-vs-vllm/), [LMCache](/posts/why-lmcache-is-needed/) |
| GPU | [GPU platform](/posts/kubernetes-gpu-platform-engineering/), [GPU sharing](/posts/kubernetes-gpu-sharing-time-slicing-mps-mig/), [memory sizing](/posts/llm-gpu-memory-sizing-weights-kv-cache/) |
| Metrics | [Metrics](/posts/llm-inference-metrics-ttft-tpot-throughput-goodput/), [monitoring](/posts/monitoring-vllm-prometheus-dashboard-alerts/), [autoscaling](/posts/autoscaling-llm-inference-kubernetes-keda/) |

## Cheat sheet

```text
Foundations         = tokens, context, KV cache, agents, quantization
Serving engines     = vLLM, SGLang, and speculative decoding
Caching and routing = LMCache, prompt layout, and llm-d
GPUs on Kubernetes  = the GPU stack, sharing one card, and sizing memory
Performance         = what to measure and how to watch it
Operations          = autoscaling, cold starts, and rate limits
Labs                = the posts that are mostly commands you can run
Shortest path       = LLM basics, then metrics, then whichever stage hurts today
```

If a post is missing from the map, tell me in the comments.
