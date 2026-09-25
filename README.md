# edit.thomaswhite.me

A private editor for `thomaswhite.me`: open the page as it looks, click text and change it, Save (one commit on an `edits` branch), Publish (the pull request, CI, merge).

**Status: planned, not built.** The approved plan is [`docs/plan.md`](docs/plan.md); the original sketch is [`docs/edit-subdomain-plan.md`](docs/edit-subdomain-plan.md). The repository holds the scaffold, the vendored HTML parser and the test fixtures described in [`AGENTS.md`](AGENTS.md).

The editor targets the preview site (`new.thomaswhite.me`, repository `ThomasWCode/ThomasWCode.github.io-revised`) until the large content update is merged into the main site, then a config switch points it at `thomaswhite.me`.
