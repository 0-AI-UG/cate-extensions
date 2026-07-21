# cate.slack

Slack as a canvas panel — a channel, pinned next to your code.

## What it does

- Points a panel straight at `https://app.slack.com/client` using the manifest's `url` mode: no assets to build, no server process, no proxy.
- Runs in the extension's own persistent session partition (`persist:ext-cate.slack`), so signing in once sticks across restarts and your Slack cookies are isolated from browser panels and from every other extension.
- Works where an iframe embed would not: the panel is a top-level browsing context, so Slack's `X-Frame-Options` / `frame-ancestors` headers don't block it.

## Your workspace

Slack is workspace-hosted, but `app.slack.com/client` is workspace-agnostic: it redirects to whichever workspace you're signed into (and to the workspace picker / sign-in when you're not). Nothing to edit for the common case.

To pin one workspace directly, sideload a copy with `url` edited to e.g. `https://app.slack.com/client/T01234567` (your team id), or `https://your-workspace.slack.com/`.

## Scopes

None. A `url` extension gets no `cateHost` bridge and no `cate.*` API — a remote origin can't prove an extension identity, so Cate attaches no preload to it (see `docs/extensions.md` → Security Hygiene). Slack is a third party; it should not be able to reach into the workspace.

## Notes

- Sign-in via "Continue with Google/Apple" is pushed to the system browser by Cate's OAuth handling; use email/magic-link or password sign-in inside the panel.
- There is nothing to build. `build.sh` ships the directory as-is (manifest + this README).
