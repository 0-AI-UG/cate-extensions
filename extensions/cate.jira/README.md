# cate.jira

Jira as a canvas panel — your board, pinned next to your code.

## What it does

- Points a panel straight at `https://home.atlassian.com/` using the manifest's `url` mode: no assets to build, no server process, no proxy.
- Runs in the extension's own persistent session partition (`persist:ext-cate.jira`), so signing in once sticks across restarts and your Atlassian cookies are isolated from browser panels and from every other extension.
- Works where an iframe embed would not: the panel is a top-level browsing context, so Atlassian's `X-Frame-Options` / `frame-ancestors` headers don't block it.

## Your tenant

Jira is tenant-hosted — your board lives at `https://<your-site>.atlassian.net`, which a shipped manifest can't know. So the panel opens **Atlassian Home**, the tenant-agnostic launcher: sign in once and it lists the sites and apps you have access to, and you click through to your own Jira. (Atlassian consolidated its per-product landing pages into this hub; the older `start.atlassian.com` / `team.atlassian.com` URLs redirect here.)

To pin your own tenant directly, sideload a copy of this extension with `url` edited to e.g. `https://your-site.atlassian.net/jira/software/projects/ABC/boards/1`.

## Scopes

None. A `url` extension gets no `cateHost` bridge and no `cate.*` API — a remote origin can't prove an extension identity, so Cate attaches no preload to it (see `docs/extensions.md` → Security Hygiene). Atlassian is a third party; it should not be able to reach into the workspace.

## Notes

- Sign-in via "Continue with Google/Microsoft/Apple" is pushed to the system browser by Cate's OAuth handling; use email/password inside the panel.
- There is nothing to build. `build.sh` ships the directory as-is (manifest + this README).
