import asyncio
import json
import sys
import types
import unittest
from unittest import mock

from hub_mocks import (
    MARKS,
    HubMocks,
    parse_payload,
    parse_rules,
    apply_json_ops,
    host_matches,
    parse_path,
    path_matches,
    rule_matches,
    select_rule,
)


class MatchingTests(unittest.TestCase):
    def test_host(self):
        self.assertTrue(host_matches("API.Example.com:443", "api.example.com"))
        self.assertTrue(host_matches("x.api.example.com", "*.example.com"))
        self.assertFalse(host_matches("example.com", "*.example.com"))
        self.assertFalse(host_matches("notexample.com", "example.com"))
        self.assertTrue(host_matches("[::1]:8080", "[::1]"))

    def test_path(self):
        self.assertTrue(path_matches("/v1/profile?x=1", "/v1/profile"))
        self.assertTrue(path_matches("/v1/profile#frag", "/v1/profile"))
        self.assertTrue(path_matches("/v1/users/42/profile", "/v1/users/*/profile"))
        self.assertFalse(path_matches("/v1/profile/extra", "/v1/profile"))
        self.assertTrue(path_matches("/v1/profile/extra", "/v1/profile*"))
        self.assertTrue(path_matches("/a.b", "/a.b"))
        self.assertFalse(path_matches("/axb", "/a.b"))
        # ? and [] are literal, not wildcards
        self.assertFalse(path_matches("/ab", "/a?"))
        self.assertFalse(path_matches("/a", "/[a]"))

    def test_rule_method(self):
        r = {"id": "a", "match": {"host": "a.example", "path": "/x", "method": "GET"}}
        self.assertFalse(rule_matches(r, "POST", "a.example", "/x"))
        self.assertTrue(rule_matches(r, "get", "A.example:443", "/x?y=1"))
        r2 = {"id": "b", "match": {"host": "a.example", "path": "/x"}}
        self.assertTrue(rule_matches(r2, "DELETE", "a.example", "/x"))

    def test_first_match_wins(self):
        rules = [
            {"id": "a", "match": {"host": "a.example", "path": "/y"}},
            {"id": "b", "match": {"host": "a.example", "path": "/*"}},
            {"id": "c", "match": {"host": "a.example", "path": "/x"}},
        ]
        self.assertEqual(select_rule(rules, "GET", "a.example", "/x")["id"], "b")
        self.assertIsNone(select_rule(rules, "GET", "other", "/x"))
        self.assertIsNone(select_rule([{"id": "bad"}], "GET", "a.example", "/x"))

    def test_kind_filter(self):
        rules = [
            {"id": "p", "kind": "patch", "match": {"host": "a.example", "path": "/*"}},
            {"id": "r", "kind": "replace", "match": {"host": "a.example", "path": "/x"}},
        ]
        self.assertEqual(select_rule(rules, "GET", "a.example", "/x", "replace")["id"], "r")
        self.assertEqual(select_rule(rules, "GET", "a.example", "/x", "patch")["id"], "p")
        self.assertIsNone(select_rule(rules, "GET", "a.example", "/y", "replace"))


class PathTests(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_path("a.b[0].c"), ["a", "b", 0, "c"])
        self.assertEqual(parse_path("items[*].price"), ["items", "*", "price"])
        self.assertIsNone(parse_path("a..b"))
        self.assertIsNone(parse_path("[0]"))
        self.assertIsNone(parse_path(""))


