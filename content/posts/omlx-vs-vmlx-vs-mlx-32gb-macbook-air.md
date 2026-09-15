+++
title = "oMLX vs vMLX vs MLX: Running Local LLMs on My 32 GB MacBook Air"
date = '2026-09-15T15:00:00+08:00'
draft = false
description = "MLX-LM, vMLX, oMLX, and Ollama's MLX engine compared: setup commands, caching, Mac management, and what published benchmarks actually tell us."
tags = ["ai", "local-llm", "mlx", "omlx", "vmlx", "ollama", "apple-silicon"]
ShowToc = true
TocOpen = false

[cover]
  image = "images/posts/mlx-32gb-macbook-air/00-pixel-art-cover.png"
  alt = "Pixel art MacBook connected to terminal, server, and management panels beside a llama under a night sky"
  relative = false
+++

I've been playing with local LLM inference on my **MacBook Air with 32 GB unified memory**, and three names kept coming up: **MLX, vMLX, and oMLX**. There is also a fourth option worth including: **Ollama's own MLX engine**.

They share some foundations, but solve different parts of the problem. My short answer: start with **MLX-LM** to learn and experiment, consider **vMLX** for a configurable application server, and look at **oMLX** for managing models and persistent caches on a Mac. Ollama belongs on the shortlist if its supported models and existing integrations suit your workflow.

For my MLX-LM, vMLX, and oMLX experiments, I used the same model:

```text
mlx-community/Qwen3-8B-4bit
```

