# cate.dynamics365

Microsoft Dynamics 365 as a canvas panel — your CRM, pinned next to your code.

## What it does

- Points a panel straight at `https://www.office.com/apps` using the manifest's `url` mode: no assets to build, no server process, no proxy.
- Runs in the extension's own persistent session partition (`persist:ext-cate.dynamics365`), so signing in once sticks across restarts and your Microsoft cookies are isolated from browser panels and from every other extension.
- Works where an iframe embed would not: the panel is a top-level browsing context, so Microsoft's `X-Frame-Options` / `frame-ancestors` headers don't block it.

## Your environment

Dynamics 365 is environment-hosted — your apps live at `https://<your-org>.crm.dynamics.com` (or `.crm4`, `.crm11`, … for your region), which a shipped manifest can't know. Microsoft **retired `home.dynamics.com` in 2021**; the documented replacement is the Microsoft 365 app launcher, which lists the Dynamics 365 apps you're licensed for and clicks through to your own environment.

To pin your environment directly, sideload a copy with `url` edited to e.g. `https://your-org.crm.dynamics.com/main.aspx?appid=<app-guid>`.

## Scopes

None. A `url` extension gets no `cateHost` bridge and no `cate.*` API — a remote origin can't prove an extension identity, so Cate attaches no preload to it (see `docs/extensions.md` → Security Hygiene). Microsoft is a third party; it should not be able to reach into the workspace.

## Notes

- Microsoft sign-in runs on `login.microsoftonline.com`, which Cate treats as an OAuth host and pushes to the system browser. Expect to complete first-time sign-in there; if the panel does not pick the session up, sideload a copy pinned at your own `*.crm.dynamics.com` URL.
- There is nothing to build. `build.sh` ships the directory as-is (manifest + this README).
