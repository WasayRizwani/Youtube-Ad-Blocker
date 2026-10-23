# EasyList attribution

`rules/easylist.json` is derived from the EasyList ad-server section, maintained
by the EasyList authors (including ryanbr, MonztA, Khrin, and Yuki2718).

- Project: https://github.com/easylist/easylist
- Source revision and SHA-256: `rules/easylist-source.json`
- Upstream licensing: https://easylist.to/pages/licence.html
- This derived rule list is distributed under Creative Commons
  Attribution-ShareAlike 3.0 Unported:
  https://creativecommons.org/licenses/by-sa/3.0/

Changes: `scripts/update_ad_domains.py` selects only unconditional whole-domain
entries from `easylist/easylist_adservers.txt`, omits protected content/video
infrastructure, and groups the remaining domains into Chrome declarative network
rules. These rules apply only to third-party resources and never to top-level
navigation. Conditional, URL-path, scriptlet, cosmetic, and allowlist entries are
not converted. This is a limited subset, not full EasyList support or an endorsed
EasyList product. The source and conversion script are provided so the changes
can be reproduced. This attribution and license apply to the derived list.
