---
title: "LLM Inference Metrics, Simply: TTFT, TPOT, Throughput, and Goodput"
date: 2026-10-13T02:10:00+08:00
draft: true
author: "Vishnu"
description: "A simple, diagram-first guide to reading LLM serving numbers: what TTFT, TPOT, ITL, throughput, percentiles, and goodput measure, how they trade off, and a 40-line script to measure them on any OpenAI-compatible endpoint."
series: ["AI Infra"]
tags: ["inference", "benchmarking", "latency", "vllm", "observability", "ai-infra"]
cover:
  image: "/images/posts/llm-inference-metrics/00-pixel-art-cover.png"
  alt: "Pixel art monitor showing a stopwatch, three streams of token blocks, and latency bars that climb past a dotted target line"
  relative: false
ShowToc: true
TocOpen: false
---

A benchmark says your model server does 2,000 tokens per second. A user says the chatbot feels slow. Both can be true at the same time.

They are looking at different clocks. Almost every confusing LLM performance conversation comes down to mixing these two up:

```text
Latency    = how long ONE user waits     (TTFT, TPOT, end-to-end)
Throughput = how much ALL users get done (tokens per second, requests per second)
```

{{< mermaid caption="Top: one user cares about their own wait. Bottom: the platform cares about total work per GPU. The same server produces both numbers." >}}
flowchart TD
    subgraph USER["One user's view"]
        direction LR
        U1["Send<br/>prompt"] a1@--> U2["Wait for<br/>first word"]
        U2 a2@--> U3["Read the<br/>stream"]
        U3 a3@--> U4["Answer done<br/>7.8 s"]
    end

    subgraph PLATFORM["The platform's view"]
        direction LR
        P1["32 users<br/>at once"] b1@--> P2["One GPU<br/>one batch"]
        P2 b2@--> P3["960 tokens<br/>per second"]
    end

    USER ~~~ PLATFORM
    a1@{ animate: true }
    a2@{ animate: true }
    a3@{ animate: true }
    b1@{ animate: true }
    b2@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class U1,P1 input;
    class U2,U3 warn;
    class U4,P2,P3 gpu;
{{< /mermaid >}}

This post explains each metric with one running example, then gives you a small script to measure them yourself. It works on vLLM, SGLang, Ollama, LM Studio, or anything else that speaks the OpenAI API.

If terms like prefill, decode, and KV cache are new, read [What Happens When You Ask an LLM a Question](/posts/llm-basics-visual-guide/) first.

## One request, four clocks

Here is the life of a single streaming request, split at the moment the first token arrives. Every latency metric is just a stopwatch between two of these points.

{{< mermaid caption="Top: everything before the first token adds up to TTFT. Bottom: the gaps between the tokens after it are what TPOT averages." >}}
flowchart TD
    subgraph WAIT["Before first token"]
        direction LR
        S["Request<br/>sent"] e1@--> Q["Queue<br/>wait for a slot"]
        Q e2@--> P["Prefill<br/>read the prompt"]
        P e3@--> F["First token<br/>arrives"]
    end

    subgraph STREAM["After first token"]
        direction LR
        D1["Token 2"] e4@--> D2["Token 3"]
        D2 e5@--> D3["...and<br/>so on"]
        D3 e6@--> L["Last token<br/>arrives"]
    end

    WAIT ~~~ STREAM
    e1@{ animate: true }
    e2@{ animate: true }
    e3@{ animate: true }
    e4@{ animate: true }
    e5@{ animate: true }
    e6@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef router fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class S input;
    class Q warn;
    class P router;
    class F,D1,D2,D3,L gpu;
{{< /mermaid >}}

| Metric | Starts at | Stops at | Plain meaning |
|---|---|---|---|
| **TTFT** | Request sent | First token | How long until something shows up |
| **TPOT** | First token | Last token, divided by tokens | How fast the text streams |
| **ITL** | One token | The next token | The gap between two tokens |
| **End-to-end** | Request sent | Last token | How long until the answer is complete |

### The running example

One request, with made-up but realistic numbers:

```text
Prompt:  2,000 tokens      Answer: 300 tokens
Queue:   50 ms             Prefill: 250 ms
Decode:  25 ms per token
```

