import assert from "node:assert/strict";
import test from "node:test";
import { withPreservedQuery } from "../lib/dashboard/routeRedirect";

test("preserves scalar and repeated query parameters across route redirects", () => {
  assert.equal(
    withPreservedQuery("/dashboard/practice/openings/B07", {
      page: "2",
      filter: ["rapid", "blitz"],
      empty: undefined,
    }),
    "/dashboard/practice/openings/B07?page=2&filter=rapid&filter=blitz",
  );
});

test("does not append a query delimiter when there are no query parameters", () => {
  assert.equal(withPreservedQuery("/dashboard/practice", {}), "/dashboard/practice");
});