class JsonOpsTests(unittest.TestCase):
    def test_apply(self):
        doc = {"user": {"isPremium": False}, "items": [{"price": 5}, {"price": 7}]}
        ok = apply_json_ops(
            doc,
            [{"path": "user.isPremium", "value": True}, {"path": "items[*].price", "value": 0}],
        )
        self.assertTrue(ok)
        self.assertEqual(doc, {"user": {"isPremium": True}, "items": [{"price": 0}, {"price": 0}]})

    def test_creates_missing_key(self):
        doc = {"user": {}}
        self.assertTrue(apply_json_ops(doc, [{"path": "user.plan", "value": "pro"}]))
        self.assertEqual(doc["user"]["plan"], "pro")
        doc = {}
        apply_json_ops(doc, [{"path": "a.b", "value": 1}])
        self.assertEqual(doc, {"a": {"b": 1}})

    def test_index_out_of_range_skipped(self):
        doc = {"items": [{"price": 5}]}
        self.assertTrue(apply_json_ops(doc, [{"path": "items[3].price", "value": 0}]))
        self.assertEqual(doc, {"items": [{"price": 5}]})
        doc = {"items": [1, 2]}
        apply_json_ops(doc, [{"path": "items[1]", "value": 9}])
        self.assertEqual(doc, {"items": [1, 9]})

    def test_non_container(self):
        for doc in ("text", 5, None, True):
            self.assertFalse(apply_json_ops(doc, [{"path": "a", "value": 1}]))

    def test_value_is_not_shared_between_targets(self):
        doc = {"items": [{}, {}]}
        apply_json_ops(doc, [{"path": "items[*].tags", "value": []}])
        doc["items"][0]["tags"].append(1)
        self.assertEqual(doc["items"][1]["tags"], [])

    def test_invalid_path_ignored(self):
        doc = {"a": 1}
        self.assertTrue(apply_json_ops(doc, [{"path": "a..b", "value": 2}, {"nope": 1}]))
        self.assertEqual(doc, {"a": 1})


class _Resp:
    def __init__(self, status_code=200, content=b"", headers=None):
        self.status_code = status_code
        self.raw_content = content
        self.headers = dict(headers or {})
        self.stream = True

    def get_text(self):
        return None if self.raw_content is None else self.raw_content.decode("utf-8")

    def set_text(self, text):
        self.raw_content = text.encode("utf-8")


class _Req:
    method = "GET"
    pretty_host = "api.example.com"
    path = "/v1/profile?x=1"


class _Flow:
    def __init__(self, response=None, comment=""):
        self.request = _Req()
        self.response = response
        self.comment = comment
        self.marked = ""


class _Options:
    def __init__(self, hub_mocks, hub_mocks_edits=""):
        self.hub_mocks = hub_mocks
        self.hub_mocks_edits = hub_mocks_edits
        self.updates = []

    def update(self, **kwargs):
        self.updates.append(kwargs)
        for k, v in kwargs.items():
            setattr(self, k, v)


def _stub_modules(raw, view=None):
    ctx = types.SimpleNamespace(
        options=_Options(raw),
        master=types.SimpleNamespace(addons=types.SimpleNamespace(get=lambda name: view if name == "view" else None)),
    )
    http = types.SimpleNamespace(
        Response=types.SimpleNamespace(
            make=staticmethod(lambda status=200, content=b"", headers=None: _Resp(status, content, headers))
        )
    )
    pkg = types.ModuleType("mitmproxy")
    pkg.ctx = ctx
    pkg.http = http
    return {"mitmproxy": pkg}


def _rules(*rules):
    return json.dumps({"allowed": True, "rules": list(rules)})


MATCH = {"host": "api.example.com", "path": "/v1/profile"}


