---
title: "Why Is My GPU Pod Pending? A Seven-Step Checklist"
date: 2026-10-13T02:50:00+08:00
draft: true
author: "Vishnu"
description: "A simple, diagram-first checklist for a GPU Pod stuck in Pending on Kubernetes: how to read the scheduler's message, the seven rules a node must pass, and the kubectl command that checks each one."
series: ["AI Infra"]
tags: ["kubernetes", "gpu", "scheduling", "troubleshooting", "nvidia", "ai-infra"]
cover:
  image: "/images/posts/gpu-pod-pending/00-pixel-art-cover.png"
  alt: "Pixel art of a terminal, Kubernetes emblem, and diagnostic lens checking four server sockets for an amber workload"
  relative: false
ShowToc: true
TocOpen: false
---

You apply a Deployment that asks for a GPU. The Pod appears, and then nothing happens. `STATUS: Pending`, minute after minute.

The cluster has GPUs. Some of them even look free. So why will the Pod not start?

```text
Pending  = the scheduler has not found one node that passes every rule
Your job = find the one rule that no node can pass
```

{{< mermaid caption="The scheduler is a funnel. Every rule removes nodes. If the last rule leaves zero, the Pod stays Pending, even though earlier stages looked fine." >}}
flowchart LR
    N["8 nodes<br/>in the cluster"] f1@--> G["3 have a<br/>free GPU"]
    G f2@--> T["2 accept<br/>this Pod's<br/>tolerations"]
    T f3@--> S["1 matches<br/>the node<br/>selector"]
    S f4@--> C["0 have enough<br/>CPU left"]
    C f5@--> P["Pending"]

    f1@{ animate: true }
    f2@{ animate: true }
    f3@{ animate: true }
    f4@{ animate: true }
    f5@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class N input;
    class G gpu;
    class T,S tree;
    class C,P warn;
{{< /mermaid >}}

A GPU Pod has more rules to pass than an ordinary Pod, which is why it gets stuck more often. This post is a checklist to work through in order, with the command for each step.

## Step 0: read what the scheduler said

Before guessing, ask. The scheduler writes its reason into the Pod's events.

```bash
kubectl describe pod <pod-name> | sed -n '/Events:/,$p'
```

You will see a line like this:

```text
0/8 nodes are available: 5 Insufficient nvidia.com/gpu, 2 node(s) had untolerated taint {nvidia.com/gpu: present}, 1 Insufficient cpu.
```

Read it as a tally. The numbers add up to the node count, and each phrase is one rule that removed some nodes. Here: five nodes had no free GPU, two refused the Pod because of a taint, and one had a GPU but not enough CPU.

| Phrase in the event | What it means | Go to |
|---|---|---|
| `Insufficient nvidia.com/gpu` | Not enough free GPUs on that node | Steps 1 and 2 |
| `had untolerated taint` | The node repels Pods without a matching toleration | Step 3 |
| `didn't match Pod's node affinity/selector` | Your selector excludes that node | Step 4 |
| `Insufficient cpu` or `Insufficient memory` | The GPU is free but CPU or RAM is not | Step 5 |
| `unbound immediate PersistentVolumeClaims` or `volume node affinity conflict` | Storage is the blocker | Step 7 |

No Pod at all? If the Deployment exists but no Pod was created, the problem is not scheduling. Jump to step 6.

## Step 1: does Kubernetes see any GPUs?

A GPU that the host can see is not automatically one that Kubernetes can count.

```bash
kubectl get nodes -o custom-columns='NODE:.metadata.name,GPUS:.status.allocatable.nvidia\.com/gpu'
```

| Output | Meaning |
|---|---|
| A number on your GPU nodes | Good. Go to step 2 |
| `<none>` on a node that has GPUs | The device plugin is not advertising them |

If it says `<none>`, scheduling is not your problem yet. The GPU software stack is. My [GPU platform guide](/posts/kubernetes-gpu-platform-engineering/) walks through that layer by layer, and the [WSL2 post](/posts/vllm-on-wsl2-minikube/) shows a real case of exactly this failure.

## Step 2: are the GPUs free, and free together?

Allocatable is the total. You need to know what is left.

```bash
kubectl describe nodes | grep -E '^Name:|nvidia.com/gpu[: ]'
```

