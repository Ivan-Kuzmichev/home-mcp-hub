import asyncio
import json
import sys
import types
import unittest
from unittest import mock

from hub_mocks import (
    HubMocks,
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
    def __init__(self, response=None):
        self.request = _Req()
        self.response = response
        self.comment = ""


def _stub_modules(raw):
    ctx = types.SimpleNamespace(options=types.SimpleNamespace(hub_mocks=raw))
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
    return json.dumps({"rules": list(rules)})


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


if __name__ == "__main__":
    unittest.main()
