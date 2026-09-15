+++
title = "AI and LLM Glossary: Common Terms in Plain English"
date = '2026-09-15T09:00:00+08:00'
draft = false
description = "A beginner-friendly AI and LLM glossary with short definitions, everyday examples, and a clickable table of contents for every term."
tags = ["ai", "llm-basics", "glossary", "local-llm", "agents"]
ShowToc = true
TocOpen = true

[cover]
  image = "/images/posts/ai-llm-glossary/00-pixel-art-cover.png"
  alt = "Pixel-art glossary book with a neural-network chip, chat bubble, and connected tokens"
  relative = false
+++

AI conversations come with a lot of new words. Here is a broad collection of common AI and LLM terms, each explained in one or two sentences, with examples wherever useful.

**Jump to any definition using the table of contents** beside this article on desktop or above it on smaller screens. Terms are grouped by topic; use your browser's Find feature (`Ctrl+F` or `Cmd+F`) if you already know the word.

New to the topic? Start with **AI → machine learning → LLM → tokens → prompts → inference → hallucination → RAG → agents**.

## AI basics

### Artificial intelligence (AI)

AI is the broad field of building computer systems that perform tasks such as recognizing speech, making predictions, or generating text. **Example:** a voice assistant understanding a spoken request.

### Machine learning (ML)

Machine learning is a way to build AI by learning patterns from data instead of writing a rule for every situation. **Example:** learning to recognize spam from past emails.

### Deep learning

Deep learning uses neural networks with many layers to learn complex patterns. **Example:** identifying objects in a photo or generating a paragraph of text.

### Neural network

A neural network is a mathematical model made of connected layers that transform inputs into outputs using learned numbers. **Example:** turning an image's pixels into a prediction that it contains a cat.

### Model

A model is a learned mathematical system that produces predictions or outputs from inputs. **Example:** the model inside a chatbot generates the reply, while the app manages the chat interface.

### Generative AI (GenAI)

Generative AI creates content such as text, images, audio, or code based on patterns learned during training. **Example:** drafting an email from a short instruction.

### Predictive AI

Predictive AI estimates an outcome or assigns a category using patterns in data. **Example:** forecasting next month's demand or flagging a suspicious transaction.

### Large language model (LLM)

An LLM is a large neural network trained on substantial amounts of language data to process and generate text. **Example:** a model that summarizes an article, translates a sentence, or writes code.

### Small language model (SLM)

An SLM is a language model with relatively fewer parameters, often making it easier to run on limited hardware. **Example:** a compact model running on a laptop; there is no universally agreed size cutoff.

### Foundation model

A foundation model is trained on broad data so it can be adapted to many tasks. **Example:** the same base model can support summarization, classification, and question answering.

### Multimodal model

A multimodal model handles more than one kind of information, such as text, images, or audio. **Example:** uploading a screenshot and asking the model to explain the error message.

### Natural language processing (NLP)

NLP is the field of helping computers work with human language. **Example:** translating text, detecting sentiment, or extracting names from a document.

### Computer vision

Computer vision helps computers extract information from images and video. **Example:** detecting a pedestrian in a camera frame.

### Diffusion model

A diffusion model learns to generate data by reversing a process that adds noise. **Example:** an image generator gradually turns random noise into a picture matching your description.

### Artificial general intelligence (AGI)

AGI is a proposed kind of AI with broad abilities across many intellectual tasks, rather than a narrow specialty. There is no universally accepted definition or test for deciding when a system qualifies.

## Inside a language model

### Token

A token is a unit a model processes, often a word, part of a word, or punctuation. **Example:** a long word may use several tokens, so 1,000 tokens does not mean 1,000 words.

### Tokenizer

A tokenizer converts text into token IDs that a model can process and can convert those IDs back into text. **Example:** different tokenizers may split the same sentence into different numbers of tokens.

### Vocabulary

A model's token vocabulary is the set of token IDs its tokenizer knows how to represent. It usually includes word pieces and symbols, rather than only complete dictionary words.

