// /public/js/admin-session.js
// ─────────────────────────────────────────────────────────────────
// Single source of truth for admin authentication.
//
// Architecture (matches docs/admin-session-design.md):
//
//   Admin page
//      │
//      ├─ JWT valid locally → continue, schedule next check near expiry
//      │
//      └─ JWT expired / expiring
//             │
//             ├─ refresh token present → POST /api/admin/refresh
//             │      ├─ ok   → save new token, reschedule
//             │      └─ 401  → save current URL, go to login
//             │
//             └─ no refresh token → save current URL, go to login
//
//   Login page
//      │
//      ├─ already have a valid session? → verify server → redirect to saved URL (or dashboard)
//      └─ otherwise wait for the operator to log in.
//
//   On login success (from the login page's own code):
//      AdminSession.redirectAfterLogin()
//
// Guarantees:
//   • The server is authoritative. A 401 from any adminFetch() always
//     wins over the local clock.
//   • No periodic server pings. The session is checked locally; the
//     server is contacted only at startup, near expiry, on refresh,
//     or when the tab becomes visible after being hidden.
//   • Return URL is only ever an internal /admin/ path. Never an
//     absolute URL. Never a URL on another origin.
//   • 403 (authenticated but unauthorized) NEVER clears the session.
//     Only 401 does.
//
// REVISION 2026-11-05:
//   • verifyAdminSession() now requires TWO consecutive fatal 401s
//     before it clears the session and redirects. Rationale:
//     a transient network blip, a cold Supabase connection, or an
//     edge proxy timeout can produce a single spurious 401 from
//     /api/admin/session. Before this change, that single 401 would
//     call redirectToLogin() — which is a full-page navigation
//     (window.location.replace). The user perceives that as "the
//     page reloaded". Two strikes eliminates that class of bug
//     without weakening security: a genuinely revoked session
//     fails the second call too.
// ─────────────────────────────────────────────────────────────────

