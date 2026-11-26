#!/usr/bin/env python3
"""Wrap index.html in a Cloudflare Worker and upload it.

Needs a Cloudflare API token with Workers Scripts Edit, sent as
Authorization: Bearer. In the Claude cloud environment the proxy injects it.
Elsewhere: CLOUDFLARE_API_TOKEN=... python3 deploy.py
"""
import json, os, pathlib, subprocess, tempfile

ACCOUNT = "c1e7742e947fa17590e127ce9db36cc8"
SCRIPT = "angrylittlefairy"
here = pathlib.Path(__file__).parent
html = (here / "index.html").read_text()

worker = """const HTML = %s;
export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });
    }
    return new Response('Not found', { status: 404 });
  }
};
""" % json.dumps(html)

with tempfile.TemporaryDirectory() as d:
    p = pathlib.Path(d) / "worker.js"
    p.write_text(worker)
    cmd = ["curl", "-s", "-X", "PUT",
           f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}",
           "-F", 'metadata={"main_module":"worker.js","compatibility_date":"2026-11-01"};type=application/json',
           "-F", f"worker.js=@{p};type=application/javascript+module"]
    tok = os.environ.get("CLOUDFLARE_API_TOKEN")
    if tok:
        cmd[1:1] = ["-H", f"Authorization: Bearer {tok}"]
    out = json.loads(subprocess.run(cmd, capture_output=True, text=True).stdout)
    print("deployed" if out["success"] else out["errors"])
