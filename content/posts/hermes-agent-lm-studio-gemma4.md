+++
title = "Hermes Agent + LM Studio Bionic: Running Gemma 4 Locally"
date = '2026-09-27T00:05:00+08:00'
draft = false
description = "A Windows walkthrough of Hermes Agent connected to LM Studio Bionic with Gemma 4 E4B: local inference, custom endpoint settings, tool use, and the checks that confirm it works."
tags = ["ai", "local-llm", "ai-agents", "hermes-agent", "lm-studio", "gemma", "homelab"]
series = ["AI Infra"]
ShowToc = true
TocOpen = false

[cover]
  image = "/images/posts/hermes-agent-lm-studio-gemma4/00-pixel-art-cover.png"
  alt = "Pixel art laptop with a winged messenger robot exchanging requests with a gem-shaped model chip"
  relative = false
+++

I wanted to take my local LLM setup one step further: put an agent in front of it. Keep the model on my machine, but give it a desktop interface, tools, and a way to work beyond a single chat reply.

The stack I connected was **Hermes Agent + LM Studio Bionic + Gemma 4 E4B** on Windows. Hermes handles the conversation and tools. Bionic hosts the model through a local API. Gemma generates the responses.

The connection comes down to two values:

```text
Base URL: http://localhost:1234/v1
Model:    google/gemma-4-e4b
```

This walkthrough follows my September setup, with the working configuration captured on September 26. The model inference runs locally. Optional features such as web search and Telegram still use network services, which matters when deciding what "all local" means for a particular task.

*Select any screenshot to open it at full resolution.*

## How the pieces fit together

[Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/desktop) is the agent application. It manages sessions, tool execution, and the conversation around the model. The model does not execute a command itself: the agent handles that part and can pass the result back for another response.

