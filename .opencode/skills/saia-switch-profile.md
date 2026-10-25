# SAIA Profile Switcher

Switches between predefined model profiles: production, development, and budget.

## Usage

Trigger this skill when:
- You want to test cheaper/budget models during development
- You need to force a production-grade model for critical work
- You're switching between prototyping and final edits

## Profiles

### Production
- Current workhorse: `glm-5.3-flash`; use `qwen3.5-397b-a17b` for harder reasoning
- Best for critical code reviews, architecture decisions
- Higher cost, best quality
- Default profile

### Development
- Balanced models such as `qwen3.8-27b` and `qwen3.6-35b-a3b`
- Good for日常 coding, quick iterations
- Faster responses, moderate quality
- Recommended for active development

### Budget
- Smaller models such as `meta-llama-3.1-8b-instruct` and `deepseek-v4-flash-0731`
- Ideal for quick edits, syntax checks, refactors
- Lowest cost, acceptable quality
- Good for large-scale codebase operations

## Profile persistence

Your profile choice is saved in `~/.config/opencode/saia-preferences.json` and persists across sessions.

## Project-specific profiles

You can override the global profile at the project level by editing `.opencode/saia/context.json` with a `"profile"` field.

## Example

```bash
# Switch to budget mode
/opencode/skills/saia-switch-profile
Choose: budget

# Result: model choices follow the selected profile
# Saved: { "profile": "budget" } in preferences
```
