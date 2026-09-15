+++
title = "oMLX vs vMLX vs MLX: Running Local LLMs on My 32 GB MacBook Air"
date = '2026-09-15T15:00:00+08:00'
draft = false
description = "Running local LLMs on a 32 GB MacBook Air: simple MLX-LM setup, vMLX serving controls, oMLX model management, and Ollama MLX."
tags = ["ai", "local-llm", "mlx", "omlx", "vmlx", "ollama", "apple-silicon"]
ShowToc = true
TocOpen = false

[cover]
  image = "images/posts/mlx-32gb-macbook-air/00-pixel-art-cover.png"
  alt = "Pixel art MacBook connected to terminal, server, and management panels beside a llama under a night sky"
  relative = false
+++

I've been playing with local LLMs on my **32 GB MacBook Air**. Three names kept coming up: **MLX, vMLX, and oMLX**. Then there is **Ollama's own MLX engine**.

The names sound similar. The real difference is how much help each gives you around running the model.

For MLX-LM, vMLX, and oMLX, I used the same [4-bit Qwen3 model](https://huggingface.co/mlx-community/Qwen3-8B-4bit):

```text
mlx-community/Qwen3-8B-4bit
```

## MLX / MLX-LM: simple, direct, flexible

[MLX](https://ml-explore.github.io/mlx/build/html/index.html) is Apple's machine learning framework. It uses unified memory so CPU and GPU operations can share the same data.

[MLX-LM](https://github.com/ml-explore/mlx-lm) supplies the LLM tools: load models, chat, generate text, and fine-tune.

**Main benefit: a straightforward way to run a model and experiment with it.**

Install `uv` once through Homebrew, then MLX-LM:

```bash
brew install uv
uv tool install mlx-lm
```

Start chatting:

```bash
mlx_lm.chat --model mlx-community/Qwen3-8B-4bit
```

Or expose an OpenAI-compatible API:

```bash
mlx_lm.server \
  --model mlx-community/Qwen3-8B-4bit \
  --host 127.0.0.1 \
  --port 8080
```

API base: `http://localhost:8080/v1`. The model downloads from Hugging Face if needed.

MLX-LM already supports **in-memory prompt caching and concurrent batching** for eligible requests. Repeated prompts can reuse work instead of starting from scratch. [Server implementation](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py)

It also supports saving prompt caches to files. That gives scripts explicit cache reuse, while automated SSD-cache management is a separate serving feature.

**My pick for:** terminal chat, Python experiments, fine-tuning, and learning how inference works.

## vMLX: more control over serving

[vMLX](https://github.com/jjang-ai/vmlx) adds serving controls around MLX: continuous batching, paged KV caching, prefix reuse, cache quantization, and SSD persistence.

**Main benefit: more control when an application sends multiple requests.**

```bash
uv tool install vmlx
vmlx serve mlx-community/Qwen3-8B-4bit \
  --host 127.0.0.1 \
  --port 8000 \
  --continuous-batching \
  --use-paged-cache
```

API base: `http://localhost:8000/v1`. The command explicitly enables continuous batching and paged caching.

Batching lets requests share GPU work. Paged caching organizes attention state into reusable blocks. These features become useful as conversations and concurrent requests grow.

The [configuration options](https://github.com/jjang-ai/vmlx#configuration) also include disk caching and KV-cache quantization. Enable and tune these for the workload; the basic command does not enable every feature.

vMLX supports **OpenAI and Anthropic API formats**. Its **MLX Studio desktop app** adds a UI and a gateway for multiple loaded models.

**My pick for:** local apps, multiple clients, and tuning how requests are served.

## oMLX: easier everyday management

[oMLX](https://github.com/jundot/omlx) combines inference with model management and a cache that spans RAM and SSD.

**Main benefit: less manual work keeping a local AI server useful.**

```bash
brew tap jundot/omlx https://github.com/jundot/omlx
brew install jundot/omlx/omlx
omlx start
```

Open `http://localhost:8000/admin`. Search for `mlx-community/Qwen3-8B-4bit`, download it into the configured model directory, and select it for chat.

API base: `http://localhost:8000/v1`.

The dashboard lets me manage models and settings without doing everything in the terminal. Pin frequently used models, unload others, or let automatic eviction free memory.

The **admin dashboard is a web UI**. The separately available **macOS app** provides the native menu-bar experience.

Persistent caching is another useful benefit. Supported cached context can be restored from SSD after a restart or eviction, reducing repeated prompt processing.

**My pick for:** an everyday local AI service, switching models, and long-running coding assistants.

**Port note:** vMLX and oMLX both use port 8000 above. Run one at a time. Stop the managed oMLX service with `omlx stop`; use Ctrl-C for foreground servers.

## Where the performance benefits come from

**Repeated prompts:** MLX-LM already caches context in memory. Adding a serving layer does not automatically make every follow-up faster.

**After a restart:** persistent SSD caching gives vMLX and oMLX another way to recover reusable context. Restoring that work can be cheaper than processing the whole prompt again.

**Several requests at once:** batching targets total throughput. Completing more requests together does not necessarily mean one chat generates tokens faster.

**Long conversations:** cache size and memory pressure become increasingly important. On my 32 GB Air, I would leave room for macOS, other apps, and temporary inference buffers.

**First request:** downloading, loading weights, and processing a fresh prompt are separate costs. A fast cached response says little about a completely fresh start.

The distinction I care about is simple: **how soon the answer starts, how quickly it continues, and how much memory the server needs**. Those are three different things to optimize.

## Ollama MLX: keep a familiar workflow

Ollama has its own [MLX-based inference engine](https://ollama.com/blog/mlx-performance), with optimized kernels and sampling for supported models.

**Main benefit: MLX inference through familiar Ollama commands and integrations.**

With a current Ollama installation, one supported example is:

```bash
ollama run gemma4:12b-mlx
```

This uses a different model from the Qwen3 example above. Different 4-bit formats also have different tradeoffs, so I would keep the weights and quantization consistent for a speed comparison.

Ollama MLX may work better for some people, especially when their apps already integrate with Ollama. It deserves a place alongside the dedicated MLX servers.

**My pick for:** keeping an existing Ollama setup with supported MLX models.

## Which would I choose?

| Tool | Clearest benefit | Where I would use it |
| --- | --- | --- |
| **MLX-LM** | Direct, flexible LLM tools | Learning, scripting, fine-tuning |
| **vMLX** | Serving and cache controls | Local apps and concurrent requests |
| **oMLX** | Model management and persistent caching | Everyday local AI and coding assistants |
| **Ollama MLX** | Familiar commands and integrations | Existing Ollama workflows |

**For experiments, I would start with MLX-LM. For everyday management, I lean toward oMLX.**

vMLX is appealing when I want more serving controls. Ollama MLX is appealing when I want to keep the workflow I already have.

On a 32 GB Air, I would start with one loaded model and a modest context limit. Then increase context and concurrency while watching memory pressure and response time.
