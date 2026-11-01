---
title: "vCluster: Virtualise Clusters, Not Machines"
date: 2026-11-01T09:00:00+08:00
draft: false
author: "Vishnu"
description: "vCluster gives every team or customer its own Kubernetes API, running as a pod in a shared cluster. Here is how the control plane, the syncer and the three node models fit together."
series: ["vCluster"]
tags: ["kubernetes", "vcluster", "multi-tenancy", "platform-engineering"]
cover:
  image: "/images/posts/vcluster-basics/00-pixel-art-cover.png"
  alt: "Pixel art of one large server rack holding several small glowing Kubernetes control towers, each wired to its own group of worker blocks"
  relative: false
ShowToc: true
TocOpen: false
---

Every platform team hits the same question sooner or later: when a new team or customer arrives, do they get a namespace or a whole cluster?

```text
Namespace per tenant = cheap, but one shared API, one set of CRDs
vCluster per tenant  = its own Kubernetes API, running as a pod
```

**vCluster** sits between those two options. This post explains what it is and how the pieces work. A [second post](/posts/vcluster-private-nodes-auto-nodes-bare-metal/) covers private nodes and bare-metal servers, and a [third one](/posts/vcluster-bare-metal-gpu-tenant-metal3/) walks through a lab I built where a tenant gets real (simulated) servers by itself.

## The problem: namespaces are not clusters

Namespaces are great for grouping. They are a weak boundary for tenants.

| Need of a tenant | With a namespace | Why it hurts |
|---|---|---|
| Install an operator with its own CRDs | CRDs are cluster-scoped | Two tenants want different versions of the same CRD |
| Be admin of "their" cluster | Only namespace-level RBAC | They cannot create ClusterRoles, webhooks or namespaces |
| Pick a Kubernetes version | Everyone shares one | One team blocks everyone's upgrade |
| Not be slowed down by others | One API server and etcd | A noisy controller in one namespace slows every tenant |

The usual answer is a separate cluster per tenant. That isolates well, but each cluster has its own servers, its own upgrades and its own monitoring. Ten tenants become ten clusters to run.

{{< mermaid caption="Three ways to host three tenants. vCluster keeps one fleet but gives each tenant its own API." >}}
flowchart TD
    subgraph NS["Namespace per tenant"]
        direction LR
        N1["Team A ns"] n1@--> NAPI["One shared<br/>API server and etcd"]
        N2["Team B ns"] n2@--> NAPI
        N3["Team C ns"] n3@--> NAPI
    end
    subgraph CL["Cluster per tenant"]
        direction LR
        C1["Cluster A<br/>own servers"]
        C2["Cluster B<br/>own servers"]
        C3["Cluster C<br/>own servers"]
        C1 ~~~ C2
        C2 ~~~ C3
    end
    subgraph VC["vCluster per tenant"]
        direction LR
        V1["API A"] v1@--> VH["One host cluster<br/>one fleet"]
        V2["API B"] v2@--> VH
        V3["API C"] v3@--> VH
    end
    NS ~~~ CL
    CL ~~~ VC
    n1@{ animate: true }
    n2@{ animate: true }
    n3@{ animate: true }
    v1@{ animate: true }
    v2@{ animate: true }
    v3@{ animate: true }
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef cp fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class N1,N2,N3 input;
    class NAPI,C1,C2,C3 warn;
    class V1,V2,V3 cp;
    class VH gpu;
{{< /mermaid >}}

| | Namespace | Cluster | vCluster |
|---|---|---|---|
| Own API server and CRDs | No | Yes | Yes |
| Tenant can be cluster-admin | No | Yes | Yes |
| Time to create | Seconds | Many minutes | Seconds |
| Servers to run | Shared | Per tenant | Shared, or per tenant if you want |
| Upgrades to run | One | One per tenant | Host once, tenants on their own schedule |

## What vCluster is

A **virtual cluster** (the docs now also say **tenant cluster**) is a full Kubernetes control plane: an API server, a controller manager and a datastore. The trick is where it runs. It runs as a pod (a StatefulSet) inside a namespace of an ordinary Kubernetes cluster.