### Parameter

A parameter is a number learned during training that helps determine how a model behaves. **Example:** an “8B” model has roughly eight billion parameters, which is separate from its context length.

### Weights

Weights are learned parameters that control how signals flow through a neural network; people often use “model weights” to mean its learned numerical contents. **Example:** downloading weights lets compatible software load and run the model.

### Transformer

A transformer is a neural-network architecture that uses attention to connect information across a sequence. Many language models use it to relate words in a prompt and generate a continuation.

### Attention

Attention lets a model give different amounts of importance to different parts of its input when computing a representation. **Example:** connecting “it” with the relevant object mentioned earlier in a sentence.

### Embedding

An embedding is a list of numbers representing something such as a word, document, or image. **Example:** embeddings can place “puppy” and “dog” close together because their meanings are related.

### Vector

A vector is an ordered list of numbers; embeddings are vectors designed to represent useful properties of data. **Example:** `[0.2, -0.5, 0.9]` is a three-dimensional vector.

### Next-token prediction

Next-token prediction estimates which token could come next given the tokens already available. **Example:** after “The sky is”, a model may give “blue” a high probability.

### Autoregressive generation

Autoregressive generation builds an output step by step, using previous output as input for the next step. **Example:** a text model generates one token, adds it to the sequence, and generates another.

### Mixture of experts (MoE)

An MoE model routes work through selected specialist parts of the network instead of using every expert for every token. **Example:** a model can have many total parameters but activate only a subset per token, though storing the experts still takes memory.

## Prompts and conversations

### Prompt

A prompt is the input you give a model to guide its response. **Example:** “Explain Kubernetes to someone who has never used it.”

### Prompt engineering

Prompt engineering means designing instructions and examples to get more useful outputs. **Example:** specifying the audience, desired format, and length of an explanation.

### System prompt

A system prompt supplies application-level instructions about how an assistant should behave. **Example:** “You are a support assistant; explain troubleshooting steps clearly.”

### Zero-shot prompting

Zero-shot prompting asks a model to perform a task without showing examples of the desired answer. **Example:** “Classify this review as positive or negative.”

### Few-shot prompting

Few-shot prompting includes a small number of examples before asking the model to handle a new case. **Example:** showing three labeled reviews before asking it to label a fourth.

### Chain of thought (CoT)

Chain of thought refers to intermediate reasoning steps used while solving a problem. A model's displayed explanation is not guaranteed to faithfully reveal its internal computation.

### Reasoning model

A reasoning model is trained to work through intermediate steps before producing an answer, often spending more computation on difficult tasks. **Example:** comparing several possible solutions to a math problem before answering.

### Context

Context is the information available to the model for its current response, including instructions, messages, and supplied documents or tool results. **Example:** pasting a log file gives the model context for troubleshooting.

### Context window

The context window is the model's token capacity for a single request, generally covering input and generated output, subject to separate limits. **Example:** a long document and chat history leave less room for a response.

### Context engineering

Context engineering means selecting and organizing the information a model receives for a task. **Example:** supplying the relevant logs, current configuration, and instructions while leaving out unrelated files.

### Memory

In an AI app, memory usually means information saved and brought back into later interactions. **Example:** the app stores your preferred language and includes it in future prompts; this does not necessarily change the model's weights.

### Truncation

Truncation means cutting off input or output to meet a length limit. **Example:** an app may drop older chat messages when the conversation becomes too long.

### Temperature

Temperature adjusts how strongly generation favors higher-probability tokens. Lower values generally produce more predictable wording, while higher values allow more variation without guaranteeing creativity or accuracy.

### Top-p (nucleus sampling)

Top-p limits token selection to a set of likely candidates whose combined probability reaches a chosen threshold. **Example:** `top_p = 0.9` samples from candidates covering about 90% of the probability mass.

### Top-k sampling

