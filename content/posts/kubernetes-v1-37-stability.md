+++
title = "Kubernetes v1.37: What Actually Matters for Everyday Clusters"
date = '2026-09-02T20:30:00+08:00'
draft = false
description = "A practical, no-hype breakdown of Kubernetes v1.37 (Garhwal): HPA scale to zero, tracking orphaned PVCs, native CA bundles, and etcd memory wins."
tags = ["kubernetes", "devops", "cloudnative", "infrastructure"]
ShowToc = true
TocOpen = true
+++

The Kubernetes project officially released version 1.37 under the release theme **Garhwal**, named after the mountainous Himalayan region of Uttarakhand, India. The release packages 67 enhancements across alpha, beta, and stable.

Whenever a new Kubernetes release lands, release notes tend to read like an academic catalog of SIG discussions, KEP numbers, and internal API interfaces. But if your day job involves keeping production clusters alive, paying the cloud bill, and deploying applications, you probably only care about a handful of things:

* What saves us money?
* What removes annoying scripts we currently maintain?
* What makes our control planes less fragile?

Here is a practical, grounded look at the highlights in v1.37 that genuinely matter for day-to-day operations.

### 1. HPA Can Finally Scale to Zero (`minReplicas: 0`)

For years, one of the most frustrating limitations in vanilla Kubernetes autoscaling was that `HorizontalPodAutoscaler` could not scale below one replica. If you had a queue consumer waiting on messages in SQS or RabbitMQ, or an expensive GPU inference worker waiting on batch jobs, you had to keep at least one pod running around the clock, or install third-party add-ons like KEDA just to do basic scale-to-zero.

In v1.37, **HPA scale to zero** graduates to Beta and is enabled by default. You can now set:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: queue-worker-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: queue-worker
  minReplicas: 0
  maxReplicas: 10
  metrics:
    - type: External
      external:
        metric:
          name: queue_depth
        target:
          type: Value
          averageValue: 30
```

When there is no work in the queue, the controller scales the deployment down to 0 pods. When new metrics arrive, it restores the pods.

**The catch:** This only works with object or external metrics. It does not work with CPU or memory metrics, because a deployment with zero running pods produces zero CPU or memory data to trigger an upscale. For event-driven workers and GPU workloads, this is an immediate cloud cost win.

### 2. Finding Orphaned PVCs Just Got Much Easier

PersistentVolumeClaims have an annoying habit of outliving the workloads that created them. An engineer deletes a Deployment or StatefulSet, but the PVC sticks around in the namespace. Weeks or months later, dozens of unused EBS volumes or cloud disks are quietly burning your infrastructure budget.

Until now, Kubernetes gave you no native way to know when a PVC was last used without writing custom scripts that inspect every pod spec across every namespace.

Kubernetes v1.37 addresses this by graduating **PVC last-used tracking** to Beta (enabled by default). The PVC protection controller now adds an `Unused` condition to `status.conditions` on PersistentVolumeClaims:

* When the last pod referencing a PVC terminates, the status sets `Status: "True"` with reason `NoPodsUsingPVC`.
* The condition's `lastTransitionTime` tells you the exact timestamp since the volume became idle.
* If a pod binds to the volume again, the condition flips back to `False`.

Kubernetes does not delete anything automatically (which is good; you do not want Kubernetes guessing whether data is safe to purge). But this gives platform teams a clean, native timestamp to build cleanup policies and reporting dashboards.

### 3. ClusterTrustBundles Go GA: Retire Your CA Sync Cronjobs

If you manage enterprise clusters with internal PKI, private container registries, or corporate proxies, you have almost certainly solved the root certificate problem with a hack. Most teams either run a custom controller that clones a secret into every namespace as a `ConfigMap`, or bake internal certificates into Docker base images.

In v1.37, **ClusterTrustBundles** and **Pod Certificates** have officially graduated to Stable (GA) under `certificates.k8s.io`.

A `ClusterTrustBundle` is a cluster-scoped object that holds trusted X.509 certificate anchors:

```yaml
apiVersion: certificates.k8s.io/v1alpha1
kind: ClusterTrustBundle
metadata:
  name: corporate-root-ca
