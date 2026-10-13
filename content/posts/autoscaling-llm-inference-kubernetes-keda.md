---
title: "Autoscaling LLM Inference on Kubernetes: Why CPU Fails and Queue Depth Works"
date: 2026-10-13T02:15:00+08:00
draft: true
author: "Vishnu"
description: "A simple, diagram-first guide to autoscaling vLLM on Kubernetes: why CPU and GPU utilization mislead the HPA, how to scale on queue depth with KEDA and Prometheus, and how to survive slow GPU cold starts."
series: ["AI Infra"]
tags: ["kubernetes", "autoscaling", "keda", "vllm", "inference", "ai-infra"]
cover:
  image: "/images/posts/llm-autoscaling/00-pixel-art-cover.png"
  alt: "Pixel art of a queued stream branching into four GPU server racks under a Kubernetes control unit"
  relative: false
ShowToc: true
TocOpen: false
---

The default Kubernetes autoscaler watches CPU. That works for a web app, because a busy web app burns CPU.

A model server is different. The GPU does the work, so CPU stays calm while users wait in a queue. The autoscaler sees nothing wrong and does nothing.

```text
Web app autoscaling = scale when CPU is busy
LLM autoscaling     = scale when requests are waiting
```

{{< mermaid caption="Top: a CPU-based autoscaler misses the traffic spike. Bottom: a queue-based autoscaler sees waiting requests and adds replicas." >}}
flowchart TD
    subgraph CPU["Scaling on CPU"]
        direction LR
        A1["Traffic<br/>spike"] a1@--> A2["CPU at 12%<br/>target is 70%"]
        A2 a2@--> A3["No scale up"]
        A3 a3@--> A4["Queue grows<br/>users wait"]
    end

    subgraph QUEUE["Scaling on queue depth"]
        direction LR
        B1["Traffic<br/>spike"] b1@--> B2["20 requests<br/>waiting"]
        B2 b2@--> B3["Scale from<br/>1 to 4 replicas"]
        B3 b3@--> B4["Queue drains"]
    end

    CPU ~~~ QUEUE
    a1@{ animate: true }
    a2@{ animate: true }
    a3@{ animate: true }
    b1@{ animate: true }
    b2@{ animate: true }
    b3@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef router fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class A1,B1 input;
    class A2,A3 idle;
    class A4 warn;
    class B2 router;
    class B3,B4 gpu;
{{< /mermaid >}}

This post covers three things: which signal to scale on, how to wire it up with KEDA, and how to deal with the fact that a new GPU replica takes minutes to become useful.

It builds on the numbers from my [inference metrics guide](/posts/llm-inference-metrics-ttft-tpot-throughput-goodput/). If TTFT and saturation point are unfamiliar, start there.

## How the HPA decides

The **Horizontal Pod Autoscaler (HPA)** runs one small formula over and over:

```text
desired replicas = ceil( current replicas x current metric / target metric )
```

A quick example with CPU:

```text
2 replicas, CPU at 90%, target 60%
desired = ceil(2 x 90 / 60) = 3 replicas
```

The formula is fine. The whole question is **which metric you feed it**. Feed it a number that does not move with load, and it will never scale.

## Why the usual signals fail

### CPU utilization

A vLLM Pod uses the CPU for tokenizing, scheduling, and streaming responses. The heavy math runs on the GPU.

So CPU usage tells you very little. A Pod serving 2 requests and a Pod drowning under 200 can report similar CPU numbers.

### GPU utilization

This one looks like the obvious fix, and it is the most common mistake.

GPU utilization means "the share of time the GPU was doing anything at all". With continuous batching, a GPU serving 4 requests and a GPU serving 40 can both read close to 100%.

| Concurrent requests | GPU utilization | Requests waiting | Is the Pod healthy? |
|---|---|---|---|
| 4 | 95% | 0 | Yes, plenty of room |
| 32 | 98% | 0 | Yes, at the sweet spot |
| 64 | 99% | 25 | No, users are queueing |

