# Friction log

Written while building Couch Pilot during the hackathon window (October 23, 2026). One entry per blocker, in the format requested by the organizers.

---

### 1. Running the Fire TV / Vega simulator in a cloud dev environment

- **Task attempted:** run Couch Pilot on the Fire TV / Vega Virtual Device to record the demo from a headless Linux build machine (cloud container, no GPU).
- **Steps taken:** checked the Vega and Fire TV starter docs, looked for a headless or containerized simulator, checked for `/dev/kvm` in the container.
- **Expected:** a way to boot a Fire TV / Vega simulator headlessly (CI, cloud IDEs, AI coding agents) and capture video.
- **Actual:** the simulator needs hardware virtualization (KVM) and a desktop session; it cannot run in a typical cloud container. No hosted or browser-based preview exists.
- **Severity:** Major
- **Workaround:** built the TV app as a web app with a Fire OS (Android TV) WebView wrapper, compiled the APK in the container, recorded the demo from the same app running in headless Chromium, and kept on-device filming for a real Fire TV.
- **Actionable suggestion:** offer a hosted Vega/Fire TV simulator (or a container image with software rendering) that can run in CI and stream or record its screen. AI coding assistants increasingly work in cloud containers.

### 2. The remote's microphone button is not available to third-party apps

- **Task attempted:** let the user press the voice button on the Fire TV remote to talk to Couch Pilot.
- **Steps taken:** handled key events in the Android activity; tested `SpeechRecognizer.isRecognitionAvailable()` paths in code.
- **Expected:** an app-level way to receive voice input on Fire TV (the voice key, or a system speech-to-text intent).
- **Actual:** the voice key is reserved for Alexa, and Android `SpeechRecognizer` is not guaranteed on Fire OS devices.
- **Severity:** Major (core to an accessibility use case)
- **Workaround:** mapped **☰ Menu** to "talk to Couch Pilot", fell back to the on-screen keyboard when speech recognition is missing, and made **Alexa+ → MCP** the main voice path.
- **Actionable suggestion:** an Alexa+ "hand-off to app" intent: Alexa transcribes, then delivers the utterance to the foreground app that registered for it (with user consent), or a documented speech-to-text intent on Fire OS.

### 3. Testing a self-hosted MCP server against a real Alexa+ device

- **Task attempted:** connect the Couch Pilot MCP server (spec 2025-11-25, Streamable HTTP) to Alexa+ to drive the TV from a real Echo / Fire TV.
- **Steps taken:** read the hackathon resources (Agent Skills, Streamable HTTP transport); looked for a developer console flow to register an MCP endpoint for a personal Alexa+ account.
- **Expected:** a developer sandbox to point Alexa+ at a self-hosted MCP URL for testing.
- **Actual:** no self-serve registration outside the brands in Preview, so the end-to-end voice path can't be tested on a real device.
- **Severity:** Major
- **Workaround:** built the simulated Alexa+ path allowed by the rules: a real MCP client (official TypeScript SDK) that calls the same `/mcp` endpoint. An automated end-to-end test (`npm run test:e2e`) proves the MCP surface works.
- **Actionable suggestion:** a developer-only "MCP sandbox" in the Alexa developer console: paste an HTTPS MCP URL, link it to your own account, see the tool calls Alexa+ makes in a log.

### 4. Which MCP features Alexa+ supports is unclear

- **Task attempted:** design multi-turn tool calls (a clarifying question, a payment confirmation) for Alexa+.
- **Steps taken:** read the MCP 2025-11-25 spec (elicitation, structured content, tool annotations) and the hackathon pages.
- **Expected:** a support matrix: does Alexa+ honor `elicitation/create`, `structuredContent`, `outputSchema`, tool annotations such as `destructiveHint`, long-running calls, progress notifications?
- **Actual:** not documented, so we could not know whether to rely on elicitation for confirmations.
- **Severity:** Minor
- **Workaround:** tools return `status: "needs_input"` with the question and numbered options, and a separate `couchpilot_answer` tool continues. This works with any MCP client.
- **Actionable suggestion:** publish an "Alexa+ MCP client capabilities" page, with timeouts for tool calls and how Alexa+ reads structured results aloud.

### 5. No consent-based way to navigate other Fire TV apps

- **Task attempted:** make Couch Pilot drive any streaming app, not only its own demo catalog.
- **Steps taken:** reviewed Fire TV integration options (deep links, content launcher in the Vega video sample).
- **Expected:** a permissioned API for an assistant to operate apps on the user's behalf (open, search, play, subtitles, volume), the way accessibility services do on phones.
- **Actual:** deep links and content launch cover "open X", not multi-step navigation, subtitles or season/episode selection across apps.
- **Severity:** Major for the product, not for the demo
- **Workaround:** the demo drives its own app with the exact same primitives a remote uses (focus, press, type).
- **Actionable suggestion:** see the feature request in `PRODUCT_FEEDBACK.md`.

### 6. AWS credentials: role ARN without source credentials

- **Task attempted:** try an optional cloud planner on Amazon Bedrock with an IAM role ARN.
- **Steps taken:** `sts:GetCallerIdentity` and `sts:AssumeRole` from the container with the environment's default credentials.
- **Expected:** a clear path from "I have a role ARN" to a working Bedrock call from a cloud dev container.
- **Actual:** `InvalidClientTokenId`. A role ARN alone can't be used without source credentials allowed to assume it, and the error doesn't say so.
- **Severity:** Minor
- **Workaround:** dropped the cloud planner from the submission. In the Alexa+ architecture, Alexa+ is the language AI and Couch Pilot executes. The Bedrock module stays in the repo, off by default.
- **Actionable suggestion:** in STS errors and Builder Center guides, explain the "source credentials + trust policy" requirement next to `AssumeRole`, with a one-command check.
