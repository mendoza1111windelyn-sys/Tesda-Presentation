const apiBaseUrl = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

export function apiUrl(path: string) {
  return `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

export function socketUrl(query: string) {
  const url = new URL(apiBaseUrl || window.location.origin);
  const protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${url.host}/ws?${query}`;
}

export const guestUrl = import.meta.env.VITE_GUEST_URL || `${window.location.origin}/watch`;
export const appRole = import.meta.env.VITE_APP_ROLE || "";
