"""Home MCP Hub mock rules for mitmproxy 12.x.

Install: put this file next to autoclear.py and add `-s /scripts/hub_mocks.py` to the
mitmproxy `command`. The hub sets the option `hub_mocks` (via mitmweb) to
`{"allowed": true, "rules": [...]}` (all rules, each with "enabled"); the addon only applies
these declarative rules, it never runs code from them and never reads files. A flow that fired
a rule gets `flow.comment = "mock:<id>"` and a mark in the flow list (one per rule kind).

Command bar (mitmweb): `hub.mocks` lists the rules, `hub.mock.on|off|delete <n|id>` change them
at once. Each change is also appended to the option `hub_mocks_edits`
(`{"epoch": ..., "edits": [{"seq", "op", "id"}]}`), which the hub reads and applies to its database.

The pure functions below match the TypeScript rules in lib/connectors/mitmproxy/rules.ts
and import nothing from mitmproxy, so they are testable with plain unittest.
"""

import asyncio
import copy
import json
import logging
import re
import secrets

logger = logging.getLogger(__name__)

JSON_PATH = re.compile(
    r"[A-Za-z_$][\w$-]*(\[(\d+|\*)\])*(\.[A-Za-z_$][\w$-]*(\[(\d+|\*)\])*)*"
)
_SEGMENT = re.compile(r"([A-Za-z_$][\w$-]*)((?:\[(?:\d+|\*)\])*)")
_INDEX = re.compile(r"\[(\d+|\*)\]")

# Flow-list marks (valid keys of mitmproxy.utils.emoji in mitmproxy 12.x).
MARKS = {"replace": ":large_blue_circle:", "patch": ":large_orange_diamond:"}
MAX_EDITS = 100
# Texts for the mitmweb commands. The hub sends its language in the payload ("lang"); an older hub
# sends none and gets Russian, as before. The «(json пропущен)» flow comment is protocol, not text.
TEXTS = {
    "ru": {
        "not_allowed": "Моки выключены в хабе",
        "none": "Моков нет.",
        "fired": "сработал {n} {times}",
        "skipped": ", из них json пропущен {skipped}",
        "error": "Ошибка: {exc}",
        "no_mock": "Нет мока «{target}» — см. hub.mocks",
        "deleted": "удалён",
        "enabled": "включён",
        "disabled": "выключен",
        "done": "Мок «{name}» {done}.",
    },
    "en": {
        "not_allowed": "Mocks are off in the hub",
        "none": "No mocks.",
        "fired": "hit {n} {times}",
        "skipped": ", json skipped in {skipped} of them",
        "error": "Error: {exc}",
        "no_mock": "No mock “{target}” — see hub.mocks",
        "deleted": "deleted",
        "enabled": "turned on",
        "disabled": "turned off",
        "done": "Mock “{name}” {done}.",
    },
}
NOT_ALLOWED = TEXTS["ru"]["not_allowed"]


def payload_lang(raw):
    """The hub's language from the payload; Russian when it is missing or unreadable."""
    try:
        return "en" if json.loads(raw or "{}").get("lang") == "en" else "ru"
    except (ValueError, AttributeError):
        return "ru"


def _text(lang, key, **values):
    return TEXTS[lang][key].format(**values)


def _command(name):
    """Same marker as mitmproxy's @command.command, without importing mitmproxy here.

    collect_commands() only looks for a str `command_name`; verified with mitmproxy 12.3.1.
    """

    def decorator(func):
        func.command_name = name
        return func

    return decorator


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


def select_rule(rules, method, host, path, kind=None):
    """First enabled matching rule of `kind` (any kind if None) in list order; malformed rules are skipped.

    The hub sends rules ordered by creation time, so overlapping rules resolve predictably.
    """
    for rule in rules:
        try:
            if rule.get("enabled") is False:
                continue
            if kind is not None and rule.get("kind") != kind:
                continue
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


def parse_payload(raw):
    """Parse the option value into (allowed, rules); any problem gives (False, []) and a warning.

    A payload without "allowed" (older hub) counts as allowed.
    """
    if not raw:
        return False, []
    try:
        data = json.loads(raw)
        rules = data["rules"]
        if not isinstance(rules, list):
            raise TypeError("rules is not a list")
        return data.get("allowed", True) is not False, [r for r in rules if isinstance(r, dict)]
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        logger.warning("hub_mocks: cannot parse rules: %s", exc)
        return False, []


def parse_rules(raw):
    return parse_payload(raw)[1]


def _dumps(value):
    # Same text as JSON.stringify, so an unchanged payload compares equal on the hub side.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _times(n, lang="ru"):
    if lang == "en":
        return "time" if n == 1 else "times"
    if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        return "раза"
    return "раз"


def _hits(flows, rule_id):
    """(fired, json skipped) among flows whose comment is `mock:<id>` or `mock:<id> (...)`."""
    tag = f"mock:{rule_id}"
    n = skipped = 0
    for f in flows or []:
        comment = str(getattr(f, "comment", "") or "")
        if comment == tag or comment.startswith(tag + " "):
            n += 1
            if comment.endswith("(json пропущен)"):
                skipped += 1
    return n, skipped


def format_mocks(rules, flows, lang="ru"):
    if not rules:
        return _text(lang, "none")
    lines = []
    for i, r in enumerate(rules, 1):
        match = r.get("match") or {}
        method = match.get("method")
        target = f"{method.upper() + ' ' if method else ''}{match.get('host', '?')}{match.get('path', '')}"
        n, skipped = _hits(flows, r.get("id"))
        fired = _text(lang, "fired", n=n, times=_times(n, lang)) + (_text(lang, "skipped", skipped=skipped) if skipped else "")
        mark = "✗" if r.get("enabled") is False else "✓"
        lines.append(f"{i}. {mark} {r.get('name') or r.get('id')} — {r.get('kind')} {target} · {fired}")
    return "\n".join(lines)


