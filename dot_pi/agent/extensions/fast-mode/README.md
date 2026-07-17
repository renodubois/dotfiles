# Pi Fast Mode

A local Pi extension that keeps one Fast-mode toggle across model switches and applies it to every currently supported ChatGPT Codex agent.

Fast mode is enabled by default when no saved session state or inherited setting exists.

## Usage

```text
/fast             Toggle Fast mode
/fast on          Enable Fast mode
/fast off         Disable Fast mode
/fast status      Show whether it is active for the selected agent
/fast models      List supported agents
```

When enabled, the footer shows:

- `⚡ fast` when Fast mode is active for the selected agent.
- `⚡ fast (armed)` when the selected agent is unsupported. The mode remains enabled and activates automatically after switching to a supported agent.

When the local `context-100k-indicator` footer is loaded, this indicator appears beside the model and thinking level instead of on a separate status line.

The setting is stored as non-context session state. It survives reloads and resumes, follows session branches, and does not leak into the model's prompt. It is also propagated through `PI_FAST_MODE_ENABLED` to child Pi processes, so supported headless subagents launched after the toggle inherit the current mode.

## Supported agents

- `gpt-5.4`
- `gpt-5.5`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`

Fast mode requires the built-in `openai-codex` provider with ChatGPT OAuth. API-key requests, unsupported models, mismatched payloads, and requests that already specify `service_tier` are left unchanged.

Eligible requests receive:

```json
{
  "service_tier": "priority"
}
```

Fast mode has higher ChatGPT credit consumption. OpenAI currently describes it as approximately 1.5x speed, with GPT-5.5 and GPT-5.6 consuming credits at 2.5x the Standard rate.

References:

- https://learn.chatgpt.com/docs/agent-configuration/speed.md
- https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json

## Maintenance

OpenAI's supported set is intentionally allowlisted. Update `SUPPORTED_OPENAI_CODEX_MODELS` in `index.ts` when Codex's model catalog adds or removes the `priority` service tier.

Run tests with:

```bash
cd ~/.pi/agent/extensions/fast-mode
npm test
```
