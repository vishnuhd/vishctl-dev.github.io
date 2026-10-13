---
title: "Speculative Decoding, Simply: A Small Model Guesses, the Big Model Checks"
date: 2026-10-13T02:40:00+08:00
draft: true
author: "Vishnu"
description: "A simple, diagram-first guide to speculative decoding: why checking tokens is cheaper than writing them, how acceptance rate decides the speedup, when it makes serving slower, and how to turn it on in vLLM."
series: ["AI Infra"]
tags: ["speculative-decoding", "inference", "vllm", "latency", "ai-infra"]
cover:
  image: "/images/posts/speculative-decoding/00-pixel-art-cover.png"
  alt: "Pixel art of a small violet drafting robot sending token tiles through a larger cyan processor that accepts or rejects them"
  relative: false
ShowToc: true
TocOpen: false
---

A large model writes one token per pass. Every token costs a full trip through billions of weights, even an obvious one like the closing bracket of a JSON object.

Speculative decoding asks a simple question: what if something cheap guessed the easy tokens, and the large model only had to check them?

```text
Normal decoding      = the big model writes every token itself, one pass per token
Speculative decoding = a small model drafts a few tokens, the big model checks them in one pass
```

{{< mermaid caption="Top: five tokens cost five big-model passes. Bottom: a small model drafts five tokens, and one big-model pass checks them all." >}}
flowchart TD
    subgraph NORMAL["Normal decoding"]
        direction LR
        N1["Big pass<br/>token 1"] n1@--> N2["Big pass<br/>token 2"]
        N2 n2@--> N3["...and<br/>so on"]
        N3 n3@--> N4["5 tokens<br/>5 big passes"]
    end

    subgraph SPEC["Speculative decoding"]
        direction LR
        S1["Small model<br/>drafts 5 tokens"] s1@--> S2["Big model<br/>checks all 5<br/>in 1 pass"]
        S2 s2@--> S3["4 tokens kept<br/>1 big pass"]
    end

    NORMAL ~~~ SPEC
    n1@{ animate: true }
    n2@{ animate: true }
    n3@{ animate: true }
    s1@{ animate: true }
    s2@{ animate: true }

    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class N1,N2,N3,N4 warn;
    class S1 tree;
    class S2,S3 gpu;
{{< /mermaid >}}

The surprising part is the guarantee: done properly, **the output is the same as what the big model would have written alone.** This is a speed trick, not a quality trade.

This post explains why that works, how much it helps, and when it makes things worse.

## Why checking is cheaper than writing

A model writes slowly because each token depends on the one before it. It cannot start token 5 until token 4 exists.

Checking has no such problem. If someone hands the model five tokens, it can score all five positions **in a single pass**, the same way it reads a whole prompt at once during [prefill](/posts/llm-basics-visual-guide/).

Think of a senior engineer and a junior engineer:

- **Writing a runbook from scratch** takes the senior engineer an hour.
- **Reviewing the junior's draft** takes ten minutes, and most lines are fine.

The senior still decides every line. They just do not have to type the obvious ones.

## One round, step by step

Suppose the model is finishing this sentence: *"The pod is in..."*

{{< mermaid caption="One round. The small model drafts five tokens. The big model agrees with the first three, rejects the fourth, and supplies its own." >}}
flowchart LR
    D["Draft<br/>5 tokens"] r1@--> V["Verify<br/>1 big pass"]
    V r2@--> A["Accept<br/>first 3"]
    A r3@--> F["Fix<br/>token 4"]
    F r4@--> N["Next round<br/>starts here"]

    r1@{ animate: true }
    r2@{ animate: true }
    r3@{ animate: true }
    r4@{ animate: true }

    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    class D tree;
    class V,A gpu;
    class F warn;
    class N input;
{{< /mermaid >}}

| Step | What happens | Tokens so far |
|---|---|---|
| 1. Draft | Small model proposes: `Crash` `Loop` `BackOff` `status` `now` | 0 confirmed |
| 2. Verify | Big model scores all five positions in one pass | 0 confirmed |
| 3. Accept | It agrees with `Crash` `Loop` `BackOff` | 3 confirmed |
| 4. Fix | It disagrees with `status`, and writes `state` instead | 4 confirmed |

The fifth draft token is thrown away, because it was built on a token that got rejected.

Result: **four tokens for the price of one big pass**, plus five cheap small ones. The worst case is also safe: if the very first draft token is wrong, the big model still supplies one correct token, so the round is never wasted.

### Why the output does not change

In step 3, the big model is not "trusting" the draft. It computes what it would have produced at each position, and a draft token only survives if it passes that test.

With greedy decoding, the test is simply "is this the token I would have picked?". With sampling, a slightly cleverer accept-or-reject rule is used so that the final text follows the big model's probabilities exactly.

vLLM's documentation describes its implementation as theoretically lossless, within the limits of floating-point precision. Tiny numeric differences are possible, as they are whenever batch sizes change. Token log probabilities are the exception: vLLM does not guarantee they stay stable with speculation on.