That ordinary cluster is the **host cluster**. The vCluster docs call it the **Control Plane Cluster** when you design for production.

{{< mermaid caption="Each tenant gets its own API server and datastore, packed into one pod in its own host namespace." >}}
flowchart TD
    subgraph HOST["Host cluster"]
        direction LR
        subgraph NSA["Namespace team-a"]
            CPA["vCluster pod<br/>API server, controllers<br/>datastore, syncer"]
        end
        subgraph NSB["Namespace team-b"]
            CPB["vCluster pod<br/>API server, controllers<br/>datastore, syncer"]
        end
    end
    UA["Team A<br/>kubectl"] e1@--> CPA
    UB["Team B<br/>kubectl"] e2@--> CPB
    e1@{ animate: true }
    e2@{ animate: true }
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef cp fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    class UA,UB input;
    class CPA,CPB cp;
{{< /mermaid >}}

To the tenant, it looks like any cluster. They get a kubeconfig, they are cluster-admin, they can create namespaces, install CRDs and run Helm charts. To the platform team, it is one more pod to look after.

## What is inside the vCluster pod

| Piece | Job | Example |
|---|---|---|
| API server | The tenant's own Kubernetes API | `kubectl get ns` shows the tenant's namespaces only |
| Controller manager | Runs the normal controllers for tenant objects | A Deployment creates a ReplicaSet and Pods |
| Backing store | Where the tenant's objects are saved | Embedded SQLite (default), embedded etcd, external etcd, or an external database |
| Syncer | Copies the objects that need real compute to the host | A tenant Pod becomes a real Pod in the host namespace |

There is usually no separate scheduler. With the default setup, the host cluster's scheduler places the pods.

The backing store choice matters for production. Embedded SQLite is fine for a dev cluster. For a tenant you care about, embedded etcd or an external database gives you something you can back up and restore with confidence.

## The syncer: how a pod in a virtual cluster actually runs

A virtual cluster has no nodes of its own in the default setup. So where do its pods run?

The **syncer** watches the tenant API. When the tenant creates a Pod, the syncer creates a matching Pod in the host namespace, with a rewritten name. The host scheduler places it on a host node. The syncer then copies the status back, so the tenant sees `Running`.

{{< mermaid caption="Only low-level objects cross to the host. Deployments, CRDs and RBAC stay inside the tenant API." >}}
sequenceDiagram
    participant T as Tenant kubectl
    participant V as Tenant API server
    participant S as Syncer
    participant H as Host API server
    participant N as Host node
    T->>V: create Deployment web
    V->>V: controllers create ReplicaSet and Pod
    S->>V: watch Pods
    S->>H: create Pod web-x-default-x-team-a
    H->>N: host scheduler places the Pod
    N-->>H: Pod Running
    S-->>V: copy status back
    V-->>T: web is Running
{{< /mermaid >}}

Here is the same flow as a walkthrough:

| Step | Tenant sees | Host sees |
|---|---|---|
| 1 | `kubectl create deployment web` | Nothing yet |
| 2 | Deployment, ReplicaSet and Pod in namespace `default` | Nothing yet: those live in the tenant datastore |
| 3 | Pod `Pending` | A Pod with a name like `web-...-x-default-x-team-a` in namespace `team-a` |
| 4 | Pod `Running` on a node | The same Pod `Running` on a real host node |

{{< mermaid caption="What stays inside the tenant API, and what the syncer copies down to the host namespace." >}}
flowchart TD
    subgraph STAY["Tenant only"]
        direction LR
        A1["Deployments<br/>StatefulSets"]
        A2["CRDs and<br/>custom resources"]
        A3["RBAC<br/>ClusterRoles"]
        A4["Namespaces"]
        A1 ~~~ A2
        A2 ~~~ A3
        A3 ~~~ A4
    end
    subgraph SYNC["Synced to host"]
        direction LR
        B1["Pods"]
        B2["Services<br/>Endpoints"]
        B3["ConfigMaps<br/>Secrets in use"]
        B4["PVCs"]
        B1 ~~~ B2
        B2 ~~~ B3
        B3 ~~~ B4
    end
    STAY ~~~ SYNC
    classDef cp fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class A1,A2,A3,A4 cp;
    class B1,B2,B3,B4 gpu;
{{< /mermaid >}}

