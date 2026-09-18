export const promptVersion = "outage-extraction.v1";

export function buildPrompt({ post, ocr, localityCandidates = [], infrastructureCandidates = [], incidentCandidates = [], knowledgeContext = [] }) {
  return `You extract only facts supported by the current City Power source. Return JSON matching the requested schema. Historical context is labeled KNOWLEDGE CONTEXT and must never be treated as current source content.

CURRENT SOURCE CONTENT
Published at: ${post.publishedAt.toISOString()}
Text: ${post.text}
Note text: ${post.noteTweetText ?? ""}
OCR: ${JSON.stringify(ocr)}

CANDIDATE LOCALITIES: ${JSON.stringify(localityCandidates)}
CANDIDATE INFRASTRUCTURE: ${JSON.stringify(infrastructureCandidates)}
RECENT INCIDENTS: ${JSON.stringify(incidentCandidates)}
KNOWLEDGE CONTEXT: ${JSON.stringify(knowledgeContext)}

Do not invent causes, ETAs, affected areas, assets, relationships, or restoration claims. Use empty arrays/nulls when unsupported.`;
}
