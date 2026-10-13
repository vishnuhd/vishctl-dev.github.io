---
title: "How Much GPU Memory Does an LLM Need? Weights, KV Cache, and Headroom"
date: 2026-10-13T02:20:00+08:00
draft: true
author: "Vishnu"
description: "A simple, diagram-first guide to sizing a GPU for LLM serving: how big the weights are, how much KV cache each token costs, how many concurrent users fit, and a small calculator script to check your own model."
series: ["AI Infra"]
tags: ["gpu", "inference", "kv-cache", "vllm", "capacity-planning", "ai-infra"]
cover:
  image: "/images/posts/llm-gpu-memory-sizing/00-pixel-art-cover.png"
  alt: "Pixel art of a GPU, a memory bank with fixed weights and growing cache, and a laptop displaying capacity headroom"
  relative: false
ShowToc: true
TocOpen: false
---

"Will this model fit on my GPU?" sounds like one question. It is really two, and most sizing mistakes come from answering only the first.

```text
Weights  = a fixed cost. Paid once, the same for 1 user or 100.
KV cache = a variable cost. Grows with every token of every active request.
```

{{< mermaid caption="Top: with one user, the weights dominate. Bottom: with fifty users, the same weights are still there, but the KV cache is now the bigger number." >}}
flowchart TD
    subgraph ONE["One user"]
        direction LR
        A1["Weights<br/>16 GB"] a1@--> A2["KV cache<br/>0.5 GB"]
        A2 a2@--> A3["Total<br/>about 17 GB"]
    end

    subgraph MANY["Fifty users"]
        direction LR
        B1["Weights<br/>16 GB"] b1@--> B2["KV cache<br/>26 GB"]
        B2 b2@--> B3["Total<br/>about 42 GB"]
    end

    ONE ~~~ MANY
    a1@{ animate: true }
    a2@{ animate: true }
    b1@{ animate: true }
    b2@{ animate: true }

    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class A1,B1 tree;
    class A2,B2 gpu;
    class A3,B3 warn;
{{< /mermaid >}}

This post gives you two small formulas, one worked example, and a calculator script. By the end you can estimate how many concurrent requests a GPU (or a [MIG slice](/posts/kubernetes-gpu-sharing-time-slicing-mps-mig/)) can hold before you rent it.

