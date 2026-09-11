+++
title = "What Happens When You Ask an LLM a Question"
date = '2026-09-11T12:00:00+08:00'
draft = false
description = "My visual notes on how LLMs work: tokens, parameters, attention, reasoning, KV cache, quantization, and serving models on GPUs."
tags = ["ai", "local-llm", "llm-basics", "gpu", "vllm"]
ShowToc = true
TocOpen = false
+++

I have been running models with [Ollama](/posts/running-ollama-on-32gb-macbook-air/) and [vLLM](/posts/vllm-on-wsl2-minikube/). Then I stopped to ask: what is actually happening behind that API call?

A learning chat turned into these notes. Let's follow one request all the way through:

> Why did my Kubernetes pod restart? The container's last termination reason is OOMKilled.

This is an illustrative example, not a live diagnosis. We will use a hypothetical **2B model** throughout. Technically, the container restarted within the pod.

## 1. An answer grows one token at a time

An **LLM**, or large language model, is a neural network trained on language. For the text-generating models here, the basic loop is: use the text so far to predict what comes next.

![A prompt becomes tokens, numerical vectors, Transformer computations, and a next-token choice that feeds back into the input.](/images/posts/llm-basics/01-token-loop.svg)

A **token** can be a word, part of a word, or punctuation. The tokenizer assigns each piece an ID. An **embedding** turns that ID into a list of numbers the network can process. The model also needs information about token positions.

For our prompt, a tokenizer might split `restarted` into `restart` and `ed`. Exact splits depend on the tokenizer. Each piece gets an ID, then a numerical vector.

The answer might grow as `The` → ` container` → ` was` → ` killed`. These are illustrative token boundaries. The model chooses from next-token scores using its generation settings, then repeats.

## 2. What does a 2B model actually contain?

**About two billion adjustable numbers**, called parameters. Most are weights used in the network's calculations. They collectively encode learned patterns, rather than one fact per number.

![Training adjusts parameters through prediction and feedback. Inference uses those learned parameters with your current prompt.](/images/posts/llm-basics/02-training.svg)

A neural network is a stack of mathematical operations. A simple neuron combines weighted inputs, adds a bias, and applies an activation function. Many such operations let the network learn complex patterns.

During training, examples about containers and memory can shape these numbers. Our question then uses those learned patterns to connect `OOMKilled` with an out-of-memory event. There is no single "Kubernetes parameter."

**Training changes the parameters. Ordinary inference uses them.** Chatting adds context; it does not normally retrain the model. A bigger parameter count alone does not guarantee better answers.

## 3. Transformers connect the relevant pieces

A **Transformer** is the architecture behind many LLMs. Its layers combine attention with other neural-network calculations.

**Attention** mixes information from tokens in the available context. In a typical text generator, a token can attend to itself and earlier tokens.

![Our Kubernetes restart question contains the clue OOMKilled. Query and key comparisons help combine relevant information.](/images/posts/llm-basics/03-attention.svg)

In our request, `OOMKilled` is a useful clue for explaining `restart`. Attention helps combine information from those positions while the layers build the response.

