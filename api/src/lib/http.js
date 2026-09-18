export function asyncHandler(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

export function pageParams(query, { defaultSize = 25, maxSize = 100 } = {}) {
  const page = Math.max(Number.parseInt(query.page ?? "1", 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize ?? String(defaultSize), 10) || defaultSize, 1), maxSize);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function pageResult(items, total, { page, pageSize }) {
  return { data: items, pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) } };
}
