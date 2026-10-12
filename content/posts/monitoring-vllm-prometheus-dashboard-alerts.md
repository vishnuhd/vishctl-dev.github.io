---
title: "Monitoring vLLM in Production: Six Panels and Four Alerts"
date: 2026-10-13T02:35:00+08:00
draft: true
author: "Vishnu"
description: "A simple, diagram-first guide to monitoring a vLLM deployment with Prometheus: why GPU dashboards mislead, the six panels worth building, four alerts that catch real problems, and a triage table for reading them together."
series: ["AI Infra"]
tags: ["observability", "prometheus", "vllm", "inference", "kubernetes", "ai-infra"]
cover:
  image: "/images/posts/vllm-monitoring/00-pixel-art-cover.png"
  alt: "Pixel art monitor showing six small dashboard panels with lines, bars, and a gauge, one of them highlighted in amber with a warning triangle"
  relative: false
ShowToc: true
TocOpen: false
---

Most teams start monitoring LLM serving with a GPU dashboard: utilization, memory, temperature. It looks reassuring. It also misses almost every problem users actually feel.

A GPU that is 98% busy might be serving everyone happily, or it might have 40 requests stuck in a queue. The hardware graphs look the same in both cases.

```text
GPU dashboard   = is the hardware busy?
Model dashboard = are users waiting?
```

{{< mermaid caption="Top: the hardware view of an overloaded server looks healthy. Bottom: the model server's own metrics show the queue and the slow first tokens." >}}
flowchart TD
    subgraph HW["GPU dashboard"]
        direction LR
        H1["Utilization<br/>98%"] h1@--> H2["Memory<br/>72 of 80 GB"]
        H2 h2@--> H3["Looks fine"]
    end

    subgraph MODEL["Model dashboard"]
        direction LR
        M1["25 requests<br/>waiting"] m1@--> M2["P95 TTFT<br/>6 seconds"]
        M2 m2@--> M3["Users are<br/>waiting"]
    end

    HW ~~~ MODEL
    h1@{ animate: true }
    h2@{ animate: true }
    m1@{ animate: true }
    m2@{ animate: true }

    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class H1,H2 idle;
    class H3 gpu;
    class M1,M2 tree;
    class M3 warn;
{{< /mermaid >}}

This post is the production follow-up to my [inference metrics guide](/posts/llm-inference-metrics-ttft-tpot-throughput-goodput/). That one explains what TTFT and TPOT mean. This one shows which graphs to build, which alerts to set, and how to read them together at 2 a.m.

## Where each metric comes from

vLLM publishes its own metrics at `/metrics` in Prometheus format. Several of them time one specific stage of a request:

{{< mermaid caption="One request passes through three stages. vLLM times each one separately (request_queue_time_seconds, request_prefill_time_seconds, request_decode_time_seconds) plus the whole trip (e2e_request_latency_seconds)." >}}
flowchart LR
    A["Request<br/>arrives"] s1@--> Q["Queue<br/>queue_time"]
    Q s2@--> P["Prefill<br/>prefill_time"]
    P s3@--> D["Decode<br/>decode_time"]
    D s4@--> E["Done<br/>e2e_latency"]

    s1@{ animate: true }
    s2@{ animate: true }
    s3@{ animate: true }
    s4@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class A input;
    class Q warn;
    class P tree;
    class D,E gpu;
{{< /mermaid >}}

Every name below carries the `vllm:` prefix. There are three kinds:

| Kind | What it is | Examples |
|---|---|---|
| Gauge | A value right now | `num_requests_running`, `num_requests_waiting`, `kv_cache_usage_perc` |
| Counter | A total that only goes up | `prompt_tokens`, `generation_tokens`, `prefix_cache_hits` |
| Histogram | A spread of timings | `time_to_first_token_seconds`, `inter_token_latency_seconds` |

Two details save a lot of confusion later:

- **Counters get a `_total` suffix in Prometheus.** The counter `vllm:generation_tokens` is queried as `vllm:generation_tokens_total`.
- **Histograms get a `_bucket` suffix.** Percentiles are calculated from `vllm:time_to_first_token_seconds_bucket`.

Metric names change between vLLM releases. Before copying any query, check what your version exposes:

```bash
curl -s http://localhost:8000/metrics | grep '^# HELP vllm' | cut -d' ' -f3
```

## The six panels

A useful dashboard answers four questions: how much traffic, how slow, how full, and how well the cache works. Six panels cover them.

| Panel | Question it answers | Healthy looks like |
|---|---|---|
| 1. Traffic | How much work is arriving? | Follows your usual daily shape |
| 2. Queue | Is anyone waiting for a slot? | Flat at zero |
| 3. TTFT | How long until the first token? | P95 inside your target |
| 4. Token speed | How smooth is the stream? | Steady, no spikes |
| 5. KV cache | How full is GPU memory? | Below about 90% |
| 6. Prefix cache | Is repeated context being reused? | Stable hit rate |