Top-k limits token selection to the k most likely next tokens. **Example:** `top_k = 40` means sampling only from the 40 highest-ranked candidates at each step.

### Maximum output tokens

Maximum output tokens sets a ceiling on how many tokens a model may generate for a response. **Example:** a low limit can cut off a long answer before it finishes.

### Stop sequence

A stop sequence is text that tells the generation service to stop producing output when it appears. **Example:** an application might use a special delimiter to mark the end of an answer.

### Structured output

Structured output follows a defined format or schema so software can process it reliably. **Example:** returning an object with `name` and `price` fields; correct formatting does not guarantee correct facts.

## Training and customization

### Training

Training adjusts a model's parameters using data and an objective that measures how well it is doing. **Example:** repeatedly improving its predictions of missing or next words.

### Training data

Training data is the collection of examples used to teach a model. **Example:** text, code, images, or labeled examples, depending on the task.

### Dataset

A dataset is an organized collection of examples used for training, validation, or evaluation. **Example:** 10,000 support tickets paired with issue categories.

### Label

A label is a target answer or category attached to an example. **Example:** an email marked “spam” has a spam label.

### Supervised learning

Supervised learning trains a model on inputs paired with desired outputs. **Example:** learning to classify pictures from images labeled “cat” or “dog”.

### Unsupervised learning

Unsupervised learning looks for patterns in data without supplied target labels. **Example:** grouping customers by similar purchasing behavior.

### Self-supervised learning

Self-supervised learning creates training targets from the data itself. **Example:** using the next word in a document as the answer the model must predict.

### Reinforcement learning (RL)

Reinforcement learning trains a system to choose actions using reward signals. **Example:** a game-playing agent improves by receiving rewards for successful play.

### Pretraining

Pretraining is an initial training stage that builds broad capabilities from large amounts of data. **Example:** a language model learns language patterns before being adapted to follow instructions.

### Post-training

Post-training refines a pretrained model's behavior or abilities through additional training. **Example:** teaching it to follow instructions, use tools, or better match human preferences.

### Fine-tuning

Fine-tuning continues training an existing model on selected data to adapt its behavior. **Example:** training on support conversations to encourage a particular response style.

### Instruction tuning

Instruction tuning trains a model on instructions paired with useful responses. **Example:** teaching it to respond to “Summarize this” with a summary instead of simply continuing the text.

### Supervised fine-tuning (SFT)

SFT fine-tunes a model using examples of desired inputs and outputs. **Example:** providing questions paired with carefully written answers.

### Reinforcement learning from human feedback (RLHF)

RLHF uses human feedback to help define rewards that guide further model training. **Example:** people rank responses, and those preferences help train a reward model used to improve the assistant.

### Direct preference optimization (DPO)

DPO trains a model directly on preferred and less-preferred responses without a separate reinforcement-learning optimization loop. **Example:** teaching it to favor a clear, helpful answer over an unhelpful one.

### LoRA (low-rank adaptation)

LoRA fine-tunes a model by training small added sets of parameters while keeping the original weights frozen. **Example:** adapting a model's writing style using less training memory than updating all its weights.

### QLoRA

QLoRA combines a quantized, frozen base model with trainable LoRA adapters to reduce fine-tuning memory needs. **Example:** adapting a model on a GPU that cannot hold its full-precision training setup.

### Distillation

Distillation trains a student model to learn from a teacher model's outputs or signals. **Example:** using a larger model's answers to help train a smaller model for a specific task.

### Synthetic data

Synthetic data is artificially generated data used for training or testing. **Example:** generating sample support questions, then checking their quality before using them.

### Loss

Loss is a numerical measure of how poorly a model meets its training objective. Training tries to reduce it, though lower training loss does not automatically mean better real-world performance.

### Learning rate

The learning rate controls the size of parameter updates during training. Think of it as the adjustment step size: too large can overshoot, while too small can make learning slow.

### Epoch

An epoch is one pass through a training dataset. **Example:** three epochs means the training process has gone through the dataset three times.