For each node this prints the capacity, the allocatable count, and how many are already requested. Subtract to get the free GPUs. The `[: ]` at the end skips the many `nvidia.com/gpu.*` labels that would otherwise flood the output.

Then check the rule that surprises people most: **a Pod cannot span nodes.** A Pod asking for 4 GPUs needs all 4 on one machine.

{{< mermaid caption="Top: six GPUs are free in total, but no single node has four, so a 4-GPU Pod stays Pending. Bottom: the same six free GPUs, packed differently, and the Pod fits." >}}
flowchart TD
    subgraph SPREAD["Free GPUs spread out"]
        direction LR
        A1["Node A<br/>2 free"] ~~~ A2["Node B<br/>2 free"]
        A2 ~~~ A3["Node C<br/>2 free"]
        A3 a1@--> A4["4-GPU Pod<br/>Pending"]
    end

    subgraph PACKED["Free GPUs packed"]
        direction LR
        B1["Node A<br/>4 free"] ~~~ B2["Node B<br/>2 free"]
        B2 ~~~ B3["Node C<br/>0 free"]
        B3 b1@--> B4["4-GPU Pod<br/>runs on A"]
    end

    SPREAD ~~~ PACKED
    a1@{ animate: true }
    b1@{ animate: true }

    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class A1,A2,A3,B2,B3 idle;
    class B1,B4 gpu;
    class A4 warn;
{{< /mermaid >}}

This is **fragmentation**. The fix is to move or stop a small Pod so that one node has enough room, or to request fewer GPUs per Pod.

One more thing to check here: the resource name. If the node uses [MIG or time-slicing](/posts/kubernetes-gpu-sharing-time-slicing-mps-mig/), GPUs may be advertised as `nvidia.com/mig-1g.10gb` or `nvidia.com/gpu.shared`. A Pod asking for plain `nvidia.com/gpu` on such a node will report `Insufficient`, even with free slices.

## Step 3: taints and tolerations

GPU nodes are usually tainted so that ordinary Pods stay off the expensive hardware. A taint means "keep out unless you have a pass".

See the taints:

```bash
kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINTS:.spec.taints[*].key'
```

If a GPU node shows a taint such as `nvidia.com/gpu`, your Pod needs a matching toleration:

```yaml
    spec:
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
```

A toleration only means "allowed". It does not pull the Pod toward that node. That is the job of the next step.

## Step 4: node selectors and affinity

Selectors do the opposite of taints: they restrict where your Pod is willing to go. A typo here is a very common cause of Pending.

Look at what the Pod demands:

```bash
kubectl get pod <pod-name> -o jsonpath='{.spec.nodeSelector}{"\n"}{.spec.affinity}{"\n"}'
```

Then look at what the nodes actually offer. This shows the GPU model label on every node:

```bash
kubectl get nodes -L nvidia.com/gpu.product
```

Compare them character by character. `NVIDIA-H100-80GB-HBM3` and `H100` are not the same string, and a selector on a label that no node has matches nothing.

## Step 5: CPU and memory

This one hides well, because the event still mentions GPUs for the other nodes.

A GPU Pod also asks for CPU and RAM. GPU nodes run several system DaemonSets (driver, device plugin, monitoring), and those take a share before your Pod arrives.

```bash
kubectl describe node <node-name> | sed -n '/Allocated resources:/,/Events:/p'
```

Check the `cpu` and `memory` lines against your Pod's requests. If the node has a free GPU but only 2 CPUs left and you ask for 8, the Pod cannot land there.

A simple guard: keep per-GPU requests proportional to the node. On a node with 8 GPUs and 64 CPUs, a Pod that takes 1 GPU and 16 CPUs leaves the last four GPUs unusable.

## Step 6: quotas

A ResourceQuota can cap GPUs per namespace. When you exceed it, the Pod is **never created**, so there is nothing Pending to describe. The error is on the ReplicaSet instead.

```bash
kubectl -n <namespace> describe resourcequota
```

Look for `requests.nvidia.com/gpu` and compare used against hard. Then confirm on the workload:

```bash
kubectl -n <namespace> get events --field-selector reason=FailedCreate
```

A message containing `exceeded quota` settles it. Either free up GPUs in that namespace or ask for a bigger quota.

## Step 7: storage

If the Pod mounts a volume, the volume gets a vote too.

```bash
kubectl -n <namespace> get pvc
```

