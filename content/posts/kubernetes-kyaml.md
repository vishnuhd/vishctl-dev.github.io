+++
title = "Kubernetes is Adding a K to YAML: Why KYAML Makes Sense"
date = '2026-09-06T03:00:00+08:00'
draft = false
description = "Kubernetes 1.37 makes KYAML stable: how flow style eliminates silent type coercion, removes load-bearing indentation, and how to try it."
tags = ["kubernetes", "yaml", "devops"]
ShowToc = true
TocOpen = false
+++

Kubernetes 1.37 ("Garhwal") just made KYAML Stable. YAML with a K bolted on, and it's a genuinely useful feature.

## The problem

YAML has two well known landmines.

**Type coercion.**

```yaml
country: NO      # becomes boolean false
enabled: yes     # becomes boolean true
version: 3.10    # becomes float 3.1
```

Those values were meant to be strings. YAML quietly turned them into something else.

**Whitespace as structure.** Indentation defines meaning in normal YAML. Get one space wrong and the file still parses. It just means something else now, silently.

```yaml
spec:
  containers:
  - name: app
    image: nginx
    ports:
    - containerPort: 80
      protocol: TCP   # one space off, this attaches to the wrong container
```

No error. No warning. Just wrong.

Helm makes this worse, since you're injecting indentation from outside the YAML context and hoping it lines up.

## What KYAML actually changes

Nothing about the language. It's YAML's existing "flow style," just enforced. Every KYAML file is valid YAML. Old tooling, old parsers, old `kubectl` versions all read it fine.

Three rules: objects use `{ }`, arrays use `[ ]`, strings are always quoted. Numbers and booleans stay bare, since they're actually meant to be those types.

One example, everything at once:

```yaml
# before
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
  template:
    spec:
      automountServiceAccountToken: false
      hostNetwork: true
      containers:
        - name: app
          image: nginx
          ports:
            - containerPort: 8080
          env:
            - name: REGION
              value: NO
```

```yaml
# after (KYAML)
apiVersion: "apps/v1"
kind: "Deployment"
metadata: { name: "api" }
spec: {
  replicas: 2,
  template: {
    spec: {
      automountServiceAccountToken: false,
      hostNetwork: true,
      containers: [
        {
          name: "app",
          image: "nginx",
          ports: [{ containerPort: 8080 }],
          env: [{ name: "REGION", value: "NO" }],
        },
      ],
    },
  },
}
```

Everything in one shot:

- `{ }` for objects (`metadata`, `spec`, each container)
- `[ ]` for arrays (`containers`, `ports`, `env`)
- strings always quoted (`"api"`, `"nginx"`, `"REGION"`)
- `replicas: 2` and `containerPort: 8080` stay bare, they're real numbers
- `automountServiceAccountToken: false` and `hostNetwork: true` stay bare, they're real booleans
- `value: "NO"` is quoted, because it's a string that would otherwise get read as `false`

KYAML doesn't remove types, it just stops guessing which one you meant.

## Why it matters

Since structure comes from `{ }` and `[ ]`, not from spaces, indentation stops being load bearing. Squash a KYAML file onto one line and it means exactly the same thing. That kills the Helm whitespace problem outright.

## Trying it

```bash
kubectl get deployment api -o kyaml
```

Convert existing files:

```bash
go install github.com/google/yamlfmt/cmd/yamlfmt@latest
yamlfmt --kyaml manifest.yaml
```

Also ships as a pre-commit hook and a Docker image for CI.

Nothing forces the switch. Plain YAML keeps working. Mixed repos, some converted, some not, are fine.

My plan if I touch this on a real repo: one directory first, verify round-trip parsing, check Helm and Kustomize don't reformat it differently, then expand once it's boring.

Not required. Cheap upgrade. Worth exploring.

For a broader breakdown of what else landed in this release, check out my notes on [Kubernetes v1.37: An Operator's Look at Garhwal](/posts/kubernetes-v1-37-stability/).
