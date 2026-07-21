# cate.hubspot

HubSpot as a canvas panel — your pipeline, pinned next to your code.

## What it does

- Points a panel straight at `https://app.hubspot.com/` using the manifest's `url` mode: no assets to build, no server process, no proxy.
- Runs in the extension's own persistent session partition (`persist:ext-cate.hubspot`), so signing in once sticks across restarts and your HubSpot cookies are isolated from browser panels and from every other extension.
- Works where an iframe embed would not: the panel is a top-level browsing context, so HubSpot's `X-Frame-Options` / `frame-ancestors` headers don't block it.

## Your portal

HubSpot is portal-scoped, but `app.hubspot.com` is portal-agnostic: it redirects to sign-in when you're signed out and to `app.hubspot.com/<app>/<portal-id>/...` for your own portal once you're in. Nothing to edit for the common case.

To land somewhere specific, sideload a copy with `url` edited to e.g. `https://app.hubspot.com/contacts/1234567/objects/0-3/views/all/board` (your portal id).

## Scopes

None. A `url` extension gets no `cateHost` bridge and no `cate.*` API — a remote origin can't prove an extension identity, so Cate attaches no preload to it (see `docs/extensions.md` → Security Hygiene). HubSpot is a third party; it should not be able to reach into the workspace.

## Notes

- Sign-in via "Continue with Google/Microsoft/Apple" is pushed to the system browser by Cate's OAuth handling; use email/password inside the panel.
- There is nothing to build. `build.sh` ships the directory as-is (manifest + this README).
