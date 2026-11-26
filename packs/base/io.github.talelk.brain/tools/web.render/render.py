import json
import os
import re
import signal
import sys
from urllib.parse import urlsplit

MAX_LINKS = 80


def fail(why):
    print(json.dumps({"error": why}), flush=True)
    os._exit(2)


def too_slow(*_):
    fail("the page took too long to load")


def read_input():
    try:
        value = json.load(sys.stdin)
    except ValueError:
        fail("the input is not JSON")
    if not isinstance(value, dict):
        fail("the input must be a JSON object")
    url = value.get("url")
    if not isinstance(url, str) or not 1 <= len(url) <= 2000:
        fail("url must be text of at most 2000 characters")
    if not re.fullmatch(r"https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?([/?#][\x21-\x7e]*)?", url):
        fail("url must be a plain https address: no other scheme, no user or password, no spaces")
    limit = value.get("max_chars", 8000)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 20000:
        fail("max_chars must be a whole number from 1 to 20000")
    wait = value.get("wait_ms", 3000)
    if isinstance(wait, bool) or not isinstance(wait, int) or not 0 <= wait <= 15000:
        fail("wait_ms must be a whole number from 0 to 15000")
    return url, limit, wait


def proxy_settings():
    raw = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if not raw:
        return None
    parts = urlsplit(raw)
    settings = {"server": f"{parts.scheme}://{parts.hostname}:{parts.port}"}
    if parts.username:
        settings["username"] = parts.username
        settings["password"] = parts.password or ""
    return settings


def main():
    url, limit, wait = read_input()
    # The input is read: the browser's own processes must not share the caller's pipe.
    os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
    try:
        from playwright.sync_api import Error as BrowserError, sync_playwright
    except ImportError:
        fail("the browser is not installed in this sandbox")
    executable = os.environ.get("WEB_RENDER_BROWSER", "/usr/bin/chromium")
    options = {"executable_path": executable, "headless": True, "args": ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]}
    proxy = proxy_settings()
    if proxy:
        options["proxy"] = proxy
    signal.signal(signal.SIGALRM, too_slow)
    signal.alarm(50)
    try:
        driver = sync_playwright().start()
        browser = driver.chromium.launch(**options)
        page = browser.new_page(user_agent="brain-web-render/1")
        page.set_default_timeout(25000)
        # Pictures, media and fonts are not read, and loading them only costs time.
        page.route("**/*", lambda route: route.abort() if route.request.resource_type in ("image", "media", "font") else route.continue_())
        response = page.goto(url, wait_until="domcontentloaded")
        try:
            page.wait_for_load_state("networkidle", timeout=max(wait, 1))
        except BrowserError:
            pass
        if wait:
            page.wait_for_timeout(min(wait, 3000))
        text = page.evaluate("document.body ? document.body.innerText : ''")
        links = page.evaluate(
            "Array.from(document.querySelectorAll('a[href]')).map(a => ({text: (a.innerText || a.title || '').trim().replace(/\\s+/g, ' ').slice(0, 160), href: a.href})).filter(l => /^https?:/.test(l.href))"
        )
        result = {"url": url, "final_url": page.url, "status": response.status if response else 0, "title": page.title()}
    except BrowserError as why:
        fail("the page failed: " + " ".join(str(why).split())[:300])
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" ?\n ?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    seen, kept = set(), []
    for link in links:
        if link["href"] in seen:
            continue
        seen.add(link["href"])
        kept.append(link)
    result.update({"text": text[:limit], "links": kept[:MAX_LINKS], "truncated": len(text) > limit or len(kept) > MAX_LINKS})
    # The answer goes out before the browser is shut down: a browser that is slow to close must not lose it.
    print(json.dumps(result, ensure_ascii=False), flush=True)
    os._exit(0)


main()
