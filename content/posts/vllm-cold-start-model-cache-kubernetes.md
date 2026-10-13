---
title: "Faster vLLM Cold Starts on Kubernetes: Cache the Model, Not the Download"
date: 2026-10-13T02:47:00+08:00
draft: true
author: "Vishnu"
description: "A simple, diagram-first guide to making a new vLLM Pod ready in seconds instead of minutes: where cold-start time goes, how to cache weights on a volume, how to pre-pull the image, and which storage to pick."
series: ["AI Infra"]
tags: ["kubernetes", "vllm", "cold-start", "storage", "inference", "ai-infra"]
cover:
  image: "/images/posts/vllm-cold-start/00-pixel-art-cover.png"
  alt: "Pixel art of a local SSD transferring model tiles through a short connection into a GPU server inside a rack"
  relative: false
ShowToc: true
TocOpen: false
---

A new vLLM Pod has a lot to do before it answers its first request. By default it pulls a large image, downloads the model from the internet, and then loads those weights into the GPU.

On a fresh node that can take five minutes. During a traffic spike, five minutes is the whole incident.

Most of that time is avoidable, because most of it is spent fetching things that have not changed since the last Pod started.

```text
Default start = pull the image + download the model + load it, every single time
Cached start  = image and model are already on disk, so only the load remains
```

{{< mermaid caption="Top: the default path downloads everything on each start. Bottom: with the image pre-pulled and the model on a volume, the Pod only has to load weights." >}}
flowchart TD
    subgraph SLOW["Default start"]
        direction LR
        A1["Pull image"] a1@--> A2["Download<br/>16 GB model"]
        A2 a2@--> A3["Load into<br/>GPU"]
        A3 a3@--> A4["Ready in<br/>about 5 min"]
    end

    subgraph FAST["Cached start"]
        direction LR
        B1["Image already<br/>on node"] b1@--> B2["Model already<br/>on disk"]
        B2 b2@--> B3["Load into<br/>GPU"]
        B3 b3@--> B4["Ready in<br/>about 30 s"]
    end

    SLOW ~~~ FAST
    a1@{ animate: true }
    a2@{ animate: true }
    a3@{ animate: true }
    b1@{ animate: true }
    b2@{ animate: true }
    b3@{ animate: true }

    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class A1,A2,A4 warn;
    class B1,B2 idle;
    class A3,B3 tree;
    class B4 gpu;
{{< /mermaid >}}

My [autoscaling guide](/posts/autoscaling-llm-inference-kubernetes-keda/) explained why slow cold starts make scaling hard. This post is about making them short.

## Where the time goes

A cold start has four phases. Each is limited by something different.

{{< mermaid caption="The four phases of a cold start and what limits each one. The first two can be removed completely. The third can be made much faster." >}}
flowchart LR
    P1["Image pull<br/>registry speed"] c1@--> P2["Model download<br/>internet speed"]
    P2 c2@--> P3["Weight load<br/>disk speed"]
    P3 c3@--> P4["Engine start<br/>fixed cost"]
    P4 c4@--> P5["Ready"]

    c1@{ animate: true }
    c2@{ animate: true }
    c3@{ animate: true }
    c4@{ animate: true }

    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:3px;
    class P1,P2 warn;
    class P3 tree;
    class P4 idle;
    class P5 gpu;
{{< /mermaid >}}

Every phase is "size divided by speed". Take an 8B model in 16-bit (16 GB) and an 8 GB serving image as an example:

| Phase | Size | Speed (example) | Time |
|---|---|---|---|
| 1. Image pull | 8 GB | 100 MB/s | 80 s |
| 2. Model download | 16 GB | 100 MB/s | 160 s |
| 3. Weight load from local SSD | 16 GB | 500 MB/s | 32 s |
| 4. Engine start | Fixed | Fixed | About 20 s |
| **Total** | | | **About 292 s** |

These speeds are round numbers for illustration. Yours will differ, but the shape rarely does: **the two downloads are most of the wait.**

## Four ways to start, compared

Now remove the phases one at a time, using the same example numbers:

| Setup | Image pull | Download | Load | Engine | Total |
|---|---|---|---|---|---|
| A. Default | 80 s | 160 s | 32 s | 20 s | 292 s |
| B. Image pre-pulled | 0 | 160 s | 32 s | 20 s | 212 s |
| C. B plus model on a shared network volume | 0 | 0 | 80 s | 20 s | 100 s |
| D. B plus model on node-local NVMe | 0 | 0 | 8 s | 20 s | 28 s |

