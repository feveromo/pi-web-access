export function buildSuccessfulFetchHint(responseId, results, maxIndexes = 20) {
	const successfulIndexes = results.flatMap((result, index) => result?.error ? [] : [index]);
	if (successfulIndexes.length === 0) return { text: "", successfulIndexes };
	const first = successfulIndexes[0];
	const batch = successfulIndexes.slice(0, maxIndexes);
	let text = `Use get_search_content({ responseId: "${responseId}", urlIndex: ${first} }) to retrieve the first successful URL`;
	if (batch.length > 1) text += `, or get_search_content({ responseId: "${responseId}", urlIndexes: [${batch.join(", ")}] }) for all successful URLs`;
	return { text: `${text}.`, successfulIndexes };
}