The middle column barely changes. The third column tells the whole story.

### What works instead

Good autoscaling signals for an LLM server share one property: **they rise when users start waiting.**

| Signal | vLLM metric | Why it works |
|---|---|---|
| Queue depth | `vllm:num_requests_waiting` | Zero when healthy, climbs the moment capacity runs out |
| Concurrency | `vllm:num_requests_running` plus waiting | Lets you set a target load per replica |
| KV cache pressure | `vllm:kv_cache_usage_perc` | Warns before long prompts start to be preempted |
| Tail latency | P95 of `vllm:time_to_first_token_seconds` | Matches what users feel, but reacts late |

**Queue depth is the best first choice.** It is simple, it is a leading indicator, and it means the same thing on every model and GPU.

## The pieces you need

The built-in HPA cannot read a vLLM metric by itself. It needs a chain of helpers:

{{< mermaid caption="vLLM publishes the queue depth, Prometheus stores it, KEDA reads it and drives an HPA, and the HPA resizes the Deployment." >}}
flowchart LR
    V["vLLM Pods<br/>/metrics"] p1@--> P["Prometheus<br/>stores it"]
    P p2@--> K["KEDA<br/>queries it"]
    K p3@--> H["HPA<br/>does math"]
    H p4@--> D["Deployment<br/>resizes"]

    p1@{ animate: true }
    p2@{ animate: true }
    p3@{ animate: true }
    p4@{ animate: true }

    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef router fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    class V,D gpu;
    class P input;
    class K,H router;
{{< /mermaid >}}