spec:
  signerName: "corp.internal/pki"
  trustBundle: |
    -----BEGIN CERTIFICATE-----
    MIICjTCCAjSgAwIBAgIU...
    -----END CERTIFICATE-----
```

Pods can project this bundle directly into their filesystem via standard projected volumes:

```yaml
spec:
  containers:
    - name: app
      volumeMounts:
        - name: trusted-certs
          mountPath: /etc/ssl/certs/corporate-root-ca.crt
          subPath: corporate-root-ca.crt
  volumes:
    - name: trusted-certs
      projected:
        sources:
          - clusterTrustBundle:
              name: corporate-root-ca
```

The kubelet handles mounting and rotation natively. That is one less custom controller or cronjob your team needs to support.

### 4. Control Plane Breathing Room: etcd RangeStream & Concurrent Decode

When large clusters experience network hiccups or controller restarts, thousands of controllers can hammer the API server with list requests at the exact same moment. Historically, etcd built full responses in memory before sending them, and the API server processed watch events serially on a single goroutine. During recovery storms, control plane memory would spike, occasionally sending nodes into Out-Of-Memory (OOM) loops.

In v1.37, two features land on by default to fix this:

1. **etcd RangeStream (Beta):** Instead of buffering massive key-value sets in memory, etcd streams responses back in chunks. This turns what used to be a memory-heavy dump into a smooth stream.
2. **Concurrent Watch Object Decode (Beta):** The API server now decodes incoming watch events across a pool of worker goroutines rather than processing them one by one.

In project benchmarks across 150,000 pods, these two improvements combined cut cache initialization time by more than 50%. For operators of large clusters or CRD-heavy environments, this means significantly less control plane jitter during rolling restarts.

### 5. `kubectl get -o kyaml` Goes Stable

YAML has a notorious history of parsing ambiguities (such as unquoted country codes like `NO` being interpreted as boolean `false`).

In v1.37, **KYAML** reaches Stable. KYAML is a safer, unambiguous subset of YAML tailored specifically for Kubernetes. You do not need to change any of your existing manifests or pipelines; KYAML is strictly backwards compatible with standard YAML.

You can now use:

```bash
kubectl get deployment my-app -o kyaml
```

It formats cleanly, avoids parser edge cases, and provides predictable output for gitops workflows and diff scripts.

### 6. One Gotcha to Know: SELinuxMount Reaches GA

If your nodes run SELinux (common in Red Hat, Rocky, or Fedora environments), volume mounts historically required recursive file relabeling on every pod start, which could cause painfully slow startup times on large volumes.

In v1.37, **SELinuxMount** is now Stable and enabled by default for CSI drivers that support it. Volumes are mounted with a single mount context rather than recursively walking the directory tree.

**The potential edge case:** A volume mount can only carry one SELinux context. If you run multiple pods with different SELinux labels that share the same volume on the same node, those pods may now fail to mount. If your workloads rely on that specific setup, you can set `spec.seLinuxChangePolicy: Recursive` in your Pod spec to keep the previous behavior.

### The Bottom Line

Do not rush to upgrade production this weekend. If you use a managed provider (EKS, GKE, Rancher), wait for `.1` or `.2` patch releases. If you run physical data centers like me and manage the control plane yourself, be even more conservative: test locally, promote through lower environments, and comfortably stay on n-1 or n-2.

The real reason to track v1.37 today is preventing fresh technical debt. If your team was about to build custom controllers to sync CA certs or write scripts to hunt dead storage, tell them to hold off. Upstream is solving it natively.

Let the early patches bake, keep your clusters healthy, and start planning which legacy workarounds you get to delete.