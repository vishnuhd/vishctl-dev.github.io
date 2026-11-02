---
title: "vCluster Private Nodes and Auto Nodes: How a Tenant Gets Its Own Servers"
date: 2026-11-01T11:00:00+08:00
draft: false
author: "Vishnu"
description: "How vCluster Platform turns one tenant request into real machines: node providers, node types, NodeClaims, and the Metal3 and Ironic flow that writes an OS to a bare-metal server and joins it."
series: ["vCluster"]
tags: ["kubernetes", "vcluster", "bare-metal", "metal3", "multi-tenancy", "gpu"]
cover:
  image: "/images/posts/vcluster-auto-nodes/00-pixel-art-cover.png"
  alt: "Pixel art of a control tower sending a request beam to a row of dark servers, one of them powering on and lighting up cyan"
  relative: false
ShowToc: true
TocOpen: false
---

```text
Private nodes = the tenant owns real machines, joined straight to its own API
Auto Nodes    = the Platform orders, installs and joins those machines for you
```

The [first post](/posts/what-is-vcluster-virtual-kubernetes-clusters/) ended on private nodes: machines that join a tenant's own control plane, with nothing shared at the node level.

That raises the practical question. Who finds the machine, installs it, and joins it?

This post follows one request from "tenant wants a GPU server" to "node is Ready". The [lab post](/posts/vcluster-bare-metal-gpu-tenant-metal3/) shows the same flow running, with real output.

## Private nodes, in one picture

With private nodes, the tenant's control plane still runs as a pod in the host cluster (the Control Plane Cluster). The workers are separate machines. Each one runs its own kubelet, its own CNI and its own CSI, and talks only to its tenant's API.

{{< mermaid caption="The host cluster only runs control planes. Each server belongs to one tenant, or waits in the free pool." >}}
flowchart TD
    PL["vCluster Platform<br/>on the Control Plane Cluster"] p1@--> CA["Tenant A<br/>control plane pod"]
    PL p2@--> CB["Tenant B<br/>control plane pod"]
    CA e1@--> M1["Server 1<br/>private node of A"]
    CA e2@--> M2["Server 2<br/>private node of A"]
    CB e3@--> M3["Server 3<br/>private node of B"]
    PL -.-> M4["Server 4<br/>free pool"]
    p1@{ animate: true }
    p2@{ animate: true }
    e1@{ animate: true }
    e2@{ animate: true }
    e3@{ animate: true }
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef router fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    class PL input;
    class CA,CB router;
    class M1,M2,M3 gpu;
    class M4 idle;
{{< /mermaid >}}

You can join a private node by hand. You create a join token in the tenant, run the join script on the machine, and it appears in `kubectl get nodes`. That works for a lab. It does not work for a product where customers order clusters at 2 a.m.

## Auto Nodes: a node is a request

**Auto Nodes** makes node creation automatic. It is built on Karpenter's ideas: a **pool** says what nodes a tenant needs, and each missing node becomes a **NodeClaim**, which is one request for one machine. A **node provider** fills the claim.

| Pool type | How claims are created | Example |
|---|---|---|
| Static | A fixed `quantity` per pool | "This tenant always has 1 GPU server and 1 CPU server" |
| Dynamic | When pods are unschedulable, within limits | "Add GPU servers when training jobs are Pending, up to 4" |

Here is a static pool on a tenant. It is the `privateNodes` part of the tenant's vCluster config:

```yaml
privateNodes:
  enabled: true
  autoNodes:
    - provider: metal3
      static:
        - name: gpu
          quantity: 1
          nodeTypeSelector:
            - property: vcluster.com/node-type
              value: gpu-server
          nodeLabels:
            workload: gpu
        - name: cpu
          quantity: 1
          nodeTypeSelector:
            - property: vcluster.com/node-type
              value: cpu-server
          nodeLabels:
            workload: cpu
      properties:
        vcluster.com/os-image: ubuntu2404-20260926
```

