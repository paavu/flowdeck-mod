## What and why

<!-- What the change does and why it is needed. -->

## Checklist

- [ ] `claude plugin test .` passes
- [ ] `claude plugin validate --strict .` passes
- [ ] Version bumped in `.claude-plugin/plugin.json`, `hooks/version.ts`, `CHANGELOG.md` and the README badge and version text
- [ ] `sh scripts/check-version.sh`, `sh scripts/check-rules.sh` and `sh scripts/check-readme.sh` pass
- [ ] Screenshots regenerated (`sh scripts/screenshots.sh`) if the UI changed
- [ ] Commit message style `<version>: <summary>`
