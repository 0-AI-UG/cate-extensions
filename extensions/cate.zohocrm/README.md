# cate.zohocrm

Zoho CRM as a canvas panel — your accounts and deals, pinned next to your code.

## What it does

- Points a panel straight at `https://crm.zoho.com/crm/ShowHomePage.do` using the manifest's `url` mode: no assets to build, no server process, no proxy.
- Runs in the extension's own persistent session partition (`persist:ext-cate.zohocrm`), so signing in once sticks across restarts and your Zoho cookies are isolated from browser panels and from every other extension.
- Works where an iframe embed would not: the panel is a top-level browsing context, so Zoho's `X-Frame-Options` / `frame-ancestors` headers don't block it.

## Your org and data centre

`crm.zoho.com/crm/ShowHomePage.do` is org-agnostic: signed out it redirects to `accounts.zoho.com/signin?servicename=ZohoCRM` and back to your own CRM home afterwards. (Bare `crm.zoho.com` redirects to the marketing site, which is why the manifest uses the app path.)

Zoho runs regional data centres. If your account is on `.eu`, `.in`, `.com.au`, `.jp` or similar, sideload a copy with `url` edited to e.g. `https://crm.zoho.eu/crm/ShowHomePage.do`.

## Scopes

None. A `url` extension gets no `cateHost` bridge and no `cate.*` API — a remote origin can't prove an extension identity, so Cate attaches no preload to it (see `docs/extensions.md` → Security Hygiene). Zoho is a third party; it should not be able to reach into the workspace.

## Notes

- Sign-in via "Continue with Google/Microsoft/Apple" is pushed to the system browser by Cate's OAuth handling; use email/password inside the panel.
- There is nothing to build. `build.sh` ships the directory as-is (manifest + this README).