To add a node, change `quantity` and apply. The Platform creates one more claim.

## The objects the Platform needs to know about

Before a claim can be filled, the Platform has to be taught where machines come from and what can be ordered. These are cluster objects in the `management.loft.sh` API group.

| Object | Question it answers | Example |
|---|---|---|
| **NodeProvider** | Where do machines come from? | `metal3` for bare metal, an OpenTofu template for VMs, KubeVirt |
| **NodeType** | What can be ordered, and how many exist? | `gpu-server` selects hosts labelled `role=gpu` |
| **NodeEnvironment** | Which network and settings do nodes get? | IP range, gateway and DNS of the server network |
| **OSImage** | What gets written to disk? | Ubuntu 24.04 cloud image |
| **NodeClaim** | One request for one node | `one-vc4vs  Pending  metal3` |
| **VirtualClusterInstance** | One tenant | `one` in project namespace `p-default` |

A good way to remember it: the provider is the shop, the node type is the item on the menu, and the claim is the order.

{{< mermaid caption="From a pool in the tenant config to a node that joined. Each arrow is a controller doing its part." >}}
flowchart TD
    VCI["VirtualClusterInstance<br/>pool gpu, quantity 1"] e1@--> NC["NodeClaim<br/>Pending"]
    NC e2@--> NT["NodeType gpu-server<br/>pick a free matching host"]
    NT e3@--> PRV["NodeProvider metal3<br/>install the machine"]
    PRV e4@--> J["Machine boots<br/>runs join script"]
    J e5@--> N["Node Ready<br/>in the tenant"]
    e1@{ animate: true }
    e2@{ animate: true }
    e3@{ animate: true }
    e4@{ animate: true }
    e5@{ animate: true }
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef router fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class VCI input;
    class NC,NT router;
    class PRV,J warn;
    class N gpu;
{{< /mermaid >}}

## Bare metal: Metal3 and Ironic do the heavy lifting

For VMs, a provider can just call an API: "clone this template". Bare metal is harder. Nobody can SSH into a server that has no OS yet.

vCluster's bare-metal story (the docs call it **vMetal**) uses two well-known open source projects:

- **Metal3** brings bare metal into Kubernetes. Each server is a **BareMetalHost** object with its BMC address, credentials and boot MAC.
- **Ironic** does the physical work. It talks to the server's BMC (the out-of-band management controller) over Redfish or IPMI, powers it on, and boots it over the network.

A BareMetalHost moves through a small set of states:

| State | Meaning |
|---|---|
| `registering` / `inspecting` | Ironic boots the server once to read its CPUs, RAM, disks and NICs |
| `available` | Inspected and free. This is the pool |
| `provisioning` | The OS image is being written to disk |
| `provisioned` | Running the new OS, handed to a tenant |
| `deprovisioning` | Released by a tenant, being cleaned before it goes back to `available` |

{{< mermaid caption="The BareMetalHost life cycle. The loop at the bottom is what lets one server serve many tenants." >}}
flowchart TD
    R["registering"] s1@--> I["inspecting<br/>read CPUs, RAM, disks"]
    I s2@--> A["available<br/>the free pool"]
    A s3@--> P["provisioning<br/>write the OS image"]
    P s4@--> D["provisioned<br/>node in a tenant"]
    D s5@--> X["deprovisioning<br/>power off, clean disks"]
    X s6@--> A
    s1@{ animate: true }
    s2@{ animate: true }
    s3@{ animate: true }
    s4@{ animate: true }
    s5@{ animate: true }
    s6@{ animate: true }
    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class R,I idle;
    class A input;
    class P,X warn;
    class D gpu;
{{< /mermaid >}}

### One claim, step by step