The tenant's Deployment never exists on the host. Only the Pod (plus the Services, ConfigMaps and Secrets it needs) is copied down. That is why tenants can run their own CRDs and controllers without the host knowing about them.

## Three ways to give a tenant compute

The control plane is always the tenant's own. What changes is where the tenant's pods run. vCluster has three node models.

{{< mermaid caption="Top to bottom: more isolation, less sharing. The control plane is dedicated in all three." >}}
flowchart TD
    subgraph SH["Shared nodes"]
        direction LR
        S1["Tenant pods"] s1@--> S2["Synced to host"]
        S2 s2@--> S3["Any host node"]
    end
    subgraph DE["Dedicated nodes"]
        direction LR
        D1["Tenant pods"] d1@--> D2["Synced to host"]
        D2 d2@--> D3["Host nodes reserved<br/>for this tenant"]
    end
    subgraph PR["Private nodes"]
        direction LR
        P1["Tenant pods"] p1@--> P3["Machines joined to<br/>the tenant API"]
    end
    SH ~~~ DE
    DE ~~~ PR
    s1@{ animate: true }
    s2@{ animate: true }
    d1@{ animate: true }
    d2@{ animate: true }
    p1@{ animate: true }
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class S1,D1,P1 input;
    class S2,D2 warn;
    class S3,D3,P3 gpu;
{{< /mermaid >}}

| Model | Where pods run | What is shared | Good for |
|---|---|---|---|
| **Shared nodes** | Any host node, next to other tenants' pods | Nodes, kernel, CNI, storage | Dev environments, CI, internal teams you trust |
| **Dedicated nodes** | Host nodes picked by a node selector for this tenant | Host CNI and storage, host control plane | Internal teams that want their own machines |
| **Private nodes** | Machines that join the tenant API directly, with their own kubelet, CNI and CSI | Nothing at the node level | External customers, GPU servers, anything untrusted |

With **private nodes** there is no syncing at all. The machine joins the tenant's control plane with a join token, the same way a worker joins a kubeadm cluster. The tenant's own scheduler places pods on it. The host cluster only runs the control plane pod.

The vCluster docs are direct about the first model: shared nodes are not a security boundary for untrusted tenants. If a container escapes, it lands on a node that other tenants also use. For that case there is **vNode**, a runtime sandbox for pods on shared nodes. For whole-machine tenants, private nodes are the cleaner answer.

## Where the control plane itself can live

There is one more option: **vCluster Standalone**. It runs the control plane straight on machines as a binary under systemd, with no host cluster underneath. It is how you bootstrap the very first cluster on bare metal, and with three control plane machines it can run in HA.

I saw this first-hand in my lab. The host cluster there was **vind** (vCluster in Docker), and `kubectl get pods -n kube-system` showed no API server pod at all. Inside the container, `ps` showed the reason:

```text
/var/lib/vcluster/bin/vcluster start --config /etc/vcluster/vcluster.yaml
/var/lib/vcluster/bin/kine --endpoint=sqlite:///var/lib/vcluster/state.db?...
/var/lib/vcluster/bin/kube-apiserver --service-cluster-ip-range=10.96.0.0/12 ...
/var/lib/vcluster/bin/kube-scheduler ...
/var/lib/vcluster/bin/kube-controller-manager ...
```

The control plane was plain processes supervised by systemd, with `kine` and SQLite as the datastore. A control plane that is just "a binary and a datastore" can run in a pod, a container, a VM or on a server.

## vCluster vs vCluster Platform

Two names come up a lot, and they are different things.

