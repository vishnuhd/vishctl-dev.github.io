---
title: "Rate Limiting LLM APIs: Count Tokens, Not Requests"
date: 2026-10-13T02:42:00+08:00
draft: false
author: "Vishnu"
description: "A diagram-first guide to token budgets, fair admission, and load shedding for shared LLM APIs, with a runnable Python simulation."
series: ["AI Infra"]
tags: ["rate-limiting", "multi-tenancy", "inference", "api-gateway", "reliability", "ai-infra"]
cover:
  image: "/images/posts/llm-rate-limiting/00-pixel-art-cover.png"
  alt: "Pixel art of a token bucket metering small requests through a shield-shaped gateway while blocking an oversized request"
  relative: false
ShowToc: true
TocOpen: false
---

```text
Request limits count calls: a short chat and a long report each count as one
Token budgets count volume: large prompts and long answers spend more budget
```

Most API gateways can limit requests per minute. That is a useful first guardrail when requests have similar costs.

LLM requests can vary widely. One call asks for a 20-token answer to a 50-token question. The next sends a 100,000-token document and asks for a 4,000-token report.

A request counter sees "one request" both times. Token volume gives you a better starting point for a budget, although input and output tokens do not cost the same amount of GPU work.

{{< mermaid caption="Top: both requests count as one, so the heavy one slips through. Bottom: counted in tokens, the heavy request is roughly 1,486 times larger." >}}
flowchart TD
    subgraph REQ["Counting requests"]
        direction LR
        A1["Small request<br/>70 tokens"] a1@--> A3["Counter says<br/>1 and 1"]
        A2["Huge request<br/>104,000 tokens"] a2@--> A3
        A3 a3@--> A4["Both allowed<br/>GPU swamped"]
    end

    subgraph TOK["Counting tokens"]
        direction LR
        B1["Small request<br/>70 tokens"] b1@--> B3["Counter says<br/>70 and 104,000"]
        B2["Huge request<br/>104,000 tokens"] b2@--> B3
        B3 b3@--> B4["Budget enforced<br/>GPU protected"]
    end

    REQ ~~~ TOK
    a1@{ animate: true }
    a2@{ animate: true }
    a3@{ animate: true }
    b1@{ animate: true }
    b2@{ animate: true }
    b3@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class A1,B1 input;
    class A2,B2,A4 warn;
    class A3 idle;
    class B3 tree;
    class B4 gpu;
{{< /mermaid >}}

This post covers the two protections every shared model endpoint needs: a **token budget** per tenant, and **load shedding** for the moments when the whole server is full.

It covers what to do once you have hit the maximum number of replicas and traffic keeps coming.

## Why request limits fail

Put three teams on one model server. Each gets the same limit: 2 requests per second.

| Team | Requests per second | Tokens per request | Tokens per second |
|---|---|---|---|
| Heavy (document analysis) | 2 | 8,000 | 16,000 |
| Light 1 (chat) | 2 | 400 | 800 |
| Light 2 (chat) | 2 | 400 | 800 |

Everyone is inside the limit. Nobody did anything wrong. Yet one team submits **90.9% of the tokens**. That can crowd out the chat teams, even though the exact latency impact depends on batching, prompt caching, and the mix of input and output tokens.

Request counts alone miss that difference in workload. Keep a request limit for bursts, and add a token budget for volume.

## The token bucket

The fix is an old networking idea with a fitting name.

Imagine a bucket that holds tokens. It refills at a steady rate.

Every request must take out as many tokens as it will use. If the bucket does not hold enough, the request is refused.

| Setting | Meaning | Example |
|---|---|---|
| Refill rate | The sustained budget | 1,000 tokens per second |
| Capacity | How big a burst is allowed | 8,000 tokens |

Watch one tenant with that bucket send four requests:

| Step | Time | Request size | Bucket before | Decision | Bucket after |
|---|---|---|---|---|---|
| 1 | 0 s | 6,000 | 8,000 | Allow | 2,000 |
| 2 | 1 s | 6,000 | 3,000 | Reject | 3,000 |
| 3 | 2 s | 400 | 4,000 | Allow | 3,600 |
| 4 | 6 s | 6,000 | 7,600 | Allow | 1,600 |

