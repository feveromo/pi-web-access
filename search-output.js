export const DEFAULT_INLINE_SEARCH_CHARS = 3500;

export function isProbablyBinarySearchText(value) {
	if (!value) return false;
	const sample = value.slice(0, 4000);
	let suspicious = 0;
	for (const ch of sample) {
		const code = ch.charCodeAt(0);
		if (ch === "\uFFFD" || code === 0 || code === 0x7f || (code < 32 && ch !== "\n" && ch !== "\r" && ch !== "\t")) suspicious++;
	}
	return sample.length >= 120 && suspicious >= 8 && suspicious / sample.length > 0.01;
}

export function sanitizeSearchText(value) {
	if (!value || isProbablyBinarySearchText(value)) return "";
	return value
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
		.replace(/\uFFFD/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function formatSourceListItem(result, index) {
	const title = sanitizeSearchText(result.title) || `Source ${index + 1}`;
	const url = sanitizeSearchText(result.url);
	const lines = [`${index + 1}. ${title}`, `   ${url}`];
	if (result.publishedDate) lines.push(`   Published: ${sanitizeSearchText(result.publishedDate)}`);
	const snippet = sanitizeSearchText(result.snippet);
	if (snippet) lines.push(`   ${snippet}`);
	return lines.join("\n");
}

export function formatSearchSummary(results, answer, searchId, queryIndex, maxChars = DEFAULT_INLINE_SEARCH_CHARS) {
	const safeAnswer = answer.trim();
	let output = safeAnswer ? `${safeAnswer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map(formatSourceListItem).join("\n\n");
	const marker = `\n\n[Inline search output capped. Use get_search_content({ responseId: "${searchId}", queryIndex: ${queryIndex} }) for all stored snippets.]`;
	return capText(output, maxChars, marker);
}

export function formatFullResults(queryData) {
	let output = `## Results for: "${sanitizeSearchText(queryData.query)}"\n\n`;
	if (queryData.answer.trim()) output += `${queryData.answer.trim()}\n\n---\n\n`;
	for (let i = 0; i < queryData.results.length; i++) {
		const result = queryData.results[i];
		const title = sanitizeSearchText(result.title) || `Source ${i + 1}`;
		output += `### ${title}\n${sanitizeSearchText(result.url)}\n`;
		if (result.publishedDate) output += `Published: ${sanitizeSearchText(result.publishedDate)}\n`;
		const snippet = sanitizeSearchText(result.snippet);
		if (snippet) output += `\n${snippet}\n`;
		output += "\n";
	}
	return output;
}

function capText(content, maxChars, marker) {
	if (content.length <= maxChars) return { text: content, truncated: false };
	const bodyLimit = Math.max(0, maxChars - marker.length);
	const slice = content.slice(0, bodyLimit);
	const breakAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "), slice.lastIndexOf("\n"));
	const text = (breakAt > Math.floor(bodyLimit * 0.5) ? slice.slice(0, breakAt + 1) : slice).trimEnd();
	return { text: `${text}${marker}`.slice(0, maxChars), truncated: true };
}
