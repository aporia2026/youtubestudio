/**
 * Shared type for the per-row auto-fetched overlay state.
 *
 * Lives in its own file so both the page-level state and the cell-level
 * presentational component can reference the same shape without the
 * component pulling in the entire page module.
 *
 * Status semantics:
 *   - 'idle'    — fetch hasn't been kicked off (or row has no overlay terms)
 *   - 'loading' — POST /api/overlay/fetch in flight
 *   - 'done'    — overlay URL ready, will be composited at render
 *   - 'skipped' — search returned nothing usable; the still alone renders
 *   - 'error'   — pipeline failed (Brave down, RMBG down, etc.)
 */
export interface RowOverlayState {
  status: 'idle' | 'loading' | 'done' | 'skipped' | 'error';
  url?: string;
  sourceUrl?: string;
  error?: string;
}
