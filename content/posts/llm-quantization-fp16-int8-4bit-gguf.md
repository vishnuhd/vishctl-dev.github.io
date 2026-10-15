---
title: "LLM Quantization, Simply: FP16, 8-bit, 4-bit, and What Q4_K_M Means"
date: 2026-10-15T00:00:00+08:00
draft: false
author: "Vishnu"
description: "A simple, diagram-first guide to LLM quantization: what rounding a weight actually does, how much memory each bit width saves, how to read names like Q4_K_M, AWQ, and FP8, and a toy script that shows where quality falls off."
series: ["AI Infra"]
tags: ["quantization", "gguf", "local-llm", "inference", "vllm", "ai-infra"]
cover:
  image: "/images/posts/llm-quantization/00-pixel-art-cover.png"
  alt: "Pixel art of three llama portraits rendered at progressively coarser precision beside a compact GPU"
  relative: false
ShowToc: true
TocOpen: false
---

An 8-billion-parameter model is about 16 GB as published. My laptop GPU has 8 GB. Yet models that size run on it.

The trick is quantization. It is the reason local LLMs exist at all, and it comes down to one idea:

```text
Full precision = store every weight as a long, exact number (16 bits)
Quantized      = round every weight to one of a few allowed values (8 or 4 bits)
```

{{< mermaid caption="Top: the 16-bit model is twice the size of the GPU. Bottom: the same model rounded to about 4 bits per weight fits with room for the KV cache." >}}
flowchart TD
    subgraph FULL["16-bit weights"]
        direction LR
        A1["8B model<br/>16 GB"] a1@--> A2["8 GB<br/>laptop GPU"]
        A2 a2@--> A3["Does not fit"]
    end

    subgraph QUANT["4-bit weights"]
        direction LR
        B1["8B model<br/>about 5 GB"] b1@--> B2["8 GB<br/>laptop GPU"]
        B2 b2@--> B3["Fits<br/>3 GB to spare"]
    end

    FULL ~~~ QUANT
    a1@{ animate: true }
    a2@{ animate: true }
    b1@{ animate: true }
    b2@{ animate: true }

    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef warn fill:#302410,stroke:#fbbf24,color:#fff3cf,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class A1,B1 tree;
    class A2,B2 input;
    class A3 warn;
    class B3 gpu;
{{< /mermaid >}}

This post explains what that rounding does, what it costs, and how to read the alphabet soup (`Q4_K_M`, AWQ, FP8) on every model download page.

## 1. A weight is just a number

A model is a very long list of numbers called weights. An 8B model has eight billion of them.

Each weight is stored with some number of **bits**. More bits means more possible values, like a ruler with finer marks.

| Bits per weight | Possible values | Like a ruler with |
|---|---|---|
| 16 | 65,536 | Marks every hair's width |
| 8 | 256 | Millimeter marks |
| 4 | 16 | Marks every few centimeters |
| 2 | 4 | Four marks in total |

Quantization swaps the fine ruler for a coarse one. Every weight moves to the nearest mark that still exists.

## 2. What rounding looks like

Take four weights and squeeze them into 4 bits. With 4 bits, each weight must become a whole number from -7 to 7.

{{< mermaid caption="One weight on its trip through 4-bit quantization. It is divided by a shared scale, rounded to a whole number, stored, and multiplied back when the model runs." >}}
flowchart LR
    O["Original<br/>0.82"] q1@--> S["Divide by<br/>the scale<br/>6.04"]
    S q2@--> R["Round<br/>6"]
    R q3@--> D["Stored in<br/>4 bits"]
    D q4@--> B["Multiply back<br/>0.814"]

    q1@{ animate: true }
    q2@{ animate: true }
    q3@{ animate: true }
    q4@{ animate: true }

    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    classDef tree fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    class O input;
    class S,R tree;
    class D,B gpu;
{{< /mermaid >}}

The **scale** is one shared number chosen so the largest weight lands on 7. Here that is `0.95 / 7 = 0.1357`.

