/**
 * PDF Content Extractor
 * 
 * Extracts text from PDF files and saves to markdown.
 * Uses unpdf (pdfjs-dist wrapper) for text extraction.
 */

import { getResolvedPDFJS } from "unpdf";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { isManagedCacheRoot, pruneManagedEntries } from "./managed-cache.js";

export interface PDFExtractResult {
  title: string;
  pages: number;
  chars: number;
  outputPath: string;
  content: string;
}

export interface PDFExtractOptions {
  maxPages?: number;
  maxChars?: number;
  outputDir?: string;
  filename?: string;
  signal?: AbortSignal;
}

const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_CHARS = 2_000_000;
const DEFAULT_OUTPUT_DIR = join(homedir(), ".pi", "web-access", "pdf-cache");
const PDF_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PDF_CACHE_MAX_FILES = 100;
const PDF_CACHE_MAX_BYTES = 250 * 1024 * 1024;
const DESTROY_TIMEOUT_MS = 1000;

type Destroyable = { destroy(): Promise<unknown> };

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function awaitWithAbort<T>(promise: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      err => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function destroyWithin(resource: Destroyable | undefined): Promise<void> {
  if (!resource) return;
  const destruction = Promise.resolve().then(() => resource.destroy()).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    destruction,
    new Promise<void>(resolve => { timer = setTimeout(resolve, DESTROY_TIMEOUT_MS); }),
  ]);
  if (timer) clearTimeout(timer);
}

/**
 * Extract text from a PDF buffer and save to markdown file
 */
export async function extractPDFToMarkdown(
  buffer: ArrayBuffer,
  url: string,
  options: PDFExtractOptions = {}
): Promise<PDFExtractResult> {
  const {
    maxPages = DEFAULT_MAX_PAGES,
    maxChars = DEFAULT_MAX_CHARS,
    filename,
    signal,
  } = options;
  const environmentOutputDir = process.env.PI_WEB_ACCESS_PDF_OUTPUT_DIR?.trim() || undefined;
  const outputDir = options.outputDir ?? environmentOutputDir ?? DEFAULT_OUTPUT_DIR;
  const manageOutput = options.outputDir === undefined && !environmentOutputDir;
  const safeMaxPages = Number.isFinite(maxPages)
    ? Math.max(1, Math.floor(maxPages))
    : DEFAULT_MAX_PAGES;
  const safeMaxChars = Number.isFinite(maxChars)
    ? Math.min(5_000_000, Math.max(1000, Math.floor(maxChars)))
    : DEFAULT_MAX_CHARS;

  signal?.throwIfAborted();
  let loadingTask: Destroyable | undefined;
  let pdf: Awaited<ReturnType<Awaited<ReturnType<typeof getResolvedPDFJS>>["getDocument"]>["promise"]> | undefined;
  try {
    const pdfjs = await awaitWithAbort(getResolvedPDFJS(), signal);
    signal?.throwIfAborted();
    const task = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: true,
    });
    loadingTask = task;
    pdf = await awaitWithAbort(task.promise, signal);
    const metadata = await awaitWithAbort(pdf.getMetadata(), signal);
    const metadataInfo = metadata.info && typeof metadata.info === "object"
      ? metadata.info as Record<string, unknown>
      : null;
    const metaTitle = typeof metadataInfo?.Title === "string" ? metadataInfo.Title : undefined;
    const metaAuthor = typeof metadataInfo?.Author === "string" ? metadataInfo.Author : undefined;
    const title = metaTitle?.trim() || extractTitleFromURL(url);
    const pagesToExtract = Math.min(pdf.numPages, safeMaxPages);
    const pages: { pageNum: number; text: string }[] = [];
    const textBudget = Math.max(0, safeMaxChars - 2000);
    let extractedChars = 0;
    let truncatedByChars = false;

    for (let i = 1; i <= pagesToExtract; i++) {
      signal?.throwIfAborted();
      const page = await awaitWithAbort(pdf.getPage(i), signal);
      const textContent = await awaitWithAbort(page.getTextContent(), signal);
      signal?.throwIfAborted();
      const pageText = textContent.items
        .map((item: unknown) => (item as { str?: string }).str || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!pageText) continue;
      const remaining = textBudget - extractedChars;
      if (remaining <= 0) {
        truncatedByChars = true;
        break;
      }
      const text = pageText.slice(0, remaining);
      pages.push({ pageNum: i, text });
      extractedChars += text.length;
      if (text.length < pageText.length) {
        truncatedByChars = true;
        break;
      }
    }
    const truncatedByPages = pdf.numPages > safeMaxPages;

    const lines = [
      `# ${title}`,
      "",
      `> Source: ${url}`,
      `> Pages: ${pdf.numPages}${truncatedByPages ? ` (extracted first ${pagesToExtract})` : ""}`,
    ];
    if (metaAuthor) lines.push(`> Author: ${metaAuthor}`);
    lines.push("", "---", "");
    for (let i = 0; i < pages.length; i++) {
      if (i > 0) lines.push("", `<!-- Page ${pages[i].pageNum} -->`, "");
      lines.push(pages[i].text);
    }
    if (truncatedByPages) {
      lines.push("", "---", "", `*[Truncated: Only first ${pagesToExtract} of ${pdf.numPages} pages extracted]*`);
    } else if (truncatedByChars) {
      lines.push("", "---", "", `*[Truncated: Extracted PDF text capped at ${safeMaxChars.toLocaleString()} characters]*`);
    }

    const uncappedContent = lines.join("\n");
    const marker = "\n\n[PDF markdown truncated at configured character limit]";
    const content = uncappedContent.length > safeMaxChars
      ? `${uncappedContent.slice(0, Math.max(0, safeMaxChars - marker.length)).trimEnd()}${marker}`
      : uncappedContent;
    const preferredName = basename(filename || `${sanitizeFilename(title)}.md`);
    signal?.throwIfAborted();
    if (manageOutput && !isManagedCacheRoot(outputDir, DEFAULT_OUTPUT_DIR)) {
      throw new Error(`Refusing to write through unsafe managed PDF cache root: ${outputDir}`);
    }
    await mkdir(outputDir, { recursive: true });
    if (manageOutput && !isManagedCacheRoot(outputDir, DEFAULT_OUTPUT_DIR)) {
      throw new Error(`Refusing to write through unsafe managed PDF cache root: ${outputDir}`);
    }
    if (manageOutput) {
      try { prunePDFCache(outputDir); } catch {}
    }
    signal?.throwIfAborted();
    const outputPath = await writeWithoutOverwrite(outputDir, preferredName, content, signal);
    if (manageOutput) {
      try { prunePDFCache(outputDir, new Set([outputPath])); } catch {}
    }
    return { title, pages: pdf.numPages, chars: content.length, outputPath, content };
  } finally {
    await destroyWithin(pdf ?? loadingTask);
  }
}