| Step | What happens | Clock reads |
|---|---|---|
| 1 | Request waits in the queue | 50 ms |
| 2 | GPU reads the 2,000-token prompt (prefill) | 300 ms |
| 3 | First token is sent back | 300 ms: this is the **TTFT** |
| 4 | 299 more tokens arrive, 25 ms apart | 7,775 ms: this is the **end-to-end latency** |

Keep these numbers in mind. Every section below refers back to them.

## 1. TTFT: time to first token

**TTFT is the wait before anything appears.** It is the number that decides whether a chat feels responsive.

In the example, TTFT is 300 ms. It has three ingredients:

```text
TTFT = network time + queue time + prefill time
```

What makes it worse:

- **Long prompts.** Prefill has to read every input token. A 20,000-token prompt takes far longer than a 2,000-token one.
- **A busy server.** If every slot is taken, the request sits in the queue first.
- **Cold caches.** If the server has seen the start of this prompt before, it can skip most of the prefill. That is what prefix caching does.

This is why TTFT is the metric that [LMCache](/posts/why-lmcache-is-needed/) and cache-aware routers like [llm-d](/posts/llm-d-kubernetes-inference-routing/) target. They do not make tokens generate faster. They make the first one arrive sooner.

## 2. TPOT and ITL: how fast the text streams

**TPOT (time per output token)** is the average gap between tokens after the first one. It is calculated once per request:

```text
TPOT = (end-to-end latency - TTFT) / (output tokens - 1)
     = (7,775 ms - 300 ms) / 299
     = 25 ms
```

Flip it over and you get the speed one user sees: `1000 / 25 = 40 tokens per second`.

| TPOT | Tokens per second | How it feels |
|---|---|---|
| 200 ms | 5 | Slower than most people read |
| 100 ms | 10 | Comfortable reading pace |
| 50 ms | 20 | Faster than you can read |
| 25 ms | 40 | Feels instant for chat |
| 10 ms | 100 | Only matters for agents and long outputs |

For a human reading a chat reply, anything under about 50 ms is already faster than their eyes. For an **agent** that waits for the full answer before acting, every millisecond of TPOT still counts.

### ITL is the same idea, measured per gap

**ITL (inter-token latency)** measures each individual gap between two streamed chunks, instead of one average per request.

Most of the time ITL and TPOT are nearly identical. They split apart when:

- **A chunk carries several tokens.** With speculative decoding, one streamed chunk can contain a few tokens at once.
- **The stream stutters.** A request with 298 fast gaps and one 2-second pause has a healthy TPOT but an ugly P99 ITL.

Use TPOT to describe speed. Use ITL to catch stutter.

## 3. End-to-end latency: output length dominates

Put the pieces together:

```text
End-to-end = TTFT + TPOT x (output tokens - 1)
           = 300 ms + 25 ms x 299
           = 7,775 ms
```

Look at the split. TTFT is 300 ms. Decoding is 7,475 ms.

**About 96% of the wait is the answer being written.**

That leads to two practical rules:

- **To make a chat feel faster, cut TTFT.** Users forgive a long answer that starts immediately.
- **To make a batch job or an agent faster, cut output tokens or TPOT.** Asking for a shorter answer is often the cheapest optimization there is.

It also means end-to-end latency is a poor number to compare across workloads. A request that returns 50 tokens will always beat one that returns 500, on any server.

## 4. Throughput: the platform's number

**Throughput is how much work the whole server finishes per second**, summed across every user.

It usually comes in two flavors:

| Throughput | Unit | Answers |
|---|---|---|
| Request throughput | requests per second | How many users can I serve? |
| Token throughput | tokens per second | How much text does one GPU produce? |

Here is the trap. A modern engine uses [continuous batching](/posts/why-vllm-is-dominating-ai-inference-market/), so it generates tokens for many requests in the same step.

Say 32 users are streaming at once, and each sees 30 tokens per second:

```text
Per-user speed     = 30 tokens per second
System throughput  = 32 x 30 = 960 tokens per second
```

Both numbers describe the same GPU at the same moment. A headline of "960 tokens per second" does not mean any single user gets 960. Nobody does.

