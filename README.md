# pr-summary
> Auto-generate PR descriptions from your git diff. Ship better PRs in seconds.

```bash
npx pr-summary
npx pr-summary --ai --copy
```

```
pr-summary · 3 commits ahead of main
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## Summary
Adds JWT auth with refresh tokens and fixes session timeout.

## What Changed
- feat: add JWT middleware with refresh token rotation
- fix: resolve session timeout race condition

## Files Changed
Modified: 8 files (+187/-34 lines)
Added: src/auth/jwt.js

## How to Test
- [ ] Run npm test
- [ ] Test POST /auth/login

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Copied to clipboard ✓
```

## Commands
| Command | Description |
|---------|-------------|
| `pr-summary` | Generate PR description |
| `--ai` | AI-polished summary |
| `--copy` | Copy to clipboard |
| `--base <branch>` | Base branch to compare |
| `--open` | Open draft PR |

## Install
```bash
npx pr-summary
npm install -g pr-summary
```

---
**Zero dependencies** · **Node 18+** · Made by [NickCirv](https://github.com/NickCirv) · MIT
