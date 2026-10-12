---
title: "GPU Sharing on Kubernetes: Time-Slicing, MPS, and MIG, Explained Simply"
date: 2026-10-13T02:00:00+08:00
draft: true
author: "Vishnu"
description: "A simple, diagram-first guide to sharing one NVIDIA GPU between many Pods: what time-slicing, MPS, and MIG actually isolate, the ConfigMaps that turn them on, and which one fits LLM inference."
series: ["AI Infra"]
tags: ["kubernetes", "gpu", "nvidia", "gpu-sharing", "mig", "ai-infra"]
cover:
  image: "/images/posts/kubernetes-gpu-sharing/00-pixel-art-cover.png"
  alt: "Pixel art of one GPU card whose chip is split into cyan, violet, and amber slices, each wired to a small workload cube floating above it"
  relative: false
ShowToc: true
TocOpen: false
---

Kubernetes counts GPUs the way it counts chairs: whole ones only. A Pod asks for `nvidia.com/gpu: 1` and gets an entire card, even if it only needs a corner of it.

That is fine for a training job that fills an H100. It is wasteful for an embedding model that uses 4 GB of an 80 GB card.

GPU sharing fixes that, and NVIDIA gives you three ways to do it. They sound similar, but they share very different things:

```text
Time-slicing = Pods take turns on the GPU. Nothing is isolated.
MPS          = Pods run side by side. Memory and compute are capped in software.
MIG          = The GPU is cut into smaller GPUs. Isolation is done in hardware.
```

{{< mermaid caption="Top: three small workloads each hold a whole H100 and leave most of it idle. Bottom: the same three workloads share one card." >}}
flowchart TD
    subgraph WHOLE["Whole GPUs"]
        direction LR
        P1["Embeddings<br/>needs 4 GB"] a1@--> G1["H100 A<br/>76 GB idle"]
        P2["Reranker<br/>needs 6 GB"] a2@--> G2["H100 B<br/>74 GB idle"]
        P3["Notebook<br/>needs 10 GB"] a3@--> G3["H100 C<br/>70 GB idle"]
    end

    subgraph SHARED["One shared GPU"]
        direction LR
        Q1["Embeddings<br/>4 GB"] b1@--> S1["H100 A<br/>20 GB used<br/>60 GB free"]
        Q2["Reranker<br/>6 GB"] b2@--> S1
        Q3["Notebook<br/>10 GB"] b3@--> S1
    end

    WHOLE ~~~ SHARED
    a1@{ animate: true }
    a2@{ animate: true }
    a3@{ animate: true }
    b1@{ animate: true }
    b2@{ animate: true }
    b3@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef waste fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class P1,P2,P3,Q1,Q2,Q3 input;
    class G1,G2,G3 waste;
    class S1 gpu;
{{< /mermaid >}}

This post walks through all three with one running example: **one H100 (80 GB) and three small workloads** that would each waste a full card.

If the GPU software stack itself is new to you (driver, device plugin, GPU Operator), start with my [Kubernetes GPU platform guide](/posts/kubernetes-gpu-platform-engineering/) and come back.

## Why Kubernetes cannot share a GPU by default

The NVIDIA device plugin tells the kubelet how many GPUs a node has. Kubernetes stores that as an **extended resource**, and extended resources have two strict rules:

- They are whole numbers. You cannot request `nvidia.com/gpu: 0.25`.
- They cannot be overcommitted. One GPU is handed to exactly one container.

So the scheduler is not being stubborn. It simply has no idea that a GPU has memory, compute, or anything else inside it. It sees a count.

Every sharing method below is a different answer to the same question: **how do we make one physical GPU show up as more than one thing to count?**

## The three ways at a glance

| | Time-slicing | MPS | MIG |
|---|---|---|---|
| How it shares | Takes turns | Runs side by side | Splits the hardware |
| Memory isolation | None | Software limit per client | Hardware, per instance |
| Fault isolation | None | Weak | Strong |
| Predictable speed | No | Mostly | Yes |
| Max shares per GPU | Any number you choose | Any number you choose | Up to 7 |
| Works on any NVIDIA GPU | Yes | Yes | No, only MIG-capable cards |

Keep this table in mind. The rest of the post is just explaining each row.

## 1. Time-slicing: take turns

Time-slicing is the simplest option. You tell the device plugin to **advertise each GPU several times**.

With `replicas: 4`, a node with one H100 reports `nvidia.com/gpu: 4`. Four Pods can each request one "GPU" and all land on the same card.

