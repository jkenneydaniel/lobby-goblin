const perPage = 20;

export function slicePage(items, requested = 1) {
  const total = items.length,
    pages = Math.max(1, Math.ceil(total / perPage)),
    page = Math.max(1, Math.min(requested, pages)),
    offset = (page - 1) * perPage;
  return {
    page,
    pages,
    total,
    first: offset + 1,
    last: Math.min(offset + perPage, total),
    items: items.slice(offset, offset + perPage),
  };
}

export function listPageControls({page, pages, first, last, total}) {
  if (pages === 1) return '';
  return `<nav class="list-pages" aria-label="List pages"><button type="button" data-list-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>Previous</button><span data-list-range role="status" tabindex="-1">Showing ${first}–${last} of ${total}</span><button type="button" data-list-page="${page + 1}" ${page === pages ? 'disabled' : ''}>Next</button></nav>`;
}

export function paintListPageControls(container, result) {
  const focused = container.contains(document.activeElement);
  container.innerHTML = listPageControls(result);
  if (focused) container.querySelector('[data-list-range]')?.focus();
}
