---
title: "TypeSafe’s Jev: Early Access to AI Built for Decisions"
date: 2026-09-19T14:00:00+08:00
lastmod: 2026-09-21
draft: false
description: "My early-access look at TypeSafe’s Jev: Noul, Choice, and Score in the playground, the coding-agent skill, and what the performance claims do and do not establish."
series: ["AI Infra"]
tags: ["ai", "inference", "ai-infra", "typesafe", "automation"]
ShowToc: true
TocOpen: false
cover:
  image: "/images/posts/typesafe-jev/00-pixel-art-cover.png"
  alt: "Pixel art processor turning unstructured documents into parallel decision paths and probability indicators"
  relative: false
---

An incident comes in. Your software needs an owner, an urgency level, and a decision on human review. It needs those answers before the request times out.

That is the part of AI infrastructure that makes TypeSafe interesting to me.

On September 15, 2026, TypeSafe AI announced **Jev**, its first **System One model**, in early access. It describes a new architecture and parallel sampler built for decisions. [Launch announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev).

I now have early access. On September 21, I tried the playground's Noul, Choice, and Score examples. The screenshots below show those runs with `jev-latest`; they make the interface concrete, but they do not establish production accuracy or validate the headline speedups.

**In simple terms, Jev makes small decisions your software can use immediately.** Give it context and allowed choices; it returns answers with probabilities. Your code decides what happens next, including when to ask a person.

## What does a System One model do?

