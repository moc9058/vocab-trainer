import { test } from "node:test";
import { spawnSync } from "node:child_process";
const available = ["pdfinfo", "pdftoppm"].every(
  (command) => spawnSync(command, ["-v"]).status === 0,
);
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { linearAlgebraFixture } from "./math-fixtures.js";
import { extractPdf } from "../math-authoring/pdf-source.js";
const fixture = await linearAlgebraFixture();
test(
  "local PDF adapter prepares images, uses loopback only and resumes completed checkpoints without more inference",
  { skip: !available && "Local Poppler is unavailable" },
  async () => {
    const output = await mkdtemp(join(tmpdir(), "math-pdf-local-")),
      pdf = resolve("src/test-fixtures/math/zero-subspace.pdf"),
      hash = createHash("sha256")
        .update(await readFile(pdf))
        .digest("hex");
    let calls = 0;
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      calls++;
      let content =
        "The zero subspace contains zero and is closed under addition and scalar multiplication.";
      if (request.response_format) {
        const provenance = structuredClone(fixture.provenance);
        for (const record of provenance.records) {
          record.verified = false;
          record.formulaVerified = false;
          for (const span of record.evidence) span.sourceRevisionId = hash;
        }
        content = JSON.stringify({
          schemaVersion: 1,
          subject: { id: "linear-algebra", title: "Linear Algebra" },
          units: [
            {
              markdown: fixture.markdown.replaceAll(
                fixture.sourceRevisionId,
                hash,
              ),
              provenance,
            },
          ],
          sources: [],
          coverage: [{ page: 1, status: "processed", omissions: [] }],
          unresolved: ["Source comparison required"],
        });
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content } }],
          usage: { total_tokens: 100 },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port,
      options = {
        subject: "linear-algebra",
        "source-id": "toy-fixture",
        pdf,
        pages: "1",
        adapter: "local",
        "semantic-policy": "local-only",
        "local-endpoint": `http://127.0.0.1:${port}/v1/chat/completions`,
        "local-model": "test-local-model",
        output,
      };
    try {
      await extractPdf(output, options);
      assert.equal(calls, 2);
      const checkpoint = JSON.parse(
        await readFile(join(output, "checkpoint.json"), "utf8"),
      );
      assert.equal(checkpoint.state, "needs-review");
      assert.equal(checkpoint.calls, 2);
      assert.deepEqual(checkpoint.completedPages, [1]);
      await extractPdf(output, { ...options, resume: true });
      assert.equal(calls, 2);
      await assert.rejects(
        () =>
          extractPdf(output, {
            ...options,
            output: join(output, "rejected"),
            "local-endpoint": "https://example.com/v1/chat/completions",
          }),
        /E_LOCAL_ENDPOINT_REQUIRED/,
      );
    } finally {
      server.close();
      await rm(output, { recursive: true, force: true });
    }
  },
);
