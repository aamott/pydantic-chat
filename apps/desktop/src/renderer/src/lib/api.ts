/**
 * Thin fetch wrapper for the FastAPI sidecar: attaches the per-launch
 * bearer token exposed by the preload as window.api.token.
 */

/** fetch() against the backend with `Authorization: Bearer <token>` set. */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${window.api.token}`)
  return fetch(`${window.api.backendUrl}${path}`, { ...init, headers })
}

/**
 * fetch + JSON + error mapping shared by every store action.
 *
 * Non-2xx responses throw an `Error` carrying FastAPI's `detail` text (when
 * the body is JSON) and a numeric `status` property for status-driven UI.
 */
export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init)
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const body: unknown = await response.json()
      if (
        typeof body === 'object' &&
        body !== null &&
        'detail' in body &&
        typeof (body as { detail: unknown }).detail === 'string'
      ) {
        detail = (body as { detail: string }).detail
      }
    } catch {
      /* non-JSON error body — keep the status line */
    }
    const error = new Error(detail) as Error & { status: number }
    error.status = response.status
    throw error
  }
  return (await response.json()) as T
}