| Step | 0.82 | -0.31 | 0.07 | -0.95 |
|---|---|---|---|---|
| 1. Divide by the scale | 6.04 | -2.28 | 0.52 | -7.00 |
| 2. Round to a whole number | 6 | -2 | 1 | -7 |
| 3. Store (4 bits each) | 6 | -2 | 1 | -7 |
| 4. Multiply back at run time | 0.814 | -0.271 | 0.136 | -0.950 |

Compare the first and last rows. The big weights barely moved. The small one, 0.07, almost doubled to 0.136.

That is the whole trade. **You save 12 of every 16 bits, and each weight gets slightly wrong.**

## 3. Why the model still works

A model does not depend on any single weight. Each output is a sum over thousands of them, and the rounding errors point in random directions, so many of them cancel out.

That tolerance has a limit. As the ruler gets coarser, the errors stop cancelling and start changing answers.

| Bits per weight | What usually happens | Typical use |
|---|---|---|
| 16 | The reference. No loss | GPU servers with memory to spare |
| 8 | Very hard to tell apart from 16-bit | Safe default when 16-bit does not fit |
| 5 to 6 | Very close to the original | Local use when memory allows |
| 4 | Small, usually acceptable loss | The popular sweet spot for local models |
| 3 and below | Quality drops quickly | Only when nothing else fits |

These are rules of thumb, not guarantees. Coding, math, and long reasoning tend to suffer before casual chat does. Test on the kind of prompts you actually use.

One more rule of thumb worth knowing: **for the same memory, a bigger model at 4 bits usually beats a smaller model at 16 bits.**

## 4. How much memory you save

Size is one multiplication:

```text
File size = parameters x bits per weight / 8
```

| Model | 16-bit | 8-bit | About 4.85 bits (Q4_K_M) |
|---|---|---|---|
| 8B | 16 GB | 8 GB | About 4.9 GB |
| 14B | 28 GB | 14 GB | About 8.5 GB |
| 32B | 64 GB | 32 GB | About 19 GB |
| 70B | 140 GB | 70 GB | About 42 GB |

Two cautions:

- **Quantizing weights does not shrink the KV cache.** The cache that grows with your context is a separate cost. The [GPU memory sizing guide](/posts/llm-gpu-memory-sizing-weights-kv-cache/) covers both.
- **File size is not the whole footprint.** Leave room for the cache and the runtime, or a model that "fits" will crawl.

## 5. Reading the names

### GGUF names such as Q4_K_M

GGUF is the file format used by llama.cpp, and by tools built on it such as Ollama and LM Studio. Its quantization names have three parts:

```text
Q4_K_M
│  │ └─ M = medium variant (S small, M medium, L large)
│  └─── K = the newer "k-quant" method
└────── Q4 = about 4 bits per weight
```

The letter at the end says how many of the model's layers get extra bits. That is why the real average is a little above the headline number.

| GGUF name | Average bits per weight | When I would pick it |
|---|---|---|
| `Q8_0` | About 8.5 | Maximum quality, memory is no concern |
| `Q6_K` | About 6.6 | Plenty of memory, want to be safe |
| `Q5_K_M` | About 5.7 | A little headroom after Q4 |
| `Q4_K_M` | About 4.85 | The default almost everywhere |
| `Q3_K_M` | About 3.9 | The model will not fit any other way |

`Q4_K_M` is what I used in both my [Ollama](/posts/running-ollama-on-32gb-macbook-air/) and [llama.cpp](/posts/running-llama-cpp-on-32gb-macbook-air/) posts, which is why their speeds were comparable.

### Names from the GPU serving world

| Name | What it is | Where you meet it |
|---|---|---|
| FP16 or BF16 | The original 16-bit weights | The default for vLLM and SGLang |
| FP8 | 8-bit floating point weights | GPU serving when 16-bit is too big |
| AWQ | 4-bit weights, chosen by watching real activations | Pre-quantized models for GPU servers |
| GPTQ | 4-bit weights, tuned layer by layer on sample data | Pre-quantized models for GPU servers |
| NVFP4 | NVIDIA's 4-bit floating point format | Newer NVIDIA stacks, as in my [FreeToken test](/posts/running-freetoken-on-8gb-laptop-gpu/) |
| MLX 4-bit | 4-bit weights in Apple's MLX format | [MLX-LM, oMLX, and vMLX](/posts/omlx-vs-vmlx-vs-mlx-32gb-macbook-air/) on a Mac |