class HookTests(unittest.TestCase):
    def run_hook(self, raw, hook, flow):
        with mock.patch.dict(sys.modules, _stub_modules(raw)):
            result = getattr(HubMocks(), hook)(flow)
            if asyncio.iscoroutine(result):
                asyncio.run(result)

    def test_replace_uses_utf8_bytes(self):
        rule = {"id": "r1", "kind": "replace", "match": MATCH, "status": 201, "body": "é « » Привет"}
        flow = _Flow()
        self.run_hook(_rules(rule), "request", flow)
        self.assertEqual(flow.response.status_code, 201)
        self.assertEqual(flow.response.raw_content, "é « » Привет".encode("utf-8"))
        self.assertEqual(flow.comment, "mock:r1")

    def test_replace_headers_and_empty_body(self):
        rule = {"id": "r1", "kind": "replace", "match": MATCH, "headers": {"X-A": "1"}, "body": ""}
        flow = _Flow()
        self.run_hook(_rules(rule), "request", flow)
        self.assertEqual(flow.response.raw_content, b"")
        self.assertEqual(flow.response.headers, {"X-A": "1"})

    def test_patch_modifies_json_status_headers(self):
        rule = {
            "id": "p1", "kind": "patch", "match": MATCH, "status": 203,
            "setHeaders": {"X-Mock": "1"}, "removeHeaders": ["Content-Length"],
            "json": [{"path": "user.isPremium", "value": True}],
        }
        resp = _Resp(200, b'{"user": {"isPremium": false}}', {"Content-Length": "30"})
        flow = _Flow(resp)
        self.run_hook(_rules(rule), "response", flow)
        self.assertEqual(resp.status_code, 203)
        self.assertEqual(resp.headers, {"X-Mock": "1"})
        self.assertEqual(json.loads(resp.raw_content), {"user": {"isPremium": True}})
        self.assertEqual(flow.comment, "mock:p1")

    def test_patch_non_json_or_missing_body(self):
        rule = {"id": "p1", "kind": "patch", "match": MATCH, "json": [{"path": "a", "value": 1}]}
        for content in (b"<html>", None):
            flow = _Flow(_Resp(200, content))
            self.run_hook(_rules(rule), "response", flow)
            self.assertEqual(flow.comment, "mock:p1 (json пропущен)")

    def test_responseheaders_disables_streaming_for_patch_only(self):
        patch = {"id": "p1", "kind": "patch", "match": MATCH, "status": 200}
        flow = _Flow(_Resp())
        self.run_hook(_rules(patch), "responseheaders", flow)
        self.assertFalse(flow.response.stream)
        replace = {"id": "r1", "kind": "replace", "match": MATCH, "body": ""}
        flow = _Flow(_Resp())
        self.run_hook(_rules(replace), "responseheaders", flow)
        self.assertTrue(flow.response.stream)

    def test_bad_option_values_give_no_rules(self):
        for raw in ("", "not json", '{"rules": 5}', "[]", '{"rules": [1, "x"]}'):
            self.assertEqual(parse_rules(raw), [])
            flow = _Flow(_Resp())
            self.run_hook(raw, "request", flow)
            self.run_hook(raw, "response", flow)
            self.run_hook(raw, "responseheaders", flow)
            self.assertEqual(flow.comment, "")

    def test_overlapping_mixed_kinds_in_any_order(self):
        patch = {"id": "p1", "kind": "patch", "match": {"host": "api.example.com", "path": "/v1/*"}, "status": 500}
        replace = {"id": "r1", "kind": "replace", "match": MATCH, "status": 201, "body": "{}"}
        for order in ((patch, replace), (replace, patch)):
            raw = _rules(*order)
            flow = _Flow()
            self.run_hook(raw, "request", flow)
            self.assertEqual(flow.response.status_code, 201)
            self.assertEqual(flow.comment, "mock:r1")
            # the replaced answer is not patched afterwards
            self.run_hook(raw, "responseheaders", flow)
            self.run_hook(raw, "response", flow)
            self.assertEqual((flow.response.status_code, flow.response.stream, flow.comment), (201, True, "mock:r1"))
            # a real answer on the same path gets the patch
            flow = _Flow()
            self.run_hook(raw, "request", flow)
            self.assertEqual(flow.comment, "mock:r1")
            other = _Flow(_Resp(200, b"{}"))
            other.request.path = "/v1/other"
            self.run_hook(raw, "request", other)
            self.run_hook(raw, "responseheaders", other)
            self.run_hook(raw, "response", other)
            self.assertEqual((other.response.status_code, other.response.stream, other.comment), (500, False, "mock:p1"))

    def test_non_matching_flow_untouched(self):
        rule = {"id": "p1", "kind": "patch", "match": {"host": "other.example", "path": "/*"}, "status": 500}
        resp = _Resp(200, b"{}")
        flow = _Flow(resp)
        for hook in ("request", "responseheaders", "response"):
            self.run_hook(_rules(rule), hook, flow)
        self.assertEqual((resp.status_code, resp.stream, flow.comment), (200, True, ""))

    def test_disabled_rule_not_applied(self):
        off = {"id": "r0", "kind": "replace", "match": MATCH, "enabled": False, "body": "off"}
        on = {"id": "r1", "kind": "replace", "match": MATCH, "enabled": True, "body": "on"}
        flow = _Flow()
        self.run_hook(_rules(off, on), "request", flow)
        self.assertEqual(flow.comment, "mock:r1")
        flow = _Flow(_Resp(200, b"{}"))
        patch = {"id": "p0", "kind": "patch", "match": MATCH, "enabled": False, "status": 500}
        for hook in ("request", "responseheaders", "response"):
            self.run_hook(_rules(patch), hook, flow)
        self.assertEqual((flow.response.status_code, flow.comment), (200, ""))

    def test_marks_by_kind(self):
        self.assertNotEqual(MARKS["replace"], MARKS["patch"])
        replace = {"id": "r1", "kind": "replace", "match": MATCH, "body": ""}
        flow = _Flow()
        self.run_hook(_rules(replace), "request", flow)
        self.assertEqual(flow.marked, MARKS["replace"])
        patch = {"id": "p1", "kind": "patch", "match": MATCH, "json": [{"path": "a", "value": 1}]}
        for content in (b"{}", b"<html>"):
            flow = _Flow(_Resp(200, content))
            self.run_hook(_rules(patch), "response", flow)
            self.assertEqual(flow.marked, MARKS["patch"])

    def test_marks_are_valid_mitmproxy_markers(self):
        # Values from mitmproxy.utils.emoji (checked against mitmproxy 12.3.1).
        self.assertEqual(MARKS, {"replace": ":large_blue_circle:", "patch": ":large_orange_diamond:"})