| | vCluster (open source) | vCluster Platform |
|---|---|---|
| What | The virtual cluster itself and the `vcluster` CLI | A management layer with UI and API for many virtual clusters |
| You get | `vcluster create`, `vcluster connect`, shared and dedicated nodes | Projects, templates, quotas, SSO, sleep mode, private nodes with Auto Nodes |
| Tenant object | A Helm release | A `VirtualClusterInstance` (`management.loft.sh`) |

If you want a few virtual clusters for your own teams, the CLI is enough. If you are building a product where customers order clusters, the Platform is the piece that turns "create a cluster" into an API call with quotas and node provisioning behind it.

## Try it

You need a Kubernetes cluster to act as the host (kind, minikube or Docker Desktop work) and the [vcluster CLI](https://www.vcluster.com/docs/vcluster/). Then:

```bash
# create a virtual cluster in namespace team-a and switch kubectl to it
vcluster create team-a --namespace team-a

# inside the virtual cluster: you are cluster-admin
kubectl create namespace web
kubectl create deployment nginx --image=nginx -n web
kubectl get pods -n web

# back to the host context
vcluster disconnect

# on the host: no "web" namespace, just the vCluster pod and the synced nginx pod
kubectl get pods -n team-a
```

Two things to notice in the last command. The tenant's `web` namespace does not exist on the host. The nginx pod does, with the tenant namespace and the vCluster name folded into its name.

Clean up with:

```bash
vcluster delete team-a --namespace team-a
```

## When I would use it

| Situation | My pick |
|---|---|
| Ten internal teams, trusted, want CRDs and admin rights | vCluster on shared nodes |
| Ephemeral cluster per pull request or CI run | vCluster on shared nodes, deleted after the run |
| Teams that need their own machines but share a network | Dedicated nodes |
| External customers, GPU servers, compliance | Private nodes, ideally with Auto Nodes |
| One cluster, one team | Nothing: plain namespaces are fine |

{{< mermaid caption="The decision I walk through for a new tenant." >}}
flowchart TD
    Q1["Does the tenant need<br/>its own API, CRDs, admin?"] -->|No| R1["Namespace"]
    Q1 -->|Yes| Q2["Is the tenant trusted?<br/>internal team, CI"]
    Q2 -->|Yes| R2["vCluster<br/>shared nodes"]
    Q2 -->|Mostly| Q3["Needs its own<br/>machines?"]
    Q3 -->|No| R3["Shared nodes<br/>plus vNode"]
    Q3 -->|Yes| R4["Dedicated nodes"]
    Q2 -->|No, external| R5["Private nodes<br/>with Auto Nodes"]
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    class Q1,Q2,Q3 input;
    class R2,R3,R4,R5 gpu;
    class R1 idle;
{{< /mermaid >}}

The question I ask is: **does the tenant need to own the Kubernetes API, or just a corner of it?** If they need to own it, vCluster gives them that without giving each of them a separate fleet of servers to run.

## Cheat sheet

```text
Virtual / tenant cluster = a full Kubernetes control plane that runs as a pod in a host namespace
Host cluster             = the ordinary cluster that runs the tenant control plane pods
Control Plane Cluster    = the production name for the host cluster
Backing store            = where tenant objects live: SQLite, etcd, or an external database
Syncer                   = copies tenant pods (and what they need) to the host so they can run
Shared nodes             = tenant pods run on host nodes next to other tenants
Dedicated nodes          = tenant pods still synced, but pinned to host nodes reserved for them
Private nodes            = machines join the tenant API directly; nothing is synced to the host
vNode                    = a runtime sandbox for tenant pods on shared nodes
vCluster Standalone      = the control plane as a binary on machines, with no host cluster
vind                     = vCluster in Docker: a whole cluster in one container
vCluster Platform        = UI and API to manage many tenants, with Auto Nodes and quotas
```

Next: [private nodes, Auto Nodes and bare metal](/posts/vcluster-private-nodes-auto-nodes-bare-metal/). Related: [Karmada, for placing workloads across clusters](/posts/karmada-kubernetes-multi-cluster/).