[KEDA](https://keda.sh/) (Kubernetes Event-Driven Autoscaling) is the glue. You describe a query and a threshold, and KEDA creates and manages the HPA for you.

## Set it up

These steps assume a Deployment named `vllm` in a namespace named `llm`, with a container port named `http`, plus a running Prometheus. Adjust the names to match your cluster.

### 1. Make sure Prometheus scrapes vLLM

If you run the Prometheus Operator, a `PodMonitor` does it:

```yaml
# vllm-podmonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: vllm
  namespace: llm
spec:
  selector:
    matchLabels:
      app: vllm
  podMetricsEndpoints:
    - port: http
      path: /metrics
      interval: 15s
```

```bash
kubectl apply -f vllm-podmonitor.yaml
```

Confirm the metric exists before going further:

```bash
kubectl -n llm port-forward deploy/vllm 8000:8000
```

```bash
curl -s http://localhost:8000/metrics | grep num_requests
```

### 2. Install KEDA

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update
```

```bash
helm install keda kedacore/keda --namespace keda --create-namespace
```

### 3. Create the ScaledObject

This is the whole autoscaling policy in one file:

```yaml
# vllm-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: vllm-queue
  namespace: llm
spec:
  scaleTargetRef:
    name: vllm
  minReplicaCount: 1
  maxReplicaCount: 4
  pollingInterval: 15
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc:9090
        query: sum(vllm:num_requests_waiting{namespace="llm"})
        threshold: "5"
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 0
        scaleDown:
          stabilizationWindowSeconds: 600
          policies:
            - type: Pods
              value: 1
              periodSeconds: 300
```

```bash
kubectl apply -f vllm-scaledobject.yaml
```

Change `serverAddress` to wherever your Prometheus lives. Then check that KEDA created the HPA:

```bash
kubectl -n llm get scaledobject,hpa
```

### How to read that file

The trigger says: **keep about 5 waiting requests per replica, at most.**

The query sums the queue across all Pods. KEDA divides that total by the threshold:

| Step | Total waiting | Math | Replicas |
|---|---|---|---|
| 1 | 0 | Nothing to do | 1 (the minimum) |
| 2 | 8 | ceil(8 / 5) | 2 |
| 3 | 20 | ceil(20 / 5) | 4 |
| 4 | 60 | ceil(60 / 5) = 12, capped | 4 (the maximum) |

Step 4 matters. Once you hit `maxReplicaCount`, the autoscaler is out of moves. That is the moment to shed load or return a "busy" response, not to let the queue grow forever.

I cover how in [Rate Limiting LLM APIs](/posts/llm-rate-limiting-load-shedding-tokens/).

### An alternative: target concurrency per replica

If you benchmarked your server and found its saturation point, you can scale on that directly.

Say one replica stays within its latency budget up to 32 concurrent requests. Then ask for one replica per 32 requests in the system:

```yaml
        query: sum(vllm:num_requests_running{namespace="llm"}) + sum(vllm:num_requests_waiting{namespace="llm"})
        threshold: "32"
```

This version scales **before** a queue forms, which is gentler on users. It only works if you measured that 32 yourself. A number copied from someone else's GPU is a guess.

## The hard part: GPU cold starts

A new web Pod is ready in seconds. A new LLM Pod is not.

{{< mermaid caption="What a new replica goes through before it can answer: the node joins, a multi-GB image is pulled, and the weights load into GPU memory. Adding a GPU node is usually the longest step." >}}
flowchart LR
    S1["Scale up<br/>decided"] c1@--> S2["GPU node<br/>boots"]
    S2 c2@--> S3["Image<br/>pull"]
    S3 c3@--> S4["Weights<br/>load"]
    S4 c4@--> S5["Ready"]

    c1@{ animate: true }
    c2@{ animate: true }
    c3@{ animate: true }
    c4@{ animate: true }

    classDef router fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:3px;
    class S1 router;
    class S2,S3,S4 warn;
    class S5 gpu;
{{< /mermaid >}}

Each amber step can take minutes. Added together, a scale-up that the autoscaler decides at 12:00 may only help users at 12:08.

That changes how you tune everything. You are not reacting to load. You are **predicting it a few minutes ahead**.

### Make cold starts shorter

| Slow step | Fix |
|---|---|
| Node boot | Keep one warm spare GPU node, or use low-priority placeholder Pods that hold a node until real work arrives |
| Image pull | Pre-pull the serving image on GPU nodes with a DaemonSet |
| Weight download | Store weights on a shared volume or node-local disk instead of downloading on every start |
| Weight load | Use a fast local disk for the model cache; network storage makes this step much slower |

### Tell Kubernetes the Pod is slow on purpose

Without a startup probe, Kubernetes may kill a Pod that is still loading its model. Give it room:

```yaml
        startupProbe:
          httpGet:
            path: /health
            port: http
          periodSeconds: 10
          failureThreshold: 90
        readinessProbe:
          httpGet:
            path: /health
            port: http
          periodSeconds: 5
```

That startup probe allows up to 15 minutes (90 checks, 10 seconds apart). The readiness probe keeps traffic away until the server can actually answer.

### Scale up fast, scale down slow

Look back at the `behavior` block in the ScaledObject. It encodes one rule:

```text
Scale up   = immediately, because a new replica is already minutes late
Scale down = slowly, because removing a replica you need again costs minutes
```

The example waits 10 minutes of low load before scaling down, and then removes only one Pod every 5 minutes. A replica that sits idle for ten minutes costs far less than a second cold start during the next spike.

## Should you scale to zero?

KEDA can set `minReplicaCount: 0`. Since Kubernetes v1.37 the built-in HPA can do it too, with `minReplicas: 0` on object or external metrics (see my [v1.37 notes](/posts/kubernetes-v1-37-stability/)). For an expensive GPU, that is tempting.

{{< mermaid caption="Top: scale to zero saves money while idle, but the first user pays the full cold start. Bottom: one warm replica answers immediately." >}}
flowchart TD
    subgraph ZERO["Minimum 0 replicas"]
        direction LR
        Z1["Idle<br/>GPU cost is zero"] z1@--> Z2["First request<br/>arrives"]
        Z2 z2@--> Z3["Cold start<br/>minutes of waiting"]
    end

    subgraph ONE["Minimum 1 replica"]
        direction LR
        O1["Idle<br/>one GPU paid for"] o1@--> O2["First request<br/>arrives"]
        O2 o2@--> O3["Answer starts<br/>right away"]
    end

    ZERO ~~~ ONE
    z1@{ animate: true }
    z2@{ animate: true }
    o1@{ animate: true }
    o2@{ animate: true }

    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class Z1,O1 idle;
    class Z2,O2 input;
    class Z3 warn;
    class O3 gpu;
{{< /mermaid >}}

There is also a chicken-and-egg problem. With zero Pods, nothing publishes `vllm:num_requests_waiting`, so a trigger based on it can never wake the Deployment up.

To scale from zero you need a signal from **in front of** the model server, such as request counts from your gateway or router. Something also has to hold the first request while the Pod starts.

| Workload | Sensible minimum |
|---|---|
| Interactive chat or agents | 1 or more. Users will not wait minutes |
| Internal tool used in office hours | 1 by day, 0 at night with a scheduled trigger |
| Batch jobs with no deadline | 0. Nobody is watching the clock |
| Many rarely used models | 0, behind a gateway that can queue the first request |

## Scale down without dropping answers

A streaming response can run for a minute or more. If Kubernetes removes a Pod mid-stream, that user gets half an answer.

Two settings help:

```yaml
    spec:
      terminationGracePeriodSeconds: 180
```

- **A generous grace period** gives in-flight requests time to finish after the Pod is told to stop.
- **A slow scale-down policy** (already in the ScaledObject) means it happens rarely.

Test this rather than trusting it. Start a long generation, delete the Pod, and watch whether the stream completes.

## Common mistakes

| Mistake | What happens | Do this instead |
|---|---|---|
| Scaling on GPU utilization | Always near 100%, so it scales to max and stays there | Scale on queue depth or concurrency |
| Same speed up and down | Replicas flap, and every flap is a cold start | Fast up, slow down |
| No startup probe | Pods are killed while still loading weights | Add a startup probe with a long budget |
| Ignoring `maxReplicaCount` | Queue grows without limit once the cap is hit | Alert at the cap and shed load |
| Autoscaling without smart routing | New replicas have cold KV caches, so TTFT gets worse first | Pair it with [cache-aware routing](/posts/llm-d-kubernetes-inference-routing/) |
| Assuming a GPU will be there | Pod stays `Pending` because no node has a free GPU | Check node capacity and [GPU sharing](/posts/kubernetes-gpu-sharing-time-slicing-mps-mig/) limits first |

## Cheat sheet

```text
HPA                 = Kubernetes autoscaler: replicas x current metric / target metric
Why CPU fails       = the GPU does the work, so CPU barely moves with load
Why GPU util fails  = batching keeps it near 100% whether 4 or 40 requests are running
Queue depth         = requests waiting for a slot; zero when healthy, the best first signal
KEDA                = reads an external metric and drives an HPA for you
ScaledObject        = the KEDA resource: target, min and max replicas, trigger, threshold
threshold           = the metric value one replica should handle
Cold start          = node boot + image pull + weight load, often several minutes
startupProbe        = tells Kubernetes a Pod is allowed to be slow while it loads
Stabilization window = how long the HPA waits before it trusts a lower number
Scale to zero       = cheapest when idle, but the first request pays the whole cold start
Rule of thumb       = scale up fast, scale down slow, and measure your own threshold
```

To find the threshold for your own model, use the load-curve method in the [inference metrics guide](/posts/llm-inference-metrics-ttft-tpot-throughput-goodput/). To practice scaling Pods across fake GPUs with no hardware, try the [laptop GPU simulation lab](/posts/simulate-gpu-vllm-llm-d-on-laptop/).