Here is the important part: **nothing changes on the GPU itself.** The card was always able to switch between processes. Time-slicing only changes the number Kubernetes is allowed to count.

{{< mermaid caption="Top: the device plugin turns one physical GPU into four countable replicas. Bottom: on the card, the Pods simply take turns." >}}
flowchart TD
    subgraph COUNT["What Kubernetes sees"]
        direction LR
        H["1 physical<br/>H100"] c1@--> DP["Device plugin<br/>replicas 4"]
        DP c2@--> R["Node reports<br/>4 GPUs"]
    end

    subgraph TURNS["What the GPU does"]
        direction LR
        T1["Turn 1<br/>Pod A runs"] t1@--> T2["Turn 2<br/>Pod B runs"]
        T2 t2@--> T3["Turn 3<br/>Pod C runs"]
        T3 t3@--> T4["Turn 4<br/>Pod A again"]
    end

    COUNT ~~~ TURNS
    c1@{ animate: true }
    c2@{ animate: true }
    t1@{ animate: true }
    t2@{ animate: true }
    t3@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef router fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    class H input;
    class DP router;
    class R gpu;
    class T1,T4 gpu;
    class T2,T3 idle;
{{< /mermaid >}}

### A four-step walkthrough

Three Pods share one time-sliced H100. Watch what happens to memory:

| Step | What happens | GPU memory in use |
|---|---|---|
| 1 | Embeddings Pod loads its model | 4 GB |
| 2 | Reranker Pod loads its model | 10 GB |
| 3 | Notebook user loads a 68 GB model by mistake | 78 GB |
| 4 | Embeddings Pod needs 3 GB more for a big batch | Out of memory |

Step 4 is the catch. The embeddings Pod did nothing wrong, yet it is the one that crashes.

That is what **no memory isolation** means. Every Pod sees all 80 GB, and whoever allocates first wins.

### What time-slicing does not give you

- **No memory limit.** Any Pod can fill the card.
- **No fault isolation.** NVIDIA's docs say plainly that there is no memory or fault isolation between replicas.
- **No guaranteed share.** Asking for 2 replicas does not buy twice the compute. It only takes two slots away from other Pods.
- **Weaker per-Pod metrics.** DCGM Exporter cannot tie GPU metrics to a container when time-slicing is on.

### Turn it on

With the [GPU Operator](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html), time-slicing is one ConfigMap plus one patch.

```yaml
# time-slicing-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: time-slicing-config
  namespace: gpu-operator
data:
  any: |-
    version: v1
    flags:
      migStrategy: none
    sharing:
      timeSlicing:
        renameByDefault: false
        failRequestsGreaterThanOne: true
        resources:
          - name: nvidia.com/gpu
            replicas: 4
```

```bash
kubectl apply -f time-slicing-config.yaml
```

```bash
kubectl patch clusterpolicies.nvidia.com/cluster-policy \
  -n gpu-operator --type merge \
  -p '{"spec": {"devicePlugin": {"config": {"name": "time-slicing-config", "default": "any"}}}}'
```

Two flags are worth understanding:

- `failRequestsGreaterThanOne: true` rejects any Pod that asks for more than one replica. That stops people from believing `nvidia.com/gpu: 2` means "twice the GPU".
- `renameByDefault: true` advertises the resource as `nvidia.com/gpu.shared` instead. Use it when you want Pods to say out loud that they accept a shared card.

Then check that the node now reports four GPUs:

```bash
kubectl get node <node-name> \
  -o jsonpath='{.status.allocatable.nvidia\.com/gpu}{"\n"}'
```

The node also gains a `nvidia.com/gpu.replicas=4` label, and the product label gets a `-SHARED` suffix. That suffix is handy for node selectors.

To see sharing in action, run four Pods that each ask for one GPU:

```yaml
# shared-gpu-test.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shared-gpu-test
spec:
  replicas: 4
  selector:
    matchLabels:
      app: shared-gpu-test
  template:
    metadata:
      labels:
        app: shared-gpu-test
    spec:
      containers:
        - name: cuda
          image: nvcr.io/nvidia/cuda:12.4.1-base-ubuntu22.04
          command: ["bash", "-c", "nvidia-smi -L; sleep infinity"]
          resources:
            limits:
              nvidia.com/gpu: 1
```

```bash
kubectl apply -f shared-gpu-test.yaml
kubectl logs -l app=shared-gpu-test --prefix | sort
```

All four Pods should print the **same GPU UUID**. That is the proof that they share one physical card.