export function prunePDFCache(
  outputDir: string,
  protectedPaths: ReadonlySet<string> = new Set(),
  limits: { maxAgeMs: number; maxFiles: number; maxBytes: number } = {
    maxAgeMs: PDF_CACHE_MAX_AGE_MS,
    maxFiles: PDF_CACHE_MAX_FILES,
    maxBytes: PDF_CACHE_MAX_BYTES,
  },
  now = Date.now(),
): string[] {
  if (!existsSync(outputDir) || !isManagedCacheRoot(outputDir, outputDir)) return [];
  const entries: { path: string; mtimeMs: number; sizeBytes: number }[] = [];
  try {
    for (const item of readdirSync(outputDir, { withFileTypes: true })) {
      if (!item.isFile() || item.isSymbolicLink()) continue;
      const path = join(outputDir, item.name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      entries.push({ path, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
    }
  } catch {
    return [];
  }
  return pruneManagedEntries(outputDir, entries, {
    maxAgeMs: limits.maxAgeMs,
    maxEntries: limits.maxFiles,
    maxBytes: limits.maxBytes,
  }, protectedPaths, now);
}

async function writeWithoutOverwrite(outputDir: string, preferredName: string, content: string, signal?: AbortSignal): Promise<string> {
  const dot = preferredName.lastIndexOf(".");
  const stem = dot > 0 ? preferredName.slice(0, dot) : preferredName;
  const extension = dot > 0 ? preferredName.slice(dot) : "";
  for (let suffix = 0; suffix < 1000; suffix++) {
    signal?.throwIfAborted();
    const name = suffix === 0 ? preferredName : `${stem}-${suffix + 1}${extension}`;
    const outputPath = join(outputDir, name);
    try {
      await writeFile(outputPath, content, { encoding: "utf-8", flag: "wx", signal });
      return outputPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = await readFile(outputPath, "utf-8").catch(() => null);
        if (existing === content) return outputPath;
        continue;
      }
      await rm(outputPath, { force: true }).catch(() => {});
      throw err;
    }
  }
  throw new Error(`Could not allocate a unique output filename for ${preferredName}`);
}

/**
 * Extract a reasonable title from URL
 */
function extractTitleFromURL(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    
    // Get filename without extension
    let filename = basename(pathname, ".pdf");
    
    // Handle arxiv URLs: /pdf/1706.03762 → "arxiv-1706.03762"
    if (urlObj.hostname.includes("arxiv.org")) {
      const match = pathname.match(/\/(?:pdf|abs)\/(\d+\.\d+)/);
      if (match) {
        filename = `arxiv-${match[1]}`;
      }
    }
    
    // Clean up filename
    filename = filename
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    
    return filename || "document";
  } catch {
    return "document";
  }
}

/**
 * Sanitize string for use as filename
 */
function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 100)
    .replace(/^-|-$/g, "")
    || "document";
}

/**
 * Check if URL or content-type indicates a PDF
 */
export function isPDF(url: string, contentType?: string): boolean {
  if (contentType?.includes("application/pdf")) {
    return true;
  }
  try {
    const urlObj = new URL(url);
    return urlObj.pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}
