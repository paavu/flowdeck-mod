# Contributing

flowdeck is a Claude mod for Claude Code. Issues and pull requests are welcome at https://github.com/paavu/flowdeck-mod.

Before a pull request:

1. `claude plugin test .` passes (the whole suite; add a test for what you change, on both the `terminal` and `desktop` surfaces where it draws).
2. `claude plugin validate .` ends with `✔ Validation passed`.
3. Every change bumps the version (`M.m.xxxx`, the 4-digit build number by one) in three places together: `version` in `.claude-plugin/plugin.json`, `VERSION` in `hooks/version.ts` and a new top heading in `CHANGELOG.md` with a line saying what changed. `sh scripts/check-version.sh` checks that they agree.
4. Update README.md when behaviour a user can see changes. If the band, the cache card or the panel looks different, run `sh scripts/screenshots.sh` (needs `agent-browser`) to render `docs/images/` again.

The issue forms and the pull request checklist are in `.github/` (`ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE.md`).

The mod must keep working without anything outside the repository: no rule may depend on a user's CLAUDE.md, memory or settings. It writes only under `<project>/.claude/flowdeck/`, and deletes a file only from `Empty Trash`.
