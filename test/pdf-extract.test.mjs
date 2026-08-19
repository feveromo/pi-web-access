import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getDocumentProxy } from "unpdf";
import { extractPDFToMarkdown } from "../pdf-extract.ts";

test("unpdf extracts text on Node 22 without native Promise.try", async () => {
  const originalPromiseTry = Promise.try;
  try {
    Reflect.deleteProperty(Promise, "try");
    assert.equal(typeof Promise.try, "undefined");

    const pdf = await getDocumentProxy(new Uint8Array(makePdf("Hello PDF")));
    const page = await pdf.getPage(1);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => item.str || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    assert.equal(pdf.numPages, 1);
    assert.match(text, /Hello PDF/);
  } finally {
    if (originalPromiseTry) Promise.try = originalPromiseTry;
  }
});

test("PDF wrapper returns markdown and reuses identical output without overwriting", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "pi-web-access-pdf-"));
  try {
    const userFile = join(outputDir, "user-owned.md");
    writeFileSync(userFile, "keep");
    utimesSync(userFile, new Date(0), new Date(0));
    const first = await extractPDFToMarkdown(makePdf("Wrapped PDF text"), "https://example.test/paper.pdf", { outputDir, filename: "paper.md" });
    const second = await extractPDFToMarkdown(makePdf("Wrapped PDF text"), "https://example.test/paper.pdf", { outputDir, filename: "paper.md" });

    assert.match(first.content, /Wrapped PDF text/);
    assert.equal(readFileSync(first.outputPath, "utf8"), first.content);
    assert.equal(first.outputPath, second.outputPath);
    assert.deepEqual(readdirSync(outputDir).sort(), ["paper.md", "user-owned.md"]);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("PDF wrapper bounds extracted markdown", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "pi-web-access-pdf-cap-"));
  try {
    const result = await extractPDFToMarkdown(makePdf("A".repeat(5000)), "https://example.test/large.pdf", { outputDir, maxChars: 1000 });
    assert.ok(result.content.length <= 1000);
    assert.match(result.content, /truncated/i);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("PDF wrapper honors a pre-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    extractPDFToMarkdown(makePdf("cancel"), "https://example.test/cancel.pdf", { signal: controller.signal }),
    err => err?.name === "AbortError",
  );
});

test("default managed PDF extraction refuses a symlink root before writing", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-web-access-pdf-home-"));
  const victim = mkdtempSync(join(tmpdir(), "pi-web-access-pdf-victim-"));
  try {
    const parent = join(home, ".pi", "web-access");
    const managedRoot = join(parent, "pdf-cache");
    mkdirSync(parent, { recursive: true });
    writeFileSync(join(victim, "owned.md"), "external victim");
    symlinkSync(victim, managedRoot, "dir");
    const script = `
      import { extractPDFToMarkdown } from ${JSON.stringify(new URL("../pdf-extract.ts", import.meta.url).href)};
      const bytes = Buffer.from(process.env.TEST_PDF_BASE64, "base64");
      try {
        await extractPDFToMarkdown(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "https://example.test/managed.pdf");
        process.exitCode = 2;
      } catch (error) {
        if (!String(error?.message).includes("unsafe managed PDF cache root")) throw error;
      }
    `;
    const env = { ...process.env, HOME: home, TEST_PDF_BASE64: Buffer.from(makePdf("Do not write")).toString("base64") };
    delete env.PI_WEB_ACCESS_PDF_OUTPUT_DIR;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.deepEqual(readdirSync(victim), ["owned.md"]);
    assert.equal(readFileSync(join(victim, "owned.md"), "utf8"), "external victim");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(victim, { recursive: true, force: true });
  }
});

function makePdf(text) {
  const content = "BT /F1 24 Tf 72 720 Td (" + text + ") Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + Buffer.byteLength(content, "ascii") + " >>\nstream\n" + content + "\nendstream",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];

  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += String(index + 1) + " 0 obj\n" + objects[index] + "\nendobj\n";
  }

  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += "xref\n0 " + String(objects.length + 1) + "\n";
  body += "0000000000 65535 f \n";

  for (const offset of offsets.slice(1)) {
    body += String(offset).padStart(10, "0") + " 00000 n \n";
  }

  body += "trailer\n<< /Size " + String(objects.length + 1) + " /Root 1 0 R >>\n";
  body += "startxref\n" + String(xrefOffset) + "\n%%EOF\n";

  return new TextEncoder().encode(body).buffer;
}
