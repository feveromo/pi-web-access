export function isProbablyBinarySearchText(value: string): boolean {
	if (!value) return false;
	const { suspicious, length } = suspiciousTextStats(value);
	return length >= 120 && suspicious >= 8 && suspicious / length > 0.01;
}

export function sanitizeSearchText(value: string): string {
	if (!value || isProbablyBinarySearchText(value)) return "";
	return value
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
		.replace(/\uFFFD/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function suspiciousTextStats(value: string): { suspicious: number; length: number } {
	const sample = value.slice(0, 4000);
	let suspicious = 0;
	for (const ch of sample) {
		const code = ch.charCodeAt(0);
		if (ch === "\uFFFD" || code === 0 || code === 0x7f || (code < 32 && ch !== "\n" && ch !== "\r" && ch !== "\t")) {
			suspicious++;
		}
	}
	return { suspicious, length: sample.length };
}