One gotcha: the Operator does not watch the ConfigMap for edits. After changing `replicas`, restart the device plugin:

```bash
kubectl rollout restart -n gpu-operator daemonset/nvidia-device-plugin-daemonset
```

## 2. MPS: run side by side

**MPS (Multi-Process Service)** is NVIDIA's answer to the two biggest time-slicing problems: wasted turns and missing memory limits.

With time-slicing, only one Pod's work runs at any instant. If Pod A uses 20% of the GPU during its turn, the other 80% sits idle until the turn ends.

MPS puts a small server in front of the GPU. Every Pod sends its work to that server, and the server feeds it all to the GPU **at the same time**. Small workloads overlap instead of queueing.

{{< mermaid caption="With MPS, Pods hand their work to one shared server. The GPU runs all of it together, and each Pod has a memory cap." >}}
flowchart LR
    A["Embeddings Pod<br/>cap 20 GB"] m1@--> S["MPS server<br/>one shared<br/>GPU context"]
    B["Reranker Pod<br/>cap 20 GB"] m2@--> S
    C["Notebook Pod<br/>cap 20 GB"] m3@--> S
    S m4@--> G["H100<br/>runs all three<br/>at once"]

    m1@{ animate: true }
    m2@{ animate: true }
    m3@{ animate: true }
    m4@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef router fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class A,B,C input;
    class S router;
    class G gpu;
{{< /mermaid >}}

### What changes compared to time-slicing

The device plugin divides the card evenly. With `replicas: 4` on an 80 GB H100, each Pod is limited to **an equal fraction: 20 GB of memory and a quarter of the compute**.

Replay the walkthrough from earlier. At step 3, the notebook user tries to load a 68 GB model. This time **their own Pod fails** at 20 GB, and the embeddings Pod never notices.

That is a real improvement. The mistake now hurts the person who made it.

### What MPS still does not give you

- **Weak fault isolation.** All Pods share one MPS server. A fatal GPU error from one client can take the others down with it.
- **Equal shares only.** You cannot give one Pod 40 GB and another 10 GB. Every replica is the same size.
- **No MIG combination.** The device plugin does not support MPS on a GPU that has MIG enabled.
- **Experimental status.** The device plugin README still describes MPS support as experimental (as of v0.15.0), so test it on your own versions before trusting it in production.

### Turn it on

The config has the same shape as time-slicing. Only the key changes:

```yaml
# mps-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mps-config
  namespace: gpu-operator
data:
  any: |-
    version: v1
    sharing:
      mps:
        renameByDefault: false
        resources:
          - name: nvidia.com/gpu
            replicas: 4
```

```bash
kubectl apply -f mps-config.yaml
```

```bash
kubectl patch clusterpolicies.nvidia.com/cluster-policy \
  -n gpu-operator --type merge \
  -p '{"spec": {"devicePlugin": {"config": {"name": "mps-config", "default": "any"}}}}'
```

Time-slicing and MPS are mutually exclusive on a node: the plugin applies one sharing method to every GPU on it. To confirm which one a node uses, read its label:

```bash
kubectl get node <node-name> \
  -o jsonpath='{.metadata.labels.nvidia\.com/gpu\.sharing-strategy}{"\n"}'
```

It prints `mps`, `time-slicing`, or `none`.

## 3. MIG: cut the GPU into smaller GPUs

**MIG (Multi-Instance GPU)** is the only option that changes the hardware layout.

A MIG-capable card can be split into **up to 7 instances**. Each instance gets its own slice of memory and its own slice of compute. To the software inside a Pod, an instance looks like a small, separate GPU.

{{< mermaid caption="One 80 GB H100 cut into four MIG instances. Each instance has its own memory and compute, so the Pods cannot touch each other." >}}
flowchart LR
    G["H100<br/>80 GB"] s1@--> I1["3g.40gb<br/>40 GB slice"]
    G s2@--> I2["2g.20gb<br/>20 GB slice"]
    G s3@--> I3["1g.10gb<br/>10 GB slice"]
    G s4@--> I4["1g.10gb<br/>10 GB slice"]
    I1 p1@--> W1["Small LLM<br/>with vLLM"]
    I2 p2@--> W2["Notebook"]
    I3 p3@--> W3["Embeddings"]
    I4 p4@--> W4["Reranker"]

    s1@{ animate: true }
    s2@{ animate: true }
    s3@{ animate: true }
    s4@{ animate: true }
    p1@{ animate: true }
    p2@{ animate: true }
    p3@{ animate: true }
    p4@{ animate: true }

    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef slice fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    class G gpu;
    class I1,I2,I3,I4 slice;
    class W1,W2,W3,W4 input;
{{< /mermaid >}}