**When you read a benchmark, always ask: is this per request or summed over all requests?**

## 5. The trade-off: you cannot max out both

Batching more requests together raises throughput, but each request gets a smaller share of every step. So latency rises with load.

These numbers are invented to show the shape, not measured on real hardware:

| Concurrent requests | System tokens per second | Per-user TPOT | TTFT |
|---|---|---|---|
| 1 | 60 | 17 ms | 150 ms |
| 8 | 400 | 20 ms | 180 ms |
| 32 | 960 | 33 ms | 300 ms |
| 64 | 1,150 | 56 ms | 900 ms |
| 128 | 1,200 | 107 ms | 6,000 ms |

Read the last two rows carefully. Going from 64 to 128 users adds almost no throughput, while TTFT explodes. The GPU is full, so new requests wait in the queue.

{{< mermaid caption="As load rises, a server moves through four zones. The goal is to run in the second one, not the third." >}}
flowchart LR
    Z1["Idle<br/>fast but<br/>GPU wasted"] e1@--> Z2["Sweet spot<br/>busy GPU<br/>latency OK"]
    Z2 e2@--> Z3["Saturated<br/>throughput flat<br/>latency climbs"]
    Z3 e3@--> Z4["Overloaded<br/>queue grows<br/>TTFT explodes"]

    e1@{ animate: true }
    e2@{ animate: true }
    e3@{ animate: true }

    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:3px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef router fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    class Z1 idle;
    class Z2 gpu;
    class Z3 router;
    class Z4 warn;
{{< /mermaid >}}

So a single number never describes a server. A useful benchmark is a **curve**: latency plotted against load. The right operating point is the highest load where latency still fits your budget.

## 6. Percentiles: why the mean lies

Latency is never one number. It is a spread, and the slow end is where users complain.

Take 100 requests. 99 of them have a 200 ms TTFT. One hits a full queue and takes 5,000 ms.

| Statistic | Value | What it tells you |
|---|---|---|
| Mean | 248 ms | Looks fine, hides the problem |
| P50 (median) | 200 ms | The typical request |
| P99 | About 5,000 ms | The slowest 1 in 100 |

"P99 = 5 seconds" means 1 request in 100 is at least that slow. That sounds rare until you remember that people send many requests.

A user who sends 20 messages in a session has this chance of hitting the slow tail at least once:

```text
1 - 0.99^20 = 18%
```

Nearly one in five sessions feels the P99. For an agent that makes 50 model calls per task, it is 39%. **This is why serious latency targets are written as P95 or P99, never as an average.**

## 7. Goodput: throughput that actually counts

Throughput counts every finished request, even the ones that were painfully slow. **Goodput** counts only the requests that met your latency target.

First you set a target, called an **SLO** (service level objective). For example:

```text
SLO: TTFT under 500 ms  and  TPOT under 50 ms
```

Then you count only the requests that pass.

{{< mermaid caption="Ten requests per second finish, but only six meet the SLO. Throughput is 10. Goodput is 6." >}}
flowchart LR
    IN["Server finishes<br/>10 requests<br/>per second"] g1@--> C["SLO check<br/>TTFT under 500 ms<br/>TPOT under 50 ms"]
    C g2@--> OK["6 pass<br/>goodput is 6"]
    C g3@--> BAD["4 too slow<br/>users gave up"]

    g1@{ animate: true }
    g2@{ animate: true }
    g3@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef router fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:3px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class IN input;
    class C router;
    class OK gpu;
    class BAD warn;
{{< /mermaid >}}

Goodput is the honest way to compare two setups. Look back at the load table: at 128 concurrent requests throughput is the highest in the table, but with a 500 ms TTFT target the goodput is close to zero.

It also turns capacity planning into one question: **what is the highest request rate where goodput still equals throughput?** That rate is what one replica can really carry.

## Try it: measure TTFT and TPOT yourself

You do not need a benchmark suite to see these numbers. This script sends one streaming request and times it. It uses only the Python standard library.