| What you see | Meaning |
|---|---|
| PVC is `Pending` | No volume has been provisioned. Check the storage class |
| Event says `volume node affinity conflict` | The volume lives in one zone, the free GPU in another |

The zone conflict is common with model caches. A disk created in zone A can only attach to nodes in zone A. If the only free GPU is in zone B, the Pod waits forever.

A shared file system avoids this, as described in my [cold start guide](/posts/vllm-cold-start-model-cache-kubernetes/).

## The whole checklist in one picture

{{< mermaid caption="Work down the list. Stop at the first step that fails: that is the rule no node can pass." >}}
flowchart TD
    S0["Read the Pod's events"] k1@--> S1["Does Kubernetes<br/>see GPUs?"]
    S1 k2@--> S2["Enough free GPUs<br/>on one node?"]
    S2 k3@--> S3["Taints<br/>tolerated?"]
    S3 k4@--> S4["Selector matches<br/>a real label?"]
    S4 k5@--> S5["CPU and memory<br/>left?"]
    S5 k6@--> S6["Quota and<br/>storage OK?"]

    k1@{ animate: true }
    k2@{ animate: true }
    k3@{ animate: true }
    k4@{ animate: true }
    k5@{ animate: true }
    k6@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    class S0 input;
    class S1,S2 gpu;
    class S3,S4,S5,S6 tree;
{{< /mermaid >}}

## When Pending is normal

Not every Pending Pod is a problem.

**The cluster is adding a node.** If you run a cluster autoscaler, a Pending Pod is the signal it scales on. Look for a `TriggeredScaleUp` event on the Pod. A GPU node can take several minutes to arrive, so Pending during that time is expected.

If you see `NotTriggerScaleUp` instead, the autoscaler looked and decided no node group could fit the Pod. That usually points back to steps 3 to 5, or to a node group that is already at its maximum size.

**A more important Pod should go first.** If every GPU is busy with batch work, an inference Pod can wait behind it. Give inference a higher priority, and the scheduler will evict lower-priority Pods to make room:

```yaml
# inference-priority.yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: inference-high
value: 100000
globalDefault: false
description: "Online inference. May preempt batch workloads."
```

```bash
kubectl apply -f inference-priority.yaml
```

Then set `priorityClassName: inference-high` in the Pod spec. Use this carefully: preempted batch jobs lose their progress unless they checkpoint.

## Common causes, ranked

The list is short, and the top three cover most cases.

| Cause | How often | Fastest check |
|---|---|---|
| All GPUs already requested | Very common | Step 2 |
| Missing toleration | Very common | Step 3 |
| Selector label does not exist | Common | Step 4 |
| Enough GPUs in total, but fragmented | Common for multi-GPU Pods | Step 2 |
| CPU or memory too small on GPU nodes | Occasional | Step 5 |
| Wrong resource name after enabling MIG | Occasional | Step 2 |
| Namespace quota | Occasional | Step 6 |
| Volume in the wrong zone | Occasional | Step 7 |

## Practice without a GPU

Every step here works on fake GPUs. The [laptop GPU simulation lab](/posts/simulate-gpu-vllm-llm-d-on-laptop/) gives you a kind cluster that advertises 16 simulated H100s. Request 17, add a taint, or misspell a selector, and you can produce each of these Pending states on purpose and practice reading the events.

## Cheat sheet

```text
Pending             = no node passed every scheduling rule yet
Pod events          = where the scheduler explains itself; always read these first
Insufficient gpu    = not enough free GPUs on that node
Allocatable         = how many GPUs a node offers in total
Fragmentation       = enough free GPUs overall, but not enough on any single node
Taint               = a node's "keep out" sign
Toleration          = a Pod's pass for a taint; allows, does not attract
Node selector       = a Pod's own restriction on where it will run
ResourceQuota       = a per-namespace cap; over it, the Pod is never created
Volume zone conflict = the disk and the free GPU are in different zones
PriorityClass       = lets important Pods preempt less important ones
TriggeredScaleUp    = the cluster autoscaler is adding a node; waiting is normal
Rule of thumb       = read the event, then find the one rule that leaves zero nodes
```

Once the Pod is running, the next question is how long it takes to become ready, which is the subject of [Faster vLLM Cold Starts on Kubernetes](/posts/vllm-cold-start-model-cache-kubernetes/). For the layers beneath scheduling, go back to the [GPU platform guide](/posts/kubernetes-gpu-platform-engineering/).