### Reading a MIG profile name

Profile names look cryptic, but they follow one pattern:

```text
3g.40gb  =  3 compute slices (out of 7)  +  40 GB of memory
```

On an 80 GB H100, the common profiles are:

| Profile | Compute slices | Memory | How many fit on one card |
|---|---|---|---|
| `1g.10gb` | 1 of 7 | 10 GB | 7 |
| `2g.20gb` | 2 of 7 | 20 GB | 3 |
| `3g.40gb` | 3 of 7 | 40 GB | 2 |
| `7g.80gb` | 7 of 7 | 80 GB | 1 |

You can also mix sizes on one card, as in the diagram above. That exact mix (two `1g.10gb`, one `2g.20gb`, one `3g.40gb`) is what the GPU Operator calls `all-balanced`.

### What MIG costs you

- **Only some cards support it.** MIG needs data-center GPUs from the Ampere generation onward, such as the A100, A30, H100, and H200. Cards like the T4, L4, and L40S do not have it. Check `nvidia-smi` or your card's documentation before planning around it.
- **Fixed sizes.** You pick from a menu of profiles. You cannot create a 13 GB instance.
- **At most 7 instances.** Time-slicing and MPS let you choose any replica count.
- **Changing the layout is disruptive.** The MIG Manager needs the GPU to be free of user workloads before it reshapes it, and some environments need a node reboot.

### Turn it on

Install (or upgrade) the GPU Operator with a MIG strategy:

```bash
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update
```

```bash
helm upgrade --install gpu-operator nvidia/gpu-operator \
  -n gpu-operator --create-namespace \
  --set mig.strategy=single
```

The strategy decides how instances are named:

| Strategy | Use when | Pods request |
|---|---|---|
| `single` | Every GPU on the node has the same profile | `nvidia.com/gpu: 1` |
| `mixed` | GPUs on the node have different profiles | `nvidia.com/mig-1g.10gb: 1` |

Then label the node with the layout you want. Drain or cordon it first, because GPU Pods on that node will be stopped:

```bash
kubectl cordon <node-name>
kubectl label nodes <node-name> nvidia.com/mig.config=all-1g.10gb --overwrite
```

Wait for the MIG Manager to finish. The state label goes from `pending` to `success`:

```bash
kubectl get node <node-name> \
  -o jsonpath='{.metadata.labels.nvidia\.com/mig\.config\.state}{"\n"}'
```

```bash
kubectl uncordon <node-name>
```

With `all-1g.10gb` and the `single` strategy, one H100 now reports `nvidia.com/gpu: 7`. Each of those seven is a hardware-isolated 10 GB instance.

## What this means for LLM inference

Sharing rules that work for notebooks can surprise you with an inference server. Three things matter most.

### vLLM grabs memory up front

By default, [vLLM](/posts/why-vllm-is-dominating-ai-inference-market/) reserves about 90% of the GPU memory it can see (`--gpu-memory-utilization 0.9`) and uses the spare room for KV cache.

Now combine that with each sharing mode:

| Mode | What vLLM sees | Result with default settings |
|---|---|---|
| Time-slicing | All 80 GB | First Pod takes 72 GB, second Pod fails to start |
| MPS, 4 replicas | A 20 GB cap | Each Pod must fit inside its 20 GB share |
| MIG `3g.40gb` | A 40 GB GPU | Works: 90% of 40 GB, no neighbors to fight |

On a time-sliced GPU you must lower the fraction yourself, for example two Pods at `--gpu-memory-utilization 0.45` each. Nothing enforces it, so one wrong flag still breaks the neighbor.

### Latency follows isolation

Time-slicing adds waiting: your request's tokens are generated only during your Pod's turns. With four busy Pods, [time to first token](/posts/llm-inference-metrics-ttft-tpot-throughput-goodput/) and tokens per second both get worse, and they get worse unevenly.

MIG gives each instance its own compute, so latency stays steady no matter what the neighbors do. That is why MIG is the usual choice when a shared model has a latency target.

### Smaller GPU means smaller KV cache

Whatever memory is left after loading weights becomes KV cache. A 10 GB slice holding an 8 GB model has very little room for long prompts or many concurrent users.

