"""Rebuild the conservative, third-party domain subset of a pinned EasyList.

Not a general ABP converter: only unconditional ||hostname^ lines are accepted.
Modifiers and path rules must never be silently converted to whole-domain blocks.
"""
import hashlib
import json
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REVISION = "7ae1547caaf9b02d0ed4fb00292602d06a9bc52d"
URL = f"https://raw.githubusercontent.com/easylist/easylist/{REVISION}/easylist/easylist_adservers.txt"
RESOURCE_TYPES = ["script", "image", "stylesheet", "font", "object", "xmlhttprequest", "sub_frame", "media", "ping", "websocket", "other"]
PROTECTED = ["youtube.com", "googlevideo.com", "ytimg.com", "google.com", "gstatic.com", "googleapis.com"]


def domains_from(text):
    domains = set()
    for line in text.splitlines():
        match = re.fullmatch(r"\|\|([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,})\^", line.strip())
        if match:
            domain = match[1]
            if not any(domain == host or domain.endswith('.' + host) for host in PROTECTED):
                domains.add(domain)
    return sorted(domains)


def main():
    with urllib.request.urlopen(URL, timeout=30) as response:
        source = response.read()
    domains = domains_from(source.decode("utf-8"))
    if len(domains) < 10000:
        raise RuntimeError("Unexpectedly small domain set; refusing to replace packaged rules")
    rules = [
        {"id": 100 + index // 200, "priority": 1, "action": {"type": "block"},
         "condition": {"requestDomains": domains[index:index + 200],
                       "domainType": "thirdParty", "resourceTypes": RESOURCE_TYPES}}
        for index in range(0, len(domains), 200)
    ]
    output = ROOT / "rules" / "easylist.json"
    output.write_text(json.dumps(rules, indent=2) + "\n")
    metadata = {"source": URL, "revision": REVISION, "sha256": hashlib.sha256(source).hexdigest(),
                "domainCount": len(domains), "ruleCount": len(rules), "license": "CC-BY-SA-3.0"}
    (ROOT / "rules" / "easylist-source.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Generated {len(rules)} rules covering {len(domains)} third-party ad domains")


if __name__ == "__main__":
    main()