```python
#!/usr/bin/env python3
"""llm_clock.py: time one streaming request to an OpenAI-compatible API."""
import json
import os
import sys
import time
import urllib.request

base, model = sys.argv[1].rstrip("/"), sys.argv[2]
prompt = sys.argv[3] if len(sys.argv) > 3 else "Explain a Kubernetes Pod in 150 words."

body = {
    "model": model,
    "messages": [{"role": "user", "content": prompt}],
    "stream": True,
    "stream_options": {"include_usage": True},
    "max_tokens": 256,
}
headers = {"Content-Type": "application/json"}
if os.environ.get("OPENAI_API_KEY"):
    headers["Authorization"] = "Bearer " + os.environ["OPENAI_API_KEY"]
req = urllib.request.Request(base + "/v1/chat/completions", json.dumps(body).encode(), headers)

start = time.perf_counter()
first = last = None
chunks, exact_tokens = 0, None

with urllib.request.urlopen(req) as resp:
    for raw in resp:
        line = raw.decode().strip()
        if not line.startswith("data:") or line.endswith("[DONE]"):
            continue
        event = json.loads(line[5:])
        if event.get("usage"):
            exact_tokens = event["usage"].get("completion_tokens")
        delta = (event.get("choices") or [{}])[0].get("delta", {})
        if delta.get("content") or delta.get("reasoning_content"):
            last = time.perf_counter()
            first = first or last
            chunks += 1

if first is None:
    sys.exit("No tokens were streamed back.")

tokens = exact_tokens or chunks
ttft = first - start
e2e = last - start
tpot = (e2e - ttft) / max(tokens - 1, 1)
print(f"Output tokens : {tokens} ({'reported by server' if exact_tokens else 'counted from chunks'})")
print(f"TTFT          : {ttft * 1000:8.1f} ms")
print(f"TPOT          : {tpot * 1000:8.1f} ms  ({1 / tpot:.1f} tokens per second)" if tpot else "TPOT          : n/a")
print(f"End-to-end    : {e2e * 1000:8.1f} ms")
```

Save it as `llm_clock.py` and point it at any server:

```bash
# vLLM or SGLang
python3 llm_clock.py http://localhost:8000 <model-name>
```

```bash
# Ollama
python3 llm_clock.py http://localhost:11434 <model-name>
```

```bash
# LM Studio
python3 llm_clock.py http://localhost:1234 <model-name>
```

Three experiments make the theory concrete:

1. **Run it twice with the same prompt.** If the second TTFT is lower, you just saw prefix caching.
2. **Paste a very long prompt as the third argument.** TTFT grows with it. TPOT barely moves.
3. **Run four copies at once.** Per-request TPOT gets worse while the total tokens per second goes up. That is the trade-off from section 5.

For experiment 3:

```bash
for i in 1 2 3 4; do python3 llm_clock.py http://localhost:8000 <model-name> & done; wait
```

No GPU nearby? The [laptop GPU simulation lab](/posts/simulate-gpu-vllm-llm-d-on-laptop/) runs a simulated vLLM whose latency you configure, so the script works there too.

## Benchmark properly with vllm bench

One request is a measurement. A benchmark needs many requests at a controlled rate. vLLM ships a load generator for this:

```bash
vllm bench serve \
  --backend vllm \
  --model <model-name> \
  --host 127.0.0.1 --port 8000 \
  --endpoint /v1/completions \
  --dataset-name random \
  --random-input-len 2000 \
  --random-output-len 300 \
  --num-prompts 200 \
  --request-rate 4
```

Flags change between releases, so check `vllm bench serve --help` for your version. The summary it prints maps directly onto this post:

```text
============ Serving Benchmark Result ============
Successful requests:                     10
Benchmark duration (s):                  5.78
Request throughput (req/s):              1.73
Output token throughput (tok/s):         382.89
---------------Time to First Token----------------
Mean TTFT (ms):                          71.54
Median TTFT (ms):                        73.88
P99 TTFT (ms):                           79.49
-----Time per Output Token (excl. 1st token)------
Mean TPOT (ms):                          7.91
P99 TPOT (ms):                           8.03
---------------Inter-token Latency----------------
Mean ITL (ms):                           7.74
P99 ITL (ms):                            8.39
==================================================
```