### 1. Traffic

Output tokens per second is the best single measure of how hard the server is working:

```text
sum(rate(vllm:generation_tokens_total[5m]))
```

Add input tokens as a second line. A jump in input with flat output usually means someone started sending much longer prompts.

```text
sum(rate(vllm:prompt_tokens_total[5m]))
```

### 2. Queue

This is the most important panel on the page. Plot running and waiting together:

```text
sum(vllm:num_requests_running)
```

```text
sum(vllm:num_requests_waiting)
```

Running goes up and down with traffic. Waiting should sit at zero. **Any sustained value above zero means you are out of capacity.**

### 3. Time to first token

Show P50, P95, and P99 as three lines:

```text
histogram_quantile(0.95, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket[5m])))
```

Change `0.95` to `0.50` and `0.99` for the other two. When P50 is calm but P99 climbs, a few requests are queueing or carrying very long prompts.

### 4. Token speed

Inter-token latency shows how smoothly answers stream:

```text
histogram_quantile(0.95, sum by (le) (rate(vllm:inter_token_latency_seconds_bucket[5m])))
```

This line rises gently as the batch gets bigger. A sudden step up usually means a noisy neighbor on a [shared GPU](/posts/kubernetes-gpu-sharing-time-slicing-mps-mig/) or a batch that grew too large.

### 5. KV cache usage

```text
max by (pod) (vllm:kv_cache_usage_perc)
```

The value runs from 0 to 1. Near 1.0, the server has no memory left for new context, so requests wait or get preempted. The [GPU memory sizing guide](/posts/llm-gpu-memory-sizing-weights-kv-cache/) explains what fills it.

### 6. Prefix cache hit rate

```text
sum(rate(vllm:prefix_cache_hits_total[5m]))
  /
sum(rate(vllm:prefix_cache_queries_total[5m]))
```

This is the share of prompt tokens that were served from cache instead of being recomputed. A high number means cheap, fast prefills. A sudden drop usually means a prompt template changed, or requests started landing on replicas that have not seen their prefix.

### Bonus: one GPU row

The hardware view still matters for hardware problems. If you run NVIDIA's DCGM exporter, three graphs are enough:

| Graph | Metric | Catches |
|---|---|---|
| GPU memory used | `DCGM_FI_DEV_FB_USED` | A neighbor eating shared memory |
| Temperature | `DCGM_FI_DEV_GPU_TEMP` | Cooling problems and throttling |
| Utilization | `DCGM_FI_DEV_GPU_UTIL` | A GPU that is idle when it should not be |

Use utilization to spot an idle GPU. Do not use it to judge load.

## Reading the panels together

One panel rarely tells the story. The combination does. Here is one incident, step by step:

| Time | What the panels show | What it means |
|---|---|---|
| 14:00 | Traffic normal, queue 0, P95 TTFT 300 ms | Healthy |
| 14:05 | Input tokens triple, output tokens flat | Someone is sending much longer prompts |
| 14:08 | KV cache at 0.97, queue climbs to 12 | Memory is full, new requests cannot start |
| 14:10 | P95 TTFT 7 s, token speed unchanged | Users wait to start, but streams are still smooth |

The fix here is not "add GPUs because TTFT is high". It is "find the client sending huge prompts", or cap prompt length. The panels tell you that because TTFT, the queue, and the KV cache moved together while token speed stayed flat.

### A triage table

| Queue | TTFT | Token speed | KV cache | Most likely cause |
|---|---|---|---|---|
| Growing | High | Normal | Normal | Not enough replicas for the request rate |
| Growing | High | Normal | Near full | Long prompts filling memory |
| Zero | High | Normal | Normal | Long prompts with no cache hits |
| Zero | Normal | Slow | Normal | Batch too large, or a noisy neighbor |
| Zero | Normal | Normal | Normal | Healthy. Look at the client or network |

{{< mermaid caption="A short path for the most common complaint: the first token is slow. Check the queue first, then the cache. The fixes: cap prompt length or add memory, scale out, check prompt templates and routing, or look at who is sending more input tokens." >}}
flowchart TD
    Q1["TTFT is high"] t1@--> Q2["Is the queue<br/>above zero?"]
    Q2 t2@-->|"Yes"| Q3["Is the KV cache<br/>near full?"]
    Q2 t3@-->|"No"| Q4["Did the prefix<br/>hit rate drop?"]
    Q3 t4@-->|"Yes"| A1["Long prompts<br/>cap length"]
    Q3 t5@-->|"No"| A2["Too few<br/>replicas"]
    Q4 t6@-->|"Yes"| A3["Cache misses<br/>check routing"]
    Q4 t7@-->|"No"| A4["Longer<br/>prompts"]

    t1@{ animate: true }
    t2@{ animate: true }
    t3@{ animate: true }
    t4@{ animate: true }
    t5@{ animate: true }
    t6@{ animate: true }
    t7@{ animate: true }

    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef question fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class Q1 warn;
    class Q2,Q3,Q4 question;
    class A1,A2,A3,A4 gpu;
{{< /mermaid >}}