class HubMocks:
    def __init__(self):
        self._raw = None
        self._allowed = False
        self._lang = "ru"
        self._rules = []
        # A new epoch per addon start tells the hub that edit numbering restarted.
        self._epoch = secrets.token_hex(8)
        self._seq = 0
        self._edits = []

    def load(self, loader):
        loader.add_option(
            "hub_mocks", str, "", "Mock rules from Home MCP Hub (JSON)"
        )
        loader.add_option(
            "hub_mocks_edits", str, "", "Mock changes made in mitmproxy, read by Home MCP Hub (JSON)"
        )

    def _refresh(self):
        from mitmproxy import ctx

        raw = ctx.options.hub_mocks
        if raw != self._raw:
            self._raw = raw
            self._allowed, self._rules = parse_payload(raw)
            self._lang = payload_lang(raw)

    def _current_rules(self):
        self._refresh()
        return self._rules

    # --- command bar ---

    def _view(self):
        from mitmproxy import ctx

        try:
            return ctx.master.addons.get("view")
        except AttributeError:
            return None

    @_command("hub.mocks")
    def mocks(self) -> str:
        """List Home MCP Hub mock rules with their numbers."""
        try:
            self._refresh()
            if not self._allowed:
                return _text(self._lang, "not_allowed")
            return format_mocks(self._rules, self._view(), self._lang)
        except Exception as exc:
            logger.warning("hub_mocks: list failed: %s", exc)
            return _text(self._lang, "error", exc=exc)

    def _edit(self, target, op):
        from mitmproxy import ctx

        try:
            self._refresh()
            if not self._allowed:
                return _text(self._lang, "not_allowed")
            target = str(target).strip()
            index = next((i for i, r in enumerate(self._rules) if r.get("id") == target), None)
            if index is None and target.isdigit() and 1 <= int(target) <= len(self._rules):
                index = int(target) - 1
            if index is None:
                return _text(self._lang, "no_mock", target=target)
            rules = [dict(r) for r in self._rules]
            rule = rules[index]
            if op == "delete":
                del rules[index]
                done = _text(self._lang, "deleted")
            else:
                rule["enabled"] = op == "enable"
                done = _text(self._lang, "enabled" if op == "enable" else "disabled")
            self._seq += 1
            self._edits = (self._edits + [{"seq": self._seq, "op": op, "id": rule.get("id")}])[-MAX_EDITS:]
            data = json.loads(self._raw)
            data["rules"] = rules
            raw = _dumps(data)
            ctx.options.update(
                hub_mocks=raw,
                hub_mocks_edits=_dumps({"epoch": self._epoch, "edits": self._edits}),
            )
            self._raw, self._rules = raw, rules
            return _text(self._lang, "done", name=rule.get("name") or rule.get("id"), done=done)
        except Exception as exc:
            logger.warning("hub_mocks: %s failed: %s", op, exc)
            return _text(self._lang, "error", exc=exc)

    @_command("hub.mock.on")
    def mock_on(self, target: str) -> str:
        """Enable a mock rule by its number in hub.mocks or its id."""
        return self._edit(target, "enable")

    @_command("hub.mock.off")
    def mock_off(self, target: str) -> str:
        """Disable a mock rule by its number in hub.mocks or its id."""
        return self._edit(target, "disable")

    @_command("hub.mock.delete")
    def mock_delete(self, target: str) -> str:
        """Delete a mock rule by its number in hub.mocks or its id."""
        return self._edit(target, "delete")

    # --- hooks ---

    def _find(self, flow, kind):
        req = flow.request
        return select_rule(self._current_rules(), req.method, req.pretty_host, req.path, kind)

    def _find_patch(self, flow):
        # A flow already answered by a replace rule is never patched on top.
        if str(getattr(flow, "comment", "") or "").startswith("mock:"):
            return None
        return self._find(flow, "patch")

    async def request(self, flow):
        from mitmproxy import http

        try:
            rule = self._find(flow, "replace")
            if rule is None:
                return
            delay = rule.get("delayMs")
            if delay:
                await asyncio.sleep(delay / 1000)
            body = rule.get("body")
            headers = {str(k): str(v) for k, v in (rule.get("headers") or {}).items()}
            flow.response = http.Response.make(
                rule.get("status", 200), (body or "").encode("utf-8"), headers
            )
            flow.comment = f"mock:{rule.get('id')}"
            flow.marked = MARKS["replace"]
        except Exception as exc:  # a broken rule must never break the proxy
            logger.warning("hub_mocks: replace failed: %s", exc)

    def responseheaders(self, flow):
        # stream_large_bodies would send big bodies before `response` runs; buffer them
        # when a patch rule matches (mocked API bodies are small).
        try:
            rule = self._find_patch(flow)
            if rule is not None and flow.response is not None:
                flow.response.stream = False
        except Exception as exc:
            logger.warning("hub_mocks: responseheaders failed: %s", exc)

    async def response(self, flow):
        try:
            rule = self._find_patch(flow)
            if rule is None or flow.response is None:
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
                doc = None
                if resp.raw_content is not None:  # None: body was streamed, not available
                    try:
                        doc = json.loads(resp.get_text())
                    except (ValueError, TypeError):
                        pass
                if doc is not None and apply_json_ops(doc, ops):
                    resp.set_text(json.dumps(doc, ensure_ascii=False))
                else:
                    comment += " (json пропущен)"
            flow.comment = comment
            flow.marked = MARKS["patch"]
        except Exception as exc:
            logger.warning("hub_mocks: patch failed: %s", exc)


addons = [HubMocks()]