### Batch size

Batch size is the number of examples processed together in a training or inference step. **Example:** a training batch might contain 32 examples.

### Overfitting

Overfitting happens when a model learns the training data too specifically and performs poorly on new examples. Think of memorizing practice-test answers without learning how to solve new questions.

### Generalization

Generalization is a model's ability to perform well on examples it did not train on. **Example:** recognizing spam that uses wording absent from its training set.

### Checkpoint

A checkpoint is a saved snapshot of a model, sometimes including the state needed to resume training. **Example:** saving progress periodically so training can restart after an interruption.

### Knowledge cutoff

A knowledge cutoff is an approximate boundary for the information included in a model's training. It does not guarantee knowledge of everything before that date, and tools can supply newer information.

## Search and grounding

### Retrieval-augmented generation (RAG)

RAG retrieves relevant information and provides it to a model before the model generates an answer. **Example:** finding passages in a company handbook so an assistant can answer a policy question.

### Grounding

Grounding connects a model's response to supplied evidence or external information. **Example:** asking it to answer from a particular report and cite the supporting passages.

### Chunking

Chunking splits documents into smaller pieces for processing or retrieval. **Example:** dividing a long manual into sections so a search system can return the relevant instructions.

### Vector database

A vector database stores vectors and supports searching for similar ones. **Example:** finding document embeddings close to the embedding of a user's question.

### Semantic search

Semantic search looks for relevant meaning rather than only matching exact words. **Example:** a search for “forgot my login” can find a page titled “Reset your password”.

### Keyword search

Keyword search matches words or phrases in documents. **Example:** searching for an exact error code such as `OOMKilled`.

### Hybrid search

Hybrid search combines keyword matching with semantic search. **Example:** matching an exact product code while also understanding the user's description of the problem.

### Similarity score

A similarity score measures how close two representations are under a chosen comparison method. **Example:** cosine similarity can compare a question embedding with document embeddings; the score is not a probability that an answer is correct.

### Reranking

Reranking reorders retrieved results using another scoring step to improve relevance. **Example:** retrieving 50 passages quickly, then selecting the five most useful ones for the answer.

## Agents and tools

### AI assistant

An AI assistant is an application that helps users through capabilities such as conversation, content generation, and tool use. **Example:** an assistant that explains code and searches documentation.

### AI agent

An AI agent uses a model to choose and carry out steps toward a goal, often with tools and feedback. **Example:** inspecting a failing test, editing code, and rerunning the test within its permissions.

### Agentic AI

Agentic AI is a broad term for systems that can select and execute steps toward a goal with some autonomy. **Example:** a system that investigates an issue and adjusts its next action based on what it finds.

### Tool use / function calling

Tool use lets a model request an operation that surrounding software executes. **Example:** the model requests a weather lookup, and the application calls the weather service and returns the result.

### Model Context Protocol (MCP)

MCP is a standard for connecting AI applications to tools, resources, and reusable prompts. **Example:** an application can connect to an MCP server that exposes document-search tools.

### Workflow

A workflow is a sequence of steps for completing a task, often with predefined rules. **Example:** classify a support ticket, retrieve relevant documentation, then draft a reply.

### Orchestration

Orchestration coordinates models, tools, data, and task steps in an AI application. **Example:** deciding when to search, when to call a model, and when to request human review.

### Multi-agent system

A multi-agent system uses multiple agents that collaborate or handle different responsibilities. **Example:** one agent researches a topic while another checks the draft against the sources.

### Human in the loop (HITL)

Human in the loop means a person reviews, corrects, or approves part of an automated process. **Example:** a person approves a drafted customer reply before it is sent.

## Running models and performance

### Inference

Inference means running a trained model to produce an output from an input. **Example:** generating a reply to your chat message.

### Model serving

Model serving makes a model available to applications and manages incoming requests. **Example:** a server loads model weights and exposes an API for generating text.

### API (application programming interface)