## The four alerts

Dashboards are for looking. Alerts are for when nobody is looking. Keep the list short, and make every alert mean "a user is affected or about to be".

| Alert | Fires when | Why this one |
|---|---|---|
| Queue backlog | Requests have been waiting for 2 minutes | The earliest sign of overload |
| Slow first token | P95 TTFT is over target for 10 minutes | What users actually feel |
| KV cache nearly full | Usage above 0.95 for 10 minutes | Predicts the next queue backlog |
| Server down | A vLLM Pod stops answering scrapes | Covers crashes and stuck Pods |

With the Prometheus Operator, they fit in one `PrometheusRule`. Adjust the namespace, the thresholds, and the `job` label to match your setup:

```yaml
# vllm-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vllm-alerts
  namespace: llm
spec:
  groups:
    - name: vllm
      rules:
        - alert: VLLMQueueBacklog
          expr: sum by (namespace) (vllm:num_requests_waiting) > 5
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "vLLM has had requests waiting for 2 minutes"
            description: "Capacity is exhausted. Check autoscaling and the KV cache panel."

        - alert: VLLMSlowFirstToken
          expr: |
            histogram_quantile(0.95,
              sum by (le, namespace) (rate(vllm:time_to_first_token_seconds_bucket[5m]))
            ) > 2
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "P95 time to first token is above 2 seconds"

        - alert: VLLMKVCacheNearlyFull
          expr: max by (namespace, pod) (vllm:kv_cache_usage_perc) > 0.95
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "KV cache on {{ $labels.pod }} is above 95 percent"

        - alert: VLLMDown
          expr: up{job="llm/vllm"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "A vLLM Pod has stopped answering metric scrapes"
```

```bash
kubectl apply -f vllm-alerts.yaml
```

Then confirm Prometheus loaded the rules:

```bash
kubectl -n llm get prometheusrule vllm-alerts
```

Three choices in that file are deliberate:

- **Every alert has a `for` duration.** A two-second blip should not page anyone.
- **Thresholds come from your own target.** The 2 seconds for TTFT is an example. Use the number you promised your users.
- **There is no alert on GPU utilization.** It is near 100% whenever the server is doing its job.

The `job` label depends on how your scrape is configured. Find the real value with this query, then update the last rule:

```text
count by (job) (vllm:num_requests_running)
```

## Mistakes worth avoiding

| Mistake | What goes wrong | Do this instead |
|---|---|---|
| Alerting on averages | One slow request in a hundred never shows up | Alert on P95 or P99 |
| Alerting on GPU utilization | It fires all day, so everyone mutes it | Alert on the queue |
| One dashboard per Pod only | You miss the fleet-wide picture | Sum across Pods, then break down by Pod |
| Short rate windows | Graphs are too spiky to read | Use 5 minute windows for latency |
| No alert for missing data | A dead server looks like a quiet one | Keep the "server down" alert |
| Watching only latency | You see the symptom, not the cause | Keep queue and KV cache next to it |

## Try it without a GPU

You can practice all of this on a laptop. The [GPU simulation lab](/posts/simulate-gpu-vllm-llm-d-on-laptop/) runs a simulated vLLM that publishes vLLM-style metrics, so the queue and latency queries have something to read. It exposes a subset of the real metric list, so run the `grep` command from earlier to see which panels will have data.

Once the panels work, connect them to action: the queue metric from panel 2 is the same signal that drives scaling in my [autoscaling guide](/posts/autoscaling-llm-inference-kubernetes-keda/).

## Cheat sheet

```text
Model metrics      = what vLLM reports about requests; the view that shows user pain
GPU metrics        = what the hardware reports; good for hardware faults, poor for load
Gauge              = a value right now, such as requests waiting
Counter            = a growing total; query it with rate() and a _total suffix
Histogram          = a spread of timings; percentiles come from the _bucket series
Queue panel        = requests waiting; should be flat at zero
TTFT panel         = P50, P95, P99 time to first token
KV cache usage     = 0 to 1; near 1 means no memory left for new context
Prefix hit rate    = cached prompt tokens / all prompt tokens
PrometheusRule     = the Prometheus Operator resource that holds alert rules
for: 2m            = the condition must hold this long before the alert fires
Rule of thumb      = alert on the queue and on P95 TTFT, never on GPU utilization
```

To understand the numbers on these panels, start with the [inference metrics guide](/posts/llm-inference-metrics-ttft-tpot-throughput-goodput/). To act on them automatically, continue to [autoscaling LLM inference on Kubernetes](/posts/autoscaling-llm-inference-kubernetes-keda/).
