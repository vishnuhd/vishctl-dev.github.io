+++
title = "Kubernetes v1.37: An Operator's Look at Garhwal"
date = '2026-09-02T20:30:00+08:00'
draft = false
description = "My notes on Kubernetes v1.37: native HPA scale-to-zero, tracking unused PVCs, ClusterTrustBundles, and etcd streaming."
tags = ["kubernetes", "devops", "cloudnative", "infrastructure"]
ShowToc = true
TocOpen = true
+++

Kubernetes v1.37 landed recently under the release theme **Garhwal**, named after the Himalayan region of Uttarakhand, India. The release packages 67 enhancements across alpha, beta, and stable.

The upstream changelog is massive, but as someone who spends most of the day managing control planes, dealing with storage, and watching cloud bills, only a handful of changes stand out as immediately relevant to day-to-day work.

Here are the features I am keeping an eye on, along with practical examples for how they work.

### 1. HPA Can Finally Scale to Zero (`minReplicas: 0`)

For years, one of the most frustrating limitations in vanilla Kubernetes autoscaling was that `HorizontalPodAutoscaler` could not scale below one replica. If you had a queue consumer waiting on messages in SQS or RabbitMQ, or a GPU worker waiting on batch jobs, you had to keep at least one pod running around the clock, or pull in third-party tools like KEDA just to do basic scale-to-zero.

In v1.37, **HPA scale to zero** graduated to Beta and is enabled by default. You can now configure `minReplicas: 0`:

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
          name: aws_sqs_approximate_number_of_messages_visible
        target:
          type: Value
          averageValue: 30
```

When the queue is empty, the controller scales the deployment down to 0 pods:

```bash
kubectl get hpa queue-worker-hpa
# NAME               REFERENCE                 TARGETS        MINPODS   MAXPODS   REPLICAS   AGE
# queue-worker-hpa   Deployment/queue-worker   0/30 (avg)     0         10        0          18m
```

Under the hood, the HPA controller adds a `ScaledToZero` condition so you can easily distinguish an automated scale-down from a manual shutdown:

```yaml
status:
  currentReplicas: 0
  desiredReplicas: 0
  conditions:
    - type: ScaledToZero
      status: "True"
      reason: ScaledToZero
      message: "all pods scaled down based on metrics"
```

**The catch:** This only works with object or external metrics. It does not work with CPU or memory metrics, because a deployment with zero running pods produces no CPU or memory data to trigger an upscale. For event-driven workers and GPU workloads, this saves real money on cloud bills.

### 2. Finding Orphaned PVCs Just Got Much Easier

PersistentVolumeClaims have a habit of outliving the workloads that created them. Someone deletes a Deployment or StatefulSet, but the PVC stays behind in the namespace. Weeks or months later, dozens of unused EBS volumes or cloud disks are quietly burning infrastructure budget.

Until now, Kubernetes gave you no native way to know when a PVC was last used without writing custom scripts to inspect every pod spec in the cluster.

Kubernetes v1.37 addresses this by graduating **PVC last-used tracking** to Beta (enabled by default). The PVC protection controller now adds an `Unused` condition to `status.conditions` on PersistentVolumeClaims:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: abandoned-redis-data
  namespace: analytics
status:
  phase: Bound
  conditions:
    - type: Unused
      status: "True"
      reason: NoPodsUsingPVC
      lastTransitionTime: "2026-08-15T09:30:00Z"
```

* When the last pod referencing a PVC terminates, `Status` flips to `"True"` with reason `NoPodsUsingPVC`.
* The `lastTransitionTime` tells you the exact timestamp since the volume became idle.
* As soon as a new pod attaches, the condition flips back to `False`.

Kubernetes does not delete anything automatically (which is good; you do not want the control plane guessing whether data is safe to purge). But this gives you a clean field to query across your cluster:

```bash
# List all PVCs across all namespaces that are currently unused, with their idle timestamp
kubectl get pvc -A -o custom-columns=\
'NAMESPACE:.metadata.namespace,\
NAME:.metadata.name,\
CAPACITY:.status.capacity.storage,\
UNUSED:.status.conditions[?(@.type=="Unused")].status,\
IDLE_SINCE:.status.conditions[?(@.type=="Unused")].lastTransitionTime'
```

With one command, you can spot storage that has been abandoned for 30+ days and clean it up safely.

### 3. ClusterTrustBundles Go GA: Retire Your CA Sync Cronjobs

If you manage enterprise clusters with internal PKI, private container registries, or corporate proxies, you have almost certainly solved the root certificate problem with a workaround. Most teams either run a custom controller that clones a secret into every namespace as a `ConfigMap`, or bake internal certificates into container base images.