[LM Studio Bionic](https://lmstudio.ai/blog/introducing-lm-studio-bionic) is a separate app from classic LM Studio, with its own agent features and support for local models through the LM Studio runtime. In this setup, I use **its Local Model API as Hermes's model backend**. Bionic's own chat interface is not an extra agent step in the request path.

**Gemma 4 E4B** is the model loaded behind that API. Selecting a different model in Hermes only works if the server can actually serve that identifier.

{{< figure src="/images/posts/hermes-agent-lm-studio-gemma4/01-local-agent-flow.svg" link="/images/posts/hermes-agent-lm-studio-gemma4/01-local-agent-flow.svg" alt="Hermes Agent sends requests over localhost to LM Studio Bionic, which runs Gemma 4 E4B on the same machine. Optional web search and Telegram connect separately to Hermes over the network." caption="The inference path stays on the machine. Network tools are a separate part of the agent workflow." class="post-screenshot" >}}

The interface is **OpenAI-compatible**: it uses a familiar request format while sending requests to `localhost`. It does not require an OpenAI-hosted model. LM Studio documents both the model-listing and chat-completion endpoints used below. [API compatibility documentation](https://lmstudio.ai/docs/developer/openai-compat).

## 1. Install Hermes and download the model

Start with the [Hermes desktop download](https://hermes-agent.nousresearch.com/desktop) and [LM Studio downloads](https://lmstudio.ai/download). Choose **Bionic** for the interface shown here. Installation and the initial model download need internet access.

My earlier Hermes setup screen shows the installer preparing Python, Git, Node.js, and the desktop dependencies. Let the first-time setup complete before configuring the provider.

{{< figure src="/images/posts/hermes-agent-lm-studio-gemma4/02-hermes-windows-installer.png" link="/images/posts/hermes-agent-lm-studio-gemma4/02-hermes-windows-installer.png" alt="Hermes Windows installer preparing dependencies and building the desktop app" caption="The initial Windows setup on September 1. Later launches use the installed environment." class="post-screenshot" >}}

In Bionic, open **Settings → Local Models → Explore**, find **Gemma 4 E4B**, and download the instruction-tuned model. These are the details visible in my setup:

| Item | My selection |
| --- | --- |
| Model | Gemma 4 E4B Instruct |
| Local API identifier | `google/gemma-4-e4b` |
| Format | GGUF |
| Quantization | `Q4_K_M` |
| Displayed model size | 6.33 GB |
| Execution location | This device |

{{< figure src="/images/posts/hermes-agent-lm-studio-gemma4/03-gemma4-model-download.png" link="/images/posts/hermes-agent-lm-studio-gemma4/03-gemma4-model-download.png" alt="Bionic Explore page with Gemma 4 E4B selected and a 6.33 GB instruction-tuned download available locally" caption="Gemma 4 E4B downloaded in Bionic. The model page advertises vision, tools, and reasoning capabilities." class="post-screenshot" >}}

The **E** in E4B means *effective*. Google's model card lists approximately 4.5 billion effective parameters and 8 billion with embeddings. That is why treating E4B as a conventional 4-billion-parameter weight file can give the wrong memory expectation. [Google's Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4).

Also distinguish the local serving name from the upstream repository. Google's instruction-tuned model card is [google/gemma-4-E4B-it](https://huggingface.co/google/gemma-4-E4B-it); the endpoint in my screenshots serves it as `google/gemma-4-e4b`. Use the name your local server reports.

## 2. Start the Local Model API

Open **Settings → Local Model API** in Bionic and turn on the server. My screen shows:

- **Local API server:** Running
- **Base URL:** `http://localhost:1234/v1`
- **Just-in-time model loading:** On
- **CORS:** Off

{{< figure src="/images/posts/hermes-agent-lm-studio-gemma4/04-local-model-api.png" link="/images/posts/hermes-agent-lm-studio-gemma4/04-local-model-api.png" alt="Local Model API running at localhost port 1234 with just-in-time loading enabled and a Gemma completion in the server log" caption="Bionic's local server is running. The log also records a completion for google/gemma-4-e4b." class="post-screenshot" >}}

Just-in-time loading lets an API request load a matching model when possible. For the first check, it is still useful to confirm the model appears under **Loaded Instances**, so a download or loading issue is easier to spot.

The screenshots keep CORS off. It is not a general connection switch to enable whenever a client fails; it concerns browser-origin requests. First check the server address, model, and authentication settings.

Both apps run on the same Windows machine here. If Hermes runs inside WSL, a container, or another computer, `localhost` refers to that environment instead. The address may then need to change.

## 3. Add the endpoint in Hermes

In Hermes, open **Settings → Providers → Custom Endpoints**. Create a named endpoint so it is easy to recognize in the provider list.

| Field | Value shown in my setup |
| --- | --- |
| Name | `LMStudio Local` |
| Provider ID | `lmstudio-local` |
| Endpoint URL | `http://localhost:1234/v1` |
| API Mode | Auto-detect |
| Default Model | `google/gemma-4-e4b` |
| Context | Auto |
| Use for new chats | Enabled |
| Discover models | Enabled |

{{< figure src="/images/posts/hermes-agent-lm-studio-gemma4/05-hermes-custom-endpoint.png" link="/images/posts/hermes-agent-lm-studio-gemma4/05-hermes-custom-endpoint.png" alt="Hermes Custom Endpoints settings with LMStudio Local active, localhost API URL, and google/gemma-4-e4b selected" caption="The working custom endpoint on September 26. Hermes and Bionic must agree on the base URL and model identifier." class="post-screenshot" >}}

Use the **base URL**, including `/v1`, in the endpoint field. Do not paste the full `/v1/chat/completions` request URL there.

Authentication depends on the server configuration. LM Studio's API documentation says authentication is disabled by default; if you enable it, supply the matching local API token in Hermes. A placeholder saying "Leave blank to keep current key" does not reveal whether an existing key is stored. [LM Studio authentication](https://lmstudio.ai/docs/developer/core/authentication).

Click **Test**, then **Save**, and activate the endpoint with **Use** if needed. Check the active profile as well: my screen has separate `default` and `work` scopes.

{{< figure src="/images/posts/hermes-agent-lm-studio-gemma4/06-endpoint-test.png" link="/images/posts/hermes-agent-lm-studio-gemma4/06-endpoint-test.png" alt="Earlier Hermes endpoint configuration with a notification that the endpoint is reachable and two models were found" caption="An earlier September 1 check returned: Endpoint is reachable. Found 2 models. Your count depends on the local model inventory." class="post-screenshot" >}}

Current Hermes also documents a built-in **LM Studio** provider through `hermes model`. The custom endpoint route above is the desktop configuration used in these screenshots. [Hermes provider guide](https://hermes-agent.nousresearch.com/docs/integrations/providers).

## 4. Check the request from both sides

Start a new Hermes session and confirm the model selector says **Gemma 4 E4B**. A saved default does not necessarily change the provider of an existing conversation.

Send a small prompt first, such as `Hi Hermes`. While it runs, inspect **Loaded Instances** in Bionic. My capture shows Gemma on **This device**, with an active request marked **Generating**.

{{< figure src="/images/posts/hermes-agent-lm-studio-gemma4/07-local-model-generating.png" link="/images/posts/hermes-agent-lm-studio-gemma4/07-local-model-generating.png" alt="Gemma 4 E4B loaded on this device in GGUF Q4_K_M format with one request generating and a token count of 226" caption="The local runtime is doing work: Gemma 4 E4B has an active generation request." class="post-screenshot" >}}

This gives a more useful check than the model selector alone: Hermes points to the local provider, and the local server records generation for the same model.

The numbers on this screen need some care. **226** is a token count, not tokens per second. **6.33 GB** is the displayed model size, not a measurement of total runtime memory. **109,568 ctx** is the loaded context setting in this instance, not a long-context benchmark or a setting everyone should copy.

Model weights, context cache, and runtime overhead all consume memory. If loading or generation struggles, reduce the configured context and check actual RAM/VRAM use. Google's [memory-planning notes](https://ai.google.dev/gemma/docs/core) also distinguish model weights from context and other runtime allocations.

### Optional: check the API directly with PowerShell

This diagnostic separates a server problem from a Hermes configuration problem. Run it on the machine hosting Bionic. The first request lists model identifiers:

```powershell
$baseUrl = "http://localhost:1234/v1"
$headers = @{}

# Only needed if you enabled authentication on the local server.
if ($env:LM_API_TOKEN) {
    $headers.Authorization = "Bearer $env:LM_API_TOKEN"
}

$models = Invoke-RestMethod -Uri "$baseUrl/models" -Headers $headers
$models.data | Select-Object id
```

Then send a small chat request, using the exact ID returned by your server:

```powershell
$body = @{
    model = "google/gemma-4-e4b"
    messages = @(
        @{
            role = "user"
            content = "In one sentence, explain what local inference means."
        }
    )
    stream = $false
} | ConvertTo-Json -Depth 6

$response = Invoke-RestMethod `
    -Uri "$baseUrl/chat/completions" `
    -Method Post `
    -Headers $headers `
    -ContentType "application/json" `
    -Body $body

$response.choices[0].message.content
```

These are diagnostic examples, not benchmark runs. A model-list response verifies reachability and discovery; a completion checks that the runtime can actually generate. LM Studio documents these separately as [List Models](https://lmstudio.ai/docs/developer/openai-compat/models) and [Chat Completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions).

## 5. Try a tool, then inspect what happened

After the greeting worked, I asked Hermes about the weather in Singapore. The conversation shows a **search step**, followed by a weather response, with Gemma 4 E4B selected in the composer.

{{< figure src="/images/posts/hermes-agent-lm-studio-gemma4/08-hermes-weather-tool.png" link="/images/posts/hermes-agent-lm-studio-gemma4/08-hermes-weather-tool.png" alt="Hermes conversation with a greeting and a Singapore weather question, showing a web search action and Gemma 4 E4B selected" caption="A chat reply followed by a tool-assisted weather answer. The model is local; the search needs the network." class="post-screenshot" >}}

That is the interesting step beyond plain local chat: the agent can obtain information through a tool and use it in the conversation. This example shows the interaction working; it does not establish search accuracy or reliability across longer tasks. For current weather, follow the source rather than treating the generated summary as a measurement.

Hermes exposes its skills and tools through **Capabilities**. The Skills Hub is useful for discovering workflows, but an installed skill can still call an external service or require separate credentials. Read what it uses before assuming the whole workflow stays on the machine. [Hermes web-tool documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search).

{{< figure src="/images/posts/hermes-agent-lm-studio-gemma4/09-hermes-skills.png" link="/images/posts/hermes-agent-lm-studio-gemma4/09-hermes-skills.png" alt="Hermes Capabilities view showing installed skills, tool tabs, and the Skills Hub browser" caption="Capabilities adds workflows around the local model. Catalog availability is separate from what has been installed and tested." class="post-screenshot" >}}

For a useful local follow-up, try a small workspace task: ask Hermes to read a README and summarize the project, or explain a short log file. Start with a read-only request and review the tool activity before moving on to edits.

## Where "all local" begins and ends

For this configuration, **the agent application and model runtime are on my machine, and the selected model is served over loopback**. There is no hosted LLM required for that main inference path.

| Activity | Where it happens |
| --- | --- |
| Gemma response generation | Local LM Studio runtime |
| Hermes conversation and orchestration | Local desktop app |
| Reading a local file through a local tool | On the machine |
| Initial app and model downloads | Network required |
| Web search and fetched pages | External network services |
| Telegram messaging | Telegram's network |
| Other skills, connectors, or auxiliary models | Depends on their configuration |

LM Studio supports [offline inference with downloaded models](https://lmstudio.ai/docs/app/offline). To check an entirely offline Hermes workflow, disable network-dependent integrations, check any auxiliary model settings, disconnect the network, and try the exact local task you intend to use. The connected weather example above is not that test.

### Optional: reach Hermes through Telegram

I also connected Telegram during the earlier setup. Hermes's messaging settings let you configure a bot and restrict access to approved users. Follow the [official Telegram setup guide](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram) for the token, user access, and gateway steps.

This gives you a messaging interface to the agent while the model can continue running locally. The host machine, Hermes gateway, and local model server need to remain available. Messages still pass through Telegram, so this is a network-connected extension of the setup.

{{< figure src="/images/posts/hermes-agent-lm-studio-gemma4/10-telegram-hermes-bot.jpg" link="/images/posts/hermes-agent-lm-studio-gemma4/10-telegram-hermes-bot.jpg" alt="Telegram conversation with Hermes Bot showing a greeting, a web search for the Jev model, and a generated reply" caption="Hermes receives the Telegram message, runs a web search, and returns a reply through the bot. This demonstrates the message and tool route, not the factual accuracy of the generated answer." class="post-screenshot post-screenshot-portrait" >}}

## If something does not work

| Symptom | What to check first |
| --- | --- |
| Connection refused | Bionic is running, the Local Model API is on, and the port matches. |
| Endpoint works in PowerShell but not Hermes | Base URL, active endpoint, profile, and selected conversation model. |
| Model not found | Copy the exact ID from `/v1/models`; a display name or upstream repository name may differ. |
| HTTP 401 or missing authorization | Confirm which provider received the request, then check its authentication requirements. |
| Unexpected API-format errors | The shown setup uses Auto-detect. If detection fails, explicitly try Chat Completions, which the server supports. |
| Loading fails or generation becomes very slow | Available memory, context allocation, competing loaded models, and runtime/offload settings. |
| Chat works but a tool fails | Tool configuration, permissions, and model/runtime support for tool calls. A text reply alone does not test these. |
| Telegram stops replying | Host availability, gateway status, allowed users, and access to the local model server. |

The part I wanted to prove here was straightforward: **Hermes can use my locally served Gemma model as its backend.** The endpoint test, the model's active generation, and the resulting conversation make that connection visible.

From here, I would evaluate it task by task: local file summaries, log analysis, and small coding changes, checking both the answers and the tool actions. Getting the agent connected is the starting point; learning which work this model handles well is the next experiment.

If you are building up the same stack, my [AI agent basics](/posts/ai-agent-basics/) explains the model/tool loop, and [running llama.cpp locally](/posts/running-llama-cpp-on-32gb-macbook-air/) looks at the runtime side more directly.
