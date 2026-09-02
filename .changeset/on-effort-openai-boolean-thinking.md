---
"@moonshot-ai/kimi-code": patch
---

Fix the thinking On switch sending no reasoning parameter for hand-configured OpenAI-compatible models. Picking On in the model or thinking picker now asks for a level (saved as `on_effort` in config.toml); set `on_effort` (e.g. `"medium"`) on the model directly to skip the prompt.
