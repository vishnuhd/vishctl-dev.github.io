+++
title = "Run vLLM on Kubernetes with Minikube, WSL2 and NVIDIA GPU"
date = '2026-09-08T13:30:00+08:00'
draft = false
description = "A practical guide to running vLLM on Kubernetes in WSL2 with Minikube, configuring NVIDIA GPU passthrough, and serving an OpenAI-compatible API."
tags = ["ai", "local-llm", "vllm", "kubernetes", "minikube", "wsl2", "gpu", "nvidia"]
ShowToc = true
TocOpen = false
+++

This is the [vLLM](https://docs.vllm.ai/) entry in my local AI series. After testing [Ollama](/posts/running-ollama-on-32gb-macbook-air/), [llama.cpp](/posts/running-llama-cpp-on-32gb-macbook-air/), and [FreeToken](/posts/running-freetoken-on-8gb-laptop-gpu/), I wanted to run vLLM as a Kubernetes Deployment on my Windows/WSL2 setup.

The plan was simple: deploy vLLM, request `nvidia.com/gpu: 1`, expose an OpenAI-compatible API endpoint through a Service, and tie it into the Kubernetes workflows I write about regularly.

Getting a GPU into Kubernetes on WSL2 turned into an investigation. Not because vLLM is hard, but because container runtimes and nested clusters handle GPU passthrough in non-obvious ways. Here is what happened, how the device plugin and node prerequisites work, and how to get a working GPU cluster running with Minikube.

## What You'll Build

```text
Windows
   │
   ▼
WSL2 Ubuntu
   │
   ▼
Docker Engine + NVIDIA Container Toolkit
   │
   ▼
Minikube
   │
   ▼
Kubernetes
   │
   ├── NVIDIA GPU Operator
   │
   ├── NVIDIA Device Plugin
   │
   └── vLLM
         │
         ▼
      NVIDIA GPU
```

By the end of this guide, you'll have vLLM running on Kubernetes with GPU acceleration and serving an OpenAI-compatible API.

---

## The Test Rig

My test machine for this run:

- **Host Machine:** Windows 11 Laptop
- **GPU:** NVIDIA GeForce RTX 4070 Laptop GPU (8.0 GiB VRAM)
- **Host Memory:** 32 GB DDR5
- **WSL2 Environment:** Ubuntu 24.04 LTS (noble) with systemd enabled
- **NVIDIA Drivers:** Driver version 616.56 / CUDA 13.4 user-mode driver
- **Kubernetes:** Minikube v1.39.0 provisioning Kubernetes v1.37.0
- **Model:** Qwen3.5-0.8B (`Qwen/Qwen3.5-0.8B`) served by vLLM v0.28.0


## Troubleshooting vLLM GPU Support on WSL2 Kubernetes

Docker Desktop offers a one-click Kubernetes cluster in its settings. Turning it on provisions a single-node cluster named `desktop-control-plane` running on `containerd://2.3.4`.

On the WSL2 host, `nvidia-smi` works fine, and running standalone GPU containers (`docker run --gpus all`) works without issues. The next step was applying the standard NVIDIA Kubernetes device plugin DaemonSet to enable GPU scheduling:

```bash
kubectl create -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.16.2/deployments/static/nvidia-device-plugin.yml
```

The DaemonSet pod started, but immediately stalled in a retry loop:

```text
E... Incompatible strategy detected auto
E... If this is a GPU node, did you configure the NVIDIA Container Toolkit?
I... No devices found. Waiting indefinitely.
```

Checking the node capacity confirmed the issue:

```bash
kubectl describe node desktop-control-plane | grep -A5 "Capacity:\|Allocatable:"
```

{{< figure src="/images/posts/vllm-wsl2-minikube/01-docker-desktop-k8s-no-gpu.png" alt="Docker Desktop Kubernetes node missing GPU resources" caption="Checking Docker Desktop's desktop-control-plane: nvidia-smi finds the RTX 4070, but the node exposes zero GPU capacity." class="post-screenshot" >}}

In this tested Docker Desktop Kubernetes setup, GPU resources were not exposed to the Kubernetes node. Despite GPU access working in WSL2 and standalone Docker containers, the Kubernetes node could not expose `nvidia.com/gpu` to the device plugin.

---

## Why Docker Desktop Kubernetes Cannot Detect My NVIDIA GPU

Based on the runtime architecture observed in this setup, the issue comes down to how Docker Desktop isolates its cluster node.

`desktop-control-plane` is not a traditional virtual machine or a standard container. It runs inside Docker Desktop's private utility VM (`docker-desktop`), isolated using **`sysbox-runc`** rather than the standard OCI runtime `runc`. Sysbox provides nested container virtualization, allowing Docker Desktop to safely spin up a full systemd, kubelet, and containerd stack within an unprivileged container environment.

In this configuration, that isolation layer prevents GPU passthrough:

1. **Missing OCI Runtime Passthrough:** The node container itself was not launched with NVIDIA GPU passthrough flags (`--gpus all`). Inside the sysbox sandbox, the nested containerd cannot see NVIDIA device nodes (`/dev/nvidia*`) or the WSL2 DirectX driver mapping (`/usr/lib/wsl/lib`).
2. **Locked-Down Runtime Configuration:** You cannot simply configure the NVIDIA Container Toolkit inside the node's containerd because you do not own the lifecycle of the `desktop-control-plane` container; Docker Desktop provisions and supervises it internally.
3. **Daemon Defaults Do Not Propagate:** Even if you shell into the `docker-desktop` WSL distribution (`wsl -d docker-desktop`) and configure `nvidia` as the default OCI runtime globally, the Kubernetes node container remains bound to `sysbox-runc`.

Docker has an open, long-standing roadmap issue requesting native GPU passthrough for Docker Desktop Kubernetes. It is not an omitted user toggle; it is an architectural boundary in the current setup.

---

## How Kubernetes Detects NVIDIA GPUs Using the NVIDIA Device Plugin

The [NVIDIA Kubernetes Device Plugin](https://github.com/NVIDIA/k8s-device-plugin) is a DaemonSet that exposes GPU hardware to the Kubernetes control plane. It does not run inference, and it does not install drivers or container runtimes.

Under standard [Kubernetes GPU scheduling](https://kubernetes.io/docs/tasks/manage-gpus/scheduling-gpus/), pods request GPU resources by specifying limits for extended resources. The device plugin integrates with Kubelet through the Kubernetes Device Plugin API over gRPC, using a Unix domain socket at `/var/lib/kubelet/device-plugins/kubelet.sock`. Its responsibility comes down to three functions:

1. **Discovery:** The plugin queries the host system using NVML (NVIDIA Management Library) to check how many physical GPUs are present and verify their health status.
2. **Registration:** It registers with Kubelet and advertises the discovered GPUs as an extended allocatable resource named `nvidia.com/gpu`.
3. **Allocation:** When a pod requesting `nvidia.com/gpu: 1` gets scheduled to the node, Kubelet calls the plugin's `Allocate` gRPC endpoint. The plugin picks a healthy GPU and sends back the device IDs and environment variables (`NVIDIA_VISIBLE_DEVICES=<UUID>`) to Kubelet. Kubelet then passes those variables to the container runtime so the container gets access to `/dev/nvidia*`.

### Worker Node Prerequisites

Because the device plugin only handles discovery and Kubelet registration, it assumes the worker node already has a functional GPU stack. For worker nodes in any Kubernetes cluster, three layers must be in place before the device plugin can run:

1. **Host Kernel Drivers:** The node OS must have the NVIDIA kernel modules loaded (`nvidia.ko`, `nvidia-uvm.ko`) and device nodes created in `/dev`. Running `nvidia-smi` on the host must return clean output.
2. **NVIDIA Container Toolkit:** Packages such as `libnvidia-container` and `nvidia-container-toolkit` must be installed on the host. Refer to the [NVIDIA Container Toolkit install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) for distribution setup. This toolkit includes the OCI prestart hook that inspects container environment variables and mounts host GPU driver libraries into the target container.
3. **Runtime Configuration:** The node container runtime (containerd or Docker) must have the NVIDIA runtime configured in its daemon settings (such as `/etc/containerd/config.toml` or `/etc/docker/daemon.json`) and set up to handle CDI (Container Device Interface) or NVIDIA runtime hooks.

If any of those three pieces is missing or unconfigured, the device plugin pod will fail during startup or report zero allocatable GPUs. That was the exact failure inside Docker Desktop: the `desktop-control-plane` container lacked the driver mounts and the toolkit configuration inside its sysbox sandbox.

---

## Step 1: Installing Docker CE and Containerd Inside WSL2

To satisfy those node prerequisites and bypass Docker Desktop's VM isolation, we install the native Docker Community Edition engine directly inside the Ubuntu 24.04 WSL2 environment:

```bash
# Add Docker's official GPG key
sudo mkdir -p /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Set up the repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker CE and containerd
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

{{< figure src="/images/posts/vllm-wsl2-minikube/02-install-docker-ce-wsl2.png" alt="Installing Docker CE and containerd in Ubuntu WSL2" caption="Configuring the official Docker CE repository and installing containerd and the Docker daemon inside Ubuntu WSL2." class="post-screenshot" >}}

Verify that both the Docker daemon and containerd services are running cleanly under systemd:

```bash
systemctl status docker
systemctl status containerd
```

{{< figure src="/images/posts/vllm-wsl2-minikube/03-docker-containerd-service-status.png" alt="Verifying systemd status for Docker and containerd" caption="Confirming active (running) status for both docker.service and containerd.service under WSL2 systemd." class="post-screenshot" >}}

Before moving to Kubernetes, sanity check that native Docker has full GPU access through the WSL2 NVIDIA container runtime:

```bash
docker container run --gpus all --rm nvidia/cuda:13.3.1-base-ubuntu26.04 nvidia-smi -L
```

{{< figure src="/images/posts/vllm-wsl2-minikube/04-docker-gpu-passthrough-verification.png" alt="Docker container GPU passthrough test" caption="Direct GPU passthrough test: Docker successfully identifies GPU 0 as the NVIDIA GeForce RTX 4070 Laptop GPU." class="post-screenshot" >}}

---

## Run Minikube with NVIDIA GPU Support on WSL2

Install the latest Minikube Debian package:

```bash
curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube_latest_amd64.deb
sudo dpkg -i minikube_latest_amd64.deb
```

{{< figure src="/images/posts/vllm-wsl2-minikube/05-install-minikube-deb.png" alt="Installing Minikube package in WSL2" caption="Installing Minikube v1.39.0 via Debian package." class="post-screenshot" >}}

Following the official [Minikube GPU documentation](https://minikube.sigs.k8s.io/docs/tutorials/nvidia/), starting Minikube with GPU acceleration requires specific driver and runtime parameters. Now start Minikube. Two flags matter here and both are easy to miss:

```bash
minikube start \
  --driver=docker \
  --container-runtime=docker \
  --gpus=all \
  --memory=12g \
  --cpus=10 \
  --extra-config=apiserver.service-account-issuer=https://kubernetes.default.svc \
  --extra-config=apiserver.service-account-signing-key-file=/var/lib/minikube/certs/sa.key
```

{{< figure src="/images/posts/vllm-wsl2-minikube/06-minikube-start-gpu-flags.png" alt="Starting Minikube with GPU support and Docker runtime" caption="Minikube starting Kubernetes v1.37.0 on Docker, automatically detecting and enabling the nvidia-device-plugin addon." class="post-screenshot" >}}

> [!IMPORTANT]
> **Why `--container-runtime=docker` is required:**
> By default, even when using `--driver=docker`, Minikube configures containerd as its internal in-node runtime. However, Minikube's `--gpus=all` flag currently hooks into Docker's OCI runtime wrapper. If you omit `--container-runtime=docker`, Minikube fails during preflight checks with an invalid flag combination error.

Notice the startup output: Minikube automatically detects the GPU and enables the `nvidia-device-plugin` addon for you.

---

## Verifying the Cluster and GPU Allocation

Install `kubectl` to talk to the cluster:

```bash
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
kubectl version --client
kubectl get nodes
kubectl get pods -A
```

{{< figure src="/images/posts/vllm-wsl2-minikube/07-kubectl-install-and-cluster-verification.png" alt="Kubectl verification and nvidia-device-plugin DaemonSet" caption="Node minikube is Ready (v1.37.0) and the nvidia-device-plugin-daemonset is 1/1 Running in kube-system." class="post-screenshot" >}}

Next, inspect the node's schedulable capacity:

```bash
kubectl describe node minikube | grep -A7 "Capacity:\|Allocatable:"
```

```text
Capacity:
  cpu:                20
  ephemeral-storage:  1081101176832
  hugepages-1Gi:      0
  hugepages-2Mi:      0
  memory:             16235176Ki
  nvidia.com/gpu:     1
  pods:               110
Allocatable:
  cpu:                20
  ephemeral-storage:  1081101176832
  hugepages-1Gi:      0
  hugepages-2Mi:      0
  memory:             16235176Ki
  nvidia.com/gpu:     1
  pods:               110
```

{{< figure src="/images/posts/vllm-wsl2-minikube/08-minikube-node-gpu-capacity.png" alt="Minikube node capacity showing GPU resource" caption="Cluster verification: nvidia.com/gpu: 1 is now officially registered in Capacity and Allocatable." class="post-screenshot" >}}

A quick test pod confirms the GPU is actually reachable from inside Kubernetes:

```bash
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: gpu-test
spec:
  restartPolicy: Never
  containers:
    - name: cuda-test
      image: nvidia/cuda:13.3.1-base-ubuntu26.04
      command: ["nvidia-smi", "-L"]
      resources:
        limits:
          nvidia.com/gpu: 1
EOF
```

Check the test pod logs:

```bash
kubectl logs gpu-test
# GPU 0: NVIDIA GeForce RTX 4070 Laptop GPU (UUID: GPU-f6577d54-195d-f2ff-6987-6960bbad74ea)
```

{{< figure src="/images/posts/vllm-wsl2-minikube/09-k8s-cuda-gpu-test-pod.png" alt="CUDA test pod running on Minikube" caption="Test pod running nvidia-smi inside the Kubernetes cluster and successfully accessing the RTX 4070." class="post-screenshot" >}}

Real GPU scheduling and `nvidia.com/gpu` resource accounting, without Docker Desktop getting in the way.


## Deploy vLLM on Kubernetes with NVIDIA GPU

Model choice for 8 GB VRAM: **Qwen3.5-0.8B** (`Qwen/Qwen3.5-0.8B`). Small enough to leave real headroom for vLLM's KV cache, which is the main reason to use vLLM over llama.cpp or Ollama in the first place, and it is a capable model at that size. As detailed in the [vLLM documentation](https://docs.vllm.ai/), the server exposes an OpenAI-compatible API endpoint over HTTP.

### The Shared Memory (`/dev/shm`) Gotcha

When running vLLM via the Docker CLI, passing `--ipc=host` lets workers exchange tensors and state across processes using host shared memory. In Kubernetes, pods do not share the host IPC namespace by default, and Kubernetes provisions `/dev/shm` as a minimal 64 MB tmpfs mount.

Some PyTorch and vLLM multiprocessing workloads can require significantly more shared memory than Kubernetes' default `/dev/shm` (which defaults to a minimal 64 MB tmpfs mount). If insufficient shared memory is available, initialization or worker processes may fail. The Kubernetes solution is mounting an `emptyDir` volume backed by host RAM (`medium: Memory`) with a dedicated `sizeLimit`:

```yaml
# vllm-qwen-k8s.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-qwen
  labels:
    app: vllm-qwen
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vllm-qwen
  template:
    metadata:
      labels:
        app: vllm-qwen
    spec:
      containers:
        - name: vllm
          image: vllm/vllm-openai:v0.28.0
          args:
            - "--model=Qwen/Qwen3.5-0.8B"
            - "--gpu-memory-utilization=0.7"
            - "--max-model-len=8192"
          ports:
            - containerPort: 8000
          resources:
            limits:
              nvidia.com/gpu: 1
          volumeMounts:
            - name: hf-cache
              mountPath: /root/.cache/huggingface
            - name: dshm
              mountPath: /dev/shm
      volumes:
        - name: hf-cache
          emptyDir: {}
        - name: dshm
          emptyDir:
            medium: Memory
            sizeLimit: 2Gi
---
apiVersion: v1
kind: Service
metadata:
  name: vllm-qwen
spec:
  selector:
    app: vllm-qwen
  ports:
    - port: 8000
      targetPort: 8000
  type: ClusterIP
```

Two practical notes on this manifest:
- **Image version pinning:** I pin the image version (`v0.28.0`) here so the deployment remains reproducible. You can update the image tag after validating compatibility with your CUDA and model version.
- **Hugging Face cache:** `emptyDir` is used here for simplicity. The Hugging Face model cache is lost when the pod is recreated. For repeated testing or larger models, consider using a PersistentVolumeClaim (PVC) or a host-mounted path.

Apply the manifest and watch the deployment roll out:

```bash
kubectl apply -f vllm-qwen-k8s.yaml
kubectl get pods,svc
```

{{< figure src="/images/posts/vllm-wsl2-minikube/10-vllm-deployment-and-service-running.png" alt="vLLM deployment and service running" caption="Applying vllm-qwen-k8s.yaml and confirming the vLLM pod reaches 1/1 Running status alongside the ClusterIP service." class="post-screenshot" >}}

Stream the pod logs to inspect the vLLM initialization sequence:

```bash
kubectl logs vllm-qwen-5c8bbc786f-gdpmj -f
```

{{< figure src="/images/posts/vllm-wsl2-minikube/11-vllm-pod-startup-logs.png" alt="vLLM pod engine initialization logs" caption="vLLM v0.28.0 engine initialization: resolving Qwen3_5ForConditionalGeneration, setting max model length to 8192, and warming up CUDA graphs." class="post-screenshot" >}}

Once PyTorch compilation and CUDA graph capture finish, the ASGI application completes startup and begins listening on port 8000:

{{< figure src="/images/posts/vllm-wsl2-minikube/12-vllm-server-ready-and-metrics.png" alt="vLLM application startup complete and request logs" caption="vLLM application startup complete: exposing OpenAI-compatible endpoints (/v1/chat/completions) with live throughput metrics." class="post-screenshot" >}}

---

## Testing Inference and Hardware Telemetry

Forward port 8000 from the cluster service to the local machine:

```bash
kubectl port-forward svc/vllm-qwen 8000:8000
```

Now issue an OpenAI-standard chat completion request using `curl`:

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen3.5-0.8B",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}]
  }'
```

```json
{
  "id": "chatcmpl-97d4ed9b5ec34359",
  "object": "chat.completion",
  "created": 1788843254,
  "model": "Qwen/Qwen3.5-0.8B",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello, I am Qwen3.5, a large language model built by Tongyi Lab, designed to assist you in tasks ranging from logical reasoning and creative writing to practical coding and data analysis. How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 18,
    "total_tokens": 66,
    "completion_tokens": 48
  }
}
```

{{< figure src="/images/posts/vllm-wsl2-minikube/13-vllm-curl-chat-completion-response.png" alt="Calling vLLM chat completions API with curl" caption="Inference test: 48 tokens generated cleanly through the OpenAI-compatible vLLM API running in Minikube." class="post-screenshot" >}}

The response returned without issues, and the server logs recorded generation throughput averaging 23.5 tokens/s.

Finally, checking Windows Task Manager confirms the hardware utilization on the host:

{{< figure src="/images/posts/vllm-wsl2-minikube/14-windows-task-manager-gpu-vram-usage.png" alt="Windows Task Manager GPU memory usage" caption="Windows Task Manager telemetry: 4.4 GB of 8.0 GB dedicated VRAM allocated to the WSL2 vLLM pod at 45°C." class="post-screenshot" >}}

Dedicated GPU memory held at **4.4 / 8.0 GB** (in line with the `--gpu-memory-utilization 0.7` setting plus desktop display overhead), with the GPU temperature at 45°C.

---

## Beyond Local Dev: Why Production Clusters Use the NVIDIA GPU Operator

For a single-node laptop or a Minikube sandbox, managing drivers on the host and running a standalone device plugin DaemonSet gets the job done.

In production Kubernetes clusters, manual node configuration does not scale. When you operate multi-node clusters across cloud providers or bare metal, nodes get provisioned dynamically by autoscalers, Linux kernel patch levels drift, and different GPU architectures (such as A100, H100, or L40S) coexist in the same cluster.

This is why production setups deploy the [NVIDIA GPU Operator](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/) instead of managing the device plugin directly.

The GPU Operator automates the deployment and lifecycle management of the NVIDIA software stack required for GPU-enabled Kubernetes nodes. Driven by the `ClusterPolicy` Custom Resource Definition, it manages several components depending on your cluster configuration:

1. **Driver Management:** Depending on the operating environment, the Operator can compile and load the NVIDIA driver container matched to the node kernel, or use pre-installed host drivers (common in managed Kubernetes environments like GKE, EKS, or AKS).
2. **Container Toolkit and CDI Configuration:** Depending on the Operator version and runtime configuration, GPU injection can be configured through direct NVIDIA runtime integration or CDI-based device injection (Container Device Interface), which modern releases enable by default.
3. **Device Plugin Supervision:** It deploys and manages the lifecycle of the NVIDIA Kubernetes Device Plugin DaemonSet, keeping it in sync with driver and runtime availability.
4. **Node Feature Discovery (GFD):** It automatically detects physical GPU capabilities and labels each node (such as `nvidia.com/gpu.product: NVIDIA-A100-SXM4-80GB` or `nvidia.com/gpu.family: ampere`). Workloads can then target specific GPU models using standard Kubernetes `nodeSelector` or affinity rules.
5. **Cluster Metrics with DCGM Exporter:** It runs the Data Center GPU Manager (DCGM) exporter to collect metrics (GPU compute utilization, VRAM usage, temperature, power draw, and memory bandwidth) and expose them to Prometheus for cluster monitoring and alerting.
6. **MIG Management:** On enterprise GPUs that support Multi-Instance GPU (MIG), the Operator can dynamically partition a single physical GPU into isolated hardware instances, allowing smaller workloads to share an A100 or H100 without memory interference.

In short: the device plugin provides basic GPU scheduling for pods. The GPU Operator manages the operational lifecycle, monitoring, and driver stack required to run GPU infrastructure reliably in production.

---

## Key Takeaways

1. **In tested Docker Desktop Kubernetes setups, GPU resources are not exposed to the node.** Because `desktop-control-plane` is isolated in a nested `sysbox-runc` sandbox without GPU passthrough flags, the device plugin cannot discover any GPU devices. Avoid spending hours trying to manually patch containerd or driver libraries inside that nested container.
2. **Minikube on native Docker CE in WSL2 works reliably.** By installing native Docker CE inside Ubuntu WSL2 (where NVIDIA container runtime works out of the box), Minikube can launch with `--driver=docker --container-runtime=docker --gpus=all` and automatically provision the NVIDIA device plugin.
3. **Understand the device plugin vs node prerequisites.** The device plugin only handles Kubelet discovery and allocation. The host worker node must already have the host NVIDIA kernel drivers, NVIDIA Container Toolkit, and configured runtime in place before the plugin can register `nvidia.com/gpu`.
4. **Always size `/dev/shm` in Kubernetes.** PyTorch, vLLM, and Triton rely heavily on shared memory for inter-process tensor operations. Never rely on the default 64 MB Kubernetes tmpfs; always attach an `emptyDir` memory volume at `/dev/shm`.
5. **Budget VRAM carefully.** On an 8 GB laptop GPU, setting `--gpu-memory-utilization 0.7` on a sub-billion parameter model like Qwen3.5-0.8B leaves enough VRAM for the KV cache without running into CUDA out-of-memory errors.
6. **Move to the NVIDIA GPU Operator in production.** While running the standalone device plugin is fine for a local dev setup or Minikube, production clusters rely on the GPU Operator to orchestrate the entire GPU stack: driver lifecycle (compiled or pre-installed), Container Toolkit and CDI configuration, node labelling with GFD, DCGM telemetry, and MIG partitioning.

---

Thanks for reading! If you run into issues setting up GPU passthrough on your machine, have questions, or have suggestions for other local AI setups to explore, leave a comment below.