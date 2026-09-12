---
title: "What Agentic AI Actually Means"
date: 2026-09-13T02:45:00+08:00
draft: false
description: "A practical explanation of agentic AI, agent harnesses, tool loops, context growth, and why agents cost more to run."
series: ["AI Infra"]
tags: ["agentic-ai", "llm", "agent-harness", "infra"]
cover:
  image: "/images/posts/ai-agent-basics/00-pixel-art-cover.png"
  alt: "Pixel art AI agent looping through code, tools, files, and results"
  relative: false
---

## Not a chatbot with more steps

"Agentic AI" gets used for basically anything with a system prompt now. It isn't a chatbot that's more polite about calling tools. The actual difference is structural: an agent runs a loop, a chatbot answers a turn.

A chatbot takes input, produces output, done. State lives in the conversation history you paste back in. An agent runs its own loop: observe, decide, act, observe again, using its own outputs to decide what to do next, without a human in the middle of every step.

**Example.** Ask a chatbot "is my API returning 500s right now" and it tells you it can't check. Ask an agent the same thing and it calls a monitoring tool, reads the response, decides the error rate looks elevated, calls a log-search tool to pull recent 500s, reads those, and comes back with "yes, 12 in the last 10 minutes, all from the /checkout endpoint, here's the stack trace." Same model, same question. The difference is the loop in between.

![A chatbot runs once from input through model to output, while an agent loops through observe, decide, act, and observe again.](/images/posts/ai-agent-basics/01-chatbot-vs-agent.svg)

## The model doesn't loop, the harness does

This is the part most explanations skip. The LLM itself is stateless and single-shot, feed it tokens, get tokens back. It has no concept of "keep going until the task is done." The loop, the tool execution, the deciding-when-to-stop, none of that lives in the model weights.

All of that lives in the **agent harness**, the code wrapped around the model that turns single-shot completions into a running agent. The harness is what:

- Sends the prompt to the model and gets a response back
- Parses that response for a tool call
- Actually executes the tool (runs the shell command, hits the API, reads the file)
- Feeds the result back into context
- Decides whether to call the model again or stop

Swap the model and keep the harness, you get the same agent with different reasoning quality. Swap the harness and keep the model, you get a completely different agent, different tools available, different context management, different stopping conditions. The harness is doing more of the actual engineering work than people give it credit for, the model is just the decision-maker it calls into on each turn.

Strip the harness out entirely and there's no agent left, just a model that can produce a tool-call-shaped output with nothing to execute it, feed a result back, or call the model again. In RL terms, the model is the policy, the harness is the environment loop that runs the policy against the world and feeds observations back. A policy with no environment isn't an agent, it's a function you can call once.

This is also why "build your own agent" and "build your own harness" are the same task described two ways. There's no shortcut where you write an agent and skip the harness, hand-rolling one just means you're the one writing the loop: send the prompt, parse the response for a tool call, execute it, append the result, decide whether to call the model again. Do that in 40 lines of Python or reach for pi.dev or Claude Code's, it's the same role either way.

**Example.** Two different harnesses wrapping the same underlying model can behave nothing alike. One harness might cap the loop at 5 iterations and summarize aggressively to save context. Another might allow 50 iterations, keep full history, and let the model spawn sub-agents. Same model, same weights, same API calls to it, wildly different agent because the harness around it is different.

![The agent harness surrounds the LLM with context management, tool execution, loop control, and a stop condition.](/images/posts/ai-agent-basics/02-agent-harness.svg)

## The four things a harness provides

**Calling the LLM as decision-maker.** The harness sends the current state to the model and treats its output as a decision about what to do next, not just a completion to display.

**A tool/function-calling interface.** The harness defines what tools exist, executes them when the model calls one, and returns results in a format the model can read.

**Memory/state across steps.** The harness owns the context window, what goes in, what gets summarized or dropped, and any external memory store.

**Loop control.** The harness decides when to call the model again and when to stop, whether that's a fixed iteration cap, a "the model said it's done" signal, or something more custom.

**Example, walking through one iteration.** User asks the agent to find the total size of log files older than 30 days. Step 1, harness sends the request to the model, model decides it needs to list files, returns a tool call for `find /var/log -mtime +30`. Step 2, harness executes that command, gets a list of paths, appends the result to context. Step 3, harness calls the model again, model decides it needs sizes, returns a tool call for `du -ch` on those paths. Step 4, harness executes it, appends the total to context. Step 5, harness calls the model once more, model has enough info, returns a final answer with no further tool call, harness detects that and stops the loop. Five round trips through the harness, one user question, no human in between.

## Why the loop gets expensive