For what the KV cache actually is, see [What Happens When You Ask an LLM a Question](/posts/llm-basics-visual-guide/#5-context-is-the-input-kv-cache-saves-work).

## 1. Weights: the fixed cost

The weights are the model itself. Their size is one multiplication:

```text
Weight memory = number of parameters x bytes per parameter
```

Bytes per parameter depends on the precision the model is stored in:

| Precision | Bytes per parameter | 8B model | 70B model |
|---|---|---|---|
| FP32 | 4 | 32 GB | 280 GB |
| FP16 or BF16 | 2 | 16 GB | 140 GB |
| FP8 or INT8 | 1 | 8 GB | 70 GB |
| 4-bit | 0.5 | 4 GB | 35 GB |

Most models are published in 16-bit, so **"parameters in billions, times two" gives you gigabytes.** An 8B model is about 16 GB. A 70B model is about 140 GB.

Two things to remember:

- **Real 4-bit files run a little larger** than the table says, because some layers are kept at higher precision. Budget closer to 0.6 bytes per parameter.
- **Weights do not grow with traffic.** One user or a hundred, the bill is the same.

## 2. KV cache: the cost per token

Every token a request holds in context (prompt and answer) stores a key and a value in every layer. That is the KV cache, and it has its own formula:

```text
KV bytes per token = 2 x layers x KV heads x head dimension x bytes per number
```

{{< mermaid caption="Where the per-token cost comes from. One token leaves a key and a value in every KV head of every layer." >}}
flowchart LR
    T["1 token"] k1@--> L["32 layers"]
    L k2@--> H["8 KV heads<br/>per layer"]
    H k3@--> D["128 numbers<br/>per head<br/>key and value"]
    D k4@--> R["About<br/>0.13 MB<br/>per token"]

    k1@{ animate: true }
    k2@{ animate: true }
    k3@{ animate: true }
    k4@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:3px;
    class T input;
    class L,H,D tree;
    class R gpu;
{{< /mermaid >}}

### Worked example: Llama 3.1 8B

The four numbers come from the model's `config.json`:

| Setting | Field in config.json | Value |
|---|---|---|
| Layers | `num_hidden_layers` | 32 |
| KV heads | `num_key_value_heads` | 8 |
| Head dimension | `hidden_size / num_attention_heads` | 4096 / 32 = 128 |
| Bytes per number | 2 for FP16 | 2 |

```text
2 x 32 x 8 x 128 x 2 = 131,072 bytes = about 0.13 MB per token
```

One eighth of a megabyte sounds tiny. Now multiply it by real context lengths:

| Tokens held in context | KV cache needed |
|---|---|
| 1,000 (a short chat) | 0.13 GB |
| 8,000 (a long chat or small RAG prompt) | About 1 GB |
| 32,000 (a big document) | About 4 GB |
| 128,000 (the full context window) | About 17 GB |

Look at the last row. **One request using the full context window needs as much memory as the entire model.**

### Read the numbers for your own model

```bash
curl -sL https://huggingface.co/<org>/<model>/resolve/main/config.json \
  | jq '{num_hidden_layers, num_attention_heads, num_key_value_heads, hidden_size}'
```

Gated models need a Hugging Face token for this. You can also open `config.json` on the model page.

If `num_key_value_heads` is smaller than `num_attention_heads`, the model uses **grouped-query attention**. That is good news: Llama 3.1 8B has 32 attention heads but only 8 KV heads, so its cache is four times smaller than it would otherwise be.

## 3. Put it together: how many requests fit?

Take one H100 with 80 GB and serve Llama 3.1 8B in FP16 with [vLLM](/posts/why-vllm-is-dominating-ai-inference-market/).

{{< mermaid caption="The memory budget from top to bottom. Whatever is left after the weights and overhead becomes the KV cache pool, and the pool decides how many requests fit." >}}
flowchart TD
    G["H100<br/>80 GB"] m1@--> B["vLLM budget at 0.9<br/>72 GB"]
    B m2@--> W["Weights<br/>16 GB"]
    B m3@--> O["Runtime overhead<br/>about 2 GB"]
    B m4@--> K["KV cache pool<br/>about 54 GB"]
    K m5@--> T["Room for about<br/>410,000 tokens"]

    m1@{ animate: true }
    m2@{ animate: true }
    m3@{ animate: true }
    m4@{ animate: true }
    m5@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:3px;
    class G,B input;
    class W tree;
    class O idle;
    class K,T gpu;
{{< /mermaid >}}

Step by step:

| Step | Calculation | Result |
|---|---|---|
| 1. Budget | 80 GB x 0.9 (vLLM's default `--gpu-memory-utilization`) | 72 GB |
| 2. Subtract weights | 72 - 16 | 56 GB |
| 3. Subtract overhead | 56 - 2 (an estimate for runtime buffers) | 54 GB |
| 4. Convert to tokens | 54 GB / 0.13 MB per token | About 410,000 tokens |

That pool of 410,000 tokens is shared by every request in flight. So the answer to "how many users?" depends entirely on how long their requests are:

| Average tokens per request | Requests that fit at once |
|---|---|
| 2,000 (short chat) | About 205 |
| 8,000 (long chat, small RAG) | About 51 |
| 32,000 (document analysis) | About 12 |
| 128,000 (full context) | 3 |

Same GPU, same model. **The workload moves the answer from 205 to 3.**

This is a memory ceiling, not a speed promise. Long before 205 requests, latency will tell you to stop. Use the load-curve method in the [inference metrics guide](/posts/llm-inference-metrics-ttft-tpot-throughput-goodput/) to find where that happens.

## 4. Sizing a shared GPU slice

The same math tells you which [MIG profile](/posts/kubernetes-gpu-sharing-time-slicing-mps-mig/) to ask for. Here is the 8B model again, on three slices of an H100, with the same 0.9 budget and 2 GB of overhead:

| Slice | Weights | KV pool left | Tokens | 4,000-token requests |
|---|---|---|---|---|
| `1g.10gb` | FP16, 16 GB | Does not fit | 0 | 0 |
| `1g.10gb` | 4-bit, about 5 GB | About 2 GB | About 17,000 | 4 |
| `2g.20gb` | FP16, 16 GB | Nothing left | 0 | 0 |
| `2g.20gb` | 4-bit, about 5 GB | About 11 GB | About 85,000 | 21 |
| `3g.40gb` | FP16, 16 GB | 18 GB | About 137,000 | 34 |

Two lessons hide in that table:

- **"The weights fit" is not enough.** On `2g.20gb` the FP16 weights squeeze in on paper (16 GB into 20 GB), but 0.9 of 20 GB is 18 GB, and after overhead there is nothing left for the cache. The server either refuses to start or handles almost no context.
- **Quantizing the weights frees room for cache.** The cache itself usually stays in FP16 even when the weights are 4-bit, so the per-token cost does not shrink.

If the cache is your bottleneck, vLLM can also store it in 8-bit with `--kv-cache-dtype fp8`, which roughly halves the per-token cost. Test output quality before relying on it.

## Try it: a sizing calculator

This script does the whole calculation. It uses only the Python standard library.

```python
#!/usr/bin/env python3
"""llm_fit.py: estimate weights, KV cache, and concurrency for one GPU."""
import argparse

p = argparse.ArgumentParser()
p.add_argument("--params-b", type=float, required=True, help="parameters, in billions")
p.add_argument("--bytes-per-param", type=float, default=2.0, help="2 = FP16, 1 = 8-bit, 0.6 = 4-bit")
p.add_argument("--layers", type=int, required=True)
p.add_argument("--kv-heads", type=int, required=True)
p.add_argument("--head-dim", type=int, required=True)
p.add_argument("--kv-bytes", type=float, default=2.0, help="2 = FP16 cache, 1 = FP8 cache")
p.add_argument("--gpu-gb", type=float, required=True)
p.add_argument("--utilization", type=float, default=0.9)
p.add_argument("--overhead-gb", type=float, default=2.0)
p.add_argument("--tokens-per-request", type=int, default=4000)
a = p.parse_args()

GB = 1e9  # decimal gigabytes, to match how model and GPU sizes are quoted
weights_gb = a.params_b * 1e9 * a.bytes_per_param / GB
kv_per_token = 2 * a.layers * a.kv_heads * a.head_dim * a.kv_bytes
budget_gb = a.gpu_gb * a.utilization
pool_gb = budget_gb - weights_gb - a.overhead_gb

print(f"Weights            : {weights_gb:7.1f} GB")
print(f"KV cache per token : {kv_per_token / 1e6:7.3f} MB")
print(f"Usable budget      : {budget_gb:7.1f} GB")
if pool_gb <= 0:
    raise SystemExit("Does not fit: weights plus overhead exceed the budget.")
tokens = int(pool_gb * GB / kv_per_token)
print(f"KV cache pool      : {pool_gb:7.1f} GB")
print(f"Tokens that fit    : {tokens:,}")
print(f"Concurrent requests: {tokens // a.tokens_per_request:,} at {a.tokens_per_request:,} tokens each")
```

Save it as `llm_fit.py`. The example from this post:

```bash
python3 llm_fit.py --params-b 8 --layers 32 --kv-heads 8 --head-dim 128 --gpu-gb 80
```

The same model as a 4-bit file on a 20 GB MIG slice:

```bash
python3 llm_fit.py --params-b 8 --bytes-per-param 0.6 \
  --layers 32 --kv-heads 8 --head-dim 128 --gpu-gb 20
```

A 70B-class model (80 layers, 8 KV heads, head dimension 128) on one 80 GB card:

```bash
python3 llm_fit.py --params-b 70 --layers 80 --kv-heads 8 --head-dim 128 --gpu-gb 80
```

That last one reports that it does not fit. A 70B model in FP16 needs about 140 GB for weights alone, so it needs two or more GPUs, or a quantized copy.

## Check the estimate against reality

A formula is a starting point. The server knows the real answer.

When vLLM starts, it logs how much memory it gave to the KV cache and the maximum concurrency for full-length requests. Look for it:

```bash
kubectl logs deploy/vllm | grep -i -E "kv cache|maximum concurrency"
```

While it runs, the live fill level is a Prometheus metric:

```bash
curl -s http://localhost:8000/metrics | grep kv_cache_usage_perc
```

If that gauge sits near 1.0 under normal load, the pool is too small for your traffic. Requests will start to queue or be preempted, and it is time to shorten context, cap concurrency, or [add replicas](/posts/autoscaling-llm-inference-kubernetes-keda/).

## What the estimate leaves out

| Not counted | Why it matters |
|---|---|
| Prefill working memory | A very long prompt needs temporary buffers while it is being read |
| Vision or audio encoders | Multimodal models carry extra weights beyond the language model |
| LoRA adapters | Each loaded adapter adds a little weight memory |
| Mixture of experts | All experts are loaded, even though only a few run per token |
| Multiple GPUs | Tensor parallelism splits weights and cache, but adds per-GPU overhead |
| Other tenants | On a time-sliced GPU, your neighbor's memory comes out of the same card |

For a first estimate, the 2 GB overhead in the script covers the small items. For a purchase decision, load the model and read the startup log.

## What to do when it does not fit

{{< mermaid caption="Two different problems with two different sets of fixes. First check whether the weights fit, then whether the cache pool is big enough." >}}
flowchart TD
    Q1["Do the weights fit<br/>in the budget?"] f1@-->|"No"| W["Quantize weights<br/>or use a bigger GPU<br/>or split across GPUs"]
    Q1 f2@-->|"Yes"| Q2["Is the KV pool big enough<br/>for your traffic?"]
    Q2 f3@-->|"No"| K["Shorten context<br/>cap concurrency<br/>FP8 cache or add replicas"]
    Q2 f4@-->|"Yes"| OK["It fits<br/>now measure latency"]

    f1@{ animate: true }
    f2@{ animate: true }
    f3@{ animate: true }
    f4@{ animate: true }

    classDef question fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:3px;
    class Q1,Q2 question;
    class W,K warn;
    class OK gpu;
{{< /mermaid >}}

One more lever sits outside the GPU. If many requests share a long prefix, prefix caching stores that part once instead of once per request. That is the idea behind [LMCache](/posts/why-lmcache-is-needed/) and cache-aware routing in [llm-d](/posts/llm-d-kubernetes-inference-routing/).

## Cheat sheet

```text
Weight memory           = parameters x bytes per parameter; fixed, independent of traffic
FP16 rule of thumb      = parameters in billions x 2 = gigabytes
KV cache per token      = 2 x layers x KV heads x head dimension x bytes per number
Llama 3.1 8B            = about 0.13 MB of KV cache per token in FP16
KV cache pool           = GPU budget minus weights minus overhead
Tokens that fit         = KV cache pool / KV bytes per token
Concurrency ceiling     = tokens that fit / average tokens per request
gpu-memory-utilization  = vLLM's share of the GPU, 0.9 by default
Grouped-query attention = fewer KV heads than attention heads, so a smaller cache
kv-cache-dtype fp8      = store the cache in 8-bit to roughly halve the per-token cost
Rule of thumb           = weights decide if it starts, KV cache decides how many users it serves
```

Next steps: pick a slice size with the [GPU sharing guide](/posts/kubernetes-gpu-sharing-time-slicing-mps-mig/), find the real limit with the [inference metrics guide](/posts/llm-inference-metrics-ttft-tpot-throughput-goodput/), and grow past one GPU with the [autoscaling guide](/posts/autoscaling-llm-inference-kubernetes-keda/).