## The number that decides everything: acceptance rate

The **acceptance rate** is how often the big model agrees with a drafted token. It decides how many tokens each big pass yields.

With a draft length of 5:

| Acceptance rate | Tokens per big-model pass |
|---|---|
| 50% | 1.97 |
| 70% | 2.94 |
| 80% | 3.69 |
| 90% | 4.69 |

Those are not the speedup yet. Drafting is cheap, but it is not free.

### Speedup, after paying for the drafts

Assume one small-model pass costs 10% of a big-model pass:

| Acceptance rate | Draft 3 tokens | Draft 5 tokens | Draft 8 tokens |
|---|---|---|---|
| 50% | 1.44x | 1.31x | 1.11x |
| 70% | 1.95x | 1.96x | 1.78x |
| 80% | 2.27x | 2.46x | 2.40x |
| 90% | 2.65x | 3.12x | 3.40x |

Read across the 50% row. **Drafting more tokens made it slower.** When the small model is often wrong, long drafts are mostly wasted work.

Now read the 90% row. Long drafts pay off, because most of them survive.

### The draft model must be much smaller

Hold acceptance at 70% and draft length at 5, and change only how expensive the small model is:

| Small model cost (share of a big pass) | Speedup |
|---|---|
| 2% | 2.67x |
| 10% | 1.96x |
| 25% | 1.31x |
| 50% | 0.84x |

At 50%, speculative decoding is **slower than doing nothing**. A draft model that is half the size of the target is not a draft model. A common starting point is a model roughly ten times smaller, from the same family, so it guesses in a similar style.

These tables come from a simplified formula that treats every token as an independent coin flip. Real text is burstier than that, so treat the numbers as the shape of the trade-off, not a forecast.

## Not every draft needs a second model

"A small model drafts" is the classic version. The draft can come from other places too.

| Draft source | How it guesses | Best for |
|---|---|---|
| Draft model | A separate small LLM | General text, when a good small sibling exists |
| N-gram, or prompt lookup | Copies a run of tokens that already appears in the prompt | Editing, summarizing, RAG answers that quote the context |
| Extra prediction heads | Small layers added to the big model itself, such as EAGLE | Highest speedups, but needs heads trained for that exact model |

The n-gram method deserves attention because it costs almost nothing. If you ask a model to fix one line in a 200-line file, most of the output is a copy of the input. Guessing "the next tokens are the same as in the prompt" is right most of the time.

vLLM rates n-gram gains as low to medium. The price is also close to zero, with no second model to load.

## When it helps and when it hurts

| Situation | Effect | Why |
|---|---|---|
| Code, JSON, structured text | Helps a lot | Predictable tokens mean high acceptance |
| Editing or quoting the prompt | Helps, even with n-gram | The answer repeats the input |
| Creative writing, high temperature | Helps little | The next token is a toss-up, so drafts miss |
| One user, latency matters | Helps | Spare GPU time is turned into speed |
| Busy server near saturation | Can hurt | Draft work competes with real requests for the same GPU |
| Tight GPU memory | Can hurt | The draft model takes memory away from the KV cache |

The last two rows are the ones that surprise people in production.

Speculative decoding spends extra compute to save time. On a quiet GPU, that compute was idle anyway. On a GPU that is already full, every wasted draft token is work taken from another user, so total throughput can go **down**.

And a draft model is not free to hold. Its weights and its own KV cache come out of the same memory budget described in the [GPU memory sizing guide](/posts/llm-gpu-memory-sizing-weights-kv-cache/).

## What it does to your metrics

If you track the numbers from my [inference metrics guide](/posts/llm-inference-metrics-ttft-tpot-throughput-goodput/), expect this:

| Metric | What changes |
|---|---|
| TTFT | About the same. The first token still needs a full prefill |
| TPOT | Improves, by roughly the speedup factor |
| ITL | Gets bursty. Several tokens can arrive in one chunk, then a pause |
| Throughput at low load | Improves |
| Throughput at high load | May get worse. Measure it |

That ITL row is why TPOT and ITL can disagree. A stream that delivers four tokens at once and then waits looks fast on average and uneven up close.

## Try it: the math in a script

This script produces the tables above and checks the formula against a simulation. It uses only the Python standard library.