They all do the same job with different rounding recipes. The format you choose is mostly decided by **which runtime you use**, not by which one is "best".

## 6. Why smart rounding beats simple rounding

The walkthrough in section 2 used the simplest possible recipe: one scale for everything. Real quantizers work harder, and the toy script below shows why they have to.

Simple rounding has a weakness. One unusually large weight stretches the scale, and every small weight then gets squashed toward zero.

Modern methods fix this in a few ways:

- **Many small scales instead of one.** Weights are quantized in small blocks, each with its own scale. This is the idea behind the K in `Q4_K_M`.
- **Mixed precision.** Sensitive layers keep more bits. This is what the S, M, and L variants control.
- **Calibration.** AWQ and GPTQ run sample text through the model and protect the weights that matter most for real outputs.

There is also **quantization-aware training**, where the model is trained with rounding switched on so it learns to live with it. It gives the best quality at low bit widths, but it needs a training run. Almost every file you download was quantized after training instead.

## 7. Does it make the model faster?

Often yes, but for a reason that surprises people.

Generating a token means reading every weight from memory. On laptops and CPUs, that reading is the bottleneck. A 4-bit model has a quarter of the bytes to move, so tokens come out faster.

| Hardware | Effect of quantizing |
|---|---|
| CPU or Apple silicon | Usually faster, because less memory has to be read per token |
| Small GPU | Often the only way the model fits on the GPU at all |
| Big GPU with spare memory | Smaller gain. 16-bit is already fast and well supported |