The diagram is an intuition, not a measured attention map. **Q, K, and V are learned numerical representations**, not literal questions or database entries. Multiple attention heads can capture different relationships. [Google's Transformer introduction](https://developers.google.com/machine-learning/crash-course/llm/transformers) explains the architecture further.

## 4. Why can it reason, and still be wrong?

Learning to predict language can build useful patterns for code, maths, and problem solving. Further training can improve instruction following and reasoning.

A model can use intermediate steps to work through a problem. Some reasoning models spend additional computation before answering. This can help, but a fluent explanation is not proof.

> A useful answer: "OOMKilled indicates an out-of-memory kill. Check the container's memory limit and memory usage."

It would be a leap to say **"Your app definitely has a memory leak."** Our prompt gives no evidence of a leak. The model also has not inspected the cluster; it only has the information we supplied.

## 5. Context is the input. KV cache saves work.

The **context window** limits how many tokens a request can accommodate, including input and generated output. Instructions, included chat history, and supplied documents all take space.

![Prefill processes the prompt and builds a KV cache. Decode reuses that cache and extends it as tokens are generated.](/images/posts/llm-basics/04-cache.svg)

**Prefill** processes the prompt and produces the scores for the first output token. **Decode** continues generation, typically one token per sequence per step.

The **KV cache** stores keys and values from earlier tokens so the model can reuse them. It is temporary attention data, not a permanent memory of you.

For our request, prefill reads the question and `OOMKilled` clue. Decode builds the answer. When generating the next piece after `The container`, the model reuses cached keys and values from earlier tokens.

Pasting 500 lines of pod logs would add input tokens and usually increase cache needs. It would not add parameters to the model.

Two useful measurements:

| Metric | What I notice |
| --- | --- |
| Time to first token (TTFT) | Wait until "The" appears, including queueing and prompt processing |
| Output tokens per second | How quickly the rest of the restart explanation appears |

## 6. Why does a model need so much memory?

GPUs accelerate the large matrix calculations. But the model also has to fit in memory.

![Ideal weight storage for our 2B model is 8 GB at 32 bits, 4 GB at 16 bits, 2 GB at 8 bits, or 1 GB at 4 bits. KV cache and runtime memory are additional.](/images/posts/llm-basics/05-memory.svg)

**Quantization** represents numbers using fewer bits. The chart shows ideal weight storage: parameters multiplied by bits, divided by eight. Actual formats add overhead and may keep some weights at higher precision.

FP16 and BF16 both use 16 bits, with different numerical ranges and precision. INT4 uses 4-bit integers. AWQ and GPTQ are quantization methods.

For our 2B model, 16-bit weights take about 4 GB; ideal 4-bit storage takes about 1 GB. The question stays the same. We store the learned numbers more compactly, leaving more of my 8 GB GPU for the cache and runtime. Whether it fits depends on the model, format, and context. Quality can fall; speed gains depend on hardware and software.

## 7. What does vLLM add?

**vLLM is serving software that runs a model efficiently.** Our pod question is **request A**. Other users send requests B and C. vLLM can process them together while maintaining each request's own context.

![Continuous batching lets a new request enter when another finishes. PagedAttention maps each request's KV cache to separate physical blocks.](/images/posts/llm-basics/06-serving.svg)

**Continuous batching** updates the active batch as requests finish and capacity becomes available. **PagedAttention** manages KV cache in blocks that need not sit together in memory, reducing wasted space. The [vLLM team's explanation](https://vllm-project.github.io/2023/06/20/vllm.html) connects these ideas to serving more requests.

If B finishes while our restart explanation is still generating, D can join when capacity allows. Our request A continues, with its own KV blocks.

## 8. More GPUs, and fewer active experts

![Tensor parallelism splits calculations within a layer, pipeline parallelism splits layers, data parallelism replicates the model, and MoE routes tokens to selected experts.](/images/posts/llm-basics/07-scaling.svg)

For the same pod question: **TP** shares each layer's calculations across GPUs; **PP** passes the work through groups of layers; **DP** sends our whole request to one model replica while another serves someone else. These are possible layouts, not a claim that our small model needs multiple GPUs.

**NCCL** is NVIDIA's GPU communication library. It can move and combine data over connections such as PCIe and NVLink. Extra GPUs can also add waiting time, so scaling is not automatically a speedup. [NVIDIA's overview](https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/overview.html) describes that communication layer.

**MoE** is an alternative architecture, not a serving switch for our dense 2B model. A mixture-of-experts model answering the same question selects a subset of expert networks for each token at an MoE layer. The routing is learned; experts are not necessarily named subject specialists. For a token in our question, a router might select experts 2 and 7. That does not make either a "Kubernetes expert." Fewer active parameters reduce computation, but all weights still need storage somewhere. [Mixtral's paper](https://arxiv.org/abs/2401.04088) provides a concrete example.

Memory capacity answers **"Will it fit?"** Memory bandwidth answers **"How fast can data move?"** Compute throughput answers **"How fast can the maths run?"** Any of these, plus GPU communication, can limit performance.

## The five things I want to remember

| Term | My reminder |
| --- | --- |
| Parameters | Learned numbers linking patterns such as OOMKilled and memory |
| Tokens | Pieces of our question and restart explanation |
| Attention | Combine the restart question with the OOMKilled clue |
| KV cache | Reuse earlier calculations as the explanation grows |
| Inference engine | Schedule our request and run the model |

Our final answer might be:

> The container was killed because of an out-of-memory event. Check its memory limit and usage to investigate why.

One question, learned numbers, context, repeated calculations, and an answer to verify against the cluster.