{{< mermaid caption="The whole bare-metal path. Only the BMC conversation is out-of-band; everything else happens on the provisioning network." >}}
sequenceDiagram
    participant P as Platform
    participant M as Metal3
    participant I as Ironic
    participant B as Server BMC
    participant S as Server
    participant T as Tenant API
    P->>M: claim needs a gpu-server
    M->>M: pick an available BareMetalHost
    M->>I: provision host with OS image
    I->>B: Redfish: set PXE boot, power on
    S->>I: PXE boot, DHCP, load agent ramdisk
    I->>S: agent writes the OS image to disk
    I->>B: Redfish: boot from disk, power cycle
    S->>S: first boot, cloud-init runs join script
    S->>T: kubelet joins with a token
    T-->>P: node Ready, claim Available
{{< /mermaid >}}

| Step | What happens | Where the time goes |
|---|---|---|
| 1 | The Platform creates a NodeClaim and Metal3 picks a free host that matches the node type | Seconds |
| 2 | Ironic tells the BMC to boot from the network and power on | Server POST: seconds in a VM, minutes on a real GPU server |
| 3 | The server PXE boots the Ironic Python Agent ramdisk | Seconds |
| 4 | The agent downloads the OS image and writes it to disk | The longest part |
| 5 | The server reboots into the new OS; cloud-init runs the vCluster join script | A minute or so |
| 6 | The kubelet registers with the tenant API and the node goes Ready | Seconds |

In my lab, with VMs pretending to be servers, a full provision took about 4 minutes, and almost all of it was step 4.

### What the network has to allow

Bare metal brings networking requirements that cloud users never see:

- **BMC network.** Ironic must reach every server's BMC (Redfish over HTTPS).
- **Provisioning network.** PXE uses DHCP, which is a broadcast. The DHCP and boot server must sit on the servers' network, or you need a DHCP relay.
- **A path to the tenant API.** A private node joins its tenant's API server. That API lives in a pod on the Control Plane Cluster, so it needs an address the servers can reach. In my lab, kube-vip gave each tenant API a floating IP on the server network. In production you would use a load balancer VIP or MetalLB.

{{< mermaid caption="Three networks, three jobs. The tenant API VIP is the piece people forget." >}}
flowchart TD
    IR["Ironic"] e1@-->|"BMC network: Redfish"| BMC["Server BMC"]
    BMC e2@-->|"power on, boot from network"| NIC["Server NIC"]
    DH["DHCP and PXE server"] e3@-->|"provisioning network"| NIC
    NIC e4@-->|"kubelet joins the VIP"| TA["Tenant API pod<br/>with a floating IP"]
    e1@{ animate: true }
    e2@{ animate: true }
    e3@{ animate: true }
    e4@{ animate: true }
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef cp fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class IR,DH warn;
    class TA cp;
    class BMC,NIC gpu;
{{< /mermaid >}}

## Giving a server back

When a pool shrinks or a tenant is deleted, its claims are released. Metal3 deprovisions the host: powers it off, optionally cleans the disks, and returns it to `available`. The next claim can take it, for any tenant.

That is how one server pool serves many tenants over time. The GPU that tenant A stopped using on Monday can be tenant B's on Tuesday.

{{< mermaid caption="Moving a server from tenant A to tenant B. The server is re-imaged, not live-migrated: running jobs do not move." >}}
flowchart TD
    subgraph OUT["Tenant A shrinks"]
        direction LR
        A1["Pool quantity<br/>1 to 0"] a1@--> A2["Claim released"]
        A2 a2@--> A3["Server<br/>deprovisioned"]
    end
    subgraph IN["Tenant B grows"]
        direction LR
        B1["New claim<br/>Pending"] b1@--> B2["Same server<br/>re-imaged"]
        B2 b2@--> B3["Node Ready<br/>in tenant B"]
    end
    OUT ~~~ IN
    a1@{ animate: true }
    a2@{ animate: true }
    b1@{ animate: true }
    b2@{ animate: true }
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class A1,B1 input;
    class A2,A3,B2 warn;
    class B3 gpu;
{{< /mermaid >}}

Two things I would always add for real tenants:

1. **Cleaning that is tested, not assumed.** Ironic supports metadata cleaning and full disk erase. Local NVMe needs a secure erase. GPU memory is cleared by a reset. Test that a new tenant cannot read anything the previous one left.
2. **A health check before handover.** For GPU servers that means something like `dcgmi diag` and an NCCL test, so a broken server goes to a repair pool instead of to a customer.

## Why whole servers for GPUs

For big GPU servers, private nodes match how the hardware is built.

Inside an 8-GPU HGX server, all GPUs talk to each other over NVLink through NVSwitch. That is a private, very fast domain. If the whole server belongs to one tenant, that domain is isolated without any extra work.

| Tenant needs | Unit to hand out | How |
|---|---|---|
| Training on full servers | Whole server | Private node, one server per claim |
| Part of one GPU | A slice of a GPU | MIG on A100/H100, inside one tenant's server |
| Many servers for one job | A group of servers on the same fabric | Pools per rack or rail group, plus a gang scheduler |

The rule of thumb: **the unit you hand out follows the fastest link**.

{{< mermaid caption="NVLink stays inside the server, so the server is the natural tenant boundary. The fabric between servers needs its own partitioning." >}}
flowchart TD
    subgraph S1["Server 1: tenant A"]
        direction LR
        G1["GPU 0 to 3"] n1@-->|"NVLink"| G2["GPU 4 to 7"]
    end
    subgraph S2["Server 2: tenant B"]
        direction LR
        G3["GPU 0 to 3"] n2@-->|"NVLink"| G4["GPU 4 to 7"]
    end
    S1 ~~~ S2
    S2 ~~~ F["Fabric between servers<br/>InfiniBand or RoCE<br/>partitioned per tenant"]
    n1@{ animate: true }
    n2@{ animate: true }
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef cp fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class G1,G2 gpu;
    class G3,G4 cp;
    class F warn;
{{< /mermaid >}}

With private nodes, the NVIDIA GPU Operator runs inside each tenant cluster, not on the host. One tenant changing its MIG layout or upgrading its operator cannot affect another tenant.

What vCluster does not do: configure your switches. Per-tenant VLANs, InfiniBand partitions or RoCE settings come from the network side. vCluster integrates with Netris for Ethernet fabrics; InfiniBand is usually managed by NVIDIA UFM.

## What still runs in one place

Private nodes remove sharing at the node level. Some things are still shared, and that is fine as long as you plan for them:

| Shared piece | Risk | What to do |
|---|---|---|
| Control Plane Cluster | If it is down, tenant APIs are down. Running pods keep running, but nothing heals or scales | Run it HA (three machines across racks) and test restores |
| Platform admin access | Admins can reach every tenant | Tight RBAC, SSO and audit logs |
| Physical network | A flat network leaks between tenants | Per-tenant VLANs or partitions |

## Cheat sheet

```text
Private nodes        = machines that join a tenant's own API; own kubelet, CNI and CSI
Auto Nodes           = Platform feature that orders, installs and joins private nodes
Pool                 = what nodes a tenant needs; static (fixed count) or dynamic (on demand)
NodeClaim            = one request for one node: Pending, then Available
NodeProvider         = where machines come from: metal3, OpenTofu templates, KubeVirt
NodeType             = what can be ordered; selects hosts by label, knows how many exist
NodeEnvironment      = the network settings nodes get from a provider
OSImage              = the disk image written to a bare-metal server
vMetal               = vCluster's bare-metal provisioning, built on Metal3 and Ironic
BareMetalHost        = Metal3's record of one server: BMC, credentials, boot MAC, state
Ironic               = powers servers via the BMC, PXE boots them, writes the image
Ironic Python Agent  = the ramdisk that writes the OS image to the server's disk
Deprovisioning       = a released server is cleaned and goes back to available
```

Previous: [what vCluster is](/posts/what-is-vcluster-virtual-kubernetes-clusters/). Next: [the lab, with real output](/posts/vcluster-bare-metal-gpu-tenant-metal3/).