This is an actual [4-bit MLX conversion of Qwen3-8B on Hugging Face](https://huggingface.co/mlx-community/Qwen3-8B-4bit). Keeping the weights consistent is a useful starting point; matching prompts, context, cache state, and generation settings matters too.

**This is a setup and workflow comparison.** I am not publishing a measured speed ranking from my Air here. The performance figures below come from other people's tests on different Macs and models. Commands and project capabilities were checked on September 15, 2026.

## 1. MLX and MLX-LM: the foundation and the simplest starting point

**MLX** is Apple's machine learning framework. Its shared-memory design lets CPU and GPU operations work with the same arrays without explicitly copying data between separate memory pools. It is the foundation, rather than an LLM chat application. [MLX documentation](https://ml-explore.github.io/mlx/build/html/index.html)

**MLX-LM** adds model loading, text generation, fine-tuning, and command-line tools. With Homebrew available, install `uv` once, then install MLX-LM in its own tool environment:

```bash
brew install uv
uv tool install mlx-lm
```

Start a terminal chat:

```bash
mlx_lm.chat --model mlx-community/Qwen3-8B-4bit
```

Or run its OpenAI-compatible server:

```bash
mlx_lm.server \
  --model mlx-community/Qwen3-8B-4bit \
  --host 127.0.0.1 \
  --port 8080
```

The API base URL is `http://localhost:8080/v1`. These are valid installed entry points; the package name uses a hyphen, while the commands use an underscore. Models download from Hugging Face when needed. [MLX-LM source and installation](https://github.com/ml-explore/mlx-lm), [command entry points](https://github.com/ml-explore/mlx-lm/blob/main/setup.py)

### MLX-LM already does more than basic chat

It would be misleading to mark caching or batching as simply missing. The current server has an in-memory prompt cache and concurrent batching for eligible requests. Its `--kv-bits` option reduces KV-cache precision, but currently disables batching. That is a real configuration tradeoff. [Server implementation](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py)

MLX-LM also supports explicitly saving a prompt cache to a file and reusing it with generation. That is different from a server automatically managing a persistent SSD cache across requests and restarts. [Prompt-cache documentation](https://github.com/ml-explore/mlx-lm#long-prompts-and-generations)

For Python experiments and one model at a time, I would start here.

## 2. vMLX: more serving controls

[vMLX](https://github.com/jjang-ai/vmlx) builds on MLX with continuous batching, paged KV caching, prefix reuse, cache quantization, SSD persistence, and OpenAI- and Anthropic-compatible endpoints.

Install and start the basic server:

```bash
uv tool install vmlx
vmlx serve mlx-community/Qwen3-8B-4bit \
  --host 127.0.0.1 \
  --port 8000
```

The API base URL is `http://localhost:8000/v1`. Qwen3-8B-4bit is also the model in the project's quickstart.

To explicitly request continuous batching and paged caching, stop that process and start:

```bash
vmlx serve mlx-community/Qwen3-8B-4bit \
  --host 127.0.0.1 \
  --port 8000 \
  --continuous-batching \
  --use-paged-cache
```

The [configuration reference](https://github.com/jjang-ai/vmlx#configuration) also lists prefix-cache, disk-cache, and KV-quantization options. Supported features are not a promise that every optimization is enabled by the shortest command.

vMLX also has an **MLX Studio desktop app**. Its gateway can route requests to multiple loaded models; that is distinct from one `vmlx serve` process. So the distinction is not “vMLX has no UI, oMLX does.”

I would shortlist vMLX for a local application needing serving controls and multiple client protocols. Whether it handles my workload faster than MLX-LM still needs measurement.

## 3. oMLX: managing a local server day to day

oMLX combines an MLX-based server with model management and tiered caching. Install through Homebrew:

```bash
brew tap jundot/omlx https://github.com/jundot/omlx
brew install jundot/omlx/omlx
omlx start
```

`omlx start` is the documented managed-service command. It does not select Qwen by itself. Open `http://localhost:8000/admin`, search for `mlx-community/Qwen3-8B-4bit`, download it into the configured model directory, and select it for chat. The OpenAI-compatible API uses `http://localhost:8000/v1`. [oMLX installation and quickstart](https://github.com/jundot/omlx#install)

The management experience is what appeals to me: loading and unloading models, changing settings, pinning frequently used models, and automatically evicting others when memory is needed. The admin dashboard is a **web UI**; the separately distributed macOS app provides the native menu-bar experience. Installing the CLI through Homebrew and installing the macOS app are different routes. [oMLX features](https://github.com/jundot/omlx#features)

Underneath, continuous batching and a RAM/SSD KV-cache hierarchy help serve repeated contexts. That makes oMLX an interesting candidate for long-running coding assistants, especially when models or server processes do not stay resident forever.

**Port clash:** vMLX and oMLX both use port 8000 in these examples. Stop one before starting the other. Use `omlx stop` for the managed oMLX service, or Ctrl-C for a foreground server.

## What do batching and caching actually improve?

These features affect different parts of a request:

| Mechanism | What it does | Where I would look for the benefit |
| --- | --- | --- |
| Continuous batching | Lets requests join and leave a running batch | Total throughput with several requests in flight |
| Prefix caching | Reuses attention state for the same beginning of a prompt | Faster follow-up requests with shared context |
| Paged KV cache | Organizes attention state in reusable blocks | Cache allocation and sharing across requests |
| SSD cache | Stores reusable state beyond the in-memory cache | Reuse after memory eviction or restart, when supported |
| KV-cache quantization | Stores attention state at lower precision | Less cache memory, with quality and speed tradeoffs |

A faster **time to first token** means less waiting before the answer begins. Faster **decode** means more output tokens per second after generation starts. Higher **aggregate throughput** means more work completed across concurrent requests. A server can improve one without improving all three.

## What the published benchmarks actually tell us

### MLX-LM versus oMLX on an M4 Max

The June excerpt comes from Michael Hannecke's [“mlx-lm vs oMLX: I Was Wrong About the Winner”](https://medium.com/macoclock/mlx-lm-vs-omlx-i-was-wrong-about-the-winner-8f36be328069), published June 23, 2026. He used **MLX-LM 0.31.3**, **oMLX 0.4.4**, and **gemma-4-31b-it-4bit** on a **64 GB Mac Studio M4 Max**.

For a repeated 8,000-token prefix, he reported:

| Warm repeated-prefix request | Reported time |
| --- | --- |
| MLX-LM | 3.4 seconds |
| oMLX | 3.6 seconds |

That small difference is not convincing evidence of a speed winner from a single run. Both benefited from prompt caching. The more useful distinction appeared after restarting: oMLX could restore persisted state from SSD, while MLX-LM's server lost its in-memory cache. The author also reported a slower genuinely cold start for oMLX, which included loading and cache setup.

My takeaway is to separate **warm reuse**, **first-ever startup**, and **post-restart reuse**. This study supports investigating oMLX's persistence; it does not establish a Qwen3-8B winner on my Air.

### The LargitData M5 Max comparison needs a qualification

The [LargitData article](https://www.largitdata.com/blog/mlx-inference-benchmark-apple-m5-max/) compares rapid-mlx, oMLX, dflash-mlx, and mlx-vlm. Its published table puts oMLX at **82.1 tokens/s** and dflash-mlx at **12.6 tokens/s** at 32,768 tokens of context, supporting its preference for oMLX at long context.

However, the linked [benchmark repository's current README](https://github.com/ywchiu/mlx_benchmark_lab) reports a later dflash-mlx 0.1.7 retest that leads decode speed across the tested contexts. It also discloses **60-second cooldowns for that retest versus 2 seconds for the other engines**. Those are different thermal conditions, so the updated ranking also needs care.

The primary comparison uses **Qwen3.6-35B-A3B-4bit on an M5 Max with 64 GB**, and measures single-sequence workloads. Neither vMLX nor standalone MLX-LM is a participant. The MTPLX addendum even uses a different model.

I would use this source to understand context-length sensitivity, not to declare oMLX the fastest option for this post's model and hardware.

## Where Ollama's own MLX engine fits

Ollama now has its own **MLX-based inference engine**. Its [March 2026 announcement](https://ollama.com/blog/mlx) introduced the Apple Silicon preview, and its [June performance update](https://ollama.com/blog/mlx-performance) describes kernel fusion, GPU sampling improvements, and model-optimized NVFP4 support.

With a current Ollama installation, its documented example is:

```bash
ollama run gemma4:12b-mlx
```

That is a separate example, **not the Qwen3-8B-4bit checkpoint used above**. An Ollama tag, a GGUF quantization, and a Hugging Face MLX conversion are not automatically equivalent just because all say “4-bit.”

Ollama's MLX implementation may work better for some people: familiar model commands and integrations can matter more than another server's settings panel. Its performance improvements are also model-specific; they do not prove it beats vMLX or oMLX with identical Qwen weights.

For context, my earlier [Ollama](/posts/running-ollama-on-32gb-macbook-air/) and [llama.cpp](/posts/running-llama-cpp-on-32gb-macbook-air/) posts concern the GGUF path. Their results should not be read as measurements of this newer MLX engine.

## So which one edges ahead for my 32 GB Air?

| My priority | Where I would start | Why |
| --- | --- | --- |
| Learn MLX, script inference, or fine-tune | **MLX-LM** | Direct access to the underlying LLM tools |
| Tune a local application server | **vMLX** | Serving controls, cache options, and multiple API formats |
| Manage a persistent local AI service | **oMLX** | Model lifecycle controls, dashboard, and persistent cache |
| Keep an existing Ollama workflow | **Ollama MLX** | Familiar integrations with an MLX engine for supported models |
| Pick the fastest Qwen3-8B server | **Measure on the Air** | The linked studies do not settle this comparison |

On a 32 GB machine, I would begin with one loaded model and a modest context limit. Model weights are only part of memory use: attention state, temporary buffers, macOS, and other apps need space too. An SSD cache can preserve reusable work; it does not make SSD bandwidth equivalent to unified memory.

Before choosing on speed, I would keep the model revision, prompt, output limit, sampling settings, and Qwen thinking mode consistent. Then measure four cases separately: a fresh prompt with the model already loaded, a warm repeated prefix, the same prefix after restart, and several simultaneous requests. Record first-token latency, generation rate, memory pressure, and swap, and repeat under comparable power and thermal conditions.

**My current preference is MLX-LM for experiments and oMLX for day-to-day management.** vMLX is worth evaluating when serving controls drive the decision, and Ollama MLX deserves a test if I want to keep my existing workflow. The useful improvement is the one I notice in my actual requests—not the largest number from another Mac.
