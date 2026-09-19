---
title: "What Is Karmada? Kubernetes Across Clusters, Explained with YAML"
date: 2026-09-19T13:00:00+08:00
draft: false
author: "Vishnu"
description: "Karmada's CNCF graduation, its multi-cluster architecture, and practical YAML for placement, replica splitting, overrides, and failover."
tags: ["kubernetes", "karmada", "multi-cluster", "devops"]
ShowToc: true
TocOpen: false
cover:
  image: "/images/posts/karmada/00-pixel-art-cover.png"
  alt: "Pixel art orchestration hub coordinating three independent Kubernetes server islands"
  relative: false
---

You have a Kubernetes cluster in your data center and another in the cloud. Both can run your application. You want four replicas in one, two in the other, and a sensible response when a cluster becomes unavailable.

Kubernetes understands the desired state inside each cluster. Who owns the desired state across both?

That is the problem **Karmada** tackles. Its recent CNCF graduation is a good reason to look past the announcement and follow what actually happens to an application.

## First, what happened with CNCF?

CNCF lists Karmada's graduation date as **September 3, 2026**, following Sandbox acceptance on September 14, 2021 and incubation on December 12, 2023. The [CNCF project record](https://www.cncf.io/projects/karmada/) is the reference for those dates.

The [public graduation announcement](https://www.cncf.io/announcements/2026/09/07/cloud-native-computing-foundation-announces-karmada-graduation/) has a September 7 page date and a September 8 dateline for the event in Shanghai. It highlights a third-party security audit, formal governance, and production adoption, including Bloomberg, Wellhub, and Trip.com.

Graduation is a project maturity milestone. Individual features still have their own stability levels and defaults. That matters especially for failover, which we will come back to.

This walkthrough uses the **Karmada v1.19 documentation**, checked on September 19, 2026. The examples are a documented lab exercise with expected results, not a claim that I have benchmarked or operated this setup in production.

## What is Karmada?

Karmada, short for *Kubernetes Armada*, is a control plane for orchestrating workloads across Kubernetes clusters.

You submit familiar objects such as Deployments and Services, then attach policies describing where they should go. The member clusters remain independent Kubernetes clusters. Each keeps its own API server, controllers, scheduler, nodes, and networking.

The [core concepts](https://karmada.io/docs/core-concepts/concepts/) separate three questions:

| Input | Question it answers |
|---|---|
| Resource template, such as a Deployment | What application should exist? |
| `PropagationPolicy` | Which clusters should receive it, and how should replicas be allocated? |
| `OverridePolicy` | What should differ for a particular destination? |

For example, one web Deployment can go to two clusters while a policy allocates different replica counts. You keep one application definition and express the placement separately.

## What problem is it solving?

Copying YAML to a second cluster is easy. Keeping a fleet consistent while its capacity and health change is the harder part.

Imagine an internal portal running in Singapore and a secondary location. A release needs to reach both. One environment needs a different setting. During maintenance, you want another cluster to take over. Each of those decisions can become a script, a pipeline branch, or a manual runbook step.

Karmada brings placement and propagation into a reconciled API. Instead of treating every destination as an unrelated deployment, you describe the relationship between the application and the fleet.

The practical questions become explicit: which clusters are eligible, how much should each receive, what differs there, and what does the controller believe is actually running?

That is useful when fleet behavior is part of the platform's requirements. For a single cluster, it adds another control plane without solving much of a problem.

## Architecture: two levels of scheduling

**Karmada schedules resources to clusters. Kubernetes schedules Pods to nodes within each cluster.**

The Karmada API server uses the Kubernetes API server implementation. Submitted workload objects are stored centrally; the central Deployment template does not itself create application Pods in the host cluster. Those Pods appear after propagation to members. The [component documentation](https://karmada.io/docs/core-concepts/components/) describes this boundary.

{{< mermaid caption="Logical control flow. The host cluster runs Karmada; member clusters run the application. Arrows represent management operations, not user traffic." >}}
flowchart TD
    U["kubectl or GitOps"] --> API["Karmada API server"]
    subgraph HOST["Karmada control plane"]
        API <--> DB["etcd"]
        API <--> CM["Karmada controllers"]
        API <--> SCH["Karmada scheduler<br/>Select clusters and replicas"]
    end
    CM -->|Push mode shown| A["Member 1 API server"]
    CM -->|Push mode shown| B["Member 2 API server"]
    A --> KA["Local controllers and scheduler"]
    B --> KB["Local controllers and scheduler"]
    KA --> PA["Pods on member 1 nodes"]
    KB --> PB["Pods on member 2 nodes"]
    classDef central fill:#13264a,stroke:#38bdf8,color:#e6f6ff;
    classDef member fill:#281d48,stroke:#a78bfa,color:#f1edff;
    classDef pods fill:#173f59,stroke:#22d3ee,color:#ecfeff;
    class API,DB,CM,SCH central;
    class A,B,KA,KB member;
    class PA,PB pods;
{{< /mermaid >}}

The core pieces have familiar jobs: etcd persists state, the API server exposes it, controllers reconcile it, and the scheduler decides destinations. A full installation also includes admission webhooks, an aggregated API server for additional APIs and proxy access, and selected Kubernetes controllers. The diagram leaves those out to keep the workload path readable.

Do not confuse the **host cluster's API endpoint** with the **Karmada API endpoint**. Applying an application to the host's ordinary Kubernetes API can run it on the host instead of distributing it.

### Follow one Deployment through the system

The [architecture guide](https://karmada.io/docs/core-concepts/architecture/) describes a controller pipeline:

1. You create a Deployment and a matching propagation policy in the Karmada API.
2. The policy controller creates a `ResourceBinding` for the selected resource.
3. The scheduler records the chosen clusters and replica assignments in the binding.
4. The binding controller prepares destination-specific `Work` objects, incorporating applicable overrides.
5. Execution applies the manifests to member APIs. Local Kubernetes controllers create ReplicaSets and Pods.

{{< mermaid caption="Bindings record placement. Work objects carry manifests for execution. These are useful debugging checkpoints, not extra files you normally author." >}}
flowchart TD
    T["Deployment template"] --> R["ResourceBinding"]
    P["PropagationPolicy"] --> R
    S["Scheduler decisions"] --> R
    R --> W["Per-cluster Work objects"]
    O["OverridePolicy"] --> W
    W --> D["Member Deployments"]
    D --> POD["Local ReplicaSets and Pods"]
    D -.->|Reported status| STATUS["Karmada status view"]
{{< /mermaid >}}

### Push versus pull

In **push mode**, the control plane connects to member API servers and applies resources. In **pull mode**, a `karmada-agent` serving each member watches its work and applies it locally, reporting status back. Pull is useful when members can reach the central endpoint but inbound access to their APIs is restricted.

Pull mode still needs working connectivity, authentication, and certificates. Some proxy and aggregated-access features need additional connectivity beyond basic agent synchronization. The [registration guide](https://karmada.io/docs/userguide/clustermanager/cluster-registration/) explains the tradeoffs.

## A small lab: one application, two clusters

Use a disposable environment with Karmada v1.19 and two healthy members named `member1` and `member2`. For installation, follow the [installation overview](https://karmada.io/docs/installation/). The project's [local walkthrough](https://karmada.io/docs/get-started/nginx-example/) uses `hack/local-up-karmada.sh` to create a host and member clusters with kind; it also builds components, so check its prerequisites before running it.

The commands below use Bash, including WSL2. They assume the local walkthrough's kubeconfig paths and context names. If your installation differs, change the paths and contexts first. All application resources use the `default` namespace, which should already exist in the control plane and members.

```bash
export KARMADA_CONFIG="$HOME/.kube/karmada.config"
export MEMBERS_CONFIG="$HOME/.kube/members.config"

k() {
  kubectl --kubeconfig "$KARMADA_CONFIG" --context karmada-apiserver "$@"
}

m() {
  local member="$1"
  shift
  kubectl --kubeconfig "$MEMBERS_CONFIG" --context "$member" "$@"
}

k get clusters
m member1 get nodes
m member2 get nodes
```

Continue once both members report ready and have capacity for this small workload. An extra member created by the local installer is fine; our policies select only two.

### 1. Define an ordinary Deployment and Service

Save this as `app.yaml`. The resource requests make the intended Pod size explicit. The environment variable gives us a visible value to override later.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fleet-web
  namespace: default
spec:
  replicas: 6
  selector:
    matchLabels:
      app: fleet-web
  template:
    metadata:
      labels:
        app: fleet-web
    spec:
      containers:
        - name: web
          image: nginx:1.28.0
          ports:
            - containerPort: 80
          env:
            - name: CLUSTER_SITE
              value: shared
          resources:
            requests:
              cpu: 100m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 128Mi
          readinessProbe:
            httpGet:
              path: /
              port: 80
            initialDelaySeconds: 2
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: fleet-web
  namespace: default
spec:
  selector:
    app: fleet-web
  ports:
    - port: 80
      targetPort: 80
```

```bash
k apply -f app.yaml
```

This image tag is fixed for the example, not a recommendation to freeze a production service on that release. Production images need your normal update and vulnerability review process.

### 2. Propagate to both members

Save this as `placement.yaml`. `PropagationPolicy` is namespaced; the selected resources are in the same namespace. Use `ClusterPropagationPolicy` when you need a policy with cluster-wide scope.

```yaml
apiVersion: policy.karmada.io/v1alpha1
kind: PropagationPolicy
metadata:
  name: fleet-web
  namespace: default
spec:
  resourceSelectors:
    - apiVersion: apps/v1
      kind: Deployment
      name: fleet-web
    - apiVersion: v1
      kind: Service
      name: fleet-web
  placement:
    clusterAffinity:
      clusterNames:
        - member1
        - member2
    spreadConstraints:
      - spreadByField: cluster
        minGroups: 2
        maxGroups: 2
    replicaScheduling:
      replicaSchedulingType: Duplicated
```

```bash
k apply -f placement.yaml
m member1 rollout status deployment/fleet-web -n default --timeout=180s
m member2 rollout status deployment/fleet-web -n default --timeout=180s
m member1 get deployment,service -n default
m member2 get deployment,service -n default
```

**Expected: six desired replicas in each cluster, twelve across the fleet.** `Duplicated` repeats the template's count. A Service has no replica count; each selected member receives its own Service.

The [propagation policy guide](https://karmada.io/docs/userguide/scheduling/propagation-policy/) distinguishes eligibility (`clusterAffinity`) from spread constraints and replica allocation. Here the eligible set is two clusters and the spread requirement is two clusters.

### 3. Split six replicas into four and two

Replace `placement.yaml` with the following and apply it again. This updates the same policy rather than creating a second policy that competes for the resource.

```yaml
apiVersion: policy.karmada.io/v1alpha1
kind: PropagationPolicy
metadata:
  name: fleet-web
  namespace: default
spec:
  resourceSelectors:
    - apiVersion: apps/v1
      kind: Deployment
      name: fleet-web
    - apiVersion: v1
      kind: Service
      name: fleet-web
  placement:
    clusterAffinity:
      clusterNames:
        - member1
        - member2
    replicaScheduling:
      replicaSchedulingType: Divided
      replicaDivisionPreference: Weighted
      weightPreference:
        staticWeightList:
          - targetCluster:
              clusterNames:
                - member1
            weight: 2
          - targetCluster:
              clusterNames:
                - member2
            weight: 1
```

```bash
k apply -f placement.yaml
m member1 get deployment fleet-web -n default
m member2 get deployment fleet-web -n default
```

After reconciliation, the desired split is **4 + 2 = 6**. The source Deployment still says six. The policy changes what that number means across destinations.

| Policy for a six-replica template | member1 | member2 | Fleet total |
|---|---:|---:|---:|
| Duplicated across both | 6 | 6 | 12 |
| Divided with weights 2:1 | 4 | 2 | 6 |

Static weights express a chosen ratio. They do not prove that either cluster can run its allocation. Also, static-weight division does not use spread constraints, so this replacement deliberately omits the earlier spread block.

For capacity-sensitive placement, Karmada supports dynamic weighting using `AvailableReplicas`. Its [resource modeling guide](https://karmada.io/docs/userguide/scheduling/cluster-resources/) explains why free CPU summed across a cluster is not enough: a Pod needs to fit on an actual node. Optional scheduler estimators improve fit estimates. Resource requests, node constraints, and available hardware still matter.

### 4. Change one setting for member2

Save this as `override.yaml`:

```yaml
apiVersion: policy.karmada.io/v1alpha1
kind: OverridePolicy
metadata:
  name: fleet-web-site
  namespace: default
spec:
  resourceSelectors:
    - apiVersion: apps/v1
      kind: Deployment
      name: fleet-web
  overrideRules:
    - targetCluster:
        clusterNames:
          - member2
      overriders:
        plaintext:
          - path: /spec/template/spec/containers/0/env/0/value
            operator: replace
            value: secondary
```

```bash
k apply -f override.yaml
m member2 rollout status deployment/fleet-web -n default --timeout=180s

k get deployment fleet-web -n default \
  -o jsonpath='{.spec.template.spec.containers[0].env[0].value}{"\n"}'
m member2 get deployment fleet-web -n default \
  -o jsonpath='{.spec.template.spec.containers[0].env[0].value}{"\n"}'
```

Expected values: `shared` centrally and `secondary` in member2. The override changes the destination's Pod template and triggers a local rollout. NGINX does not use this variable to change its web page; it is simply an observable configuration example.

The JSON path is tied to the first container and first environment entry in this exact manifest. Update the path if you reorder them. The [override guide](https://karmada.io/docs/userguide/scheduling/override-policy/) also documents specialized image, command, label, and annotation overriders for other cases.

## How do I debug the path?

Start centrally, then inspect the destination. These commands expose the intermediate objects shown in the architecture diagram:

```bash
k get propagationpolicies -n default
k get resourcebindings -n default -o yaml
k get works -n karmada-es-member1
k get works -n karmada-es-member2
k get events -n default --sort-by=.metadata.creationTimestamp

m member1 get pods -n default -l app=fleet-web
m member1 describe deployment fleet-web -n default
m member1 get events -n default --sort-by=.metadata.creationTimestamp
```

My debugging order would be: did the policy select the resource, did the binding get destinations, did the Work reach the member, and did local Kubernetes accept and run it?

A successful placement decision cannot pull an unavailable image or repair a failing readiness probe. If the Deployment exists in the member but its Pods are pending, inspect the member's scheduling events and resource constraints.

For a direct HTTP check, run `m member1 port-forward -n default service/fleet-web 8080:80`, then open `http://localhost:8080` while that command is running. Repeat for member2 after stopping the first port-forward.

## What happens when a cluster fails?

First, **v1.19 documents the `Failover` feature gate as Beta and disabled by default**. Enable `Failover=true` in the Karmada controller manager through your installation configuration before expecting cluster eviction and rescheduling. Merge it with any existing feature-gate settings. The [cluster failover guide](https://karmada.io/docs/userguide/failover/cluster-failover/) is explicit about this.

There is a second detail: unhealthy status and eviction are different steps. The [failover process analysis](https://karmada.io/docs/userguide/failover/failover-analysis/) says unhealthy clusters receive `NoSchedule` taints, while a non-tolerated `NoExecute` taint triggers removal from placement and rescheduling. Configure cluster taint management for your desired automatic behavior; do not assume the feature gate alone defines a complete outage policy.

For the manual exercise below, also set `--enable-no-execute-taint-eviction=true` on the Karmada controller manager. If you later automate taints with a `ClusterTaintPolicy` that uses `NoExecute`, the webhook additionally needs `--allow-no-execute-taint-policy=true`. These are separate opt-ins documented in [cluster taint management](https://karmada.io/docs/userguide/failover/cluster-taint-management/).

In a disposable lab with both controller-manager settings enabled, use the divided policy from step 3 and deliberately taint member2. Install the matching `karmadactl` CLI first; its [taint command](https://karmada.io/docs/reference/karmadactl/karmadactl-commands/karmadactl_taint/) operates on Karmada clusters:

```bash
# Lab only: this can affect every Karmada workload using member2.
karmadactl taint clusters member2 lab-drain=true:NoExecute \
  --kubeconfig "$KARMADA_CONFIG" --karmada-context karmada-apiserver

k get resourcebindings -n default -o yaml
m member1 get deployment fleet-web -n default --watch
```

With sufficient capacity and successful reconciliation, the intended replacement is six replicas on member1. This is a controlled eviction exercise, not a simulation of every network partition failure mode.

Remove the lab taint afterward:

```bash
karmadactl taint clusters member2 lab-drain:NoExecute- \
  --kubeconfig "$KARMADA_CONFIG" --karmada-context karmada-apiserver
```

Removing the taint restores eligibility. Do not assume it immediately restores the original 4:2 distribution; verify placement and use an intentional rebalance workflow if needed.

### Failover has application-level consequences

Restoring replicas is only one part of recovery. Users also need traffic to reach those replicas, and the application needs usable data.

In a network partition, an unreachable cluster may still be serving requests. Creating replacements does not prove the old instances have stopped. For a writer or queue consumer, think about fencing, leases, idempotency, and duplicate processing before enabling automatic movement.

Karmada supports state-preservation mechanisms for particular recovery workflows, but moving a StatefulSet definition cannot copy the bytes on its disks. Database replication, accessible checkpoints, storage compatibility, and recovery testing need their own design.

## What about networking, Services, and storage?

Our two Services are cluster-local. Copying a Service manifest does not create one global virtual IP, connect Pod networks, or route public traffic between regions.

Karmada documents [Submariner integration](https://karmada.io/docs/userguide/network/working-with-submariner/) for cross-cluster connectivity. Whether you need that connectivity, a service mesh, or independent ingress endpoints depends on the application.

For this web example, I would design the user path separately:

{{< mermaid caption="A possible traffic architecture. The global routing layer and health checks must be configured separately from workload placement." >}}
flowchart TD
    USER["Users"] --> ROUTE["Global DNS or load balancer<br/>Endpoint health checks"]
    ROUTE --> I1["Member 1 ingress or gateway"]
    ROUTE --> I2["Member 2 ingress or gateway"]
    I1 --> S1["Local Service and ready Pods"]
    I2 --> S2["Local Service and ready Pods"]
{{< /mermaid >}}

A 4:2 replica allocation does not automatically produce a 2:1 traffic split. The routing layer has its own policy and observations.

Dependencies deserve the same attention. Karmada can [propagate referenced ConfigMaps and Secrets](https://karmada.io/docs/userguide/scheduling/propagate-dependencies/) with `propagateDeps`, but that does not provision external databases or grant cloud IAM permissions. Our lab selects the Service explicitly because a Deployment does not reference its Service as a dependency.

For real applications, check namespace creation, registry access, storage classes, secrets, CRDs, and required operators in every eligible destination. Propagating a custom resource to a cluster without its operator will not make the application work.

## Where does GitOps fit?

The [Argo CD integration](https://karmada.io/docs/userguide/cicd/working-with-argocd/) treats the Karmada API as a deployment destination. Git can hold the application templates and Karmada policies; Argo CD reconciles them centrally, and Karmada handles member placement.

I would make ownership explicit: one reconciler owns the central application definition, and Karmada owns the propagated copies. Configuring another GitOps application to overwrite those same member objects invites conflicting changes, particularly around replica counts and overrides.

If all you need is a fixed application copy in a fixed set of clusters, existing GitOps workflows may already satisfy the requirement. Karmada becomes more compelling when placement and allocation need to respond to fleet conditions.

## What I would check before production

The additional control plane is now part of your recovery story. Give its API and etcd a high-availability and backup plan, protect member credentials, and test what happens when the management plane is unavailable. Independent member control planes can continue local reconciliation, but central changes and cross-cluster decisions depend on Karmada recovering.

I would start with a stateless service and measure the full failure sequence: detection, eviction decision, replacement readiness, and restored user traffic. Test a control-plane outage separately from a member outage. Then test a network partition where the old application is still alive.

Capacity is another operational choice. A fallback cluster that is already full is not a useful recovery destination. Similarly, a GPU cluster label does not guarantee the correct accelerator, driver, model files, or per-node GPU count for an inference Pod. This sits one layer above the prerequisites in my [vLLM on Kubernetes walkthrough](/posts/vllm-on-wsl2-minikube/).

The question I would use to decide whether Karmada belongs in a platform is: **do we need a controller to continuously manage where this application lives across clusters?** If the answer is yes, its templates, bindings, and placement policies give that decision a concrete API and an inspectable execution path.

### Clean up the lab application

After removing the lab taint, delete the central application and override, then the propagation policy. Keep Karmada running so it can reconcile the deletions into members.

```bash
k delete -f app.yaml -f override.yaml
k delete -f placement.yaml
m member1 get deployment,service -n default
m member2 get deployment,service -n default
```

Confirm `fleet-web` disappears from both members before tearing down the lab control plane.
