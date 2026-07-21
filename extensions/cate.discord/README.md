# cate.discord

Discord as a canvas panel — the Discord web app, pinned next to your code.

## What it does

- Points a panel straight at `https://discord.com/app` using the manifest's `url` mode: no assets to build, no server process, no proxy.
- Runs in the extension's own persistent session partition (`persist:ext-cate.discord`), so signing in once sticks across restarts and your Discord cookies are isolated from browser panels and from every other extension.
- Works where an iframe embed would not: the panel is a top-level browsing context, so Discord's `X-Frame-Options` / `frame-ancestors` headers don't block it.

## Scopes

None. A `url` extension gets no `cateHost` bridge and no `cate.*` API — a remote origin can't prove an extension identity, so Cate attaches no preload to it (see `docs/extensions.md` → Security Hygiene). Discord itself is a third party; it should not be able to reach into the workspace.

## Notes

- Sign-in via "Continue with Google/Apple" is pushed to the system browser by Cate's OAuth handling; use email/password or QR sign-in inside the panel.
- There is nothing to build. `build.sh` ships the directory as-is (manifest + this README).
