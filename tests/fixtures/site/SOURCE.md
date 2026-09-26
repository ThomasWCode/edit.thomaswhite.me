# Fixture source

Verbatim copies of files from `ThomasWCode/ThomasWCode.github.io-revised` at commit `3d1918ea1a9dc9f11412d62afd024004e72dbfed`
(25 September 2026), taken from the git index so they carry LF endings exactly as the
GitHub API serves them. Refresh them with `git show HEAD:<path>` when the editor needs to
follow a markup change; the unit tests pin editable counts per page, so a refresh usually
means updating those numbers deliberately.

`FILES.txt` is `git ls-tree -r --name-only` of the same commit: the checks test resolves
local references (`/Images/…`, `/Tom-White-CV.pdf`) against it, as the site's own
local-reference contract does.