In v1.37, **ClusterTrustBundles** and **Pod Certificates** officially graduated to Stable (GA) under `certificates.k8s.io`.

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
    MIICjTCCAjSgAwIBAgIUTkX...
    -----END CERTIFICATE-----
```

Workloads in any namespace can project this bundle directly into their filesystem via standard projected volumes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: internal-api
spec:
  template:
    spec:
      containers:
        - name: app
          image: my-registry.internal/api:v1
          env:
            # Point common TLS libraries to the projected CA bundle
            - name: SSL_CERT_FILE
              value: /etc/ssl/certs/corporate-root-ca.crt
          volumeMounts:
            - name: trusted-certs
              mountPath: /etc/ssl/certs/corporate-root-ca.crt
              subPath: corporate-root-ca.crt
              readOnly: true
      volumes:
        - name: trusted-certs
          projected:
            sources:
              - clusterTrustBundle:
                  name: corporate-root-ca
```

The kubelet handles mounting and rotation natively. That is one less custom controller or sync cronjob to maintain.

### 4. Control Plane Breathing Room: etcd RangeStream & Concurrent Decode

When large clusters experience network hiccups or controller restarts, hundreds of controllers can hit the API server with list requests at the exact same moment. Historically, etcd built full responses in memory before sending them, and the API server processed watch events serially on a single goroutine. During recovery storms, control plane memory would spike, occasionally sending nodes into Out-Of-Memory (OOM) loops.

In v1.37, two features land on by default to fix this:

1. **etcd RangeStream (Beta):** Instead of buffering massive key-value sets in memory, etcd streams responses back in chunks. This turns what used to be a memory-heavy dump into a smooth stream.
2. **Concurrent Watch Object Decode (Beta):** The API server now decodes incoming watch events across a pool of worker goroutines rather than processing them one by one.

If you interact with etcd 3.7+ directly, you can test the new chunked streaming RPC via `etcdctl`:

```bash
# Stream keys in chunks rather than buffering everything into a single gRPC response
etcdctl get /registry/pods/ --prefix --stream
```

In upstream benchmarks across 150,000 pods, these two improvements combined cut cache initialization time by more than 50%. For operators of large clusters or CRD-heavy environments, this means significantly less control plane jitter during rolling restarts.

### 5. `kubectl get -o kyaml` Goes Stable

YAML has plenty of parsing quirks (such as unquoted country codes like `NO` being interpreted as boolean `false`).

In v1.37, **KYAML** reaches Stable. KYAML is a safer, unambiguous subset of YAML tailored specifically for Kubernetes. You do not need to change any of your existing manifests or pipelines; KYAML is strictly backwards compatible with standard YAML.

You can now run:

```bash
# Output clean, normalized YAML without parser ambiguity
kubectl get deployment queue-worker -o kyaml
```

Comparing the output against regular YAML:

```yaml
# Standard YAML output often strips quotes from country codes or booleans:
country: NO    # Parsed by some YAML 1.1 loaders as boolean false!

# KYAML output strictly normalizes and quotes scalar types:
country: "NO"
```

It formats cleanly, avoids parser edge cases, and provides predictable output for gitops diffs and scripts.

### 6. SELinuxMount Reaches GA

If your nodes run SELinux (common in Red Hat, Rocky, or Fedora environments), volume mounts historically required recursive file relabeling on every pod start, which could cause painfully slow startup times on large volumes.

In v1.37, **SELinuxMount** is now Stable and enabled by default for CSI drivers that support it. Volumes are mounted with a single mount context rather than recursively walking the directory tree.

**The catch:** A volume mount can only carry one SELinux context. If you run multiple pods with different SELinux labels that share the same volume on the same node, those pods may now fail to mount.

If your workloads rely on shared volumes with mixed labels, you can preserve the legacy recursive relabeling behavior in your Pod spec:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: shared-data-consumer
spec:
  securityContext:
    seLinuxChangePolicy: Recursive
  containers:
    - name: app
      image: alpine
      volumeMounts:
        - name: shared-storage
          mountPath: /data
  volumes:
    - name: shared-storage
      persistentVolumeClaim:
        claimName: shared-data-pvc
```

### Where This Leaves Us

Do not rush to upgrade production this weekend. If you use a managed provider (EKS, GKE, Rancher), wait for `.1` or `.2` patch releases. If you run physical data centers like me and manage the control plane yourself, be even more conservative: test locally, promote through lower environments, and comfortably stay on n-1 or n-2.

The real reason to track v1.37 today is preventing fresh technical debt. If your team was about to build custom controllers to sync CA certs or write scripts to hunt dead storage, tell them to hold off. Upstream is solving it natively.

Let the early patches bake, keep your clusters healthy, and start planning which legacy workarounds you get to delete.