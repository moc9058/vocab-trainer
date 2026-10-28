import { test, expect, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import MathMarkdown from "./MathMarkdown";
import translations from "../i18n/translations";
import { ApiError } from "../api/client";
import {
  enqueueAnswer,
  discardAnswers,
  getOutboxState,
  resolveMathConflict,
  flushAnswers,
} from "../utils/answerOutbox";
afterEach(() => {
  vi.useRealTimers();
  discardAnswers();
});
test("mathematics translations are complete in English, Japanese and Korean", () => {
  const keys = Object.keys(translations.en).filter((k) => k.startsWith("math"));
  for (const language of ["ja", "ko"] as const)
    for (const key of keys)
      expect(
        (translations[language] as Record<string, string>)[key],
      ).toBeTruthy();
});
test("math renderer supports MathML, matrices and local CSS while blocking HTML, images and unsafe URLs", () => {
  const html = renderToStaticMarkup(
    React.createElement(MathMarkdown, {
      children:
        "$\\frac{1}{2}$\n\n$$\n\\begin{pmatrix}1&0\\\\0&1\\end{pmatrix}\n$$\n\n<script>alert(1)</script>\n\n![remote](https://example.com/tracker)\n\n[bad](javascript:alert(1))",
    }),
  );
  expect(html).toContain("<math");
  expect(html).toContain("katex");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript:');
  expect(() =>
    renderToStaticMarkup(
      React.createElement(MathMarkdown, { children: "$\\badcommand{$" }),
    ),
  ).not.toThrow();
});
test("mathematics conflicts retain the head and serial tail until explicit resolution", async () => {
  const order: string[] = [];
  let allowed = false;
  enqueueAnswer({
    domain: "math",
    execute: async () => {
      if (!allowed) throw new ApiError(409, "conflict");
      order.push("draft");
      return {};
    },
    rebase: async () => {
      allowed = true;
    },
    resolve: () => {},
    reject: () => {},
  });
  enqueueAnswer({
    domain: "math",
    execute: async () => {
      order.push("submit");
      return {};
    },
    rebase: async () => {},
    resolve: () => {},
    reject: () => {},
  });
  await vi.waitFor(() => expect(getOutboxState().conflictBlocked).toBe(true));
  expect(getOutboxState().pending).toBe(2);
  flushAnswers();
  expect(order).toEqual([]);
  await resolveMathConflict(true);
  await vi.waitFor(() => expect(getOutboxState().pending).toBe(0));
  expect(order).toEqual(["draft", "submit"]);
});

test("canonical math selections contain selectable leaves and expand historic parent selections", async () => {
  const { leafSelection, selectableLeaves } = await import("./CurriculumTree");
  const node = (id: string, parentId: string | null, ancestorIds: string[], unitIds: string[], eligibleObjectiveCount?: number) =>
    ({ id, parentId, ancestorIds, unitIds, eligibleObjectiveCount, subjectId: "s", kind: "section", title: id, order: 0 });
  const nodes = [node("root", null, [], []), node("chapter", "root", ["root"], []),
    node("ready", "chapter", ["root", "chapter"], ["u"], 1),
    node("blocked", "chapter", ["root", "chapter"], ["u-blocked"], 0),
    node("other", "root", ["root"], ["u-other"], 1)];
  expect(selectableLeaves(nodes).map((n) => n.id)).toEqual(["ready", "other"]);
  expect(leafSelection(nodes, ["chapter"])).toEqual(["ready"]);
  expect(leafSelection(nodes, ["ready", "chapter", "missing"])).toEqual(["ready"]);
});
test("optional question count distinguishes continuous from invalid finite values", async () => {
  const { parseQuestionCount } = await import("./MathTestSetup");
  expect(parseQuestionCount("")).toBeUndefined();
  expect(parseQuestionCount("  ")).toBeUndefined();
  expect(parseQuestionCount("1")).toBe(1);
  expect(parseQuestionCount("20")).toBe(20);
  for (const input of ["0", "-1", "1.5", "21", "1e1", "abc"])
    expect(parseQuestionCount(input)).toBe(false);
});