Two things stand out:

- **Caching the model is the biggest single win.** It removes the largest phase outright.
- **After that, disk speed is everything.** Setup C loads from network storage at 200 MB/s. Setup D loads from NVMe at 2,000 MB/s. Same files, ten times faster.

From A to D is a 10x improvement, with no change to the model or the GPU.

## Step 1: put the model on a volume

By default vLLM downloads from the Hugging Face Hub into a cache directory inside the container. When the Pod dies, the cache dies with it.

Point that cache at a persistent volume, and the download happens once.

```yaml
# model-cache-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: model-cache
  namespace: llm
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 100Gi
```

```bash
kubectl apply -f model-cache-pvc.yaml
```

`ReadWriteMany` lets several replicas mount the same volume, so they all share one copy. It needs a storage class that supports it (NFS, a managed file store, or a distributed file system). With `ReadWriteOnce`, each replica needs its own claim and its own download.

### Fill the cache with a Job

Download the model once, ahead of time, instead of making the first serving Pod do it:

```yaml
# model-download-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: model-download
  namespace: llm
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: download
          image: python:3.12-slim
          command:
            - bash
            - -c
            - pip install -q huggingface_hub && hf download "$MODEL"
          env:
            - name: MODEL
              value: "<org>/<model>"
            - name: HF_HOME
              value: /cache
            - name: HF_TOKEN
              valueFrom:
                secretKeyRef:
                  name: hf-token
                  key: token
                  optional: true
          volumeMounts:
            - name: cache
              mountPath: /cache
      volumes:
        - name: cache
          persistentVolumeClaim:
            claimName: model-cache
```

```bash
kubectl apply -f model-download-job.yaml
kubectl -n llm wait --for=condition=complete job/model-download --timeout=30m
```

`HF_HOME` tells the Hugging Face tools where the cache lives. The token is only needed for gated models. On older versions of `huggingface_hub`, the command is `huggingface-cli download` instead of `hf download`.

### Mount it in the serving Pod

Add three things to the vLLM container: the same `HF_HOME`, the volume, and a switch that forbids downloads.

```yaml
# excerpt from the vLLM Deployment
      containers:
        - name: vllm
          image: vllm/vllm-openai:latest
          args: ["--model", "<org>/<model>"]
          env:
            - name: HF_HOME
              value: /cache
            - name: HF_HUB_OFFLINE
              value: "1"
          volumeMounts:
            - name: cache
              mountPath: /cache
              readOnly: true
      volumes:
        - name: cache
          persistentVolumeClaim:
            claimName: model-cache
```

`HF_HUB_OFFLINE=1` is the important line. Without it, a Pod that cannot find the model quietly starts a 16 GB download. With it, the Pod fails immediately and tells you the cache is missing.

**A fast, loud failure beats a slow, silent one.**

Pin the image to a specific version tag in real deployments. `latest` is here only to keep the example short.

## Step 2: pre-pull the image

The serving image is large because it carries CUDA libraries and PyTorch. A node that has never run it must pull all of it before the container can start.

A small DaemonSet fixes that by pulling the image on every GPU node as soon as the node joins:

```yaml
# vllm-image-prepull.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: vllm-image-prepull
  namespace: llm
spec:
  selector:
    matchLabels:
      app: vllm-image-prepull
  template:
    metadata:
      labels:
        app: vllm-image-prepull
    spec:
      nodeSelector:
        nvidia.com/gpu.present: "true"
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      initContainers:
        - name: pull
          image: vllm/vllm-openai:latest
          command: ["sh", "-c", "exit 0"]
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.10
```

```bash
kubectl apply -f vllm-image-prepull.yaml
```

The init container runs the vLLM image just long enough to exit, which forces the node to download it. The tiny `pause` container then keeps the Pod alive without using resources.

Use the same image tag here as in your Deployment. Otherwise you pre-pull an image nobody runs. The `nvidia.com/gpu.present` label is set by the GPU Operator's feature discovery; change the selector if your GPU nodes are labelled differently.

## Step 3: pick the right storage

Once nothing is downloaded, the load phase is all that is left, and it runs at the speed of your disk.

| Storage | Typical read speed | 16 GB load | Shared by replicas | Survives node loss |
|---|---|---|---|---|
| Network file storage | Around 200 MB/s | About 80 s | Yes | Yes |
| Network block storage | Around 500 MB/s | About 32 s | No, one Pod each | Yes |
| Node-local NVMe | 2,000 MB/s or more | About 8 s | Only Pods on that node | No |

