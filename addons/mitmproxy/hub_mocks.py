"""Home MCP Hub mock rules for mitmproxy 12.x.

Install: put this file next to autoclear.py and add `-s /scripts/hub_mocks.py` to the
mitmproxy `command`. The hub sets the option `hub_mocks` (via mitmweb) to
`{"rules": [...]}`; the addon only applies these declarative rules, it never runs code
from them and never reads files. A flow that fired a rule gets `flow.comment = "mock:<id>"`.

The pure functions below match the TypeScript rules in lib/connectors/mitmproxy/rules.ts
and import nothing from mitmproxy, so they are testable with plain unittest.
"""

import asyncio
import copy
import json
import logging
import re

logger = logging.getLogger(__name__)

JSON_PATH = re.compile(
    r"[A-Za-z_$][\w$-]*(\[(\d+|\*)\])*(\.[A-Za-z_$][\w$-]*(\[(\d+|\*)\])*)*"
)
_SEGMENT = re.compile(r"([A-Za-z_$][\w$-]*)((?:\[(?:\d+|\*)\])*)")
_INDEX = re.compile(r"\[(\d+|\*)\]")


def _normalize_host(host):
    h = host.strip().lower()
    if h.startswith("["):
        end = h.find("]")
        return h[: end + 1] if end >= 0 else h
    return re.sub(r":\d+$", "", h)


def host_matches(host, pattern):
    """Exact host or `*.example.com` (non-empty subdomain); case and port ignored."""
    h = _normalize_host(host)
    p = _normalize_host(pattern)
    if p.startswith("*."):
        return h.endswith(p[1:]) and len(h) > len(p) - 1
    return h == p


def path_matches(path, pattern):
    """Whole-path match where `*` is any run of characters; query and fragment dropped."""
    clean = path.split("?", 1)[0].split("#", 1)[0]
    source = ".*".join(re.escape(part) for part in pattern.split("*"))
    return re.fullmatch(source, clean, re.DOTALL) is not None


def rule_matches(rule, method, host, path):
    match = rule["match"]
    wanted = match.get("method")
    if wanted and wanted.upper() != method.upper():
        return False
    return host_matches(host, match["host"]) and path_matches(path, match["path"])


def select_rule(rules, method, host, path):
    """First matching rule in list order; malformed rules are skipped."""
    for rule in rules:
        try:
            if rule_matches(rule, method, host, path):
                return rule
        except (KeyError, TypeError, AttributeError):
            continue
    return None


def parse_path(path):
    """`a.b[0].c` -> ["a", "b", 0, "c"]; `[*]` -> "*". None if the path is invalid."""
    if not isinstance(path, str) or JSON_PATH.fullmatch(path) is None:
        return None
    out = []
    for part in path.split("."):
        m = _SEGMENT.fullmatch(part)
        if m is None:
            return None
        out.append(m.group(1))
        for idx in _INDEX.findall(m.group(2)):
            out.append("*" if idx == "*" else int(idx))
    return out


def _set(node, segs, value):
    key, rest = segs[0], segs[1:]
    if isinstance(key, str) and key != "*":
        if not isinstance(node, dict):
            return
        if not rest:
            node[key] = copy.deepcopy(value)
            return
        if key not in node:
            node[key] = {}
        _set(node[key], rest, value)
        return
    if not isinstance(node, list):
        return
    if key == "*":
        targets = range(len(node))
    elif key < len(node):
        targets = [key]
    else:
        return
    for i in targets:
        if not rest:
            node[i] = copy.deepcopy(value)
        else:
            _set(node[i], rest, value)


def apply_json_ops(doc, ops):
    """Apply [{path, value}] in place. False if doc is not a dict/list (nothing done)."""
    if not isinstance(doc, (dict, list)):
        return False
    for op in ops:
        try:
            segs = parse_path(op["path"])
            if segs is None:
                continue
            _set(doc, segs, op.get("value"))
        except (KeyError, TypeError, AttributeError):
            continue
    return True


def parse_rules(raw):
    """Parse the option value; any problem gives an empty list and a warning."""
    if not raw:
        return []
    try:
        data = json.loads(raw)
        rules = data["rules"]
        if not isinstance(rules, list):
            raise TypeError("rules is not a list")
        return [r for r in rules if isinstance(r, dict)]
    except (ValueError, KeyError, TypeError) as exc:
        logger.warning("hub_mocks: cannot parse rules: %s", exc)
        return []


class HubMocks:
    def __init__(self):
        self._raw = None
        self._rules = []

    def load(self, loader):
        loader.add_option(
            "hub_mocks", str, "", "Mock rules from Home MCP Hub (JSON)"
        )

    def _current_rules(self):
        from mitmproxy import ctx

        raw = ctx.options.hub_mocks
        if raw != self._raw:
            self._raw = raw
            self._rules = parse_rules(raw)
        return self._rules

    def _find(self, flow):
        req = flow.request
        return select_rule(self._current_rules(), req.method, req.pretty_host, req.path)

    async def request(self, flow):
        from mitmproxy import http

        try:
            rule = self._find(flow)
            if rule is None or rule.get("kind") != "replace":
                return
            delay = rule.get("delayMs")
            if delay:
                await asyncio.sleep(delay / 1000)
            body = rule.get("body")
            headers = {str(k): str(v) for k, v in (rule.get("headers") or {}).items()}
            flow.response = http.Response.make(
                rule.get("status", 200), body if body is not None else "", headers
            )
            flow.comment = f"mock:{rule.get('id')}"
        except Exception as exc:  # a broken rule must never break the proxy
            logger.warning("hub_mocks: replace failed: %s", exc)

    async def response(self, flow):
        try:
            rule = self._find(flow)
            if rule is None or rule.get("kind") != "patch" or flow.response is None:
                return
            delay = rule.get("delayMs")
            if delay:
                await asyncio.sleep(delay / 1000)
            resp = flow.response
            if rule.get("status") is not None:
                resp.status_code = rule["status"]
            for k, v in (rule.get("setHeaders") or {}).items():
                resp.headers[str(k)] = str(v)
            for k in rule.get("removeHeaders") or []:
                resp.headers.pop(str(k), None)
            comment = f"mock:{rule.get('id')}"
            ops = rule.get("json")
            if ops:
                try:
                    doc = json.loads(resp.get_text())
                except (ValueError, TypeError):
                    doc = None
                if doc is not None and apply_json_ops(doc, ops):
                    resp.set_text(json.dumps(doc, ensure_ascii=False))
                else:
                    comment += " (json пропущен)"
            flow.comment = comment
        except Exception as exc:
            logger.warning("hub_mocks: patch failed: %s", exc)


addons = [HubMocks()]