Three things happened there, and all three are what you want:

- **A burst was allowed** (step 1). A full bucket absorbs an occasional large request.
- **A second burst was refused** (step 2). Sustained heavy use is not possible.
- **Small requests kept flowing** (step 3). Light traffic is barely affected by the limit.

### How many tokens does a request cost?

You must decide the cost **before** running the request, and half of it is unknown.

```text
Cost = input tokens (known) + output tokens (not known yet)
```

For a gateway you control, one approach is to reserve the worst case and refund the rest:

1. **Reserve** `input tokens + max_tokens` when the request arrives.
2. **Run** the request.
3. **Refund** the unused output tokens when it finishes.

Treat `max_tokens` here as your output cap; the API field name varies. Hosted providers can use different accounting rules.

This is also a good reason to make clients set a sensible `max_tokens`. A client that always asks for the maximum reserves budget it never uses.

The budget is an approximation of compute cost. Prefill handles input tokens in parallel, while decode generates output tokens step by step. For tighter control, use separate input and output budgets or measured weights, plus an in-flight request limit.

A reservation larger than the bucket capacity will never fit, even after waiting. Reject it with a clear size or budget error so the client can shorten the request. In production, make reservations atomic across gateway replicas and reconcile them when requests finish or are cancelled.

## Try it: one heavy tenant, two limits

This script runs the three-team example through both kinds of limit. Save it as `token_limit.py`. It uses only the Python standard library and models admission decisions, not a GPU or a queue.

```python
#!/usr/bin/env python3
"""token_limit.py: request limits versus token limits for three tenants."""


class TokenBucket:
    """Holds up to `capacity` units and refills at `rate` units per second."""

    def __init__(self, rate, capacity):
        self.rate, self.capacity = rate, capacity
        self.level, self.last = capacity, 0.0

    def allow(self, cost, now):
        self.level = min(self.capacity, self.level + (now - self.last) * self.rate)
        self.last = now
        if cost > self.level:
            return False              # reject now, do not queue
        self.level -= cost
        return True


# name: (requests per second, tokens per request)
tenants = {"heavy": (2, 8000), "light-1": (2, 400), "light-2": (2, 400)}
SECONDS = 60


def run(make_bucket, cost_of):
    admitted = {}
    for name, (rps, tokens) in tenants.items():
        bucket, ok = make_bucket(), 0
        for i in range(SECONDS * rps):
            if bucket.allow(cost_of(tokens), now=i / rps):
                ok += 1
        admitted[name] = ok * tokens
    return admitted


by_request = run(lambda: TokenBucket(rate=2, capacity=2), cost_of=lambda tokens: 1)
by_token = run(lambda: TokenBucket(rate=1000, capacity=8000), cost_of=lambda tokens: tokens)

for title, result in (("Limit: 2 requests per second each", by_request),
                      ("Limit: 1,000 tokens per second each", by_token)):
    total = sum(result.values())
    print(title)
    for name, tokens in result.items():
        print(f"  {name:8} {tokens / SECONDS:8,.0f} tokens/s   {100 * tokens / total:5.1f}% of admitted tokens")
    print(f"  {'total':8} {total / SECONDS:8,.0f} tokens/s\n")
```

```bash
python3 token_limit.py
```

The output:

```text
Limit: 2 requests per second each
  heavy      16,000 tokens/s    90.9% of admitted tokens
  light-1       800 tokens/s     4.5% of admitted tokens
  light-2       800 tokens/s     4.5% of admitted tokens
  total      17,600 tokens/s

Limit: 1,000 tokens per second each
  heavy       1,067 tokens/s    40.0% of admitted tokens
  light-1       800 tokens/s    30.0% of admitted tokens
  light-2       800 tokens/s    30.0% of admitted tokens
  total       2,667 tokens/s
```

Same class, same three tenants. The only change is the unit being counted.

With the token limit, all chat requests are still admitted: each light tenant keeps its full 800 tokens per second. The heavy tenant is held near its sustained budget. The initial 8,000-token burst explains why its 60-second average is slightly above 1,000 tokens per second.