PREMIUM = {
    "id": "p1", "name": "Премиум", "enabled": True, "kind": "patch",
    "match": {"host": "api.example.com", "path": "/v1/profile", "method": "GET"},
    "json": [{"path": "a", "value": 1}],
}
DOWN = {"id": "r2", "name": "Лежит", "enabled": False, "kind": "replace", "match": {"host": "*.example.com", "path": "/*"}, "body": ""}


class CommandTests(unittest.TestCase):
    def setUp(self):
        self.view = [
            _Flow(comment="mock:p1"),
            _Flow(comment="mock:p1 (json пропущен)"),
            _Flow(comment="mock:p10"),
            _Flow(comment=""),
        ]
        self.addon = HubMocks()

    def run_cmd(self, raw, name, *args):
        modules = _stub_modules(raw, self.view)
        self.ctx = modules["mitmproxy"].ctx
        with mock.patch.dict(sys.modules, modules):
            return getattr(self.addon, name)(*args)

    def call(self, name, *args):
        """Further calls on the same ctx (options keep what the addon wrote)."""
        with mock.patch.dict(sys.modules, {"mitmproxy": types.SimpleNamespace(ctx=self.ctx)}):
            return getattr(self.addon, name)(*args)

    def edits(self):
        return json.loads(self.ctx.options.hub_mocks_edits)

    def test_commands_are_registered_with_mitmproxy_names(self):
        names = {getattr(getattr(self.addon, a), "command_name", None) for a in dir(self.addon)}
        self.assertTrue({"hub.mocks", "hub.mock.on", "hub.mock.off", "hub.mock.delete"} <= names)

    def test_list(self):
        out = self.run_cmd(_rules(PREMIUM, DOWN), "mocks")
        self.assertEqual(
            out,
            "1. ✓ Премиум — patch GET api.example.com/v1/profile · сработал 2 раза, из них json пропущен 1\n"
            "2. ✗ Лежит — replace *.example.com/* · сработал 0 раз",
        )

    def test_list_without_view(self):
        self.view = None
        self.assertIn("сработал 0 раз", self.run_cmd(_rules(PREMIUM), "mocks"))

    def test_list_empty_and_not_allowed(self):
        self.assertEqual(self.run_cmd(_rules(), "mocks"), "Моков нет.")
        for raw in (json.dumps({"allowed": False, "rules": []}), "", "garbage"):
            self.assertEqual(self.run_cmd(raw, "mocks"), "Моки выключены в хабе")

    def test_english_when_the_hub_says_so(self):
        en = lambda *rules: json.dumps({"allowed": True, "rules": list(rules), "lang": "en"})
        self.assertEqual(self.run_cmd(en(), "mocks"), "No mocks.")
        self.assertEqual(
            self.run_cmd(en(PREMIUM, DOWN), "mocks"),
            "1. ✓ Премиум — patch GET api.example.com/v1/profile · hit 2 times, json skipped in 1 of them\n"
            "2. ✗ Лежит — replace *.example.com/* · hit 0 times",
        )
        self.assertEqual(self.run_cmd(en(PREMIUM, DOWN), "mock_off", "1"), "Mock “Премиум” turned off.")
        # The language travels with the rules when mitmweb edits them.
        self.assertEqual(json.loads(self.ctx.options.hub_mocks)["lang"], "en")
        self.assertEqual(self.run_cmd(json.dumps({"allowed": False, "rules": [], "lang": "en"}), "mocks"), "Mocks are off in the hub")
        self.assertEqual(self.run_cmd(en(PREMIUM), "mock_on", "nope"), "No mock “nope” — see hub.mocks")

    def test_off_on_delete_by_number_and_id(self):
        self.assertEqual(self.run_cmd(_rules(PREMIUM, DOWN), "mock_off", "1"), "Мок «Премиум» выключен.")
        self.assertFalse(parse_payload(self.ctx.options.hub_mocks)[1][0]["enabled"])
        # takes effect immediately: the rule no longer fires
        flow = _Flow(_Resp(200, b"{}"))
        with mock.patch.dict(sys.modules, {"mitmproxy": types.SimpleNamespace(ctx=self.ctx)}):
            asyncio.run(self.addon.response(flow))
        self.assertEqual(flow.comment, "")
        self.assertEqual(self.call("mock_on", "r2"), "Мок «Лежит» включён.")
        self.assertEqual(self.call("mock_delete", "p1"), "Мок «Премиум» удалён.")
        allowed, rules = parse_payload(self.ctx.options.hub_mocks)
        self.assertTrue(allowed)
        self.assertEqual([(r["id"], r["enabled"]) for r in rules], [("r2", True)])
        journal = self.edits()
        self.assertTrue(journal["epoch"])
        self.assertEqual(
            journal["edits"],
            [
                {"seq": 1, "op": "disable", "id": "p1"},
                {"seq": 2, "op": "enable", "id": "r2"},
                {"seq": 3, "op": "delete", "id": "p1"},
            ],
        )
        self.assertIn("1. ✓ Лежит", self.call("mocks"))

    def test_hub_payload_replaces_local_state(self):
        self.run_cmd(_rules(PREMIUM), "mock_off", "1")
        self.ctx.options.hub_mocks = _rules(PREMIUM)
        self.assertIn("1. ✓ Премиум", self.call("mocks"))

    def test_edits_capped_at_100(self):
        self.run_cmd(_rules(PREMIUM), "mock_off", "1")
        for i in range(120):
            self.call("mock_on" if i % 2 else "mock_off", "p1")
        edits = self.edits()["edits"]
        self.assertEqual(len(edits), 100)
        self.assertEqual((edits[0]["seq"], edits[-1]["seq"]), (22, 121))

    def test_epoch_differs_per_addon(self):
        self.run_cmd(_rules(PREMIUM), "mock_off", "1")
        first = self.edits()["epoch"]
        self.addon = HubMocks()
        self.run_cmd(_rules(PREMIUM), "mock_off", "1")
        self.assertNotEqual(self.edits()["epoch"], first)

    def test_unknown_target(self):
        for target in ("0", "3", "nope", ""):
            out = self.run_cmd(_rules(PREMIUM, DOWN), "mock_on", target)
            self.assertTrue(out.startswith("Нет мока"), out)
        self.assertEqual(self.ctx.options.updates, [])

    def test_not_allowed(self):
        raw = json.dumps({"allowed": False, "rules": []})
        for name in ("mock_on", "mock_off", "mock_delete"):
            self.assertEqual(self.run_cmd(raw, name, "1"), "Моки выключены в хабе")
            self.assertEqual(self.ctx.options.updates, [])


if __name__ == "__main__":
    unittest.main()
