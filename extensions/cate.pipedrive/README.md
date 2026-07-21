# cate.pipedrive

Pipedrive as a canvas panel — your deal pipeline, pinned next to your code.

## What it does

- Points a panel straight at `https://app.pipedrive.com/` using the manifest's `url` mode: no assets to build, no server process, no proxy.
- Runs in the extension's own persistent session partition (`persist:ext-cate.pipedrive`), so signing in once sticks across restarts and your Pipedrive cookies are isolated from browser panels and from every other extension.
- Works where an iframe embed would not: the panel is a top-level browsing context, so Pipedrive's `X-Frame-Options` / `frame-ancestors` headers don't block it.

## Your company

Pipedrive companies have their own `https://<company>.pipedrive.com` domain, but `app.pipedrive.com` is company-agnostic: it shows the login form when you're signed out and redirects to your own company's app once you're in. Nothing to edit for the common case.

To pin your company directly, sideload a copy with `url` edited to e.g. `https://your-company.pipedrive.com/pipeline`.

## Scopes

None. A `url` extension gets no `cateHost` bridge and no `cate.*` API — a remote origin can't prove an extension identity, so Cate attaches no preload to it (see `docs/extensions.md` → Security Hygiene). Pipedrive is a third party; it should not be able to reach into the workspace.

## Notes

- Sign-in via "Google" or SSO is pushed to the system browser by Cate's OAuth handling; use email/password inside the panel.
- There is nothing to build. `build.sh` ships the directory as-is (manifest + this README).
