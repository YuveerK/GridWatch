// EvidenceContribution.refB includes the relation for typed water edges; the InfraEdge
// primary key stores childId and relationType separately. All repair paths use this codec.
export const edgeEvidenceRef = (childId, relationType = 'LEGACY_PARENT') =>
  relationType === 'LEGACY_PARENT' ? childId : `${relationType}:${childId}`;

export function decodeEdgeEvidenceRef(refB) {
  const separator = refB.indexOf(':');
  if (separator < 0) return { childId: refB, relationType: 'LEGACY_PARENT' };
  return { relationType: refB.slice(0, separator), childId: refB.slice(separator + 1) };
}
