# cate.salesforce

Salesforce as a canvas panel — your org, pinned next to your code.

## What it does

- Points a panel straight at `https://login.salesforce.com/` using the manifest's `url` mode: no assets to build, no server process, no proxy.
- Runs in the extension's own persistent session partition (`persist:ext-cate.salesforce`), so signing in once sticks across restarts and your Salesforce cookies are isolated from browser panels and from every other extension.
- Works where an iframe embed would not: the panel is a top-level browsing context, so Salesforce's `X-Frame-Options` / `frame-ancestors` headers don't block it.

## Your org

Salesforce is instance-hosted — your org lives at something like `https://your-org.lightning.force.com`, which a shipped manifest can't know. So the panel opens `login.salesforce.com`, the tenant-agnostic gateway: sign in (or use "Use Custom Domain" if your org enforces My Domain) and Salesforce redirects you to your own instance.

To pin your org directly, sideload a copy with `url` edited to e.g. `https://your-org.lightning.force.com/lightning/page/home`.

## Scopes

None. A `url` extension gets no `cateHost` bridge and no `cate.*` API — a remote origin can't prove an extension identity, so Cate attaches no preload to it (see `docs/extensions.md` → Security Hygiene). Salesforce is a third party; it should not be able to reach into the workspace.

## Notes

- SSO that hands off to Google/Microsoft/Apple is pushed to the system browser by Cate's OAuth handling; use username/password (with MFA) inside the panel.
- There is nothing to build. `build.sh` ships the directory as-is (manifest + this README).
