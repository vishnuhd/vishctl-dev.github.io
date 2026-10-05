---
title: "llm-d, Simply: A Smarter Router for vLLM on Kubernetes"
date: 2026-10-06T00:00:00+08:00
draft: false
author: "Vishnu"
description: "A practical, diagram-first guide to llm-d: why round-robin wastes GPUs, how cache-aware routing works, which well-lit path to start with, and the commands to deploy it."
series: ["AI Infra"]
tags: ["llm-d", "vllm", "kubernetes", "inference", "ai-infra", "kv-cache"]
cover:
  image: "/images/posts/llm-d/00-pixel-art-cover.png"
  alt: "Pixel art router tower sending glowing requests to GPU racks, with the brightest path going to the rack that already holds matching cache cubes"
  relative: false
ShowToc: true
TocOpen: false
---

You run eight vLLM pods behind a Kubernetes Service. Every request carries the same 6,000-token runbook as its system prompt.

The Service spreads requests round-robin. So each pod processes that runbook again and again, and one pod sits on a deep queue while another is idle.

**The GPUs are fine. The routing is blind.**

[llm-d](https://llm-d.ai/) fixes that. It is a Kubernetes-native layer that sits **above** vLLM (or SGLang, or TensorRT-LLM) and decides **which pod** gets each request.

```text
vLLM   → runs the model fast on one pod
llm-d  → picks the right pod, and splits work across many
```

> Written against llm-d **v0.10.0** (released 29 September 2026). llm-d is a [CNCF Sandbox project](https://www.cncf.io/blog/2026/03/24/welcome-llm-d-to-the-cncf-evolving-kubernetes-into-sota-ai-infrastructure/) founded by Red Hat, Google Cloud, IBM Research, CoreWeave, and NVIDIA.

## The problem in one picture

A Kubernetes Service sees TCP connections. It doesn't know about prompts, KV caches, or queue depth.

{{< mermaid caption="Left: round-robin sends a repeated prefix to every pod, so each one rebuilds its KV cache. Right: llm-d sends it where the cache already lives." >}}
flowchart LR
    subgraph RR["Kubernetes Service"]
        direction TB
        Q1["Runbook + question"] a1@--> P1["pod-1<br/>rebuild KV"]
        Q1 a2@--> P2["pod-2<br/>rebuild KV"]
        Q1 a3@--> P3["pod-3<br/>rebuild KV"]
    end
    subgraph LD["llm-d router"]
        direction TB
        Q2["Runbook + question"] b1@--> R{"Who has<br/>this prefix?"}
        R b2@--> P4["pod-1<br/>cache hit"]
        R -.-> P5["pod-2"]
        R -.-> P6["pod-3"]
    end
    RR ~~~ LD
    a1@{ animate: true }
    a2@{ animate: true }
    a3@{ animate: true }
    b1@{ animate: true }
    b2@{ animate: true }
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff;
    classDef waste fill:#302410,stroke:#fbbf24,color:#fff3cf;
    classDef hit fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:3px;
    classDef router fill:#281d48,stroke:#a78bfa,color:#f1edff;
    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    class Q1,Q2 input;
    class P1,P2,P3 waste;
    class P4 hit;
    class R router;
    class P5,P6 idle;
{{< /mermaid >}}

Rebuilding the KV cache is **prefill**: the slow, compute-heavy step before the first token. Skip it and time to first token (TTFT) drops. If prefill and the KV cache are new to you, start with my [visual LLM guide](/posts/llm-basics-visual-guide/#5-context-is-the-input-kv-cache-saves-work) and the [LMCache post](/posts/why-lmcache-is-needed/).

## The pieces

| Piece | Job | Think of it as |
|---|---|---|
| **Proxy** (Envoy, or a Gateway such as Istio or agentgateway) | Receives the OpenAI-style request | The front door |
| **Router / EPP** (Endpoint Picker) | Scores pods and picks one | The brain |
| **InferencePool** | Groups the model server pods (a [Gateway API Inference Extension](https://gateway-api-inference-extension.sigs.k8s.io/) resource) | The Service, but model-aware |
| **Model servers** | vLLM, SGLang, or TensorRT-LLM pods | The muscle |
| **Sidecar** (P/D only) | Coordinates prefill and decode pods | The relay runner |
| **Autoscaler** | Scales on inference signals, not CPU | The thermostat |

The request path is short:

{{< mermaid caption="The proxy asks the router which pod to use, then forwards the request there. Pods report queue depth and KV usage back to the router." >}}
flowchart LR
    C["Client<br/>/v1/completions"] e1@--> P["Proxy<br/>Envoy"]
    P e2@-->|"which pod?"| E["Router<br/>EPP"]
    E e3@-->|"pod-3"| V["vLLM pod-3<br/>InferencePool"]
    e1@{ animate: true }
    e2@{ animate: true }
    e3@{ animate: true }
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff;
    classDef router fill:#281d48,stroke:#a78bfa,color:#f1edff;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff;
    class C,P input;
    class E router;
    class V gpu;
{{< /mermaid >}}

The client still talks to one OpenAI-compatible endpoint. Nothing changes in your app.

## How the router picks a pod

The default setup, called the **optimized baseline**, runs two steps for every request.

{{< mermaid caption="Filter for cache affinity, then score by load. A hot pod loses its cache advantage so load still spreads." >}}
flowchart TD
    R["Request"] e1@--> F{"1. Filter<br/>Which pods likely<br/>hold this prefix?"}
    F e2@-->|"sticky pods"| H{"Any of them<br/>saturated?"}
    H e3@-->|"no"| S["2. Score<br/>lowest token load"]
    H -.->|"yes"| X["Widen to<br/>all pods"]
    X -.-> S
    S e4@--> W["Winner pod"]
    e1@{ animate: true }
    e2@{ animate: true }
    e3@{ animate: true }
    e4@{ animate: true }
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff;
    classDef router fill:#281d48,stroke:#a78bfa,color:#f1edff;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff;
    class R input;
    class F,S router;
    class H,X warn;
    class W gpu;
{{< /mermaid >}}

- **Prefix-cache affinity filter**: keeps only the pods that likely hold the start of this prompt.
- **Saturation override**: if those pods get hot, it stops being sticky and spreads the load.
- **Token load scorer**: picks the pod with the least prefill work queued.

That is the whole default config. This is the router config the guide ships:

```yaml
apiVersion: llm-d.ai/v1alpha1
kind: EndpointPickerConfig
plugins:
- type: approx-prefix-cache-producer    # tracks which pod saw which prefix
- type: inflight-load-producer          # tracks in-flight work per pod
- type: prefix-cache-affinity-filter    # step 1: keep cache-warm pods
- type: token-load-scorer               # step 2: prefer the least loaded
schedulingProfiles:
- name: default
  plugins:
  - pluginRef: prefix-cache-affinity-filter
  - pluginRef: token-load-scorer
```

**Producers** gather signals. **Filters** remove pods. **Scorers** rank what's left. Every routing feature in llm-d is built from those three kinds of plugin.

## Example: four requests, eight pods

Same runbook assistant. Here is what the router does (illustrative):

| # | Request | Router sees | Goes to | Why |
|---|---|---|---|---|
| 1 | Runbook + "How do I drain a node?" | No pod has this prefix | pod-2 | Least loaded |
| 2 | Runbook + "Pre-upgrade checks?" | pod-2 has the runbook | **pod-2** | Cache hit: skips ~6,000 tokens of prefill |
| 3 | Runbook + "Roll back a deploy?" | pod-2 has it, but is saturated | pod-5 | Override spreads load; pod-5 builds a second warm copy |
| 4 | Different app, different prompt | No match | pod-7 | Least loaded |

{{< mermaid caption="Requests 1 and 2 share a warm cache on pod-2. Request 3 spills to pod-5 once pod-2 is busy." >}}
sequenceDiagram
    participant U as Users
    participant R as Router
    participant P2 as pod-2
    participant P5 as pod-5
    U->>R: 1. runbook + drain?
    R->>P2: no match, least loaded
    Note over P2: prefill full runbook
    U->>R: 2. runbook + upgrade?
    R->>P2: prefix match
    Note over P2: cache hit, fast first token
    U->>R: 3. runbook + rollback?
    Note over R: pod-2 saturated
    R->>P5: spread load
    Note over P5: builds a second warm copy
{{< /mermaid >}}

Without llm-d, request 2 has about a one-in-eight chance of landing on pod-2.

## Pick a well-lit path

llm-d ships **well-lit paths**: tested recipes with Helm charts, Kustomize overlays, and benchmarks. Start with the optimized baseline, then add a path when you hit its symptom.

{{< mermaid caption="Start in the middle. Follow an arrow only when you see the symptom on it." >}}
flowchart LR
    OB["Optimized baseline<br/>prefix + load aware"]
    OB a1@-->|"approximate tracking<br/>misses cache hits"| PP["Precise prefix-cache<br/>routing"]
    OB a2@-->|"KV cache doesn't<br/>fit in GPU memory"| TP["Tiered prefix cache<br/>CPU / disk"]
    OB a3@-->|"long inputs slow<br/>down token streaming"| PD["P/D<br/>disaggregation"]
    OB a4@-->|"huge MoE model<br/>like DeepSeek-R1"| EP["Wide expert<br/>parallelism"]
    OB a5@-->|"traffic spikes,<br/>idle GPUs at night"| AS["Workload<br/>autoscaling"]
    OB a6@-->|"tenants starve<br/>each other"| FC["Flow control"]
    a1@{ animate: true }
    a2@{ animate: true }
    a3@{ animate: true }
    a4@{ animate: true }
    a5@{ animate: true }
    a6@{ animate: true }
    classDef base fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:3px;
    classDef cache fill:#281d48,stroke:#a78bfa,color:#f1edff;
    classDef scale fill:#302410,stroke:#fbbf24,color:#fff3cf;
    classDef ops fill:#13264a,stroke:#38bdf8,color:#e6f6ff;
    class OB base;
    class PP,TP cache;
    class PD,EP scale;
    class AS,FC ops;
{{< /mermaid >}}

| Path | One-line idea |
|---|---|
| [Optimized baseline](https://llm-d.ai/docs/well-lit-paths/foundations/optimized-baseline) | Route by prefix and load. Start here. |
| Precise prefix-cache routing | Track real KV cache state from the pods instead of guessing from routing history |
| [Tiered prefix cache](https://llm-d.ai/docs/well-lit-paths/foundations/tiered-prefix-cache) | Spill KV cache to CPU or disk; keep more conversations warm |
| P/D disaggregation | Separate pods for reading the prompt and writing the answer |
| [Wide expert parallelism](https://llm-d.ai/docs/well-lit-paths/foundations/wide-expert-parallelism) | Spread MoE experts across many GPUs over fast interconnects |
| Workload autoscaling | Scale on queue and SLO signals, including down to zero |
| Flow control | Hold excess requests at the router, with fairness between tenants |

The full list is on the [well-lit paths page](https://llm-d.ai/docs/well-lit-paths).

## P/D disaggregation in one flow

An LLM request has two jobs with opposite needs:

- **Prefill** reads the whole prompt at once. Compute-bound.
- **Decode** writes one token at a time. Memory-bandwidth-bound.

On the same GPU, a big prefill stalls everyone else's token stream. P/D puts them on different pods.

{{< mermaid caption="The router picks both pods. Prefill builds the KV cache, NIXL moves it to decode, and decode streams the answer." >}}
flowchart TD
    C["Request<br/>10k-token prompt"] e1@--> R["Router<br/>picks P + D"]
    R e2@--> S["Decode pod<br/>sidecar"]
    S e3@-->|"1. prompt"| P["Prefill pod<br/>build KV cache"]
    P e4@-->|"2. KV blocks via NIXL<br/>RDMA or TCP"| D["Decode pod<br/>vLLM"]
    D e5@-->|"3. stream tokens"| O["Client"]
    e1@{ animate: true }
    e2@{ animate: true }
    e3@{ animate: true }
    e4@{ animate: true }
    e5@{ animate: true }
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff;
    classDef router fill:#281d48,stroke:#a78bfa,color:#f1edff;
    classDef prefill fill:#302410,stroke:#fbbf24,color:#fff3cf;
    classDef decode fill:#173f59,stroke:#22d3ee,color:#ecfeff;
    class C,O input;
    class R router;
    class P prefill;
    class S,D decode;
{{< /mermaid >}}

The reference guide runs `gpt-oss-120b` as **8 prefill pods (TP=1)** and **2 decode pods (TP=4)**: many small pods for the compute-bound job, a few wide ones for the memory-bound job.

**Use it when:** the model is medium to large, inputs are long (think 10k in, 1k out), or it's a sparse MoE.
**Skip it when:** prompts and answers are short (200 in, 200 out). The KV transfer costs more than it saves.

The KV transfer runs over the network, so RDMA matters here. My [GPU platform post](/posts/kubernetes-gpu-platform-engineering/) covers that layer.

## Hands-on: deploy the optimized baseline

The reference setup is `Qwen/Qwen3-32B` on **8 replicas × 2 H100s = 16 GPUs**. Fewer GPUs? Lower `replicas` and `--tensor-parallel-size` in the guide's `modelserver/gpu/vllm/base/patch-vllm.yaml`.

You need `kubectl`, `helm`, a GPU cluster, and a Hugging Face token.

**1. Clone and set variables**

```bash
git clone https://github.com/llm-d/llm-d.git && cd llm-d
export REPO_ROOT=$(pwd)
export GUIDE_NAME=optimized-baseline
export NAMESPACE=llm-d-optimized-baseline
export ACCELERATOR_TYPE=gpu MODEL_SERVER=vllm INFRA_PROVIDER=base
export MODEL=Qwen/Qwen3-32B
source guides/env.sh   # sets chart versions and the router chart reference
```

**2. Install CRDs, namespace, and token secret**

```bash
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api-inference-extension/${GAIE_URL}/v1-manifests.yaml
kubectl create namespace ${NAMESPACE}
kubectl create secret generic llm-d-hf-token \
  --from-literal="HF_TOKEN=${HF_TOKEN}" -n ${NAMESPACE}
```

**3. Deploy the router (standalone mode, Envoy sidecar)**

```bash
helm install ${GUIDE_NAME} ${ROUTER_STANDALONE_CHART} \
  -f guides/recipes/router/base.values.yaml \
  -f guides/${GUIDE_NAME}/router/${GUIDE_NAME}.values.yaml \
  -n ${NAMESPACE} --version ${ROUTER_CHART_VERSION}
```

**4. Deploy the vLLM pods**

```bash
kubectl apply -n ${NAMESPACE} \
  -k guides/${GUIDE_NAME}/modelserver/${ACCELERATOR_TYPE}/${MODEL_SERVER}/${INFRA_PROVIDER}/
```

**5. Send a request**

```bash
export IP=$(kubectl get service ${GUIDE_NAME}-epp -n ${NAMESPACE} \
  -o jsonpath='{.spec.clusterIP}')

kubectl run curl-test --rm -i --restart=Never -n ${NAMESPACE} \
  --image=curlimages/curl --env="IP=${IP}" --env="MODEL=${MODEL}" -- \
  sh -c 'curl -sS http://${IP}/v1/completions -H "Content-Type: application/json" \
    -d "{\"model\": \"${MODEL}\", \"prompt\": \"How are you today?\"}"'
```

A JSON completion back means the full path works: proxy → router → vLLM pod.

These steps are trimmed from the [optimized baseline guide](https://github.com/llm-d/llm-d/tree/main/guides/optimized-baseline), which also covers AMD, Intel XPU, TPU, CPU, SGLang, TensorRT-LLM, and Gateway mode. Clean up with `helm uninstall` and `kubectl delete namespace`.

> **No GPUs yet?** [llm-d-inference-sim](https://github.com/llm-d/llm-d-inference-sim) is a lightweight vLLM simulator for mocking replicas. Use it to learn the routing layer on a laptop cluster.

## What to watch

Routing has two goals that pull against each other: **cache hits** and **even load**. Watch both.

| Signal | Metric | Healthy looks like |
|---|---|---|
| Cache hit rate | `vllm:prefix_cache_hits_total` ÷ `vllm:prefix_cache_queries_total` | High, and stable as you add replicas |
| Load balance | `vllm:num_requests_running` per pod | Roughly even; no hot pod next to idle ones |
| Pressure | `vllm:kv_cache_usage_perc`, `vllm:num_requests_waiting` | No single pod pinned near full |
| User experience | `vllm:time_to_first_token_seconds` | Drops compared with round-robin |

On hardware other than the guide's H100 reference, uneven load usually means the saturation override isn't kicking in. The guide's calibration recipe measures `peakPrefillThroughput` for your model and GPU.

## Do the numbers hold up?

These are **project-reported** results. Your workload will differ.

- **3x output throughput, 2x faster TTFT**: prefix-aware routing vs round-robin, Llama 3.1 70B on 4× AMD MI300X ([source](https://llm-d.ai/blog/production-grade-llm-inference-at-scale-kserve-llm-d-vllm))
- **Up to 70% higher tokens/sec**: P/D vs standard vLLM, GPT-OSS on NVIDIA B200, AWS ([source](https://aws.amazon.com/blogs/machine-learning/introducing-disaggregated-inference-on-aws-powered-by-llm-d/))
- **40% lower TTFT and ITL**: predicted-latency scheduling vs heuristics, Google ([source](https://llm-d.ai/blog/predicted-latency-based-scheduling-for-llms))

The gains come from **reuse and balance**. No shared prefixes and steady load means less to win. Each guide ships a benchmark profile, so measure against your own traffic. Reproducible runs are on [Prism](https://prism.llm-d.ai).

## When you don't need llm-d

- One vLLM replica. There is nothing to route between.
- Short, unique prompts with no shared prefix.
- Low, steady traffic where round-robin never creates a hot pod.

A plain Service is fine there. llm-d starts paying off at **several replicas + shared prefixes + bursty traffic**.

## Cheat sheet

```text
vLLM / SGLang     = run the model on one pod
llm-d router      = pick the best pod per request (EPP)
InferencePool     = model-aware group of pods
producer          = gathers signals (prefix seen, load)
filter            = removes pods (not cache-warm)
scorer            = ranks pods (least token load)
well-lit path     = tested recipe + benchmark
prefill / decode  = read prompt / write answer
P/D               = split them across pods, KV moves via NIXL
start here        = optimized baseline
```

vLLM made one GPU fast. llm-d makes a fleet of them act like it knows what it's doing.
