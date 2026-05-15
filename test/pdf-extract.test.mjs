import assert from "node:assert/strict";
import { test } from "node:test";
import { getDocumentProxy } from "unpdf";

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
