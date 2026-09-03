+++
title = "Running llama.cpp on a 32 GB MacBook Air: A Direct Comparison with Ollama"
date = '2026-09-03T10:30:00+08:00'
draft = false
description = "Compile llama.cpp with Metal support on Apple Silicon, serve local GGUF models, and benchmark prompt eval and generation speeds head-to-head against Ollama."
tags = ["ai", "local-llm", "llama-cpp", "ollama", "apple-silicon", "benchmarks"]
ShowToc = true
TocOpen = false
+++

In the [previous post](/posts/running-ollama-on-32gb-macbook-air/), I ran Ornith 1.5 9B on my 32 GB MacBook Air using Ollama and recorded baseline token-generation speeds on short prompts. Ollama is great for getting up and running quickly, but under the hood, its inference engine is built on [llama.cpp](https://github.com/ggml-org/llama.cpp).

In this post, we go one level down: building and running llama.cpp directly, offloading inference to Apple Silicon's Metal GPU, and comparing performance numbers side by side with Ollama on the exact same model and quantization level.

### Step 1: Build llama.cpp from Source

Building llama.cpp from source on macOS is fast and straightforward. On Apple Silicon, CMake automatically enables Metal support (`GGML_METAL=ON`) and compiles GPU compute kernels tailored for Apple's unified memory architecture.

Clone the repository and compile the release binaries using all available CPU cores:

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j$(sysctl -n hw.logicalcpu)
```

Once the build finishes, the binaries live in `build/bin`. Add them to your current session's `$PATH`:

```bash
export PATH="$(pwd)/build/bin:$PATH"
```

To make this permanent across terminal sessions, append it to your shell configuration:

```bash
echo "export PATH=\"$(pwd)/build/bin:\$PATH\"" >> ~/.zshrc
source ~/.zshrc
```

Confirm that the build succeeded:

```bash
llama-server --version
```

### Step 2: Serve the Model (Out-of-the-Box Baseline)

llama.cpp can download GGUF models directly from Hugging Face Hub using the `-hf` flag, caching weights under `~/.cache/huggingface/hub`:

```bash
llama-server -hf ornith-ai/Ornith-1.5-9B-GGUF --port 8080 -ngl 99
```

Here is what the flags do:
- `-hf ornith-ai/Ornith-1.5-9B-GGUF`: Resolves the model on Hugging Face and downloads the default `Q4_K_M` quant.
- `-ngl 99`: Offloads all 99 model layers to the GPU (Metal on Apple Silicon unified memory).
- `--port 8080`: Binds the OpenAI-compatible HTTP server to port 8080.

{{< figure src="/images/posts/llama-cpp-32gb-macbook-air/01-llama-server-start.png" alt="Starting llama-server and downloading Ornith 1.5 9B from Hugging Face" caption="Starting llama-server with automatic Hugging Face download and full Metal GPU offload." class="post-screenshot" >}}

During startup, llama.cpp downloads both the multimodal vision projector (`mmproj-Ornith-1.5-9B-BF16.gguf`) and the main model weights (`Ornith-1.5-9B-Q4_K_M.gguf`), offloads the layers into Metal, initializes inference slots, and listens on port 8080.

We test this default setup with a short greeting prompt through the OpenAI-compatible API:

```bash
curl http://localhost:8080/v1/chat/completions \
  -d '{
    "model": "ornith-1.5-9b",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

{{< figure src="/images/posts/llama-cpp-32gb-macbook-air/02-llama-server-first-request.png" alt="Calling the llama-server chat completions API" caption="First chat completion request via curl, returning detailed server-side timing breakdowns." class="post-screenshot" >}}

The response returns a complete timing breakdown in the `timings` object:

```
prompt eval time = 496.21 ms / 12 tokens (24.18 tokens per second)
eval time        = 5527.17 ms / 96 tokens (17.19 tokens per second)
```

Compare that to Ollama's numbers on the same model and quant from the [earlier post](/posts/running-ollama-on-32gb-macbook-air/):

| Metric | Ollama (Default) | llama.cpp (Default, no `-fa`) |
| --- | --- | --- |
| **Prompt Eval Speed** | **37.13 tokens/s** | 24.18 tokens/s |
| **Generation Speed** | 16.68 tokens/s | **17.19 tokens/s** |

Generation speed is practically neck-and-neck (~17 tokens/s). However, prompt evaluation (prefill latency) was noticeably slower on vanilla llama.cpp out of the box (24.18 tokens/s vs. Ollama's 37.13 tokens/s).

Ollama enables FlashAttention and sensible batch sizes by default, while raw llama.cpp keeps conservative baseline settings unless configured explicitly.

### Step 3: Verifying the Quants

Before comparing benchmark numbers, it is critical to confirm that both engines are executing the exact same quantization format. Comparing different quants (e.g. Q4_K_M vs Q8_0) would invalidate any performance conclusions.

Check the quant llama.cpp loaded:

```bash
curl -s http://localhost:8080/v1/models | jq
```

```json
"ftype": "Q4_K - Medium"
```

Check the quant Ollama is using:

```bash
curl -s http://localhost:11434/api/show -d '{"model": "ornith-1.5:9b"}' | jq '.details.quantization_level'
```

```json
"Q4_K_M"
```

Both runtimes are confirmed to be executing `Q4_K_M`. Precision and model size are strictly identical.

### Step 4: Leveling the Playing Field with Flash Attention & Batch Tuning

To give llama.cpp parity with Ollama's runtime optimizations, we restart `llama-server` with FlashAttention enabled and explicit batch sizes configured:

```bash
llama-server -hf ornith-ai/Ornith-1.5-9B-GGUF --port 8080 -ngl 99 -fa on -b 2048 -ub 512
```

Here is what these tuning flags configure:
- `-fa on` (or `--flash-attn on`): Enables FlashAttention kernels for Apple Silicon Metal. This significantly accelerates prompt evaluation (prefill) and reduces memory bandwidth overhead.
- `-b 2048` (`--batch-size`): Sets the logical batch size for prompt evaluation.
- `-ub 512` (`--ubatch-size`): Sets the physical micro-batch size dispatched to Metal compute passes, keeping the GPU pipelines fully saturated.

### Step 5: Side-by-Side Benchmark on Longer Generation

Both engines were given the same prompt:

> `"give a 25 line story"`

A longer generation produces several hundred tokens, giving a much more reliable measurement of steady-state generation speed than short one-liners.

Here are the side-by-side results on the 32 GB MacBook Air:

| Metric | Ollama (`ornith-1.5:9b`) | llama.cpp (`-fa on -b 2048 -ub 512`) |
| --- | --- | --- |
| **Prompt Eval Count** | 17 tokens | 18 tokens |
| **Prompt Eval Speed** | 46.01 tokens/s | **48.68 tokens/s** |
| **Generation Count** | 496 tokens | 436 tokens |
| **Generation Speed** | 16.42 tokens/s | **17.07 tokens/s** |
| **Total Duration** | 30.58 s | **25.85 s** |

With FlashAttention and batch tuning enabled, llama.cpp matches or slightly edges out Ollama across both prompt evaluation (**48.68 vs. 46.01 tokens/s**) and token generation speed (**17.07 vs. 16.42 tokens/s**).

#### Ollama Command & Stats

```bash
ollama run ornith-1.5:9b --verbose
>>> give a 25 line story
Thinking...
...done thinking.

[story output omitted]

total duration:       30.582007541s
load duration:        2.821208ms
prompt eval count:    17 token(s)
prompt eval duration: 369.481ms
prompt eval rate:     46.01 tokens/s
eval count:           496 token(s)
eval duration:        30.204706s
eval rate:            16.42 tokens/s
```

#### llama.cpp Server Startup & Timing Logs

Server startup and live slot execution log:

```text
➜  ~ llama-server -hf ornith-ai/Ornith-1.5-9B-GGUF --port 8080 -ngl 99 -fa on -b 2048 -ub 512
0.00.729.018 I cmn  common_param: common_params_print_info: verbosity = 3 (adjust with the `-lv N` CLI arg)
0.00.729.664 W srv  llama_server: -----------------
0.00.729.667 W srv  llama_server: CORS is set to allow all origins ('*') and no API key is set
0.00.729.668 W srv  llama_server: this can be a security risk (cross-origin attacks)
0.00.729.668 W srv  llama_server: more info: https://github.com/ggml-org/llama.cpp/pull/25655
0.00.729.669 W srv  llama_server: -----------------
0.00.731.435 I srv    load_model: loading model 'ornith-ai/Ornith-1.5-9B-GGUF'
0.01.177.317 W model has unused tensor blk.32.attn_norm.weight (size = 16384 bytes) -- ignoring
0.01.177.324 W model has unused tensor blk.32.post_attention_norm.weight (size = 16384 bytes) -- ignoring
0.01.177.329 W model has unused tensor blk.32.attn_q.weight (size = 18874368 bytes) -- ignoring
0.01.177.331 W model has unused tensor blk.32.attn_k.weight (size = 2359296 bytes) -- ignoring
0.01.177.333 W model has unused tensor blk.32.attn_v.weight (size = 3440640 bytes) -- ignoring
0.01.177.338 W model has unused tensor blk.32.attn_output.weight (size = 9437184 bytes) -- ignoring
0.01.177.340 W model has unused tensor blk.32.attn_q_norm.weight (size = 1024 bytes) -- ignoring
0.01.177.341 W model has unused tensor blk.32.attn_k_norm.weight (size = 1024 bytes) -- ignoring
0.01.177.343 W model has unused tensor blk.32.ffn_gate.weight (size = 28311552 bytes) -- ignoring
0.01.177.345 W model has unused tensor blk.32.ffn_down.weight (size = 41287680 bytes) -- ignoring
0.01.177.347 W model has unused tensor blk.32.ffn_up.weight (size = 28311552 bytes) -- ignoring
0.01.177.350 W model has unused tensor blk.32.nextn.eh_proj.weight (size = 18874368 bytes) -- ignoring
0.01.177.353 W model has unused tensor blk.32.nextn.enorm.weight (size = 16384 bytes) -- ignoring
0.01.177.354 W model has unused tensor blk.32.nextn.hnorm.weight (size = 16384 bytes) -- ignoring
0.01.177.359 W model has unused tensor blk.32.nextn.shared_head_norm.weight (size = 16384 bytes) -- ignoring
0.01.799.972 I cmn          init: llama threadpool init, n_threads = 4
0.01.959.375 W load_hparams: Qwen-VL models require at minimum 1024 image tokens to function correctly on grounding tasks
0.01.959.377 W load_hparams: if you encounter problems with accuracy, try adding --image-min-tokens 1024
0.01.959.377 W load_hparams: more info: https://github.com/ggml-org/llama.cpp/issues/16842

0.02.172.437 I srv    load_model: loaded multimodal model, '/Users/vishnuhd/.cache/huggingface/hub/models--ornith-ai--Ornith-1.5-9B-GGUF/snapshots/abdd624b12ebf020b767fff532ff44fe552b28c3/mmproj-Ornith-1.5-9B-BF16.gguf'
0.02.399.797 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 262144, kv_unified = 'true'
0.02.402.615 I srv          init: chat template supports preserving reasoning, consider enabling it via --reasoning-preserve
0.02.402.621 I srv  llama_server: model loaded
0.02.402.623 I srv  llama_server: listening on http://127.0.0.1:8080
0.02.402.623 W srv  llama_server: NOTICE: server default port will be changed to :9931 in a future release
0.02.402.623 W srv  llama_server:         ref: https://github.com/ggml-org/llama.cpp/pull/26508

0.36.386.802 I slot get_availabl: id  3 | task -1 | selected slot by LRU, t_last = -1
0.36.386.826 I slot launch_slot_: id  3 | task 0 | processing task, is_child = 0
0.42.586.497 I slot print_timing: id  3 | task 0 | n_gen =    100, tg =  16.98 t/s, tg_3s =  17.15 t/s
0.45.633.605 I slot print_timing: id  3 | task 0 | n_gen =    152, tg =  17.01 t/s, tg_3s =  17.07 t/s
0.48.679.586 I slot print_timing: id  3 | task 0 | n_gen =    204, tg =  17.03 t/s, tg_3s =  17.07 t/s
0.51.718.658 I slot print_timing: id  3 | task 0 | n_gen =    256, tg =  17.04 t/s, tg_3s =  17.11 t/s
0.54.746.036 I slot print_timing: id  3 | task 0 | n_gen =    308, tg =  17.07 t/s, tg_3s =  17.18 t/s
0.57.778.672 I slot print_timing: id  3 | task 0 | n_gen =    360, tg =  17.08 t/s, tg_3s =  17.15 t/s
1.00.817.109 I slot print_timing: id  3 | task 0 | n_gen =    412, tg =  17.08 t/s, tg_3s =  17.11 t/s
1.02.233.148 I slot print_timing: id  3 | task 0 | prompt eval time =     369.74 ms /    18 tokens (   20.54 ms per token,    48.68 tokens per second)
1.02.233.155 I slot print_timing: id  3 | task 0 |        eval time =   25476.17 ms /   436 tokens (   58.57 ms per token,    17.07 tokens per second)
1.02.233.157 I slot print_timing: id  3 | task 0 |       total time =   25845.92 ms /   454 tokens
1.02.233.159 I slot print_timing: id  3 | task 0 |    graphs reused =        434
1.02.233.187 I slot      release: id  3 | task 0 | stop processing: n_tokens = 453, truncated = 0
```

And the raw curl request (with story output trimmed):

```bash
curl http://localhost:8080/v1/chat/completions \
  -d '{
    "model": "ornith-1.5-9b",
    "messages": [{"role": "user", "content": "Give me a 25 line story"}]
  }'
```

```json
{
  "choices": [{
    "finish_reason": "stop",
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "[story text omitted]",
      "reasoning_content": "[thinking omitted]"
    }
  }],
  "created": 1788423730,
  "model": "ornith-ai/Ornith-1.5-9B-GGUF",
  "system_fingerprint": "b10712-daef7b687",
  "object": "chat.completion",
  "usage": {
    "completion_tokens": 436,
    "prompt_tokens": 18,
    "total_tokens": 454,
    "prompt_tokens_details": {
      "cached_tokens": 0
    }
  },
  "id": "chatcmpl-dLoeYkd6rvuFieOvUSr9dBxB798twvZi",
  "timings": {
    "cache_n": 0,
    "prompt_n": 18,
    "prompt_ms": 369.742,
    "prompt_per_token_ms": 20.54,
    "prompt_per_second": 48.68,
    "predicted_n": 436,
    "predicted_ms": 25476.174,
    "predicted_per_token_ms": 58.57,
    "predicted_per_second": 17.07
  }
}
```

### Key Takeaways

1. **Ollama is not faster than llama.cpp**: Under the hood, Ollama is llama.cpp. Its initial out-of-the-box advantage in prompt evaluation comes entirely from default runtime tuning (FlashAttention and batch sizes), not a secret runtime or different quantization.
2. **FlashAttention is essential on Apple Silicon**: Enabling `-fa on` doubled prompt evaluation speed from **24.18 tokens/s to 48.68 tokens/s**, drastically cutting time-to-first-token.
3. **Consistent throughput**: At 9B parameters with Q4_K_M quantization, Apple Silicon unified memory sustains a rock-solid **~17.1 tokens/sec**.
4. **Why run llama.cpp directly?**: Ollama provides exceptional developer ergonomics for local apps and testing. But direct llama.cpp gives you full control over context allocation, slot limits, KV cache quantization (`-ctk`, `-ctv`), and immediate access to upstream features and bugfixes.

In the next post, we will explore KV cache quantization and memory profiling to see how far we can stretch long-context windows on a 32 GB machine.