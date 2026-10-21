/** Public GetAwemeSeriesListOpen schema; availability for a particular account is unverified. */
export const AWEME_SERIES_CONTRACT = Object.freeze({
  version: 1,
  path: '/novelsale/openapi/content/aweme_series/list/v1/',
  query: { sort_field: 8, sort_type: 1 },
  pageSize: 100,
  pageSizeParam: 'page_size',
  itemsPath: 'data',
  // Upstream allows index 10000; this worker retains its existing 10000-page scan limit.
  pagination: { type: 'page', parameter: 'page_index', initial: 0, totalPath: 'total', maxPage: 9999 },
  fields: { externalId: 'book_id', title: 'book_name', episodeCount: 'episode_amount', releaseStatus: 'publish_status' },
});