An API is a defined way for software systems to communicate. **Example:** your app sends a prompt to a model service and receives generated text.

### Local LLM

A local LLM runs on hardware you control, such as your laptop or workstation. **Example:** generating text on your machine after downloading a model; the app's other features may still use network services.

### GPU (graphics processing unit)

A GPU is a processor that can perform many mathematical operations in parallel. **Example:** accelerating the matrix calculations used to train or run a neural network.

### VRAM

VRAM is memory available on a graphics card for data such as model weights and temporary computations. **Example:** a model can run out of VRAM even when the computer still has free system RAM.

### Quantization

Quantization represents model numbers using fewer bits, reducing storage and often memory use. **Example:** storing weights at roughly 4-bit precision can make a model easier to fit, with possible quality tradeoffs.

### FP32, FP16, and BF16

These are floating-point number formats: FP32 uses 32 bits, while FP16 and BF16 use 16 bits with different precision and range. **Example:** 16-bit weights generally need about half the raw storage of 32-bit weights.

### INT8 and INT4

INT8 and INT4 are 8-bit and 4-bit integer representations often used in quantization. **Example:** a model with INT4 weights uses less raw weight storage than one with INT8 weights, though metadata and other data add overhead.

### GGUF

GGUF is a file format for storing models and metadata, commonly used with llama.cpp and related local inference tools. **Example:** a `.gguf` file may contain quantized weights, but the file format itself does not specify one fixed precision.

### Prefill

Prefill is the inference phase that processes the prompt before generating the continuation. **Example:** reading a long pasted document can add delay before the first response token appears.

### Decode

Decode is the generation phase in which an autoregressive model produces new tokens using the existing sequence. **Example:** the answer grows token by token after the prompt has been processed.

### KV cache

The key-value cache stores attention-related intermediate results so the model can reuse earlier computation during generation. **Example:** longer conversations generally require more KV-cache memory.

### Prompt caching / prefix caching

Prompt or prefix caching reuses computation for input shared across requests. **Example:** repeatedly sending the same long instruction prefix may require less processing when a compatible cached prefix is available.

### Latency

Latency is the time you wait for a response or a particular stage of it. **Example:** the delay between submitting a prompt and receiving the complete answer.

### Time to first token (TTFT)

TTFT measures the time from sending a request to receiving its first generated token. **Example:** a chatbot can start responding quickly even if finishing its answer takes much longer.

### Throughput

Throughput measures how much work a system completes per unit of time. **Example:** a model server might handle thousands of output tokens per second across many users.

### Tokens per second (tokens/s)

Tokens per second measures token-processing or generation speed, so the measured stage and scope matter. **Example:** 30 output tokens/s for one chat is different from 3,000 output tokens/s across an entire server.

### Streaming

Streaming sends output to the user as it is generated instead of waiting for the entire response. **Example:** words appear progressively in a chat window.

### Continuous batching

Continuous batching lets a server add and remove requests from a running batch as work arrives and finishes. **Example:** a new chat can begin processing without waiting for every current response to complete.

### Speculative decoding

Speculative decoding uses a cheaper process to propose several tokens that the main model verifies together. Standard exact versions preserve the target model's output distribution, but the speed benefit depends on the workload.

### Model parallelism

Model parallelism spreads a model's computation or layers across multiple devices. **Example:** splitting a model across two GPUs when it cannot fit on one.

### GPU offloading

GPU offloading moves some or all model work from the CPU to a GPU. **Example:** a local runner places selected layers on the GPU and keeps the rest in system memory.

### Open weights

An open-weight model makes its trained weights available to download under stated license terms. This does not automatically mean its training data is available or that every use is permitted.

### Open-source AI

Open-source AI refers to systems released with permissions and materials that enable use, study, modification, and sharing under an applicable definition or license. Check the actual release and license: downloadable weights alone do not establish that the whole system is open source.

## Quality, evaluation, and safety

### Hallucination

