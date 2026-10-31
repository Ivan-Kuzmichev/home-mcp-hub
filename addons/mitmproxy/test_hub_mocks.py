import unittest

from hub_mocks import (
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


if __name__ == "__main__":
    unittest.main()