This demonstrates admission fairness by token volume. It does not predict response latency or GPU utilization.

Notice the same `TokenBucket` class did both jobs. A request limit is just a token bucket where every request costs 1.

## Where the limit lives

Rate limiting belongs at the front door, before a request can take a slot on the GPU.

{{< mermaid caption="The budget check happens at the gateway. A request that is over budget is refused in milliseconds and never reaches the model server's queue." >}}
flowchart TD
    C["Client<br/>with API key"] g1@--> G["Gateway<br/>token budget<br/>per tenant"]
    G g2@--> R["Router<br/>picks a replica"]
    R g3@--> V["vLLM<br/>queue and GPU"]
    G g4@--> X["Over budget<br/>429 in<br/>milliseconds"]

    g1@{ animate: true }
    g2@{ animate: true }
    g3@{ animate: true }
    g4@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    class C input;
    class G,R tree;
    class V gpu;
    class X warn;
{{< /mermaid >}}

Three practical points:

- **Key the budget on the tenant**, not the IP address. Use the API key, team, or application.
- **Share the count across gateway replicas.** If each replica keeps its own bucket in memory, three replicas means three times the budget. Use a shared store such as Redis with an atomic refill-and-reserve operation.
- **Tell clients where they stand.** Hosted APIs return headers such as `x-ratelimit-remaining-tokens` for this. Doing the same lets well-behaved clients slow down before they hit the wall.

## Load shedding: when the whole server is full

A token budget protects tenants from each other. It does not protect the server from everyone at once.

For a simplified example with equally costly requests, suppose your replicas can finish 10 requests per second, you are already at the maximum replica count, and 15 requests per second arrive. Each tenant is inside its own budget.

Without a plan, the extra requests wait in the queue. The queue never drains, because arrivals keep beating departures:

| Time | Arrived | Finished | Waiting | Wait for a new request |
|---|---|---|---|---|
| 0 s | 0 | 0 | 0 | 0 s |
| 20 s | 300 | 200 | 100 | 10 s |
| 40 s | 600 | 400 | 200 | 20 s |
| 60 s | 900 | 600 | 300 | 30 s |

After one minute, every new request waits 30 seconds before it even starts. If clients have a 30-second total timeout, queued requests can expire before they receive an answer. Unless cancellation reaches the backend, the GPU may keep working on answers nobody is waiting for.

Throughput can stay high while **goodput collapses**: fewer answers reach clients within their deadline.

{{< mermaid caption="Top: with no shedding, every request slows down and many time out. Bottom: rejecting the excess immediately keeps the admitted requests fast." >}}
flowchart TD
    subgraph NOSHED["Queue everything"]
        direction LR
        N1["15 arrive<br/>per second"] n1@--> N2["Queue grows<br/>5 per second"]
        N2 n2@--> N3["New arrivals wait<br/>30 s at t = 60 s"]
        N3 n3@--> N4["Clients time out<br/>work is wasted"]
    end

    subgraph SHED["Shed the excess"]
        direction LR
        S1["15 arrive<br/>per second"] s1@--> S2["10 admitted<br/>5 rejected fast"]
        S2 s2@--> S3["10 answered<br/>on time"]
        S3 s3@--> S4["5 retry later<br/>or go elsewhere"]
    end

    NOSHED ~~~ SHED
    n1@{ animate: true }
    n2@{ animate: true }
    n3@{ animate: true }
    s1@{ animate: true }
    s2@{ animate: true }
    s3@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    class N1,S1 input;
    class N2,N3,N4 warn;
    class S2,S3 gpu;
    class S4 idle;
{{< /mermaid >}}

**Load shedding** means refusing work you cannot finish in time, immediately, so the work you accept stays fast. A quick "no" is far more useful to a client than a slow timeout: it can retry, fall back to another model, or tell the user right away.

### Four shedding rules that work