A hallucination is generated content that is false or unsupported but may sound convincing. **Example:** inventing a research paper or a software option that does not exist.

### Evaluation / evals

Evaluation checks how well a model or AI system performs on chosen tasks and criteria. **Example:** testing whether a support assistant gives correct answers and cites the right documents.

### Benchmark

A benchmark is a defined test or dataset used to compare systems. **Example:** measuring code generation on a shared set of programming problems; one score does not describe every real-world task.

### Accuracy

Accuracy is the fraction of predictions that are correct in a classification task. **Example:** 90 correct labels out of 100 gives 90% accuracy, though this can be misleading when one class dominates.

### Precision

Precision measures how many items predicted as positive were actually positive. **Example:** if 8 of 10 emails flagged as spam are spam, precision is 80%.

### Recall

Recall measures how many actual positive items a system successfully finds. **Example:** if it catches 8 of the 20 spam emails, recall is 40%.

### F1 score

F1 combines precision and recall using their harmonic mean, rewarding a balance between the two. **Example:** 80% precision and 40% recall produce an F1 score of about 53%.

### Perplexity

Perplexity measures how well a language model predicts a sequence, with lower values indicating better prediction on that data. Comparisons need compatible tokenization and evaluation settings, and lower perplexity does not necessarily mean a better assistant.

### Bias

Bias can mean systematic skew in a model's predictions or behavior, including unfair differences across groups. **Example:** a hiring model may reproduce patterns of unequal treatment present in its training data.

### Alignment

Alignment concerns making a model's behavior match intended goals, values, and constraints. **Example:** training an assistant to follow useful instructions while respecting privacy requirements.

### Guardrails

Guardrails are checks or controls intended to constrain an AI system's behavior. **Example:** validating tool arguments or requiring approval before a purchase; their presence does not guarantee that mistakes are impossible.

### Prompt injection

Prompt injection occurs when untrusted content tries to redirect an AI system away from its intended instructions. **Example:** a retrieved webpage tells an assistant to ignore the user and reveal private data.

### Jailbreak

A jailbreak is an attempt to bypass a model's behavioral or safety restrictions. **Example:** using a specially constructed prompt to get an answer the assistant is configured to refuse.

### Data leakage

Data leakage means information reaches a place it should not, with the exact meaning depending on context. **Example:** test answers accidentally enter training data, or an assistant exposes confidential information to an unauthorized user.

### Red teaming

Red teaming deliberately probes a system for failures, vulnerabilities, or harmful behavior. **Example:** testing whether malicious documents can trick an assistant into misusing a tool.

## Commonly confused terms

- **AI vs. ML vs. deep learning:** AI is the broad field; ML is one approach within it; deep learning is a family of ML techniques.
- **Model vs. chatbot:** the model produces outputs; the chatbot is an application built around it.
- **Training vs. inference:** training changes learned parameters; inference uses them to produce outputs.
- **RAG vs. fine-tuning:** RAG supplies retrieved information at response time; fine-tuning changes model parameters.
- **Context vs. memory:** context is available for the current response; app memory can store information and bring it into future context.
- **Parameters vs. tokens:** parameters are learned numbers inside the model; tokens are units it processes.
- **Latency vs. throughput:** latency is how long a request takes; throughput is how much work the system handles over time.
- **Open weights vs. open source:** access to weights is one part of openness; permissions and other available materials also matter.

## Further reading

For broader reference, see [Google's machine-learning glossary](https://developers.google.com/machine-learning/glossary) and [Google Cloud's generative AI glossary](https://docs.cloud.google.com/docs/generative-ai/glossary).

For a practical explanation of retrieving documents before answering, see [Anthropic's contextual retrieval guide](https://www.anthropic.com/engineering/contextual-retrieval). Its [context engineering guide](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) explains how to select information for agents.

Continue on this blog with [what happens when you ask an LLM a question](/posts/llm-basics-visual-guide/) or [AI agent basics](/posts/ai-agent-basics/).
