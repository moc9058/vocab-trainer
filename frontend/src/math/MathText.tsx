import Markdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
/** Raw HTML is never interpreted. KaTeX trust is disabled. */
export default function MathText({ text }: { text: string }) {
  const normalized = text
    .replace(/\\\[([\s\S]*?)\\\]/g, "\n$$$$\n$1\n$$$$\n")
    .replace(/\\\(([\s\S]*?)\\\)/g, "$$$1$");
  return (
    <div className="math-text">
      <Markdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[[rehypeKatex, { trust: false, strict: "ignore" }]]}
        skipHtml
      >
        {normalized}
      </Markdown>
    </div>
  );
}