| Rule | What it does | Why it helps |
|---|---|---|
| Bounded queue | Reject new requests once N are waiting | Limits backlog; use deadlines to cap waiting time |
| Deadline check | Reject work unlikely to finish before its deadline | Stops work on answers nobody will read |
| Priority classes | Shed batch traffic before interactive traffic | Protects the users who are watching |
| Output cap | Enforce a maximum `max_tokens` per tier | Stops one request from holding a slot for minutes |

A rough starting point is queue capacity = measured start rate × allowed queue wait. At 10 starts per second and a 2-second queue-wait budget, that gives about 20 waiting requests.

TTFT also includes prefill and other overhead, so leave room for those inside the TTFT target. Variable prompt lengths and batching make this a planning estimate; validate it under load.

### Say no clearly

The response matters as much as the decision.

| Situation | Status code | Meaning to the client |
|---|---|---|
| This tenant is over its budget | `429 Too Many Requests` | You are sending too much. Slow down |
| The whole server is overloaded | `503 Service Unavailable` | Not your fault. Try again shortly |

For temporary limits, send a `Retry-After` header with a realistic wait in seconds. Clients must also support its HTTP-date form. Do not suggest retrying an unchanged request that can never fit the bucket.

The HTTP standards define [429 for rate limiting](https://www.rfc-editor.org/rfc/rfc6585.html#section-4) and [503 for temporary overload](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.4). Both can carry `Retry-After`; it is a retry hint, not a guarantee of capacity.

On the client side, the matching behavior is short:

```text
1. Honor Retry-After when it is present
2. Otherwise wait, doubling the delay after each failure
3. Add a little randomness so clients do not all retry at the same instant
4. Give up after a few attempts and tell the user
```

Step 3 is not a detail. Without it, a thousand clients rejected at the same moment all return at the same moment, and the overload repeats.

## What to watch

Limits you cannot see are limits you cannot tune. Track these three signals on your dashboard:

| Metric to add | What it tells you |
|---|---|
| Rejections per tenant (429) | Who is hitting their budget, and how often |
| Server-wide rejections (503) | How often you are out of capacity |
| Tokens used versus budget, per tenant | Who needs a bigger budget, and who has room to spare |

A steady trickle of 429s for one tenant is the system working. A burst of 503s for everyone signals a service-wide problem. Investigate serving health, capacity, and traffic demand before changing the limits.

## Common mistakes

| Mistake | What goes wrong | Do this instead |
|---|---|---|
| Limiting requests only | One heavy tenant takes the GPU | Limit tokens, optionally with a request limit on top |
| Counting input tokens only | Long generations escape the budget | Reserve `max_tokens`, then refund |
| An unbounded queue | Latency grows until everything times out | Bound the queue and reject beyond it |
| Rejecting without `Retry-After` | Clients retry instantly and make it worse | Send a realistic wait for temporary limits |
| One global limit | Small tenants are punished for a large one | Budget per tenant |
| Per-replica counters | The real limit is multiplied by the replica count | Keep counts in a shared store |

## Cheat sheet

```text
Rate limiting     = capping how much one tenant may use over time
Request limit     = counts calls; useful for bursts but misses differences in cost
Token limit       = budgets token volume; a proxy for compute, not a GPU measurement
Token bucket      = a budget that refills at a steady rate and allows bounded bursts
Refill rate       = the sustained budget, such as 1,000 tokens per second
Capacity          = the largest burst the bucket can absorb
Reserve and refund = charge input + max_tokens up front, give back what was not used
Load shedding     = rejecting work you cannot finish in time so accepted work stays fast
Bounded queue     = refuse new requests once the wait would break the latency target
429               = this tenant is over budget
503               = the whole service is overloaded
Retry-After       = tells the client how long to wait before trying again
Backoff with jitter = wait longer after each failure, plus randomness to avoid retry storms
Rule of thumb     = budget tenants in tokens, bound the queue, and say no quickly
```

Limits decide who gets capacity. For the serving engine behind the gateway, read [why vLLM is used for inference](/posts/why-vllm-is-dominating-ai-inference-market/). For distributing traffic across replicas, read [LLM inference routing on Kubernetes](/posts/llm-d-kubernetes-inference-routing/).
