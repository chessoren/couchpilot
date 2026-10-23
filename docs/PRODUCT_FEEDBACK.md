# Product feedback

One entry per tool, API or SDK used to build Couch Pilot.

## 1. Model Context Protocol, spec 2025-11-25, Streamable HTTP (Alexa+ track)

- **Used for:** the Couch Pilot MCP server (`/mcp`): `couchpilot_run_goal`, `couchpilot_answer`, `couchpilot_stop`, `tv_get_state`, 7 primitives, 2 resources, tool annotations, stateless Streamable HTTP with JSON responses.
- **What worked well:** stateless mode (one server + transport per request) is simple to host and to put behind a load balancer. Tool annotations (`readOnlyHint`, `destructiveHint`) map naturally to our trust levels. `structuredContent` gives clients machine-readable results next to the spoken text.
- **What needs work:** for voice assistants, the spec doesn't say much about long-running tools and "ask the user, then continue" flows. Elicitation exists, but whether Alexa+ supports it is undocumented, so we used a portable `needs_input` + answer-tool pattern.
- **Onboarding:** under an hour from zero to a tool called by a client.
- **Build with it again?** Yes. It's the cleanest way to give Alexa+ new abilities without writing a skill per intent.

## 2. MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.1)

- **Used for:** `McpServer` + `StreamableHTTPServerTransport` (server), `Client` + `StreamableHTTPClientTransport` (Alexa+ simulator and end-to-end test).
- **What worked well:** `registerTool` with Zod schemas, `LATEST_PROTOCOL_VERSION = 2025-11-25` out of the box, a working client in the same package, so we could test the server for real.
- **What needs work:** the stateless (no session ID) setup is only explained in a code comment in `streamableHttp.d.ts`; it deserves a top-level README example. Zod 3/4 compatibility is accepted but not explained.
- **Onboarding:** smooth.
- **Build with it again?** Yes.

## 3. Alexa+ (simulated experience path)

- **Used for:** the "Alexa+ understands, Couch Pilot acts" flow. `web/alexa.html` + `server/alexa-sim.js` simulate the Alexa+ conversation and call Couch Pilot through a real MCP client.
- **What worked well:** the rules explicitly allow the simulated path, which let us focus on the agent and the TV experience.
- **What needs work:** we could not connect a self-hosted MCP server to a real Alexa+ account (see friction log #3). A developer sandbox would let teams prove the real integration.
- **Onboarding:** the hackathon pages were clear on what's accepted. Device-side testing isn't possible yet.
- **Build with it again?** Yes, with a sandbox it would be our first choice for voice on Fire TV.

## 4. Fire OS / Android TV (Fire TV track)

- **Used for:** `android/`: a Kotlin app with a full-screen WebView (`androidx.webkit` `WebViewAssetLoader` serving the bundled app), leanback launcher and banner, D-pad handling, Menu key = talk, Back = stop, `SpeechRecognizer` when available, `TextToSpeech` for spoken replies.
- **What worked well:** a standard Android TV project builds with stock Gradle/AGP, and the WebView path lets one codebase serve the browser, the APK and the MCP demo. D-pad events reach the WebView as arrow keys.
- **What needs work:** voice input for third-party apps (friction log #2), no headless simulator (friction log #1). We would also like clear guidance on which video codecs the WebView supports per Fire TV generation (we ship WebM/VP9 and MP4/H.264 sources).
- **Onboarding:** good docs for sideloading with ADB. We wrote the wrapper in under an hour.
- **Build with it again?** Yes.

## 5. Fire TV starter samples and docs

- **Used for:** reference for 10-foot UI patterns (focus, navigation) and the multi-modal UX priority category. We did not fork a sample: our app is plain ES modules so it runs unchanged in the browser and in the Fire OS WebView.
- **What worked well:** `vega-tv-interfaces-sample` and the multi-TV React Native sample show focus management clearly.
- **What needs work:** a "web app on Fire OS" sample (WebView + D-pad + TTS) would help the many teams who prototype in the browser.
- **Build with it again?** Yes.

## 6. Amazon Bedrock (tried, not used in the submission)

- **Used for:** an optional cloud planner (`server/bedrock.js`: Converse API with a forced `submit_plan` tool limited to the allow-listed actions). Off by default.
- **What worked well:** the Converse API's tool schema is a good fit for constraining an LLM to a fixed action set. The JS SDK is easy to wire.
- **What needs work:** getting from a role ARN to a working call from a cloud container (friction log #6).
- **Build with it again?** Yes, for a production planner. For this hackathon, Alexa+ is the language AI and Couch Pilot executes, so we did not need a second LLM.

## Feature request

- **Feature:** an official, consent-based way for third-party assistants (and accessibility apps) to navigate the Fire TV interface and other apps on the user's behalf: open, search, choose season/episode, play, subtitles, volume. Ideally exposed to Alexa+ as MCP tools.
- **Why it matters:** Couch Pilot proves the experience on its own catalog. With this API it becomes an accessibility layer for every Fire TV user: older adults, people with low vision, people with motor impairments.
- **Priority:** Critical