(function () {
    'use strict';

    // ─── CONFIG ─────────────────────────────────────────────────────
    const ADMIN_SESSION_KEY = 'admin_sess';
    const RETURN_URL_KEY    = 'admin_return_url';
    const LOGIN_URL         = '/admin/index.html';
    const DASHBOARD_URL     = '/admin/dashboard.html';

    // How close to expiry to proactively refresh. 5 minutes.
    const REFRESH_BEFORE_MS = 5 * 60 * 1000;
    // Never schedule a timer sooner than this — protects against a
    // pathological token with a bad exp.
    const MIN_TIMER_MS      = 1000;

    // How many consecutive fatal 401s from /api/admin/session before
    // we clear the session. 2 = tolerate one transient blip.
    const MAX_VERIFY_FAIL_STREAK = 2;

    // ─── PAGE DETECTION ─────────────────────────────────────────────
    const pathname = window.location.pathname;
    const IS_ADMIN_PAGE = pathname.startsWith('/admin');
    const IS_LOGIN_PAGE =
        pathname === '/admin' ||
        pathname === '/admin/' ||
        pathname === '/admin/index' ||
        pathname === '/admin/index.html' ||
        pathname === '/admin/login' ||
        pathname === '/admin/login.html';
    const IS_DASHBOARD_PAGE =
        pathname === '/admin/dashboard' ||
        pathname === '/admin/dashboard/' ||
        pathname === '/admin/dashboard.html';

    if (!IS_ADMIN_PAGE) return;

    // ─── STATE ──────────────────────────────────────────────────────
    let isRedirecting     = false;
    let isVerifying       = false;
    let refreshInFlight   = false;
    let expiryTimer       = null;
    let initAttempted     = false;
    let verifyFailStreak  = 0;    // consecutive fatal 401s from /session
    let verifyPromise     = null; // shared in-flight promise for concurrent callers

    // ─── SESSION STORAGE ────────────────────────────────────────────

    function getAdminSession() {
        try {
            const raw = localStorage.getItem(ADMIN_SESSION_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            return parsed;
        } catch (e) {
            console.error('[ADMIN SESSION] Invalid session data:', e);
            return null;
        }
    }

    function getAdminToken() {
        const s = getAdminSession();
        return s && s.token ? s.token : null;
    }

    function getAdminUser() {
        const s = getAdminSession();
        return s && s.user ? s.user : null;
    }

    function getRefreshToken() {
        const s = getAdminSession();
        return s && s.refreshToken ? s.refreshToken : null;
    }

    function clearAdminSession() {
        try {
            localStorage.removeItem(ADMIN_SESSION_KEY);
            sessionStorage.removeItem(ADMIN_SESSION_KEY);
        } catch (_) { /* ignore */ }
        verifyFailStreak = 0;
        console.log('[ADMIN SESSION] Session cleared');
    }

    function saveAdminSession(token, user, refreshToken) {
        if (!token || typeof token !== 'string' || token.split('.').length !== 3) {
            throw new Error('Cannot save invalid admin token');
        }
        const expiresAt = getTokenExpiry(token);
        const session = {
            token: token,
            refreshToken: refreshToken || null,
            user: user || null,
            loggedAt: Date.now(),
            expiresAt: expiresAt
        };
        try {
            localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
        } catch (e) {
            console.error('[ADMIN SESSION] Could not persist session:', e);
            throw e;
        }
        verifyFailStreak = 0;  // a fresh token invalidates old failures
        console.log(
            '[ADMIN SESSION] Saved. Expires:',
            expiresAt ? new Date(expiresAt).toLocaleString() : 'INVALID'
        );
        return session;
    }

    // ─── JWT (local, no crypto) ─────────────────────────────────────

    function decodeJwtPayload(token) {
        try {
            if (!token || typeof token !== 'string') return null;
            const parts = token.split('.');
            if (parts.length !== 3) return null;
            let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            while (base64.length % 4 !== 0) base64 += '=';
            return JSON.parse(atob(base64));
        } catch (_) {
            return null;
        }
    }

    function getTokenExpiry(token) {
        const payload = decodeJwtPayload(token);
        if (!payload || !payload.exp) return null;
        return payload.exp * 1000;
    }

    function isTokenExpired(token) {
        const expiry = getTokenExpiry(token);
        if (!expiry) return true;
        return Date.now() >= expiry;
    }

    function isSessionValid() {
        const token = getAdminToken();
        if (!token) return false;
        return !isTokenExpired(token);
    }

    // ─── RETURN-URL HANDLING ────────────────────────────────────────

    function saveReturnUrl() {
        if (IS_LOGIN_PAGE) return;
        const current = window.location.pathname + window.location.search + window.location.hash;
        // Only internal admin pages. Never absolute, never another origin.
        if (!current.startsWith('/admin/')) return;
        try {
            sessionStorage.setItem(RETURN_URL_KEY, current);
        } catch (_) { /* ignore */ }
    }

    function getReturnUrl() {
        try {
            const raw = sessionStorage.getItem(RETURN_URL_KEY);
            if (!raw) return null;
            if (!raw.startsWith('/admin/')) {
                sessionStorage.removeItem(RETURN_URL_KEY);
                return null;
            }
            // Never return the login page itself — protects against a loop.
            if (raw === LOGIN_URL || raw.startsWith('/admin/index')) {
                sessionStorage.removeItem(RETURN_URL_KEY);
                return null;
            }
            return raw;
        } catch (_) {
            return null;
        }
    }

    function clearReturnUrl() {
        try { sessionStorage.removeItem(RETURN_URL_KEY); } catch (_) { /* ignore */ }
    }

    // ─── REDIRECTS ──────────────────────────────────────────────────

    function redirectToLogin() {
        if (IS_LOGIN_PAGE || isRedirecting) return;
        isRedirecting = true;
        stopExpiryTimer();
        saveReturnUrl();
        console.log('[ADMIN SESSION] Redirecting to login. Return URL saved.');
        window.location.replace(LOGIN_URL);
    }

    function redirectToDashboard() {
        if (IS_DASHBOARD_PAGE || isRedirecting) return;
        isRedirecting = true;
        console.log('[ADMIN SESSION] Redirecting to dashboard');
        window.location.replace(DASHBOARD_URL);
    }

    // Called by the login page after a successful login.
    function redirectAfterLogin() {
        const target = getReturnUrl();
        if (target) {
            clearReturnUrl();
            console.log('[ADMIN SESSION] Returning to:', target);
            window.location.replace(target);
            return;
        }
        window.location.replace(DASHBOARD_URL);
    }

    // ─── SERVER VERIFICATION ────────────────────────────────────────
    //
    // Two-strike rule: a fatal 401 from /api/admin/session only
    // clears the session and redirects after MAX_VERIFY_FAIL_STREAK
    // consecutive failures. A single failure (which could be a
    // transient network blip or edge timeout) bumps the streak but
    // does NOT navigate. Any success resets the streak.
    //
    // Additionally: concurrent callers share a single in-flight
    // promise (verifyPromise). Before this change, a second caller
    // during an in-flight verify would return true immediately
    // (`if (isVerifying) return true`), which masked failures —
    // callers would think the session was OK even though the
    // in-flight verify later failed. The shared promise awaits the
    // real outcome.
    //
    async function verifyAdminSession() {
        if (verifyPromise) return verifyPromise;

        const token = getAdminToken();
        if (!token) {
            return false;
        }

        verifyPromise = (async () => {
            try {
                console.log('[ADMIN SESSION] Verifying with server…');
                const response = await fetch('/api/admin/session', {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Cache-Control': 'no-cache, no-store, must-revalidate'
                    },
                    cache: 'no-store'
                });

                if (response.ok) {
                    verifyFailStreak = 0;
                    console.log('[ADMIN SESSION] Server verification OK');
                    return true;
                }

                // 401 or 403 — try to read the body for a code.
                if (response.status === 401 || response.status === 403) {
                    let errorCode = 'UNKNOWN';
                    try {
                        const body = await response.json();
                        errorCode = body && body.code ? body.code : 'UNKNOWN';
                    } catch (_) { /* ignore */ }

                    console.warn('[ADMIN SESSION] Server rejected session:', response.status, errorCode);

                    // Only 401 with an auth-fatal code counts toward
                    // the streak. 403 is a permission issue on a
                    // specific route, not a dead session.
                    const isFatal = response.status === 401 && (
                        errorCode === 'SESSION_REVOKED' ||
                        errorCode === 'SESSION_EXPIRED' ||
                        errorCode === 'NO_ACTIVE_SESSION' ||
                        errorCode === 'INVALID_SESSION' ||
                        errorCode === 'NO_TOKEN'
                    );

                    if (isFatal) {
                        verifyFailStreak += 1;
                        console.warn(
                            '[ADMIN SESSION] Fatal 401 streak:',
                            verifyFailStreak, '/', MAX_VERIFY_FAIL_STREAK,
                            '(' + errorCode + ')'
                        );
                        if (verifyFailStreak >= MAX_VERIFY_FAIL_STREAK) {
                            clearAdminSession();
                            redirectToLogin();
                        }
                    } else {
                        // Non-fatal: reset the streak — the session is
                        // still alive, this was a route-level rejection.
                        verifyFailStreak = 0;
                    }
                    return false;
                }

                // 5xx, network flakes, etc. Do not log out and do not
                // bump the streak — this is "unknown", not "fatal".
                console.warn('[ADMIN SESSION] Server error, keeping session:', response.status);
                return true;
            } catch (err) {
                console.warn('[ADMIN SESSION] Verification network error, keeping session:', err.message);
                return true;
            } finally {
                verifyPromise = null;
            }
        })();

        return verifyPromise;
    }

    // ─── TOKEN REFRESH ──────────────────────────────────────────────
    //
    // Shared promise — every caller during an in-flight refresh awaits
    // the same outcome. Never returns false just because another call
    // already started the refresh.
    //
    let refreshPromise = null;

    async function refreshAdminToken() {
        if (refreshPromise) return refreshPromise;

        const refreshToken = getRefreshToken();
        if (!refreshToken) {
            console.warn('[ADMIN SESSION] No refresh token available');
            return false;
        }

        refreshPromise = (async () => {
            console.log('[ADMIN SESSION] Attempting refresh…');
            try {
                const response = await fetch('/api/admin/refresh', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ refresh_token: refreshToken })
                });

                if (response.ok) {
                    const data = await response.json();
                    const newToken   = (data && data.data && data.data.access_token)   || (data && data.access_token);
                    const newRefresh = (data && data.data && data.data.refresh_token)  || (data && data.refresh_token) || refreshToken;
                    const freshUser  = (data && data.data && data.data.user)           || (data && data.user)          || getAdminUser();

                    if (newToken && typeof newToken === 'string' && newToken.split('.').length === 3) {
                        saveAdminSession(newToken, freshUser, newRefresh);
                        console.log('[ADMIN SESSION] Token refreshed');
                        return true;
                    }
                    console.warn('[ADMIN SESSION] Refresh returned no usable token');
                    return false;
                }

                if (response.status === 401) {
                    console.warn('[ADMIN SESSION] Refresh rejected — logging out');
                    clearAdminSession();
                    saveReturnUrl();
                    redirectToLogin();
                    return false;
                }

                console.warn('[ADMIN SESSION] Refresh failed with status', response.status);
                return false;
            } catch (err) {
                console.warn('[ADMIN SESSION] Refresh network error:', err.message);
                return false;
            }
        })();

        try {
            return await refreshPromise;
        } finally {
            refreshPromise = null;
        }
    }

    // ─── EXPIRY TIMER (replaces the old 45s heartbeat) ──────────────
    //
    // We schedule a single timer that fires ~30s before the token
    // expires. That is the only moment we proactively contact the
    // server. If the token is refreshed, we reschedule. If it is not,
    // we log out. Between those moments, no requests are made just to
    // keep the session alive.
    //

    function stopExpiryTimer() {
        if (expiryTimer) {
            clearTimeout(expiryTimer);
            expiryTimer = null;
        }
    }

    function scheduleTokenExpiryCheck() {
        stopExpiryTimer();
        if (IS_LOGIN_PAGE) return;

        const token = getAdminToken();
        if (!token) { redirectToLogin(); return; }

        const expiry = getTokenExpiry(token);
        if (!expiry) { clearAdminSession(); redirectToLogin(); return; }

        const timeLeft = expiry - Date.now();
        const checkIn = Math.max(timeLeft - 30_000, MIN_TIMER_MS);

        console.log(`[ADMIN SESSION] Next expiry check in ${Math.round(checkIn / 1000)}s`);

        expiryTimer = setTimeout(async () => {
            const current = getAdminToken();
            if (!current) { redirectToLogin(); return; }

            if (!isTokenExpired(current)) {
                // Token changed while we were sleeping (e.g. refreshed
                // by an adminFetch). Reschedule against the new exp.
                scheduleTokenExpiryCheck();
                return;
            }

            console.warn('[ADMIN SESSION] Token expired — attempting refresh');
            const refreshed = await refreshAdminToken();

            if (refreshed) {
                scheduleTokenExpiryCheck();
                return;
            }

            console.warn('[ADMIN SESSION] Refresh failed — logging out');
            clearAdminSession();
            redirectToLogin();
        }, checkIn);
    }

    // Kept as public API for pages that historically called
    // startHeartbeat()/stopHeartbeat(). They now map to the expiry timer.
    function startHeartbeat() { scheduleTokenExpiryCheck(); }
    function stopHeartbeat()  { stopExpiryTimer(); }

    // ─── ADMIN FETCH (server is authoritative) ─────────────────────
    //
    // On 401, do NOT call verifyAdminSession() from here. That would
    // fire a second network call and — because verifyAdminSession's
    // own failure path can redirect — produce a cascade where a
    // transient 401 on a POST becomes a page navigation. Instead:
    //   1. Try refreshAdminToken() once. If it succeeds, retry the
    //      original request with the new token.
    //   2. If refresh fails (or there is no refresh token), surface
    //      the 401 to the caller. The caller (or a subsequent user
    //      click) will trigger verifyAdminSession() from a fresh
    //      user gesture, which is where the two-strike rule lives.
    //
    async function adminFetch(url, options) {
        options = options || {};

        let token = getAdminToken();
        if (!token) {
            saveReturnUrl();
            redirectToLogin();
            throw new Error('Admin authentication required');
        }

        // If we're close to expiry, try one refresh first. If it fails
        // because the token is already dead, we bail.
        const expiry = getTokenExpiry(token);
        if (expiry) {
            const timeLeft = expiry - Date.now();
            if (timeLeft < REFRESH_BEFORE_MS) {
                const refreshed = await refreshAdminToken();
                if (refreshed) {
                    token = getAdminToken();
                } else if (timeLeft <= 0) {
                    saveReturnUrl();
                    clearAdminSession();
                    redirectToLogin();
                    throw new Error('Admin session expired');
                }
            }
        }

        const isFormData = (typeof FormData !== 'undefined') && (options.body instanceof FormData);
        const headers = Object.assign(
            {},
            isFormData ? {} : { 'Content-Type': 'application/json' },
            options.headers || {},
            {
                'Authorization': `Bearer ${token}`,
                'Cache-Control': 'no-cache'
            }
        );

        const response = await fetch(url, Object.assign({}, options, {
            headers: headers,
            cache: 'no-store'
        }));

        // 401 → try a refresh. If refresh succeeds, retry the request
        // once with the new token. If refresh fails, surface the 401
        // to the caller — do NOT redirect from here.
        if (response.status === 401) {
            const refreshed = await refreshAdminToken();
            if (refreshed) {
                const newToken = getAdminToken();
                const retryHeaders = Object.assign({}, headers, { 'Authorization': `Bearer ${newToken}` });
                return fetch(url, Object.assign({}, options, { headers: retryHeaders, cache: 'no-store' }));
            }
            const err = new Error('Request failed with 401');
            err.code = 'REQUEST_UNAUTHORIZED';
            err.status = 401;
            throw err;
        }

        // 403 → authenticated but unauthorized. Surface but do not log out.
        if (response.status === 403) {
            let body = null;
            try { body = await response.clone().json(); } catch (_) { /* ignore */ }
            const err = new Error((body && body.error) || 'You do not have permission to perform this action.');
            err.code = (body && body.code) || 'PERMISSION_DENIED';
            err.required = (body && body.required) || null;
            err.status = 403;
            throw err;
        }

        return response;
    }

    // ─── LOGOUT ─────────────────────────────────────────────────────

    async function logoutAdmin() {
        const token = getAdminToken();
        stopExpiryTimer();
        clearReturnUrl();

        try {
            if (token) {
                await fetch('/api/admin/logout', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    keepalive: true
                });
            }
        } catch (err) {
            console.warn('[ADMIN SESSION] Logout request failed:', err.message);
        } finally {
            clearAdminSession();
            window.location.replace(LOGIN_URL);
        }
    }

    // ─── INIT ───────────────────────────────────────────────────────

    async function init() {
        if (initAttempted) return;
        initAttempted = true;

        console.log('[ADMIN SESSION] Initializing on:', pathname);
        console.log('[ADMIN SESSION] Is login page:', IS_LOGIN_PAGE);

        // ─── Login page ────────────────────────────────────────────
        if (IS_LOGIN_PAGE) {
            const session = getAdminSession();
            if (session && session.token && !isTokenExpired(session.token)) {
                const verified = await verifyAdminSession();
                if (verified) {
                    console.log('[ADMIN SESSION] Valid session on login page — redirecting after login');
                    redirectAfterLogin();
                    return;
                }
            } else if (session && session.token && isTokenExpired(session.token)) {
                // Try a refresh before giving up. If it works, we can
                // return the operator to where they were.
                const refreshed = await refreshAdminToken();
                if (refreshed) {
                    redirectAfterLogin();
                    return;
                }
                clearAdminSession();
            }
            console.log('[ADMIN SESSION] Login page ready');
            return;
        }

        // ─── Protected admin page ──────────────────────────────────
        const token = getAdminToken();
        console.log('[ADMIN SESSION] Token present:', !!token);

        if (!token) {
            console.warn('[ADMIN SESSION] No admin token');
            redirectToLogin();
            return;
        }

        // If already expired, try to refresh once before redirecting.
        if (isTokenExpired(token)) {
            console.warn('[ADMIN SESSION] Token expired locally — attempting refresh');
            const refreshed = await refreshAdminToken();
            if (!refreshed) {
                clearAdminSession();
                redirectToLogin();
                return;
            }
        }

        // One server check at page load. This is the only unconditional
        // network call the session layer makes.
        const verified = await verifyAdminSession();
        if (!verified) {
            // verifyAdminSession() may have redirected on two-strike.
            // If not (single-strike), stay on the page — the operator
            // can still try to interact and the next failure will
            // trigger the redirect.
            return;
        }

        // Schedule the next expiry check. No periodic heartbeat.
        scheduleTokenExpiryCheck();

        console.log('[ADMIN SESSION] Initialization complete');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        setTimeout(init, 50);
    }

    // When the tab becomes visible, re-verify once. This is cheap and
    // catches the case where the session was revoked while the tab was
    // hidden. It does not run on a timer.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        if (IS_LOGIN_PAGE) return;
        const token = getAdminToken();
        if (!token) return;
        setTimeout(() => { verifyAdminSession().catch(() => {}); }, 400);
    });

    // ─── EXPOSE ─────────────────────────────────────────────────────

    window.AdminSession = {
        // Getters
        getSession:      getAdminSession,
        getToken:        getAdminToken,
        getUser:         getAdminUser,
        getRefreshToken: getRefreshToken,

        // Session management
        save:  saveAdminSession,
        clear: clearAdminSession,

        // Local checks
        isValid:   isSessionValid,
        isExpired: isTokenExpired,
        getExpiry: getTokenExpiry,

        // Server interactions
        verify:  verifyAdminSession,
        refresh: refreshAdminToken,
        fetch:   adminFetch,
        logout:  logoutAdmin,

        // Navigation
        redirectToLogin:     redirectToLogin,
        redirectToDashboard: redirectToDashboard,
        redirectAfterLogin:  redirectAfterLogin,

        // Return-URL helpers (exposed in case a page wants them directly)
        saveReturnUrl:  saveReturnUrl,
        getReturnUrl:   getReturnUrl,
        clearReturnUrl: clearReturnUrl,

        // Backwards-compat aliases. The old heartbeat is now the
        // expiry-scheduler — nothing here polls the server.
        startHeartbeat: startHeartbeat,
        stopHeartbeat:  stopHeartbeat
    };

})();