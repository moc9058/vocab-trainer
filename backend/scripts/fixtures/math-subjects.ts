import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mathHash } from "../../src/math-core.js";
import {
  curriculumRevision,
  curriculumReadingView,
} from "../../src/math-curriculum.js";
import { prepareMathBooks } from "../../src/math-sync.js";
import type {
  Curriculum,
  CurriculumObjective,
  SubjectProfile,
} from "../../src/math-types.js";
export async function prepareSubjectFixtures(root: string) {
  const fixtures = [
    {
      id: "physics-fixture",
      title: "Physics Example",
      subject: "physics" as const,
      heading: "1.1 Constant acceleration",
      markdown:
        "# 1.1 Constant acceleration\nIn one dimension assume acceleration a is constant for t >= 0. The initial position is x0 and initial velocity is v0. Velocity is v(t)=v0+a*t. Displacement over this interval equals the average of initial and final velocities times elapsed time: x(t)-x0=(v0+v(t))*t/2. SI units are meters, seconds and meters per second squared. These relations apply only when acceleration is constant; no calculus is assumed.\n",
      statement:
        "Derive and evaluate position for one-dimensional constant-acceleration motion.",
      criteria: [
        "Substitute v(t)=v0+a*t into the average-velocity displacement relation.",
        "Preserve the initial position, constant-acceleration assumption and SI units.",
      ],
      constraints: [
        "No differential equations or calculus.",
        "State the constant-acceleration assumption and SI units.",
      ],
    },
    {
      id: "economics-fixture",
      title: "Economics Example",
      subject: "economics" as const,
      heading: "1.1 Linear market equilibrium",
      markdown:
        "# 1.1 Linear market equilibrium\nWithin a static model suppose quantity demanded Qd=A-B*p and quantity supplied Qs=C+D*p, with B>0, D>0 and price p>=0. A,C are exogenous real parameters. An interior feasible equilibrium requires Qd=Qs>=0. Algebra gives p*=(A-C)/(B+D) and Q*=(A*D+B*C)/(B+D); these are feasible only if p*>=0 and Q*>=0. The model does not assert these linear equations are empirical laws or provide any current statistics.\n",
      statement:
        "Derive and evaluate feasible equilibrium price and quantity within a linear supply-demand model.",
      criteria: [
        "Solve equality of demand and supply using the positive denominator B+D.",
        "Check nonnegative price and quantity and state the exogenous-parameter assumptions.",
      ],
      constraints: [
        "Reason within the specified static model.",
        "Do not invent observations or infer universal empirical laws.",
      ],
    },
  ];
  const books = [];
  for (const f of fixtures) {
    const chapterId = `${f.id}-c1`,
      file = `${f.title}/md/1. Introduction.md`,
      curriculumFile = `${f.title}/curriculum/learning-objectives.json`;
    await mkdir(resolve(root, f.title, "md"), { recursive: true });
    await mkdir(resolve(root, f.title, "curriculum"), { recursive: true });
    await writeFile(resolve(root, file), f.markdown);
    const objective: CurriculumObjective = {
      id: `${f.id}-objective`,
      chapterId,
      statement: f.statement,
      ability: "modeling",
      supportedTaskKinds: ["derive", "compute"],
      sourceRefs: [{ chapterId, section: "1.1", heading: f.heading }],
      prerequisiteObjectiveIds: [],
      requiredBackground: ["Elementary algebra."],
      successCriteria: f.criteria.map((criterion, i) => ({
        id: `c${i + 1}`,
        criterion,
      })),
      scopeConstraints: f.constraints,
      commonErrors: [],
      status: "active",
    };
    const c: Curriculum = {
      schemaVersion: 2,
      bookId: f.id,
      revision: "",
      sourceLanguage: "en",
      instructionLanguage: "en",
      sources: [{ chapterId, file, sha256: mathHash(f.markdown) }],
      objectives: [objective],
    };
    c.revision = curriculumRevision(c);
    await writeFile(
      resolve(root, curriculumFile),
      JSON.stringify(c, null, 2) + "\n",
    );
    await writeFile(
      resolve(root, f.title, "curriculum/README.md"),
      curriculumReadingView(c),
    );
    const subjectProfile: SubjectProfile = {
      version: `${f.subject}-v1`,
      subject: f.subject,
      constraints: f.constraints,
    };
    books.push({
      id: f.id,
      subjectId: f.subject,
      subjectTitle: f.subject,
      title: f.title,
      language: "en",
      curriculumFile,
      subjectProfile,
      chapters: [{ id: chapterId, file }],
    });
  }
  return prepareMathBooks(root, { books });
}
