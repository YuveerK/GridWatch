export async function reconcileKnowledge({ prisma }) {
  const unresolved = await prisma.unresolvedEntityMention.count({ where: { status: "UNRESOLVED" } });
  return { unresolved, status: "ready" };
}
