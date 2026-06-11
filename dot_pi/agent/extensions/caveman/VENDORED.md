# Caveman Pi Extension

Source analyzed: https://github.com/JuliusBrussee/caveman
Snapshot reviewed locally: git clone --depth 1 on 2026-06-10.

This is a small Pi-native reimplementation, not an npm install. It vendors the upstream MIT license as `LICENSE.caveman-upstream` because the behavior and skill text are inspired by upstream Caveman.

Upstream pieces reviewed:
- `skills/caveman/SKILL.md`
- `src/rules/caveman-activate.md`
- `README.md`

Pi-specific pieces implemented here:
- `/caveman` command
- text trigger detection (`talk like caveman`, `normal mode`, etc.)
- `before_agent_start` system prompt injection
- status indicator
- contributed Agent Skill path for `/skill:caveman`