Every loop iteration appends to context: the tool call, the tool result, the model's next reasoning step. None of that gets discarded between iterations, unless the harness explicitly manages it.

Tie this back to KV cache: cache grows with every token in context, and context in an agent loop grows every single step, not just per conversation turn. A single-shot inference request builds a cache once and discards it after. An agent loop keeps extending the same cache, iteration after iteration, and the cost compounds because every added token gets re-attended-to on every subsequent forward pass.

**Worked example.** Say a tool call and its result add roughly 300 tokens to context per iteration. A 10-iteration loop adds 3,000 tokens on top of the original prompt, all of it sitting in KV cache. Run the log-file-size agent above against a directory tree with a lot of nested paths and that 300-token estimate climbs fast, since raw `find` and `du` output isn't exactly compact.

Practical implication: a long-running agent has to actively manage context, not just let it grow unbounded. This is a harness responsibility, not a model one, good harnesses summarize old steps, drop stale tool outputs, and truncate before the sequence gets unwieldy. That's not an optimization, it's what keeps a loop viable past a handful of iterations regardless of what it's running on.

![Context tokens in the KV cache rise from roughly 500 to 3,500 over ten agent loop iterations.](/images/posts/ai-agent-basics/03-context-growth.svg)

## Single-shot vs loop, at the token level

Single-shot: prompt in, tokens out, KV cache built once, discarded after.

Agent loop: prompt in, tokens out (including a tool call), harness executes the tool outside the model, tool result gets tokenized and appended by the harness, full sequence goes back through the model, cache either recomputed from scratch or extended depending on the serving setup. Repeat.

The cost isn't "the model thinks harder." It's "the model re-processes a longer sequence every iteration." That's the whole reason agent loops cost more to serve than a single chatbot request, and why serving techniques like continuous batching and prefix caching (vLLM does both) matter more for agents than for one-off completions.

![At the token level, the prompt enters the model, produces a tool call, the harness executes it, and the tool result loops back to the model.](/images/posts/ai-agent-basics/04-agent-token-loop.svg)

## Some harnesses and agents you've probably heard of

Frameworks like [CrewAI](https://www.crewai.com/) and [LangGraph](https://www.langchain.com/langgraph) are toolkits for building your own harness, not already-built ones. Since the interesting question is which finished harnesses and agents are worth knowing, here's a rough split, open source and paid, as of when this was written:

**Open source / self-hostable harnesses**

- **[Pi (pi.dev)](https://pi.dev/)**, a minimal, aggressively extensible terminal coding-agent harness. Deliberately skips features like sub-agents, plan mode, and MCP support out of the box, the pitch is you build those in yourself with extensions rather than accept whatever the harness maker decided. It also makes the model-vs-harness split from earlier concrete: it supports 15+ model providers and lets you switch mid-session, the harness stays constant, the model underneath it doesn't have to.
- **[OpenHands](https://www.openhands.dev/)** (formerly OpenDevin), an open-source autonomous software engineer harness, the open equivalent of Devin below.
- **[OpenClaw](https://openclaw.ai/)**, a fast-growing self-hosted personal agent harness, notable for running locally with your own model of choice.
- **[AutoGPT](https://www.agpt.co/)**, the original viral agent demo, now a maturer platform with a visual builder and self-hosting support. Still the reference point most people mean when they say "autonomous agent."

**Paid / proprietary harnesses and agents**

- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started)**, Anthropic's coding agent harness, runs in a terminal, reads and edits across a whole codebase, runs tests, commits changes.
- **[Devin](https://cognition.com/blog/introducing-devin)**, a fully autonomous coding agent from Cognition, runs in its own sandboxed cloud environment rather than your terminal.
- **[OpenAI Codex](https://openai.com/codex/) / [ChatGPT Agent](https://help.openai.com/en/articles/11752874-chatgpt-agent)**, OpenAI's equivalents, spanning terminal, cloud, and chat surfaces.
- **[Perplexity Comet](https://www.perplexity.ai/comet)**, a browsing agent that navigates and completes tasks inside the browser rather than a terminal.

Coding is where agents and harnesses are most mature right now, since code execution gives the loop a fast, checkable signal of whether the last action actually worked. That's not a coincidence, it's the same reason the log-file-size example earlier in this post works cleanly: shell commands succeed or fail in an unambiguous way, which is exactly the kind of feedback a harness's loop needs to decide what to do next.

## Up next

Next post in the local tools series is the practical version of this: standing up a Hermes-style agent, harness, tool calling, loop, the works, on the local setup already covered in this series. This post is the vocabulary you need before that one makes sense.