There is no single winner. It is a trade between speed and convenience:

{{< mermaid caption="A short way to choose where the model cache lives. Start with whether the nodes have fast local disks." >}}
flowchart TD
    Q1["Do GPU nodes have<br/>local NVMe?"] s1@-->|"Yes"| Q2["Do nodes come<br/>and go often?"]
    Q1 s2@-->|"No"| N["Shared network volume<br/>simple and good enough"]
    Q2 s3@-->|"No"| L["Local NVMe cache<br/>fastest starts"]
    Q2 s4@-->|"Yes"| H["Both: shared volume<br/>plus a copy to NVMe"]

    s1@{ animate: true }
    s2@{ animate: true }
    s3@{ animate: true }
    s4@{ animate: true }

    classDef question fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class Q1,Q2 question;
    class N input;
    class L,H gpu;
{{< /mermaid >}}

The "both" option is common on autoscaled clusters. An init container copies the model from the shared volume to the node's NVMe the first time a node is used. Later Pods on that node start at full NVMe speed.

One free speedup is worth knowing. Linux keeps recently read files in memory. If a Pod restarts on the same node soon after, the weights may still be in the page cache, and the load takes seconds regardless of the disk.

## What about baking the model into the image?

It is tempting: one artifact, nothing to mount.

| | Model in the image | Model on a volume |
|---|---|---|
| Moving parts | Fewer | A volume and a download Job |
| Image size | Huge (image plus weights) | Normal |
| Changing models | Rebuild and push tens of GB | Run the download Job again |
| First start on a new node | Pulls everything, slowly | Loads from the volume |
| Works without shared storage | Yes | No |

For a small model in an air-gapped cluster, baking it in can be the simplest thing that works. For anything large or frequently updated, the volume wins.

## Do not let Kubernetes kill a slow starter

Even a fast start takes longer than a typical web app. Tell Kubernetes to wait, or it will restart the Pod mid-load and make things worse:

```yaml
          startupProbe:
            httpGet:
              path: /health
              port: 8000
            periodSeconds: 5
            failureThreshold: 120
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            periodSeconds: 5
```

That allows up to 10 minutes (120 checks, 5 seconds apart) before the Pod is considered failed. Once startup passes, the readiness probe takes over. A short `periodSeconds` matters here: it is how quickly a ready Pod starts receiving traffic.

## Measure your own cold start

Do not trust the tables above. Time the real thing:

```bash
kubectl -n llm delete pod -l app=vllm --wait=false
```

```bash
kubectl -n llm get pods -l app=vllm -w
```

Watch how long the new Pod spends in each state:

| Pod status | Phase it corresponds to |
|---|---|
| `Pending` | Waiting for a node or a GPU |
| `ContainerCreating` | Image pull and volume mount |
| `Running`, not ready | Model download (if any) and weight load |
| `Running`, ready | Serving |

For the exact split inside the container, read the startup log. vLLM prints how long loading the weights took:

```bash
kubectl -n llm logs -l app=vllm | grep -i -E "load|took|seconds"
```

Whichever phase is longest is the one to fix next.

## Cheat sheet

```text
Cold start        = time from Pod created to first request served
Image pull        = downloading the serving image; removed by pre-pulling
Model download    = fetching weights from the Hub; removed by a cached volume
Weight load       = reading weights from disk into the GPU; limited by disk speed
HF_HOME           = where Hugging Face tools keep their cache; point it at a volume
HF_HUB_OFFLINE=1  = forbid downloads, so a missing cache fails fast instead of slowly
Download Job      = fills the cache once, before any serving Pod needs it
ReadWriteMany     = a volume several replicas can mount at once and share
Pre-pull DaemonSet = pulls the image on every GPU node ahead of time
Node-local NVMe   = the fastest place to load from, but lost with the node
Page cache        = files recently read are still in memory, so restarts are quick
startupProbe      = tells Kubernetes a Pod is allowed to take minutes to start
Rule of thumb     = never download at start time, then load from the fastest disk you have
```

Fast starts make [autoscaling](/posts/autoscaling-llm-inference-kubernetes-keda/) practical: a replica that is ready in 30 seconds can react to a spike that a 5-minute replica would miss. For how big the weights are in the first place, see [How Much GPU Memory Does an LLM Need?](/posts/llm-gpu-memory-sizing-weights-kv-cache/) and [LLM Quantization, Simply](/posts/llm-quantization-fp16-int8-4bit-gguf/).
