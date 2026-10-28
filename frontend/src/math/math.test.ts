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