If a model serves real traffic, size the slice for **weights plus cache**, not for weights alone. The [GPU memory sizing guide](/posts/llm-gpu-memory-sizing-weights-kv-cache/) has the formulas and a calculator for this. Routers such as [llm-d](/posts/llm-d-kubernetes-inference-routing/) and caches such as [LMCache](/posts/why-lmcache-is-needed/) help more when each replica has cache to spare.

## Which one should you pick?

{{< mermaid caption="A short decision path. Start with who shares the GPU (other teams and latency-sensitive production on one side, one trusted team on the other), then check what your hardware supports." >}}
flowchart TD
    Q1["Who shares<br/>the GPU?"] e1@-->|"Other teams or<br/>strict latency"| Q2["Does the card<br/>support MIG?"]
    Q1 e2@-->|"One team<br/>dev or batch"| Q3["Do Pods need<br/>memory caps?"]
    Q2 e3@-->|"Yes"| M["Pick MIG<br/>hardware isolation"]
    Q2 e4@-->|"No"| W["Give whole GPUs<br/>or accept MPS limits"]
    Q3 e5@-->|"Yes"| P["Pick MPS<br/>equal capped shares"]
    Q3 e6@-->|"No"| T["Pick time-slicing<br/>simplest setup"]

    e1@{ animate: true }
    e2@{ animate: true }
    e3@{ animate: true }
    e4@{ animate: true }
    e5@{ animate: true }
    e6@{ animate: true }

    classDef question fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef pick fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:3px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class Q1,Q2,Q3 question;
    class M,P,T pick;
    class W warn;
{{< /mermaid >}}

### Pick time-slicing when:

- **Everyone sharing the GPU is on one team** and a crash is an annoyance, not an incident.
- **Workloads are bursty and mostly idle**, like notebooks, CI jobs, and demos.
- **Your GPUs do not support MIG** and you want the least moving parts.

### Pick MPS when:

- **Many small processes each use a fraction of the GPU** and you want them to overlap instead of queue.
- **You need a memory cap per Pod** but your cards cannot do MIG.
- **Equal shares are acceptable** and you have tested MPS on your driver and plugin versions.

### Pick MIG when:

- **Different teams or tenants share a card** and one must never affect another.
- **A workload has a latency or throughput target** that noisy neighbors would break.
- **Your sizes are stable.** If the layout needs to change every hour, the drain-and-reconfigure cycle will hurt.

You can also layer them. Time-slicing works on top of MIG instances, so a `3g.40gb` slice can itself be shared by a few trusted dev Pods while the other slices stay strictly isolated.

## Where this is heading: DRA

All three methods above are workarounds for the "GPUs are whole numbers" rule.

**Dynamic Resource Allocation (DRA)** removes the rule. Instead of a count, a Pod makes a claim that describes the device it needs, and a driver decides how to satisfy it. DRA is now a stable API in recent Kubernetes releases, and NVIDIA maintains a DRA driver for GPUs.

The ideas in this post do not go away under DRA. Time-slicing, MPS, and MIG are still the mechanisms on the card. DRA changes how you ask for them, not what they isolate.

## Cheat sheet

```text
Extended resource     = a whole-number device count; cannot be split or overcommitted
Time-slicing          = advertise one GPU as N replicas; Pods take turns, nothing is isolated
replicas              = how many Pods may share one GPU (or one MIG instance)
renameByDefault       = expose shared GPUs as nvidia.com/gpu.shared instead of nvidia.com/gpu
MPS                   = one shared server runs Pods side by side with equal memory and compute caps
MIG                   = split a supported GPU into up to 7 hardware-isolated instances
MIG profile 3g.40gb   = 3 of 7 compute slices plus 40 GB of memory
mig.strategy single   = all GPUs on the node share one profile; Pods still ask for nvidia.com/gpu
mig.strategy mixed    = profiles differ per GPU; Pods ask for nvidia.com/mig-<profile>
Fault isolation       = one Pod's GPU crash cannot take down its neighbors (MIG only)
DRA                   = the newer Kubernetes API that describes devices instead of counting them
Rule of thumb         = trust decides: same team can time-slice, strangers need MIG
```

No GPU to try this on? The [laptop GPU simulation lab](/posts/simulate-gpu-vllm-llm-d-on-laptop/) fakes 16 H100s on kind, which is enough to practice requests, limits, and scheduling. For the layers underneath sharing (driver, device plugin, NUMA, RDMA), see the [Kubernetes GPU platform guide](/posts/kubernetes-gpu-platform-engineering/).
