/** Method/path capabilities for the Chinese reading client. No quizzes or admin writes. */
import routes from './extension-routes.json' with { type: 'json' };
export const EXTENSION_ROUTES = routes;
export function extensionAllows(method: string, path: string): boolean {
  if (!path.startsWith('/api/') || /[%\\?#\u0000-\u0020]/u.test(path) || path.split('/').some(p => p === '.' || p === '..')) return false;
  return EXTENSION_ROUTES.some(([m, pattern]) => method === m && new RegExp(`^${pattern}$`).test(path));
}