That sample is trimmed from the [vLLM benchmark docs](https://docs.vllm.ai/en/latest/benchmarking/cli/). You can now read every line of it.

To build the latency curve from section 5, run it several times with a rising `--request-rate` (for example 1, 2, 4, 8, 16) and write down P99 TTFT and output token throughput for each run. The rate where P99 TTFT bends upward is your saturation point.

The same tool reports goodput. Pass your SLO in milliseconds and the summary gains a line for the requests per second that met it:

```bash
vllm bench serve \
  --model <model-name> \
  --dataset-name random \
  --num-prompts 200 \
  --request-rate 4 \
  --goodput ttft:500 tpot:50
```

## Watch the same metrics in production

A benchmark tells you what a server can do. Production metrics tell you what it is doing. vLLM exposes these at `/metrics` in Prometheus format:

| What you want to know | vLLM metric |
|---|---|
| TTFT | `vllm:time_to_first_token_seconds` |
| Gap between tokens | `vllm:inter_token_latency_seconds` |
| End-to-end latency | `vllm:e2e_request_latency_seconds` |
| Time stuck in the queue | `vllm:request_queue_time_seconds` |
| Requests being served now | `vllm:num_requests_running` |
| Requests waiting for a slot | `vllm:num_requests_waiting` |
| How full the KV cache is | `vllm:kv_cache_usage_perc` |

Peek at them with one command:

```bash
curl -s http://localhost:8000/metrics | grep -E "time_to_first_token|num_requests_(running|waiting)"
```

The latency metrics are histograms, so percentiles come from a query. P99 TTFT over the last five minutes:

```text
histogram_quantile(0.99, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket[5m])))
```

If you only alert on one thing, make it `vllm:num_requests_waiting`. A queue that stays above zero is the earliest sign that you have entered the saturated zone.

For the full set of panels and alert rules, see [Monitoring vLLM in Production](/posts/monitoring-vllm-prometheus-dashboard-alerts/).

## Which knob moves which metric

| Symptom | Likely cause | What helps |
|---|---|---|
| High TTFT, empty queue | Long prompts being prefilled every time | Prefix caching, [LMCache](/posts/why-lmcache-is-needed/), stable prompt prefixes |
| High TTFT, growing queue | Not enough capacity | More replicas, autoscale on queue depth |
| High TTFT on some replicas only | Requests land where the cache is cold | Cache-aware routing with [llm-d](/posts/llm-d-kubernetes-inference-routing/) |
| High TPOT for everyone | Batch too large, or a noisy neighbor on a [shared GPU](/posts/kubernetes-gpu-sharing-time-slicing-mps-mig/) | Cap concurrency, isolate the GPU |
| Good TPOT, ugly P99 ITL | Stutter from long prefills in the same batch | Separate long-prompt traffic, or disaggregate prefill and decode |
| Slow strict-JSON answers | Token-by-token constrained decoding | An engine with jump-forward decoding, see [SGLang vs. vLLM](/posts/sglang-vs-vllm/) |

## Cheat sheet

```text
TTFT              = time to first token: network + queue + prefill
TPOT              = time per output token: (end-to-end - TTFT) / (output tokens - 1)
ITL               = inter-token latency: the gap between two streamed chunks
End-to-end        = TTFT + TPOT x (output tokens - 1); dominated by answer length
Tokens per second = 1000 / TPOT in ms for one user; summed over all users for a system
Throughput        = total requests or tokens finished per second, across everyone
P50 / P99         = the typical request / the slowest 1 in 100
SLO               = the latency target you promise, such as P99 TTFT under 500 ms
Goodput           = requests per second that met the SLO
Saturation point  = the load where throughput stops rising and latency takes off
Queue depth       = requests waiting for a slot; the earliest warning sign
Rule of thumb     = chat cares about TTFT, agents and batch care about TPOT and output length
```

To see what makes TTFT drop, read [Why LMCache Exists](/posts/why-lmcache-is-needed/) and the [llm-d routing guide](/posts/llm-d-kubernetes-inference-routing/). To see what continuous batching does to throughput, read [Why vLLM Is Dominating the AI Inference Market](/posts/why-vllm-is-dominating-ai-inference-market/).
