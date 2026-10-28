import { Link } from "react-router-dom";
import { useI18n } from "../i18n/context";
import type { Citation, StoredSolution } from "./types";
import MathMarkdown from "./MathMarkdown";
export function MathCitation({
  citation: c,
  catalogId,
}: {
  citation: Citation;
  catalogId: string;
}) {
  const { t } = useI18n();
  return (
    <div className="math-citation">
      <span>
        {[
          c.subjectTitle,
          c.bookTitle,
          c.edition,
          ...c.sourcePath.map((n) =>
            [n.printedLabel, n.title].filter(Boolean).join(" "),
          ),
        ]
          .filter(Boolean)
          .join(" / ")}
      </span>
      <br />
      <Link to={`/math/catalogs/${catalogId}/concepts/${c.conceptId}`}>
        {c.printedItemLabel || t("mathUnnumbered")} · {c.itemTitle}
      </Link>
      {c.printedPageLabel && (
        <span>
          {" "}
          · {t("mathPrintedPage")} {c.printedPageLabel}
        </span>
      )}
      {c.pdfPageStart && (
        <span>
          {" "}
          · PDF {c.pdfPageStart}
          {c.pdfPageEnd !== c.pdfPageStart ? `–${c.pdfPageEnd}` : ""}
        </span>
      )}
      <span className="math-muted"> · {c.origin}</span>
    </div>
  );
}
export function MathSolutionView({
  solution,
  catalogId,
}: {
  solution: StoredSolution;
  catalogId: string;
}) {
  const { t } = useI18n();
  return (
    <section className="math-card">
      <h2>{t("mathUsedKnowledge")}</h2>
      {solution.citations.map((c) => (
        <MathCitation key={c.citationId} citation={c} catalogId={catalogId} />
      ))}
      <h2>{t("mathStrategy")}</h2>
      <MathMarkdown>
        {solution.candidate.solution.strategyMarkdown}
      </MathMarkdown>
      {solution.candidate.solution.steps.map((step) => (
        <div className="math-card" key={step.id}>
          {step.citationIds.map((id) => {
            const citation = solution.citations.find(
              (c) => c.citationId === id,
            );
            return citation ? (
              <MathCitation
                key={id}
                citation={citation}
                catalogId={catalogId}
              />
            ) : null;
          })}
          <h3>{t("mathConditions")}</h3>
          <MathMarkdown>{step.applicabilityMarkdown}</MathMarkdown>
          <MathMarkdown>{step.explanationMarkdown}</MathMarkdown>
        </div>
      ))}
      <h2>{t("mathFinalAnswer")}</h2>
      <MathMarkdown>
        {solution.candidate.solution.finalAnswerMarkdown}
      </MathMarkdown>
      <h2>{t("mathChecks")}</h2>
      <MathMarkdown>{solution.candidate.solution.checksMarkdown}</MathMarkdown>
    </section>
  );
}