**Jev is not a typical chat model.** It returns typed decisions and probabilities rather than generating conversational replies. Your application uses those answers to choose actions or hand work to tools, other models, or a person. [TypeSafe's model introduction](https://docs.typesafe.ai/introduction).

{{< figure src="/images/posts/typesafe-jev/01-jev-software-workflow.png" alt="Three-panel diagram: application state and typed questions enter Jev, which returns decisions and probabilities to application code. The code applies thresholds, selects branches, calls tools or models, routes to a person, and logs results." caption="Jev supplies narrow judgments. Application code controls execution and escalation; the brain illustration is symbolic." class="post-screenshot" >}}

You provide **state** and **typed questions**. State is the information to inspect, such as a support conversation and account record. Questions define the judgments to make.

Each question is evaluated independently against the same state. Application code combines those judgments into a workflow. [Model introduction](https://docs.typesafe.ai/introduction).

The three primitives make the idea easier to see:

| Primitive | Example question | Result |
| --- | --- | --- |
| **Choice** | Which team should receive this ticket? | A selected option, probabilities over the options, and confidence |
| **Score** | How severe is this issue on our defined scale? | A score, probabilities over the levels, and confidence |
| **Noul** | Does the message report an outage? | A value from 0 to 1 representing the probability of yes |

Noul has no separate confidence field. Choice uses predefined alternatives; Score uses an ordered scale. The interface constrains answers instead of generating arbitrary descriptions. [Primitives documentation](https://docs.typesafe.ai/primitives).

An illustrative incident workflow could look like this:

{{< mermaid caption="A possible incident-routing design. Jev supplies narrow judgments; application code controls the workflow." >}}
flowchart LR
    S["Alert and service context"] --> J["Jev"]
    J --> T["Choice: owning team"]
    J --> U["Score: urgency"]
    J --> O["Noul: outage reported?"]
    T --> P["Application policy"]
    U --> P
    O --> P
    P --> R["Route to a team"]
    P --> H["Request human review"]
{{< /mermaid >}}

Ownership rules, escalation permissions, and audit logging stay explicit in code. A permission change does not depend on the model interpreting a revised prompt correctly.

### A documented request and its answers

TypeSafe's [Python SDK guide](https://docs.typesafe.ai/sdk/python) includes this three-question support example. Install `typesafe-sdk` and set `TYPESAFE_API_KEY` in your environment first. The request below follows that example; the print statements expose the returned probabilities too.

```python
from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

with TypeSafeClient() as client:
    response = client.system_one(
        state={"document": "I was charged twice. Please fix this ASAP."},
        questions={
            "billing": Noul(instructions="Is this ticket about billing?"),
            "tone": Choice(
                instructions="What is the customer's tone?",
                criteria={"calm": None, "frustrated": None, "angry": None},
            ),
            "urgency": Score(
                instructions="How urgent is this ticket?",
                criteria=["can wait", "this week", "today"],
            ),
        },
    )

print(response.nouls["billing"].noul)
print(response.choices["tone"].choice)
print(response.choices["tone"].probabilities)
print(response.scores["urgency"].score)
print(response.scores["urgency"].probabilities)
```

One call evaluates the same ticket three ways. The response exposes a yes probability, a distribution over tones, and a distribution over urgency levels. These are response fields, not a recorded run from my account.

## What I saw in early access

The console home brings together the playground, example workflows, API keys, usage, and an agent setup link. In the playground, state and questions sit on the left, with typed answers on the right.

{{< figure src="/images/posts/typesafe-jev/02-early-access-home.png" link="/images/posts/typesafe-jev/02-early-access-home.png" alt="TypeSafe early-access console home with playground examples, agent setup, API keys, and usage" caption="My early-access console on September 21, 2026. Open any screenshot for the full-size view." class="post-screenshot" >}}

### Noul: an ice cream sandwich gets 35% true

The first example asks whether an ice cream sandwich is a sandwich. The state describes ice cream between cookies, wafers, or cake. The criteria matter: the true condition refers to a filling between structural starch, while the false condition explicitly includes wafers and cookies as non-bread wrappers. Those descriptions leave room for conflicting interpretations.

The result is **35% true**. This is the model's probability for the yes/no question under those definitions. It is not a measure of how much of the dessert is a sandwich, and a single answer cannot tell us whether the probabilities are calibrated.

{{< figure src="/images/posts/typesafe-jev/03-noul-sandwich.png" link="/images/posts/typesafe-jev/03-noul-sandwich.png" alt="Jev playground showing the ice cream sandwich state, true and false criteria, and a Noul result of 35 percent true" caption="Noul returns a probability for a defined yes/no judgment. The definition needs as much attention as the result." class="post-screenshot" >}}

### Choice: richer descriptions change the leading option

The next example uses a short state about an approaching tornado and asks for the sky's color. With simple option labels, **seafoam green leads at 63%**, followed by gray at 34% and indigo at 3%. The displayed confidence is **56%**.

A second question in the same request uses structured instructions and richer option descriptions. There, **indigo leads at 42%**, followed by seafoam green at 34% and gray at 24%, with **31% confidence**.

This is a useful reminder that question design is part of the application. Both the instructions and criteria differ here, so this run does not isolate which change caused the shift or establish which answer is better. It does show why I would version the questions and evaluate changes against known cases.

{{< figure src="/images/posts/typesafe-jev/04-choice-sky-color.png" link="/images/posts/typesafe-jev/04-choice-sky-color.png" alt="Two sky-color Choice answers: seafoam green leads at 63 percent with 56 percent confidence, while the question with descriptions selects indigo at 42 percent with 31 percent confidence" caption="Choice exposes the distribution as well as the selected option. The winning probability and confidence are different quantities." class="post-screenshot" >}}

### Score: a distribution across five levels

The third example describes the Naruto macaque photograph scenario and asks two separate questions about contribution to the image. On five levels from None (0) to Completely (4), the result gives **Naruto 3.46 out of 4** with **55% confidence**, and **the human photographer 1.18 out of 4** with **69% confidence**.

The distributions make the scores easier to read: Naruto's answer concentrates on levels 3 and 4, while the photographer's concentrates on level 1. These are separate judgments against the supplied scenario and rubric; they are not shares that must add up to 100% or determinations of copyright ownership.

{{< figure src="/images/posts/typesafe-jev/05-score-contribution.png" link="/images/posts/typesafe-jev/05-score-contribution.png" alt="Score playground results showing Naruto at 3.46 out of 4 and the photographer at 1.18 out of 4, with probabilities across five contribution levels" caption="Score can fall between levels. The full distribution preserves information that a single rounded rating would hide." class="post-screenshot" >}}

TypeSafe defines the score as the probability-weighted average of the level indices. The UI rounds the displayed probabilities, so recomputing from the screenshot can differ slightly from the displayed score. [Score documentation](https://docs.typesafe.ai/primitives/score).

The three playground captures display timing pairs of `84ms + 278ms`, `160ms + 233ms`, and `158ms + 234ms`. I am preserving the UI's notation: the screenshots alone do not explain the components. These few example runs are not a latency benchmark.

## Using the TypeSafe agent skill

TypeSafe also provides an [agent skill](https://docs.typesafe.ai/agent-skill) for coding agents, including Codex and Claude Code. It supplies API context, question types, workflow patterns, and evaluation guidance for writing integrations.

The documented installation command for Codex and other supported agents is:

```bash
npx skills add typesafe-ai/skills --skill typesafe-ai
```

Select your agent when prompted; installation is project-local by default. The linked guide also covers Claude Code's plugin installation and updates. Choose one installation method.

For an incident-routing experiment, I would start with a prompt like:

> Use the TypeSafe skill to propose an incident-routing experiment in shadow mode. Batch independent questions about the same incident into one request. Keep questions and thresholds together for review, and compare proposed routes against historical labels.

The skill helps an agent use the API. Questions, criteria, and thresholds still need review and evaluation on the application's own data.

## How is it different from an LLM with structured outputs?

LLMs can already enforce output structure. OpenAI's Structured Outputs constrains generated tokens to a supplied schema, with separate handling for refusals and interrupted responses.

That guarantees structure under the documented conditions, not correct values. [Structured Outputs technical explanation](https://openai.com/index/introducing-structured-outputs-in-the-api/).

So valid JSON alone is not the breakthrough.

| Aspect | General text-generating LLM | Jev's documented approach |
| --- | --- | --- |
| Output | Text, including schema-constrained text where supported | Typed decisions and distributions |
| Generation | Autoregressive token generation | Parallel decision outputs |
| Interface | Prompts, messages, tools, and schemas | State plus focused typed questions |
| Application design | Can generate explanations and proposed plans | Code combines individual judgments |

TypeSafe's **Reinforcement Learning for Calibrated Decisions (RLCD)** targets decisions and calibrated probabilities. RLHF focuses on human preferences; RLVR uses verifiable rewards. [TypeSafe's AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer).

These objectives can be combined. They do not divide every production model into a separate category.

The real question: can this specialization improve latency, cost, and uncertainty estimates for the same job?

## Why could this be a big deal?

### Latency changes where AI can run

TypeSafe reports **70 to 500 milliseconds** end-to-end latency, **$0.042 per million input tokens** at launch, and no output-token charge.

Its headline workflow results are **193.6 times faster** and **444.6 times cheaper**. [Launch figures](https://typesafe.ai/blog/introducing-system-one-models-and-jev).

Five dependent 200-millisecond calls take one second. Five two-second calls take ten, before any other work.

That gap can decide whether a workflow fits inside an interactive request or needs a background job.

Independent questions can run together. Dependent decisions still need later stages, and network latency, retries, and queueing still count.

### Uncertainty becomes something code can use

Calibration means outcomes assigned an 80% probability should occur roughly 80% of the time across comparable predictions. It describes groups of predictions. [Calibration explanation](https://docs.typesafe.ai/introduction/machine-learning-primer).

Jev's `confidence` for Choice and Score summarizes the probability distribution's shape. It is not automatically the measured probability that an answer is correct.

Thresholds need testing on your own data. [Confidence documentation](https://docs.typesafe.ai/confidence).

The practical test is how many decisions you can automate at an acceptable error rate. Useful uncertainty estimates could help identify which cases need review.

### The unit of value becomes a completed decision

For an incident router, I care about decisions per second, cost per correct routing, and the share of cases needing manual review. Token throughput only tells part of that story.

Jev encourages evaluating AI as a software component with a specific job. Constrained outputs simplify inspection, even though the judgments remain probabilistic.

## What the benchmarks do and do not establish

**The performance figures are TypeSafe's own results. I have not independently benchmarked Jev.** Treat them as a reason to evaluate it, not a production guarantee.

TypeSafe tests security incidents, agent trace observability, invoice processing, and customer service. It compares structured workflows with standalone prompts.

Reference labels average GPT-6 Astra and Claude Fable 5.1 responses at high thinking settings. Other models use provider-default reasoning settings. [Workflow evaluation methodology](https://evals.typesafe.ai/).

The score measures agreement with other models. It does not independently verify business outcomes, and it depends on workflow and reasoning settings.

TypeSafe says the headline gains are at the high end of expectations. Its team built the workflows, and the LLM comparison adapter requests probabilities, adding cost and latency. [Benchmark caveats](https://typesafe.ai/blog/introducing-system-one-models-and-jev).

Gains will depend on the task, region, input length, and load.

## Does type safety eliminate mistakes?

**A valid decision can still be the wrong decision.**

If the only permitted teams are `platform`, `network`, and `application`, a constrained system can prevent an invented fourth team. It can still send a network incident to `application`.

The launch's hallucination guarantee concerns schema matching. It does not establish error-free reasoning or input interpretation. [Type-safety claim](https://typesafe.ai/blog/introducing-system-one-models-and-jev).

Bad context, ambiguous policies, and incomplete choices still cause problems. An `other` option and a review path give uncertain cases somewhere to go.

## Who is behind TypeSafe?

The founders are **Diogo Almeida, CEO; Sasha Sheng, COO; and Erik Gafni, CTO**. Almeida worked at OpenAI and Google Brain, Sheng at Meta/FAIR, and Gafni founded Ravel. [TypeSafe team](https://typesafe.ai/team).

Almeida also co-authored the 2022 **InstructGPT** paper on learning to follow instructions using human feedback. That experience makes his shift toward software-consumed decisions interesting. [InstructGPT paper](https://arxiv.org/abs/2203.02155).

## What I would test next

After these playground examples, my next test would be **incident routing in shadow mode**. Jev proposes a team and urgency; the existing process makes the actual decision.

I would compare Jev, existing rules, and a constrained-output LLM on the same held-out incidents.

Measure routing accuracy, missed urgent cases, review volume, p95 and p99 latency, and cost per incident. Break results down by service and incident type: averages can hide weak spots.

Explanations, remediation code, and deeper investigation remain separate tasks. The decision layer can choose when to invoke them.

**I would adopt it if it cut latency and cost without increasing missed urgent incidents or manual review. If those errors rose, the speedup would not be worth it.**