```python
#!/usr/bin/env python3
"""spec_decode.py: how much does speculative decoding help?"""
import random


def tokens_per_round(accept, draft_len):
    """Expected tokens produced by one big-model pass."""
    return (1 - accept ** (draft_len + 1)) / (1 - accept)


def speedup(accept, draft_len, draft_cost):
    """Speed versus normal decoding. draft_cost = small-model pass / big-model pass."""
    return tokens_per_round(accept, draft_len) / (draft_len * draft_cost + 1)


def simulate(accept, draft_len, rounds=200_000):
    """Check the formula by actually flipping coins."""
    random.seed(1)
    total = 0
    for _ in range(rounds):
        kept = 0
        while kept < draft_len and random.random() < accept:
            kept += 1
        total += kept + 1          # accepted drafts plus one token from the big model
    return total / rounds


print("Tokens per big-model pass (draft length 5)")
for accept in (0.5, 0.7, 0.8, 0.9):
    print(f"  acceptance {accept:.0%}: formula {tokens_per_round(accept, 5):.2f}, simulated {simulate(accept, 5):.2f}")

print("\nSpeedup when the draft model costs 10% of the big model")
print("  acceptance   draft 3   draft 5   draft 8")
for accept in (0.5, 0.7, 0.8, 0.9):
    row = "   ".join(f"{speedup(accept, n, 0.10):5.2f}x" for n in (3, 5, 8))
    print(f"  {accept:>9.0%}    {row}")

print("\nSpeedup at 70% acceptance, draft length 5, by draft cost")
for cost in (0.02, 0.10, 0.25, 0.50):
    print(f"  draft costs {cost:>4.0%} of a big pass: {speedup(0.7, 5, cost):.2f}x")
```

```bash
python3 spec_decode.py
```

The first block of output shows the formula and the simulation agreeing:

```text
Tokens per big-model pass (draft length 5)
  acceptance 50%: formula 1.97, simulated 1.97
  acceptance 70%: formula 2.94, simulated 2.94
  acceptance 80%: formula 3.69, simulated 3.69
  acceptance 90%: formula 4.69, simulated 4.68
```

Change the numbers to match your own case. If your draft model is 5% of the target's size and you expect 75% acceptance, the script tells you whether a draft length of 4 or 8 is the better bet.

## Turn it on in vLLM

Speculative decoding is a server setting. Clients do not change anything.

The cheapest experiment is n-gram, because it needs no second model:

```bash
vllm serve <target-model> \
  --speculative-config '{
    "method": "ngram",
    "num_speculative_tokens": 4,
    "prompt_lookup_min": 2,
    "prompt_lookup_max": 5
  }'
```

With a separate draft model:

```bash
vllm serve <target-model> \
  --speculative-config '{
    "method": "draft_model",
    "model": "<draft-model>",
    "num_speculative_tokens": 5
  }'
```

Both commands follow the current [vLLM speculative decoding docs](https://docs.vllm.ai/en/latest/features/speculative_decoding/). The option names have changed across releases, so check the page for your version.

Then measure, with the same prompts, before and after:

1. **Run a single request** with the timing script from the [inference metrics guide](/posts/llm-inference-metrics-ttft-tpot-throughput-goodput/#try-it-measure-ttft-and-tpot-yourself). TPOT should drop.
2. **Run a load test** at your normal request rate. Check that throughput did not fall.
3. **Try your real prompts**, not a demo prompt. Acceptance on your traffic is the only number that matters.

## Should you use it?

{{< mermaid caption="Start with how busy the GPU is. Speculation spends spare compute, so it pays off when there is some to spend." >}}
flowchart TD
    Q1["Is the GPU usually<br/>near saturation?"] d1@-->|"Yes"| X["Skip it<br/>add capacity first"]
    Q1 d2@-->|"No"| Q2["Is the output<br/>predictable?"]
    Q2 d3@-->|"Copies the prompt"| N["Try n-gram<br/>almost free"]
    Q2 d4@-->|"Code or JSON"| D["Try a draft model<br/>about 10x smaller"]
    Q2 d5@-->|"Creative text"| M["Small gain<br/>measure before keeping"]

    d1@{ animate: true }
    d2@{ animate: true }
    d3@{ animate: true }
    d4@{ animate: true }
    d5@{ animate: true }

    classDef question fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef idle fill:#101e27,stroke:#324950,color:#8aa0a8;
    class Q1,Q2 question;
    class X warn;
    class N,D gpu;
    class M idle;
{{< /mermaid >}}

## Cheat sheet

```text
Speculative decoding = a cheap drafter proposes tokens, the big model verifies them in one pass
Draft model          = the small LLM that proposes; should be about 10x smaller than the target
Target model         = the big model whose output you actually want
Verification         = one big-model pass that scores every drafted position at once
Acceptance rate      = how often the target agrees with a drafted token
Draft length         = how many tokens are proposed per round (num_speculative_tokens)
Tokens per pass      = (1 - acceptance^(draft length + 1)) / (1 - acceptance)
Lossless             = the output follows the target model's own choices, not the draft's
N-gram, prompt lookup = draft by copying tokens that already appear in the prompt
EAGLE-style heads    = small extra layers on the target model that do the drafting
Where it hurts       = saturated GPUs and tight memory, where draft work crowds out requests
Rule of thumb        = predictable output and spare GPU time: use it; busy GPU: skip it
```

Related: speculative decoding makes each stream faster, while [continuous batching](/posts/why-vllm-is-dominating-ai-inference-market/) makes the whole server carry more streams. For another way to skip work on structured output, see jump-forward decoding in [SGLang vs. vLLM](/posts/sglang-vs-vllm/).
