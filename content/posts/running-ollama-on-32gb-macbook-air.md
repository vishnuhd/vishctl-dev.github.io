+++
title = "Running Ollama on a 32 GB MacBook Air: A Practical First Setup"
date = '2026-09-03T09:30:00+08:00'
draft = false
description = "Install Ollama, pull and run local models, and call the local API on a 32 GB Apple-silicon MacBook Air."
tags = ["ai", "local-llm", "ollama", "apple-silicon", "homelab"]
ShowToc = true
TocOpen = true
+++

I have a 32 GB MacBook Air. It is not a workstation GPU box, but its unified memory makes it a surprisingly capable machine for local models, provided I choose models that fit and keep expectations sensible.

This is the first post in a small, practical series about running models locally. I am starting with Ollama because it gets a model running quickly without building a runtime from source or hand-managing dependencies.

### Why Ollama

[Ollama](https://ollama.com/) manages model downloads, exposes a straightforward CLI, and starts a local HTTP API. On Apple silicon, it supports the Apple GPU; Ollama's current macOS requirement is Sonoma (14) or newer. The app stores models and configuration under `~/.ollama`. [The macOS documentation](https://docs.ollama.com/macos) is the useful reference for install, storage, and logs.

Under the hood, Ollama packages model management and an API around inference backends including [llama.cpp](https://github.com/ggml-org/llama.cpp). That distinction is useful: Ollama is the convenient front door; llama.cpp is a lower-level route I can use later when I want to compare runtimes directly.

### Step 1: Install Ollama

Download the macOS app from [ollama.com/download](https://ollama.com/download), mount the DMG, and drag Ollama to `/Applications`. Start it once. If the CLI is not already available, the app will offer to add it to your path.

Confirm that both the CLI and the local server are available:

```bash
ollama --version
ollama list
ollama ps
```

On a new installation, `ollama list` and `ollama ps` should be empty. The first reports downloaded models; the second reports models currently loaded into memory.

### Step 2: Pull a Model

For this machine, I started with Ornith 1.5 9B:

```bash
ollama pull ornith-1.5:9b
```

This feels deliberately familiar if you work with containers: `ollama pull` downloads the model and its layers, while `ollama run` starts an interactive session. The current Ollama build of `ornith-1.5:9b` is 6.6 GB with a 256K context window, which is a comfortable starting point on a 32 GB laptop. [Ollama's model page](https://ollama.com/library/ornith-1.5) lists the available tags; the 35B download is 23 GB, so I would not make that the default on an Air.

![Pulling Ornith 1.5 9B, then confirming the local model](/images/posts/ollama-32gb-macbook-air/01-pull-ornith-1-5-9b.png)

After the pull completes, confirm it is available:

```bash
ollama list
```

### Step 3: Run It Interactively

Start a chat session with the model:

```bash
ollama run ornith-1.5:9b
```

Use a question that resembles the work you actually do. I tested a simple greeting first, then moved on to infrastructure questions. Exit the interactive prompt with `/exit` or `Ctrl-D`.

![An interactive Ornith 1.5 9B session in the terminal](/images/posts/ollama-32gb-macbook-air/02-run-ornith-1-5-9b.png)

For an initial sanity check, the model was responsive and produced a natural answer. That is useful confirmation that the model loads and runs locally, but it is not a benchmark. A real comparison needs the same prompt, context length, generation settings, and output length.

### Step 4: Inspect Performance with `--verbose`

Ollama's `--verbose` flag is a quick way to see timings after every response:

```bash
ollama run ornith-1.5:9b --verbose
```

On this MacBook Air, my short greeting test produced 114 output tokens at **16.68 tokens/sec**, with a total duration of **7.22 seconds**. The model's thinking trace was visible before its answer.

I ran the same kind of test with Gemma 4 E4B:

```bash
ollama run gemma4:e4b --verbose
```

That run produced 228 output tokens at **27.62 tokens/sec**, with a total duration of **8.49 seconds**. It is faster in this small test, but it also generated a different and longer response. These figures are useful as a personal baseline, not as an apples-to-apples model ranking.

### Ornith 1.5 9B vs. Gemma 4 E4B

Both models fit well on a 32 GB MacBook Air, but they are aimed at slightly different trade-offs.

| Model | What I observed | Practical fit |
| --- | --- | --- |
| `ornith-1.5:9b` | 6.6 GB download; 16.68 tokens/sec in my short verbose run | A capable 9B-class, text-and-image model with plenty of memory headroom |
| `gemma4:e4b` | 9.6 GB download; 27.62 tokens/sec in my different short verbose run | An efficient edge model for local chat, reasoning, coding, and multimodal work |

The `E` in Gemma 4 E4B means **effective** parameters. Ollama describes E4B as a 4.5B-effective-parameter edge model (8B including embeddings), with a 128K context window and text, image, and audio support. It is designed to do useful local work without the memory cost of the larger Gemma 4 workstation models. [The Gemma 4 library page](https://ollama.com/library/gemma4) has the current tags, sizes, and capabilities.

In practice, I would start with `ornith-1.5:9b` if I want the smaller download and a roomy 256K context window, or `gemma4:e4b` if I want the efficient Gemma 4 feature set. Neither of these two quick runs says which model is universally better; use the prompts you care about and record the result.

### Step 5: Call the Local API

The terminal chat is only the first test. Ollama exposes an API locally at `http://localhost:11434/api`, so the model can be part of a script or an application.

```bash
curl http://localhost:11434/api/chat \
  -d '{
    "model": "ornith-1.5:9b",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

![Calling the local Ollama chat API with curl](/images/posts/ollama-32gb-macbook-air/03-ornith-local-api.png)

The response includes the answer and useful timing fields. Keep this endpoint local by default. If I later expose it to another device, I will put authentication and a proper reverse proxy in front of it. I will not publish port 11434 directly. [Ollama's API documentation](https://docs.ollama.com/api/introduction) covers the local base URL and client libraries.

### Step 6: Try the App UI

The CLI is great for testing and scripts, but the Ollama app also gives me a simple chat interface. Here, Ornith is selected in the model picker and used for a weather question.

![The Ollama app with Ornith 1.5 9B selected](/images/posts/ollama-32gb-macbook-air/04-ollama-app-ornith.png)

The UI is useful when I want to compare prompts casually. The local API is the path I will use when I want to integrate models into tooling.

### Commands Worth Remembering

```bash
# Download without entering an interactive chat
ollama pull ornith-1.5:9b

# Start an interactive chat
ollama run ornith-1.5:9b

# Show downloaded models and their disk usage
ollama list

# Show models currently loaded by the runner
ollama ps

# Remove a model I no longer need
ollama rm ornith-1.5:9b
```

Models are not small. Treat `ollama pull` the same way you would a sizeable `docker pull`: check disk space before collecting a pile of models "just in case."

### What This MacBook Air Is Good At

An 8B–9B class model is a good fit for private note summarisation, explaining logs, drafting YAML, lightweight coding help, and experimenting with local integrations. This is not where I expect a 70B-class model to be effortless or where I would host production inference.

There are many ways to run models locally, but Ollama is an excellent Apple-silicon starting point. It gets the plumbing out of the way so I can spend time evaluating the models themselves.

Next, I will run llama.cpp directly on the same machine, then see whether a vLLM setup is worth comparing. Stay tuned.
