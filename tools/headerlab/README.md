# HeaderLab

HeaderLab is a Chrome extension under development. Request-header rules can be
added, edited, enabled, and removed for selected sites. Query parameter rules
update matching tab addresses without reloading; existing values require a
choice before replacement. Undo information is held only for the current
browser session, and site changes are preserved with a warning. Cookie rules
create session cookies in the available browser cookie stores. Existing
same-name cookies are shown for confirmation before replacement, and their
original values are restored only if the managed cookies have not changed.
Choosing to keep existing cookies disables the entire cookie rule.
Partitioned cookies are not managed.
Chrome does not provide atomic conditional cookie updates, so concurrent site
changes can race with replacement or restoration.

Cookie backups live only in session storage: browser restart, extension reload,
disable, or update can erase them before the originals are restored. An
interrupted cookie operation can therefore leave a changed cookie behind.
Cookie rules request HTTP and HTTPS access to the selected host and candidate
parent hosts so existing parent-domain cookies can be detected; this may
include public-suffix patterns. Site access is requested when saving a rule.
Rules and activation are shared with incognito windows only after enabling
**Allow in Incognito** in Chrome's extension settings. Rule values are stored
locally and are not encrypted; avoid saving secrets.
Rule values are visible in the popup. Rules are grouped by type; each group
checkbox enables or disables its rules. If a group update fails partway
through, earlier changes remain applied and the popup reports the error.
Hover or focus a header or cookie name to see its settings; press Escape to
dismiss the tooltip.
Use **Detect** beside Site to replace its contents with the active HTTP(S)
tab's hostname, without its port or path. The `activeTab` permission grants
temporary access when the extension is opened; restricted pages and unsupported
hostnames cannot be detected.

The extension reconciles installed header rules with saved settings when its
service worker starts and when the popup opens. If reconciliation or reading
settings fails, the popup disables its controls and shows an error; reopen it
to retry. Changes to browser rules and storage are not atomic, so an interruption can leave a temporary mismatch until the
worker starts again.

```sh
npm run build -w headerlab
```

This is an incomplete development build, not a finished release. In Chrome,
open `chrome://extensions`, enable Developer mode, select **Load
unpacked**, and choose `tools/headerlab/dist`. Reload the extension after a new
build.

## Interactive preview

Run `npm run dev -w headerlab` and open the local address it prints. The
development-only simulation uses the real popup and rule logic with simulated
tabs, permissions, headers, and cookies; it does not change real browser
traffic, tabs, or cookies. Load a simulated address or set a simulated site
cookie to explore conflicts and restoration. Detect uses the simulated normal
tab. The bordered, scrollable area represents the popup; simulation controls
are outside it. Reload the page to reset the simulation. The simulation always grants site access and does not reproduce
all Chrome behavior, so also test the unpacked extension in Chrome.

For browser tests, install Playwright's Chromium once, then run the tests. The browser tests use temporary extension copies with host access pre-granted;
they do not exercise Chrome's site-permission prompt. Permission denial is
simulated in the popup test. An isolated Chromium test exercises cookie and
query rules in incognito windows, including reopening a private store. Browser
tests also cover a worker restart with a pending cookie conflict and with query
undo records. Real Chrome permission-prompt behavior still needs manual
verification.

```sh
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install chromium
npm test -w headerlab
```