On a data-center GPU the stronger argument is capacity, not speed: a smaller model leaves more memory for the KV cache, which means more concurrent users. See [how many requests fit](/posts/llm-gpu-memory-sizing-weights-kv-cache/#3-put-it-together-how-many-requests-fit).

## Try it: watch the quality fall off

This script quantizes weights with the simple one-scale recipe and measures the damage. It uses only the Python standard library.

```python
#!/usr/bin/env python3
"""toy_quant.py: round weights to N bits and measure the damage."""
import random


def quantize(weights, bits):
    top = 2 ** (bits - 1) - 1                 # 4 bits -> whole numbers from -7 to 7
    scale = max(abs(w) for w in weights) / top
    stored = [round(w / scale) for w in weights]
    return stored, [n * scale for n in stored]


demo = [0.82, -0.31, 0.07, -0.95]
stored, restored = quantize(demo, 4)
print("original :", demo)
print("stored   :", stored)
print("restored :", [round(r, 3) for r in restored])

random.seed(0)
weights = [random.gauss(0, 0.05) for _ in range(100_000)]
typical = sum(abs(w) for w in weights) / len(weights)
print()
for bits in (8, 6, 4, 3, 2):
    _, restored = quantize(weights, bits)
    error = sum(abs(a - b) for a, b in zip(weights, restored)) / len(weights)
    print(f"{bits} bits: average error is {100 * error / typical:5.1f}% of a typical weight")
```

```bash
python3 toy_quant.py
```

This is the output on my machine:

```text
original : [0.82, -0.31, 0.07, -0.95]
stored   : [6, -2, 1, -7]
restored : [0.814, -0.271, 0.136, -0.95]

8 bits: average error is   1.0% of a typical weight
6 bits: average error is   4.3% of a typical weight
4 bits: average error is  19.0% of a typical weight
3 bits: average error is  44.3% of a typical weight
2 bits: average error is  97.0% of a typical weight
```

Two things to notice:

- **The error roughly doubles for every bit you remove.** At 8 bits it is noise. At 2 bits the weights are almost entirely wrong.
- **Naive 4-bit is rough: 19% error.** Real 4-bit files are far better than this toy, because of the block scales, mixed precision, and calibration from section 6. That gap is exactly what those methods buy you.

## See which quantization you are running

Ollama prints it in the model details:

```bash
ollama show <model-name>
```

With llama.cpp, pick the quantization when you download by adding it after a colon:

```bash
llama-server -hf <org>/<model>-GGUF:Q5_K_M -ngl 99 --port 8080
```

To make your own from a 16-bit GGUF file:

```bash
llama-quantize model-f16.gguf model-q4_k_m.gguf Q4_K_M
```

On a GPU server, vLLM loads pre-quantized checkpoints the same way as any other model. Look for repositories whose names end in `-AWQ` or `-FP8`:

```bash
vllm serve <org>/<model>-FP8
```

A fair test is simple: run the same ten prompts from your real work against two quantization levels and compare the answers side by side. Use the script from the [inference metrics guide](/posts/llm-inference-metrics-ttft-tpot-throughput-goodput/) to compare speed at the same time.

## Which one should you pick?

{{< mermaid caption="Start from where the model runs. The runtime decides the format, and the memory you have decides the bit width." >}}
flowchart TD
    Q1["Where does<br/>the model run?"] p1@-->|"Laptop, CPU<br/>or Mac"| L["GGUF or MLX<br/>start at 4-bit"]
    Q1 p2@-->|"GPU server"| Q2["Does 16-bit fit<br/>with cache room?"]
    L p3@--> L2["Memory left over?<br/>step up to Q5 or Q6"]
    Q2 p4@-->|"Yes"| F["Stay on 16-bit<br/>simplest and safest"]
    Q2 p5@-->|"No"| E["Use FP8 first<br/>then AWQ if still tight"]

    p1@{ animate: true }
    p2@{ animate: true }
    p3@{ animate: true }
    p4@{ animate: true }
    p5@{ animate: true }

    classDef question fill:#281d48,stroke:#a78bfa,color:#f1edff,stroke-width:2px;
    classDef gpu fill:#173f59,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef input fill:#13264a,stroke:#38bdf8,color:#e6f6ff,stroke-width:2px;
    class Q1,Q2 question;
    class L,L2 input;
    class F,E gpu;
{{< /mermaid >}}

### On a laptop or Mac:

- **Start with `Q4_K_M`** (or the 4-bit MLX build). It is the default for a reason.
- **Step up to `Q5_K_M` or `Q6_K`** if the model fits with memory to spare and you care about coding or reasoning quality.
- **Prefer a bigger model at 4-bit** over a smaller model at 8-bit when both fit.

### On a GPU server:

- **Stay on 16-bit** if the weights and a healthy KV cache both fit. It is the best-supported path.
- **Use FP8** when you need room for more concurrent users.
- **Use a 4-bit format such as AWQ** when the model will not fit otherwise, and check quality on your own prompts first.

## Cheat sheet

```text
Quantization    = round each weight to fewer bits so the model takes less memory
Bits per weight = how fine the ruler is: 16 bits has 65,536 marks, 4 bits has 16
Scale           = the shared number weights are divided by before rounding
File size       = parameters x bits per weight / 8
GGUF            = the model file format of llama.cpp, Ollama, and LM Studio
Q4_K_M          = about 4 bits, k-quant method, medium variant; about 4.85 bits on average
Q8_0            = about 8 bits; very close to the original
FP8             = 8-bit floating point weights, common on GPU servers
AWQ / GPTQ      = 4-bit methods that use sample data to protect important weights
QAT             = quantization-aware training: learn with rounding on; best quality, needs training
KV cache        = not shrunk by weight quantization; size it separately
Rule of thumb   = 8-bit is safe, 4-bit is the sweet spot, below 4 falls off fast
```

For the memory math behind these choices, read [How Much GPU Memory Does an LLM Need?](/posts/llm-gpu-memory-sizing-weights-kv-cache/). For plain-English definitions of nearby terms (GGUF, FP16, INT4), see the [AI and LLM glossary](/posts/ai-llm-glossary/).
