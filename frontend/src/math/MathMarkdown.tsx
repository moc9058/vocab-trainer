import Markdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import "./math.css";
export default function MathMarkdown({ children }: { children: string }) {
  return (
    <div className="math-markdown">
      <Markdown
        skipHtml
        remarkPlugins={[remarkMath]}
        rehypePlugins={[
          [
            rehypeKatex,
            {
              trust: false,
              maxExpand: 200,
              maxSize: 20,
              throwOnError: false,
              strict: "warn",
              macros: {},
              output: "htmlAndMathml",
            },
          ],
        ]}
        disallowedElements={[
          "img",
          "iframe",
          "script",
          "style",
          "object",
          "embed",
        ]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href?.startsWith("https://") ? href : undefined}
              target="_blank"
              rel="noreferrer"
            >
              {children}
            </a>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
